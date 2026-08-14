#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-python", "tree-sitter-json", "black"]
# ///
"""Validate the non-destruction gate against black.

black is the oracle: it is a correct formatter, so whatever it does to the
corpus must pass gate 3. Anything black does that the gate rejects is a bug in
the gate, not in black.

Run after changing normalisation in score.py.
"""

import sys
from pathlib import Path

import black
import tree_sitter_python
from tree_sitter import Language, Parser

sys.path.insert(0, str(Path(__file__).parent))
from score import describe_diff, semantics  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PARSER = Parser(Language(tree_sitter_python.language()))


def main() -> int:
    failures = 0
    for path in sorted((ROOT / "corpus" / "src" / "python").glob("*.py")):
        source = path.read_text()
        before = semantics(source, "python")
        for width in (88, 60):
            out = black.format_str(source, mode=black.Mode(line_length=width))
            after = semantics(out, "python")
            if after is None:
                failures += 1
                print(f"FAIL {path.name}@{width}: black output does not parse")
            elif before != after:
                failures += 1
                print(f"FAIL {path.name}@{width}: {describe_diff(before, after)}")
    if failures:
        print(f"\n{failures} case(s) where black would be disqualified -- gate is wrong")
        return 1
    print("black passes gate 3 on every corpus file at both widths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
