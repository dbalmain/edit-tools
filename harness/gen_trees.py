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
import locale
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import injection  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
OUT = ROOT / "corpus" / "trees"


def pin_ctype() -> None:
    """Make character classification independent of the machine's locale.

    Eight of the pinned grammars carry an external scanner and seven of those
    call `isw*` from libc on the lookahead character. Those functions are
    locale-dependent natively: glibc answers 0 for e-acute, alpha, alef and CJK
    under `LC_CTYPE=C` and 1 under any UTF-8 locale. So the same grammar, the
    same source and the same tree-sitter can produce two different trees
    depending on an environment variable -- measured, on tree-sitter-rust
    0.24.0, where `let x = 1.\u00e9;` is a `field_expression` under UTF-8 and
    `float_literal` followed by ERROR under C.

    The corpus does not currently exercise this: regenerating all 234 trees
    under `LC_ALL=C` produces byte-identical output, because no corpus file
    puts a non-ASCII character anywhere a scanner asks whether it is a letter.
    That is luck, not design -- one new corpus file could spend it, and the
    failure would be a silent difference in a committed artifact rather than an
    error. Pinning costs one call and converts the hazard into a constant.

    UTF-8 is the side to pin to: it is what every developer machine and CI
    image already runs, so the committed corpus does not move, and it is the
    answer wasm gives, which is not locale-sensitive at all.
    """
    for candidate in ("C.UTF-8", "en_US.UTF-8", "en_AU.UTF-8"):
        try:
            locale.setlocale(locale.LC_CTYPE, candidate)
            return
        except locale.Error:
            continue
    # No UTF-8 locale on this machine. Say so rather than emitting a corpus
    # whose character classification silently differs from everyone else's.
    raise SystemExit(
        "gen_trees: no UTF-8 locale available (tried C.UTF-8, en_US.UTF-8, "
        "en_AU.UTF-8). Character classification in grammar scanners is "
        "locale-dependent, so the corpus this would write is not the "
        "committed one. Install a UTF-8 locale, or set LC_ALL explicitly."
    )


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
        if not region.format:
            embedded["opaque"] = True
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
                if not region.format:
                    embedded["opaque"] = True
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
    """Every ERROR or MISSING in this subtree, as human-readable problems.

    `node.children` is the *visible* children, so walking it alone misses a
    MISSING node whose symbol is invisible -- and tree-sitter-go inserts exactly
    that, a MISSING `aux_sym_source_file_token1`, for a file with no trailing
    newline. Reproduced on `corpus/src/go/iota.go` with its newline stripped:
    the walk below finds nothing while `root_node.has_error` is True.

    So the walk is the diagnostic and `has_error` is the guarantee. Without the
    second check this function's promise -- and `gen_trees.py`'s, which is
    stated at the top of this file as refusing to emit a tree containing ERROR
    or MISSING -- held only for the visible ones, which is narrower than either
    reads. No committed corpus file trips it today; the point is that nothing
    was stopping one.
    """
    problems = []
    stack = [node]
    while stack:
        n = stack.pop()
        if n.type == "ERROR" or n.is_missing:
            line = n.start_point[0] + 1
            problems.append(f"{path.name}:{line}: {n.type}{' (missing)' * n.is_missing}")
        stack.extend(n.children)
    if node.has_error and not problems:
        problems.append(
            f"{path.name}: has_error with no visible ERROR or MISSING node "
            "(an invisible MISSING -- tree-sitter-go does this for a file with "
            "no trailing newline)"
        )
    return problems


def sources(m: mf.Manifest) -> list[Path]:
    src_dir = SRC / m.name
    if not src_dir.is_dir():
        return []
    found: list[Path] = []
    for ext in m.extensions:
        found.extend(src_dir.glob(f"*{ext}"))
    return sorted(found)


