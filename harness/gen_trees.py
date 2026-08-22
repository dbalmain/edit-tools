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
import injection  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
OUT = ROOT / "corpus" / "trees"


def convert(
    node,
    source: bytes,
    field: str | None,
    *,
    base: int = 0,
    outer_source: bytes | None = None,
    manifest: mf.Manifest | None = None,
    aliases: dict[str, mf.Manifest] | None = None,
    parsers: dict | None = None,
) -> dict:
    """tree-sitter node -> our boring JSON shape.

    Anonymous nodes (punctuation, keywords) are kept: a formatter needs to know
    where the commas and colons were, and dropping them would force every
    submission to reinvent that knowledge in its rules.

    An embedded parse uses offsets relative to its own source. `base` rebases
    them onto `outer_source`; leaf text is always checked against those outer
    bytes, so a spliced subtree has exactly the same offset contract as its host.
    """
    outer_source = source if outer_source is None else outer_source
    start, end = base + node.start_byte, base + node.end_byte

    region = root = None
    if manifest is not None and aliases is not None and parsers is not None:
        region = injection.region_for(node, source, manifest, aliases)
        root = injection.parse(region, parsers) if region is not None else None
    if region is not None and root is not None and region.content == node:
        guest = region.guest
        assert guest is not None
        embedded = convert(
            root,
            region.source,
            field,
            base=base + region.content.start_byte,
            outer_source=outer_source,
            manifest=guest,
            aliases=aliases,
            parsers=parsers,
        )
        embedded["language"] = guest.name
        return embedded

    out: dict = {"type": node.type, "start": start, "end": end}
    if field is not None:
        out["field"] = field

    if node.children:
        children = []
        for i, child in enumerate(node.children):
            child_field = node.field_name_for_child(i)
            if region is not None and root is not None and child == region.content:
                guest = region.guest
                assert guest is not None
                embedded = convert(
                    root,
                    region.source,
                    child_field,
                    base=base + region.content.start_byte,
                    outer_source=outer_source,
                    manifest=guest,
                    aliases=aliases,
                    parsers=parsers,
                )
                embedded["language"] = guest.name
                children.append(embedded)
            else:
                children.append(
                    convert(
                        child,
                        source,
                        child_field,
                        base=base,
                        outer_source=outer_source,
                        manifest=manifest,
                        aliases=aliases,
                        parsers=parsers,
                    )
                )
        out["children"] = children
    else:
        out["text"] = outer_source[start:end].decode("utf-8")
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


def parse_doc(
    m: mf.Manifest,
    source: bytes,
    source_file: str,
    manifests: dict[str, mf.Manifest],
    parsers: dict,
) -> tuple[dict, list[str]]:
    tree = parsers[m.name].parse(source)
    problems = check_clean(tree.root_node, Path(source_file))
    doc = {
        "language": m.name,
        "source_file": source_file,
        # Submissions need the original text: byte offsets alone cannot tell
        # two spaces from two newlines, so blank-line preservation is impossible
        # without it. The idempotence pass re-emits this field, so a design that
        # reads it behaves the same in round 2.
        "source": source.decode("utf-8"),
        "root": convert(
            tree.root_node,
            source,
            None,
            manifest=m,
            aliases=mf.injection_map(manifests),
            parsers=parsers,
        ),
    }
    return doc, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language", help="regenerate only this language's trees")
    args = ap.parse_args()

    known = mf.bootstrap()
    manifests = mf.selected(known, args.language)
    parsers = mf.parsers(known)

    OUT.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    written = 0
    seen: dict[str, Path] = {}

    for name, m in manifests.items():
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
            doc, problems = parse_doc(
                m, source, str(path.relative_to(ROOT)), known, parsers
            )
            if problems:
                failures.extend(problems)
                continue
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
