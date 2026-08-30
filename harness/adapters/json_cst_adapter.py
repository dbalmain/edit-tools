#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""Parser adapter: `harness/json_cst.py`, the hand-rolled JSON parser.

    ./harness/adapters/json_cst_adapter.py json < source > tree.json

The probe in `docs/tree-interface-probe.md` established that this parser feeds
both unmodified runtimes and reproduces the committed JSON trees byte for byte.
It is here as the *contrast* to the tree-sitter adapter: it was written to
parse clean JSON and it raises on anything else, so it should pass the clean
checks and fail the dirty ones. That asymmetry is what shows the conformance
runner discriminates at all.

A refusal is reported the way any adapter must report one: non-zero exit, the
reason on stderr, nothing on stdout.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import json_cst  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    language = sys.argv[1]
    source = sys.stdin.buffer.read()
    try:
        doc = json_cst.tree_doc(source, language, "<stdin>")
    except json_cst.ParseError as exc:
        print(f"parse error: {exc}", file=sys.stderr)
        return 1
    except UnicodeDecodeError as exc:
        print(f"not UTF-8: {exc}", file=sys.stderr)
        return 1
    doc.pop("source_file", None)
    sys.stdout.write(json_cst.dumps(doc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
