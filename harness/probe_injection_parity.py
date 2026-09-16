#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Compare Python and browser-path injection trees for every corpus host.

    ./harness/probe_injection_parity.py [--allow-missing]

This is a **producer** agreement check, not a runtime one. `fmt-rust` and
`fmt-js` agree on a frozen tree; this asks whether the Python path that froze it
and the browser path that parses the same source produce the same tree at all.
Nothing else in `test.sh` covers that surface.

`--allow-missing` skips when a generated web blob is absent and reports success.
The blobs are gitignored -- `web/gen.py` transcodes them and they are 22.9 MB
raw -- so a fresh checkout has none and needs either that command or this flag.
Without it, a missing prerequisite is a failure. That default is the whole point:
the skip used to be unconditional, so the one gate over this surface reported
success while comparing zero files, and `test.sh` could not tell the difference
between agreement and absence.

Its blind spot, which the flag does not fix: the required blob set is derived
from `language` keys in the produced document, so a producer dependency that is
not an injected language -- Markdown's inline grammar, were the prose projection
to use it -- would never be required and never be missed. A new dependency has
to be declared here, not discovered.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402
import manifest as mf  # noqa: E402
import ts_injections as tj  # noqa: E402
import ts_secondaries as secondary  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "harness"
BLOBS = ROOT / "web" / "data" / "blobs"


class Failed(Exception):
    """The two injection paths did not produce the same tree."""


def walk(node: dict):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def first_difference(want, got, at: str = "doc") -> str:
    if type(want) is not type(got):
        return f"{at}: {type(want).__name__} != {type(got).__name__}"
    if isinstance(want, dict):
        if want.keys() != got.keys():
            return f"{at}: keys {sorted(want)} != {sorted(got)}"
        for key in want:
            if want[key] != got[key]:
                return first_difference(want[key], got[key], f"{at}.{key}")
    elif isinstance(want, list):
        if len(want) != len(got):
            return f"{at}: lengths {len(want)} != {len(got)}"
        for index, item in enumerate(want):
            if item != got[index]:
                return first_difference(item, got[index], f"{at}[{index}]")
    else:
        return f"{at}: {want!r} != {got!r}"
    return f"{at}: values differ"


def main(allow_missing: bool = False) -> int:
    manifests = mf.bootstrap()
    parsers = mf.parsers(manifests)
    hosts = [m for m in manifests.values() if m.injections]
    expected: dict[str, list[tuple[Path, dict]]] = {}
    required = {host.name for host in hosts}
    required.update(
        grammar.name
        for host in hosts
        for grammar in host.secondary_grammars
    )

    for host in hosts:
        records = []
        source_dir = ROOT / "corpus" / "src" / host.name
        for path in sorted(p for p in source_dir.iterdir() if p.suffix):
            doc, problems = gen_trees.parse_doc(
                host,
                path.read_bytes(),
                str(path.relative_to(ROOT)),
                manifests,
                parsers,
            )
            if problems:
                raise Failed(f"{path.name}: Python path did not parse cleanly: {problems}")
            records.append((path, doc))
            required.update(
                node["language"]
                for node in walk(doc["root"])
                if "language" in node
            )
        expected[host.name] = records

    comparisons = sum(len(records) for records in expected.values())
    missing = sorted(
        language
        for language in required
        if not (BLOBS / f"{language}.blob.json").is_file()
    )
    if missing:
        what = (
            f"0/{comparisons} corpus files compared; missing "
            f"{len(missing)} generated web blob(s): {', '.join(missing)}"
        )
        if not allow_missing:
            raise Failed(f"{what} -- run ./web/gen.py to transcode them, or "
                         "pass --allow-missing to skip this check deliberately")
        print(f"SKIP injection tree parity: {what}")
        return 0

    checked = 0
    with tempfile.TemporaryDirectory(prefix="injection-parity-") as tmp:
        temp = Path(tmp)
        for language in required:
            (temp / f"{language}.blob.json").symlink_to(
                BLOBS / f"{language}.blob.json"
            )
        config = temp / "injections.json"
        config.write_text(
            json.dumps(tj.config(manifests, temp), indent=1) + "\n",
            encoding="utf-8",
        )
        secondaries = temp / "secondaries.json"
        secondaries.write_text(
            json.dumps(secondary.config(manifests), indent=1) + "\n",
            encoding="utf-8",
        )

        for host in hosts:
            records = expected[host.name]
            paths = "".join(f"{path}\n" for path, _ in records)
            proc = subprocess.run(
                [
                    "node",
                    HARNESS / "ts_check_trees.mjs",
                    temp / f"{host.name}.blob.json",
                    host.name,
                    "--emit",
                    "--inject",
                    config,
                    "--secondary",
                    secondaries,
                ],
                input=paths,
                capture_output=True,
                text=True,
                timeout=120,
            )
            if proc.returncode != 0:
                raise Failed(
                    f"{host.name}: JavaScript path failed: "
                    f"{proc.stderr.strip() or proc.stdout.strip()}"
                )
            actual = [json.loads(line) for line in proc.stdout.splitlines()]
            if len(actual) != len(records):
                raise Failed(
                    f"{host.name}: JavaScript returned {len(actual)} trees for "
                    f"{len(records)} sources"
                )
            for (path, want), record in zip(records, actual, strict=True):
                if "error" in record:
                    raise Failed(f"{path.name}: JavaScript refused: {record['error']}")
                if record["doc"] != want:
                    difference = first_difference(want, record["doc"])
                    raise Failed(f"{path.name}: {difference}")
                checked += 1

    if checked == 0:
        raise Failed("no corpus injection trees were compared")
    print(f"injection tree parity: {checked}/{comparisons} corpus files identical")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main("--allow-missing" in sys.argv[1:]))
    except Failed as exc:
        print(f"FAIL injection tree parity: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
