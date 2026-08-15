#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Hold gate 3 honest. Three checks, in increasing order of what they catch.

    ./harness/check_gate3.py [--language NAME] [--verbose]

**1. The reference formatter must pass.** Every language's reference is a
correct formatter, so whatever it does to the corpus must pass gate 3. Anything
it does that the gate rejects is a bug in the gate, not in the formatter. This
generalises the old "black is the oracle" check to every language, and reads the
committed `corpus/reference/` output so it needs nothing installed.

**2. The generic default must agree with every stronger override.** Python
compares `ast.dump` and JSON compares an ordered `json.loads`; both are stronger
than the generic named-node comparison and both are the reason we can tell
whether the generic one is any good. Where a language has both, they must reach
the same verdict on the same input. A generic checker that disagrees with `ast`
on real Python is telling you something, and this is where you find out --
before thirteen languages that have *only* the generic checker are onboarded
against it.

**3. The gate must still reject destruction.** A gate that accepts everything
passes checks 1 and 2 perfectly. So each language's reference output is mutated
in two ways a real formatter bug would produce -- a comment dropped, a token
dropped -- and the gate must reject both. Without this, gate 3 could rot into a
no-op and every other check here would keep saying PASS.

Run after changing anything in `gate3.py` or a `*_gate3.py` override.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate3  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
REFERENCE = ROOT / "corpus" / "reference"


def cases(m: mf.Manifest):
    """(label, source_text, formatted_text) per corpus file per width."""
    src_dir = SRC / m.name
    if not src_dir.is_dir():
        return
    for path in sorted(p for ext in m.extensions for p in src_dir.glob(f"*{ext}")):
        source = path.read_text()
        for width in m.widths:
            ref = REFERENCE / f"{m.name}__{path.stem}@{width}.txt"
            if not ref.is_file():
                yield (f"{m.name}__{path.stem}@{width}", source, None)
                continue
            yield (f"{m.name}__{path.stem}@{width}", source, ref.read_text())


def drop_a_comment(text: str, parser) -> str | None:
    """Remove one comment. A formatter that did this has destroyed something."""
    root = parser.parse(text.encode()).root_node
    stack, found = [root], None
    while stack:
        n = stack.pop()
        if n.is_extra and n.is_named:
            found = n
            break
        stack.extend(reversed(n.children))
    if found is None:
        return None
    b = text.encode()
    return (b[: found.start_byte] + b[found.end_byte :]).decode()


def drop_a_token(text: str, parser) -> str | None:
    """Remove the last named leaf. Usually an ERROR, sometimes silently valid."""
    root = parser.parse(text.encode()).root_node
    last = None
    stack = [root]
    while stack:
        n = stack.pop()
        if not n.children and n.is_named and not n.is_extra:
            last = n
        stack.extend(n.children)
    if last is None or last.start_byte == last.end_byte:
        return None
    b = text.encode()
    return (b[: last.start_byte] + b[last.end_byte :]).decode()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    manifests = mf.selected(mf.bootstrap(), args.language)
    failures: list[str] = []
    checked = disagreements = mutations = uncompared = 0

    for name, m in manifests.items():
        parser = mf.parser_for(m)
        overridden = m.gate3 != "default"

        for label, source, formatted in cases(m):
            if formatted is None:
                uncompared += 1
                failures.append(
                    f"{label}: no committed reference output "
                    f"-- run harness/gen_reference.py"
                )
                continue

            # --- 1. the reference formatter must pass the gate
            before = gate3.signature(source, m, parser)
            after = gate3.signature(formatted, m, parser)
            checked += 1
            if before is None:
                failures.append(f"{label}: the *source* does not pass its own gate")
            elif after is None:
                failures.append(f"{label}: reference output does not parse")
            elif before != after:
                failures.append(f"{label}: {gate3.describe(before, after, m)}")

            # --- 2. the generic default must reach the same verdict
            if overridden:
                g_before = gate3.generic_signature(source, m, parser)
                g_after = gate3.generic_signature(formatted, m, parser)
                strong_ok = before is not None and before == after
                generic_ok = g_before is not None and g_before == g_after
                if strong_ok != generic_ok:
                    disagreements += 1
                    verdict = "accepts" if generic_ok else "rejects"
                    failures.append(
                        f"{label}: generic default {verdict} but {m.gate3} override "
                        f"does not -- "
                        + gate3.describe(g_before, g_after, _as_generic(m))
                    )
                elif args.verbose:
                    print(f"  agree ({'pass' if strong_ok else 'fail'}) {label}")

            # --- 3. the gate must still reject destruction
            for what, mutate in (("a dropped comment", drop_a_comment),
                                 ("a dropped token", drop_a_token)):
                broken = mutate(formatted, parser)
                if broken is None or broken == formatted:
                    continue
                mutations += 1
                if gate3.signature(broken, m, parser) == before:
                    failures.append(f"{label}: gate ACCEPTS {what}")

    for f in failures:
        print(f"  FAIL {f}")

    print(f"\n{checked} reference outputs checked across "
          f"{len(manifests)} language(s); "
          f"{mutations} destructive mutations rejected; "
          f"{disagreements} generic/override disagreement(s)")
    if failures:
        print(f"{len(failures)} problem(s) -- the gate is wrong, "
              f"or the reference corpus is stale")
        return 1
    if uncompared:
        return 1
    print("gate 3 accepts every reference formatter and rejects every mutation")
    return 0


def _as_generic(m: mf.Manifest) -> mf.Manifest:
    """Same manifest with the override switched off, for `describe`."""
    return mf.Manifest(**{**m.__dict__, "gate3": "default"})


if __name__ == "__main__":
    mf.cli(main)
