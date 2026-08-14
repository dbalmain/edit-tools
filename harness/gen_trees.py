#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-python", "tree-sitter-json"]
# ///
"""Generate the frozen tree corpus from corpus/src/.

Emits one .tree.json per source file into corpus/trees/. Submissions read
these; they never parse anything themselves.

Refuses to emit a tree containing ERROR or MISSING nodes -- a corpus file that
does not parse cleanly would silently hand every submission a different
problem than the one we meant to pose.
"""

import json
import sys
from pathlib import Path

import tree_sitter_json
import tree_sitter_python
from tree_sitter import Language, Node, Parser

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
OUT = ROOT / "corpus" / "trees"

LANGUAGES = {
    "python": (tree_sitter_python.language, ".py"),
    "json": (tree_sitter_json.language, ".json"),
}


def convert(node: Node, source: bytes, field: str | None) -> dict:
    """tree-sitter node -> our boring JSON shape.

    Anonymous nodes (punctuation, keywords) are kept: a formatter needs to know
    where the commas and colons were, and dropping them would force every
    submission to reinvent that knowledge in its rules.
    """
    out: dict = {"type": node.type, "start": node.start_byte, "end": node.end_byte}
    if field is not None:
        out["field"] = field

    if node.children:
        out["children"] = [
            convert(child, source, node.field_name_for_child(i))
            for i, child in enumerate(node.children)
        ]
    else:
        out["text"] = source[node.start_byte : node.end_byte].decode("utf-8")
    return out


def check_clean(node: Node, path: Path) -> list[str]:
    problems = []
    stack = [node]
    while stack:
        n = stack.pop()
        if n.type == "ERROR" or n.is_missing:
            line = n.start_point[0] + 1
            problems.append(f"{path.name}:{line}: {n.type}{' (missing)' * n.is_missing}")
        stack.extend(n.children)
    return problems


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failures = []
    written = 0

    for lang, (lang_fn, suffix) in LANGUAGES.items():
        parser = Parser(Language(lang_fn()))
        src_dir = SRC / lang
        if not src_dir.is_dir():
            continue
        for path in sorted(src_dir.glob(f"*{suffix}")):
            source = path.read_bytes()
            tree = parser.parse(source)
            problems = check_clean(tree.root_node, path)
            if problems:
                failures.extend(problems)
                continue
            doc = {
                "language": lang,
                "source_file": str(path.relative_to(ROOT)),
                # Submissions need the original text: byte offsets alone cannot
                # tell two spaces from two newlines, so blank-line preservation
                # is impossible without it. The idempotence pass re-emits this
                # field, so a design that reads it behaves the same in round 2.
                "source": source.decode("utf-8"),
                "root": convert(tree.root_node, source, None),
            }
            dest = OUT / f"{lang}__{path.stem}.tree.json"
            dest.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
            written += 1
            print(f"  {dest.relative_to(ROOT)}")

    if failures:
        print("\nparse errors -- corpus not regenerated cleanly:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1

    print(f"\n{written} trees written to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
