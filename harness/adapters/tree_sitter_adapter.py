#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Parser adapter: real tree-sitter. The conformance runner's positive control.

    ./harness/adapters/tree_sitter_adapter.py <language> < source > tree.json

This is the adapter every other one is measured against, so it must pass every
check in `parse_conform.py`. If it does not, the runner is wrong, not the
parser -- that is the whole point of running it first.

Injections are off, matching `corpus/trees-edited/`: a candidate parse layer
parses one language, and the oracle it owes us is one grammar's own recovery.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import manifest as mf  # noqa: E402
import parse_oracle as po  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    language = sys.argv[1]
    known = mf.bootstrap()
    if language not in known:
        print(f"no manifest for {language!r}", file=sys.stderr)
        return 2
    source = sys.stdin.buffer.read()
    parser = mf.parser_for(known[language])
    root = po.convert(parser.parse(source).root_node, source)
    doc = {
        "language": language,
        "source": source.decode("utf-8"),
        "parse": "scratch",
        "root": root,
    }
    sys.stdout.write(po.dumps(doc))
    return 0


if __name__ == "__main__":
    mf.cli(main)