def _host_nodes(root: dict, kind: str):
    """Host nodes of `kind`, excluding CSTs already spliced as injections."""
    stack = [root]
    while stack:
        node = stack.pop()
        if node.get("language") is not None:
            continue
        if node["type"] == kind:
            yield node
        stack.extend(reversed(node.get("children", [])))


def secondary_trees(
    m: mf.Manifest,
    source: bytes,
    block_root: dict,
    parsers: dict,
    source_file: str,
) -> list[dict]:
    """One outcome per manifest-declared contiguous range.

    **Total, and that is the point.** Every host range the declaration matches
    gets exactly one record, `outcome: "clean"` carrying a `root` or
    `outcome: "dirty"` carrying none. So a reader can tell three things apart
    that a list of successes collapses into two: there is no host range here;
    there is one and its tree is trustworthy; there is one and it is not. A
    host range with *no* record is then a producer bug rather than an ordinary
    dirty parse, which is the distinction A2.1 needs when it asks whether it
    may reflow a given paragraph.

    A dirty parse is an outcome, not an error. It costs that range and nothing
    else -- the same policy `ts_inject.mjs` has always applied to a guest
    language that will not parse, where the region stays verbatim and the
    document formats normally. Refusing the whole document instead would mean
    A2.0 could stop a buffer formatting that formatted before it existed.

    What still raises is infrastructure: a missing parser, an undeclared
    grammar, a routing error. Those mean the declared pipeline could not run at
    all, which is not the same claim as "this paragraph is untrustworthy".
    Artifact-quality policy -- whether a *corpus* file is allowed to contain a
    dirty range -- belongs to the caller, not here; `parse_doc` applies it.
    """
    out: list[dict] = []
    for grammar in m.secondary_grammars:
        parser = parsers[grammar.name]
        for node in _host_nodes(block_root, grammar.within):
            start, end = node["start"], node["end"]
            tree = parser.parse(source[start:end])
            entry = {
                "language": grammar.name,
                "within": grammar.within,
                "start": start,
                "end": end,
            }
            if tree.root_node.has_error:
                entry["outcome"] = "dirty"
            else:
                entry["outcome"] = "clean"
                entry["root"] = convert(
                    tree.root_node,
                    source[start:end],
                    None,
                    base=start,
                    outer_source=source,
                )
            out.append(entry)
    return out


def dirty_ranges(secondary: list[dict], source_file: str) -> list[str]:
    """The corpus's artifact-quality policy, stated where it is applied.

    A committed tree may not carry a dirty range: the frozen corpus is a
    reference, and a reference built from syntax nobody could parse is not one.
    A live editor buffer is under no such obligation, which is why this is a
    caller's rule and not `secondary_trees`'.
    """
    return [
        f"{Path(source_file).name}: secondary grammar {entry['language']} "
        f"refused dirty {entry['within']} range {entry['start']}..{entry['end']}"
        for entry in secondary
        if entry["outcome"] == "dirty"
    ]


def parse_doc(
    m: mf.Manifest,
    source: bytes,
    source_file: str,
    manifests: dict[str, mf.Manifest],
    parsers: dict,
) -> tuple[dict, list[str]]:
    tree = parsers[m.name].parse(source)
    problems = check_clean(tree.root_node, Path(source_file))
    block_root = convert(
        tree.root_node,
        source,
        None,
        manifest=m,
        aliases=mf.injection_map(manifests),
        parsers=parsers,
    )
    secondary = secondary_trees(m, source, block_root, parsers, source_file)
    problems.extend(dirty_ranges(secondary, source_file))
    doc = {
        "language": m.name,
        "source_file": source_file,
        # Submissions need the original text: byte offsets alone cannot tell
        # two spaces from two newlines, so blank-line preservation is impossible
        # without it. The idempotence pass re-emits this field, so a design that
        # reads it behaves the same in round 2.
        "source": source.decode("utf-8"),
        "root": block_root,
    }
    if secondary:
        doc["secondary"] = secondary
    return doc, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language", help="regenerate only this language's trees")
    args = ap.parse_args()

    pin_ctype()
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
            dest.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
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
