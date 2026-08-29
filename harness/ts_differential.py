#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Differential-test the table interpreter against real tree-sitter.

    find $(go env GOROOT)/src -name '*.go' |
      uv run --with tree-sitter==0.26.0 --with tree-sitter-go==0.25.0 \
        harness/ts_differential.py --language go --module tree_sitter_go \
                                   --blob <blob.json>

Reads paths on stdin. For each, parses with the real grammar via
`gen_trees.convert()` and with `harness/ts_check_trees.mjs --emit`, and compares
the two documents.

Why this exists: the frozen corpus is 3 JSON files and 16 Go files. That is a
thin oracle for a 372 KB table blob, and a transcoder bug in a table those
nineteen files never reach would produce a green run. This widens the oracle to
whatever source is lying around -- the Go standard library is ~7,700 files --
without touching the frozen corpus, which stays the acceptance bar.

It is still only evidence about **clean full parses**. Files that tree-sitter
itself cannot parse without ERROR or MISSING are skipped, exactly as
`gen_trees.py` refuses them, so error recovery is no better tested here than it
is by the corpus.
"""

from __future__ import annotations

import argparse
import importlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402

HARNESS = Path(__file__).resolve().parent


def reference_doc(parser, language: str, path: Path) -> dict | None:
    """What `gen_trees.py` would freeze for this file, or None if unclean."""
    source = path.read_bytes()
    try:
        source.decode("utf-8")
    except UnicodeDecodeError:
        return None
    tree = parser.parse(source)
    if gen_trees.check_clean(tree.root_node, path):
        return None
    return {
        "language": language,
        "source_file": str(path),
        "source": source.decode("utf-8"),
        "root": gen_trees.convert(tree.root_node, source, None),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--language", required=True)
    ap.add_argument("--module", required=True, help="e.g. tree_sitter_go")
    ap.add_argument("--blob", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-bytes", type=int, default=400_000)
    args = ap.parse_args()

    import tree_sitter as ts

    grammar = importlib.import_module(args.module)
    parser = ts.Parser(ts.Language(grammar.language()))

    paths = [Path(line.strip()) for line in sys.stdin if line.strip()]
    paths = [p for p in paths if p.is_file() and p.stat().st_size <= args.max_bytes]
    paths.sort()
    if args.limit:
        paths = paths[: args.limit]
    if not paths:
        print("no input files", file=sys.stderr)
        return 2

    listing = "\n".join(str(p) for p in paths)
    proc = subprocess.run(
        [str(HARNESS / "ts_check_trees.mjs"), str(args.blob), args.language, "--emit"],
        input=listing,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(proc.stderr[-4000:], file=sys.stderr)
        return 1
    actual = {}
    # split("\n"), not splitlines(): Python splits on \v, \x1c-\x1e, \x85,
    # U+2028 and U+2029 as well, and JSON.stringify leaves the last three
    # unescaped inside strings. Go's own unicode tests contain them.
    for line in proc.stdout.split("\n"):
        if not line:
            continue
        rec = json.loads(line)
        actual[rec["path"]] = rec

    agree = skipped = 0
    failures: list[str] = []
    for path in paths:
        want = reference_doc(parser, args.language, path)
        if want is None:
            skipped += 1
            continue
        rec = actual.get(str(path))
        if rec is None:
            failures.append(f"{path}: interpreter emitted nothing")
        elif "error" in rec:
            failures.append(f"{path}: {rec['error']}")
        # `source_file` is a path the harness stamps in, not a parse result;
        # the JS side makes it repo-relative and these inputs are outside the
        # repo. Everything else -- source, and the whole tree -- must match.
        elif drop_path(rec["doc"]) != drop_path(want):
            failures.append(f"{path}: {describe(drop_path(want), drop_path(rec['doc']))}")
        else:
            agree += 1

    total = len(paths) - skipped
    print(f"{agree}/{total} agree with tree-sitter ({skipped} skipped as unclean)")
    for f in failures[:20]:
        print(f"  FAIL {f}", file=sys.stderr)
    if len(failures) > 20:
        print(f"  ... and {len(failures) - 20} more", file=sys.stderr)
    return 0 if not failures else 1


def drop_path(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k != "source_file"}


def describe(want: dict, got: dict) -> str:
    a = json.dumps(want, sort_keys=False)
    b = json.dumps(got, sort_keys=False)
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return f"diverges at char {i}: want {a[i:i + 90]!r} got {b[i:i + 90]!r}"
    return f"prefix agrees, lengths differ ({len(a)} vs {len(b)})"


if __name__ == "__main__":
    sys.exit(main())
