"""Which languages cannot be scored yet, and why.

Three callers need this answer and none of them should own it. `score.py`
excludes pending languages from every gate; `review_page.py` prints the reason
in a language row; `check_gate3.py` annotates its adversarial line with it.
Before this module the closure lived in `score.py` and `check_gate3.py` imported
the scorer to reach it, which is the wrong direction for a gate -- and the
alternative, a second copy of the walk, is the defect this repository keeps
finding.

The dependency graph itself stays in `manifest.py`, which owns it. What lives
here is the part that is neither graph nor scoring: turning "these packages are
absent" into "these languages are pending, and here is the one to blame".

`available` is a predicate rather than a path so the decision is pure. A caller
with a submission directory passes `roster_on_disk(submission)`; a test passes
a set's `__contains__`, and neither needs the other's world.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import manifest as mf


def roster_on_disk(submission: Path) -> Callable[[str], bool]:
    """`available` for a real submission: a package is a file that exists.

    Existence only. A package that is present and refuses is a real failure and
    must still be scored as one -- see `awaiting_package`.
    """

    def available(name: str) -> bool:
        return (submission / "packages" / f"{name}.json").is_file()

    return available


def awaiting_package(
    available: Callable[[str], bool],
    manifests: dict[str, mf.Manifest],
    all_manifests: dict[str, mf.Manifest] | None = None,
) -> dict[str, str]:
    """Languages that cannot be scored yet, mapped to why.

    Onboarding lands stage A (corpus, manifest, trees, reference output) before
    stage C writes the package, and without this the scorer reports a stage-A
    language as one refusal per tree per width and DISQUALIFIED -- which reads
    exactly like a broken package. Four reviewed TOML corpora sat unmerged for
    weeks because of it, and the stage-A brief asks for a green `./test.sh` from
    a stage that could not produce one.

    A language is awaiting its package only when the package is absent
    entirely. A package that is present and refuses is a real failure and is
    still scored as one. That stays true transitively: only absence
    propagates, never a refusal.

    The formatter recurses into guest regions, so a host whose package exists
    still cannot be scored when a guest it formats is awaiting one -- otherwise
    the host scores as one refusal per tree that embeds the guest, the same
    false DISQUALIFIED the direct case was written to prevent. The relationship
    is the manifest injection graph (`mf.formatted_guests`): `guest` is an
    alias, an `info` site can resolve to any alias, and opaque sites do not
    load a package. The wait is transitive; a cycle does not hang.

    `all_manifests` is the roster the graph is built from. `--language` still
    has to see a guest that was not selected, because the host's score depends
    on that guest's package whether or not we asked to score the guest.
    """
    all_manifests = all_manifests if all_manifests is not None else manifests
    missing = {name for name in all_manifests if not available(name)}
    aliases = mf.injection_map(all_manifests)
    direct = {
        name: mf.formatted_guests(m, aliases) for name, m in all_manifests.items()
    }
    hosts_of: dict[str, set[str]] = {}
    for host, guests in direct.items():
        for guest in guests:
            hosts_of.setdefault(guest, set()).add(host)

    pending = set(missing)
    stack = list(missing)
    while stack:
        guest = stack.pop()
        for host in hosts_of.get(guest, ()):
            if host not in pending:
                pending.add(host)
                stack.append(host)

    def missing_in_closure(host: str) -> list[str]:
        seen: set[str] = set()
        found: set[str] = set()
        walk = list(direct.get(host, ()))
        while walk:
            guest = walk.pop()
            if guest in seen:
                continue
            seen.add(guest)
            if guest in missing:
                found.add(guest)
            walk.extend(direct.get(guest, ()))
        return sorted(found)

    reasons = {}
    for name in pending:
        if name in missing:
            reasons[name] = "corpus landed, not yet scored"
        else:
            roots = missing_in_closure(name)
            if len(roots) == 1:
                reasons[name] = f"{roots[0]} is pending"
            else:
                reasons[name] = f"{', '.join(roots)} are pending"
    return {name: reasons[name] for name in manifests if name in pending}
