#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Check a language's port against real tree-sitter with **injections off**.

    ./harness/ts_check_hostonly.py <language> <trees-dir>

`ts_check_trees.mjs` compares against `corpus/trees/`, and for a language with
injections those fixtures are *spliced*: `gen_trees.py` reparses a fenced
region with the guest grammar and substitutes the guest's tree for the host's
leaf. The table interpreter has no included-range second pass, so it cannot
reproduce that shape and never will from a single parse -- the mismatch is a
property of the fixture, not of the port.

markdown is the first language where that bites. Six of its fifteen clean
fixtures (`comments`, `fences`, `kitchen`, `long_sequences`, `nesting`,
`normalisation`) carry a spliced guest `document`, so `ts_check_trees.mjs`
reports 9/15 for a port that is byte-identical to the host grammar on all
fifteen. `parse_oracle.py` already turns injections off for exactly this
reason, which is why `corpus/trees-edited/` needs no equivalent.

So this is the other half of the bar for such a language: parse each corpus
file with the real grammar and **no injection pass**, serialise it in
`gen_trees.py`'s shape, and require our `--write-dir` output to equal it byte
for byte. Produce that output first:

    ./harness/ts_transcode.py <parser.c> --scanner harness/scanners/X.svm \
      -o /tmp/X.blob.json
    node harness/ts_check_trees.mjs /tmp/X.blob.json X --write-dir /tmp/X-ours
    ./harness/ts_check_hostonly.py X /tmp/X-ours

It is *weaker* than the frozen-fixture check in one way and stronger in
another: weaker because it re-derives its oracle from a live grammar rather
than from a committed artifact, stronger because it is the only comparison an
injected language's clean corpus admits at all.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402
import gen_trees as gt  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("language")
    ap.add_argument("trees_dir", help="output of ts_check_trees.mjs --write-dir")
    args = ap.parse_args()

    known = mf.bootstrap()
    if args.language not in known:
        print(f"unknown language {args.language}", file=sys.stderr)
        return 2
    m = known[args.language]
    parsers = mf.parsers(known)
    gt.pin_ctype()

    ours = Path(args.trees_dir)
    files = sorted(gt.sources(m))
    bad: list[str] = []
    for path in files:
        source = path.read_bytes()
        tree = parsers[m.name].parse(source)
        doc = {
            "language": m.name,
            "source_file": str(path.relative_to(gt.ROOT)),
            "source": source.decode("utf-8"),
            # manifest/aliases/parsers omitted, so convert() takes no
            # injection branch -- this is the whole point of the script.
            "root": gt.convert(tree.root_node, source, None),
        }
        want = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
        got = (ours / f"{m.name}__{path.stem}.tree.json").read_text(encoding="utf-8")
        if want != got:
            bad.append(path.stem)
        print(f"  {path.stem:<24} {'ok' if want == got else 'DIFFERS'}")

    print(f"\n{len(files) - len(bad)}/{len(files)} byte-identical, injections off")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
