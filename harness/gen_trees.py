#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Generate the frozen tree corpus from corpus/src/.

    ./harness/gen_trees.py [--language NAME]

Emits one .tree.json per source file into corpus/trees/. Submissions read
these; they never parse anything themselves.

Which languages exist, which grammar parses each, and which file extensions
belong to it all come from `harness/languages/*.toml`. There is no list in this
file on purpose -- fifteen languages are onboarded in parallel worktrees, and a
map here would be a three-way merge conflict every round.

Note the inline `dependencies` above names only `tree-sitter`. The grammars are
installed by `manifest.bootstrap()`, which re-execs this script under
`uv run --with <pinned grammar>` for every manifest. A grammar listed here would
be the same shared-file conflict wearing a different hat.

Refuses to emit a tree containing ERROR or MISSING nodes -- a corpus file that
does not parse cleanly would silently hand every submission a different
problem than the one we meant to pose.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
OUT = ROOT / "corpus" / "trees"


def convert(node, source: bytes, field: str | None) -> dict:
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


def check_clean(node, path: Path) -> list[str]:
    problems = []
    stack = [node]
    while stack:
        n = stack.pop()
        if n.type == "ERROR" or n.is_missing:
            line = n.start_point[0] + 1
            problems.append(f"{path.name}:{line}: {n.type}{' (missing)' * n.is_missing}")
        stack.extend(n.children)
    return problems


def sources(m: mf.Manifest) -> list[Path]:
    src_dir = SRC / m.name
    if not src_dir.is_dir():
        return []
    found: list[Path] = []
    for ext in m.extensions:
        found.extend(src_dir.glob(f"*{ext}"))
    return sorted(found)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language", help="regenerate only this language's trees")
    args = ap.parse_args()

    manifests = mf.bootstrap()
    manifests = mf.selected(manifests, args.language)

    OUT.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    written = 0
    seen: dict[str, Path] = {}

    for name, m in manifests.items():
        parser = mf.parser_for(m)
        for path in sources(m):
            # Two extensions can share a stem (`app.ts` / `app.tsx`); the tree
            # name has no room for both, so say so rather than overwrite.
            key = f"{name}__{path.stem}"
            if key in seen:
                failures.append(f"{path.name}: tree name {key} already taken by "
                                f"{seen[key].name}; rename one")
                continue
            seen[key] = path

            source = path.read_bytes()
            tree = parser.parse(source)
            problems = check_clean(tree.root_node, path)
            if problems:
                failures.extend(problems)
                continue
            doc = {
                "language": name,
                "source_file": str(path.relative_to(ROOT)),
                # Submissions need the original text: byte offsets alone cannot
                # tell two spaces from two newlines, so blank-line preservation
                # is impossible without it. The idempotence pass re-emits this
                # field, so a design that reads it behaves the same in round 2.
                "source": source.decode("utf-8"),
                "root": convert(tree.root_node, source, None),
            }
            dest = OUT / f"{key}.tree.json"
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
    mf.cli(main)
