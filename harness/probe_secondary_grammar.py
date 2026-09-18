#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-markdown==0.5.1"]
# ///
"""Prove the secondary Markdown grammar agrees across both producers."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

import tree_sitter as ts
import tree_sitter_markdown as tsmd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402
import manifest as mf  # noqa: E402
import prose  # noqa: E402
import ts_secondaries  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "harness"
AUDIT_COMMIT = "f2819822fa033987e86db79143ab8ffecb900a35"
BLOCK_BLOB = ROOT / "web" / "data" / "blobs" / "markdown.blob.json"
INLINE_BLOB = ROOT / "web" / "data" / "blobs" / "markdown_inline.blob.json"
CLEAN = HARNESS / "fixtures" / "secondary-clean.md"
DIRTY = HARNESS / "fixtures" / "secondary-dirty.md"
MIXED = HARNESS / "fixtures" / "secondary-mixed.md"

# Both fixtures are one paragraph, so each has exactly one `inline` host range
# spanning the whole line. Naming the outcome here rather than deriving it is
# the point: a control that accepts whatever the producers agree on proves they
# agree, not that either did the thing the control is named for. The clean
# fixture must attach a *clean* outcome with a tree; the dirty fixture must
# attach a *dirty* one, in the same total array, at the same range -- so a
# refusal that starts firing on clean input, or a dirty range that goes missing
# instead of being recorded, fails here rather than agreeing with itself.
CLEAN_RANGES = [(0, 24)]
DIRTY_RANGES = [(0, 28)]
# Clean, dirty, clean -- in that order, in one document. The point is the
# middle one: a dirty range must not erase the outcome recorded before it, and
# must not stop the walk reaching the one after it. An all-or-nothing producer
# and a correct one are indistinguishable on a single-paragraph fixture.
MIXED_OUTCOMES = [(0, 24, "clean"), (26, 54, "dirty"), (56, 80, "clean")]


class Failed(Exception):
    pass


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def tracked_markdown() -> list[str]:
    return sorted(
        path
        for path in git("ls-tree", "-r", "--name-only", AUDIT_COMMIT)
        .decode()
        .splitlines()
        if path.endswith(".md")
    )


def reached_paragraphs(node: dict):
    if node["type"] in prose.CONTAINERS or "language" in node:
        return
    if node["type"] == "paragraph":
        yield node
        return
    for child in node.get("children", []):
        yield from reached_paragraphs(child)


def native_case(
    source_file: str,
    source: bytes,
    ranges: set[tuple[int, int]] | None,
    manifest: mf.Manifest,
    parsers: dict,
) -> list[dict]:
    tree = parsers[manifest.name].parse(source)
    if tree.root_node.has_error:
        raise Failed(f"{source_file}: block root is dirty")
    root = gen_trees.convert(tree.root_node, source, None)
    secondary = gen_trees.secondary_trees(
        manifest, source, root, parsers, source_file
    )
    if ranges is not None:
        secondary = [
            entry
            for entry in secondary
            if (entry["start"], entry["end"]) in ranges
        ]
    return secondary


def main() -> int:
    missing = [path for path in (BLOCK_BLOB, INLINE_BLOB) if not path.is_file()]
    if missing:
        names = ", ".join(str(path.relative_to(ROOT)) for path in missing)
        raise Failed(f"missing generated blob(s) {names}; run ./web/gen.py")

    manifests = mf.bootstrap()
    markdown = manifests["markdown"]
    parsers = mf.parsers(manifests)
    block_parser = ts.Parser(ts.Language(tsmd.language()))
    payload = []
    expected = []
    audited = 0

    for path in tracked_markdown():
        source = git("show", f"{AUDIT_COMMIT}:{path}")
        tree = block_parser.parse(source)
        if tree.root_node.has_error:
            continue
        root = gen_trees.convert(tree.root_node, source, None)
        ranges = set()
        for paragraph in reached_paragraphs(root):
            if prose.refusal(paragraph, source) == "inline token":
                inline = paragraph["children"][0]
                ranges.add((inline["start"], inline["end"]))
        if not ranges:
            continue
        expected.append(native_case(path, source, ranges, markdown, parsers))
        payload.append(
            {
                "source_file": path,
                "source": base64.b64encode(source).decode(),
                "ranges": sorted(ranges),
            }
        )
        audited += len(ranges)

    if audited != 2553:
        raise Failed(
            f"audited range set changed: expected 2553 at {AUDIT_COMMIT}, got {audited}"
        )

    for fixture in (CLEAN, DIRTY, MIXED):
        source = fixture.read_bytes()
        expected.append(
            native_case(fixture.name, source, None, markdown, parsers)
        )
        payload.append(
            {
                "source_file": fixture.name,
                "source": base64.b64encode(source).decode(),
                "ranges": None,
            }
        )

    proc = subprocess.run(
        ["node", str(HARNESS / "probe_secondary_driver.mjs"),
         str(BLOCK_BLOB), str(INLINE_BLOB)],
        input=json.dumps(
            {"config": ts_secondaries.config(manifests), "cases": payload}
        ),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise Failed(f"browser producer failed: {proc.stderr.strip()}")
    got = json.loads(proc.stdout)
    if len(got) != len(expected):
        raise Failed(f"browser returned {len(got)} cases, expected {len(expected)}")
    compared = 0
    for item, want_secondary, case in zip(got, expected, payload, strict=True):
        if item["error"] is not None:
            raise Failed(f"{case['source_file']}: browser threw {item['error']!r}")
        if item["secondary"] != want_secondary:
            raise Failed(f"{case['source_file']}: secondary outcomes differ")
        if case["ranges"] is not None:
            # Not just the count: the *set*, per document. Equal totals across
            # the corpus would survive one file attaching a range another file
            # dropped, and the audited ranges are exactly the ones A2.1 will
            # ask about, so a bijection is the claim worth making.
            want = [tuple(pair) for pair in case["ranges"]]
            ranges_got = sorted((e["start"], e["end"]) for e in item["secondary"])
            if ranges_got != want:
                raise Failed(
                    f"{case['source_file']}: attached ranges {ranges_got} "
                    f"!= audited {want}"
                )
            # Counting *clean* outcomes, not records. The array is total now, so
            # the bijection above survives every range turning dirty -- which is
            # exactly how this gate would go vacuous if the secondary parse
            # silently stopped working. A tree compared is the only evidence the
            # two grammars agreed about anything.
            compared += sum(1 for e in item["secondary"] if e["outcome"] == "clean")

    # Agreement between two empty lists is agreement about nothing, and every
    # equality above holds if both producers silently stop attaching. `audited`
    # counts ranges the *block* parse found, so it stays at 2553 through that
    # failure; only this counts CSTs the secondary parse actually produced and
    # the two paths actually compared.
    if compared != audited:
        raise Failed(
            f"compared {compared} clean rebased CSTs for {audited} audited "
            "ranges; each range must parse cleanly and produce exactly one"
        )

    clean_secondary, dirty_secondary, mixed_secondary = expected[-3:]

    def outcomes(entries):
        return [(e["start"], e["end"], e["outcome"]) for e in entries]

    want_clean = [(a, b, "clean") for a, b in CLEAN_RANGES]
    if outcomes(clean_secondary) != want_clean:
        raise Failed(
            f"clean fixture recorded {outcomes(clean_secondary)}, "
            f"expected {want_clean}"
        )
    # An `inline` root with no children parses anything and proves nothing; the
    # fixture's emphasis span is what makes the attachment a syntax tree.
    if not clean_secondary[0]["root"].get("children"):
        raise Failed("clean fixture attached a childless inline root")

    want_dirty = [(a, b, "dirty") for a, b in DIRTY_RANGES]
    if outcomes(dirty_secondary) != want_dirty:
        raise Failed(
            f"dirty fixture recorded {outcomes(dirty_secondary)}, "
            f"expected {want_dirty}"
        )
    # Recorded, not omitted, and recorded without a tree. Omitting it would make
    # an unparseable range indistinguishable from a range that was never there.
    if "root" in dirty_secondary[0]:
        raise Failed("dirty fixture attached a tree it could not parse")
    if gen_trees.dirty_ranges(dirty_secondary, DIRTY.name) != [
        f"{DIRTY.name}: secondary grammar markdown_inline "
        f"refused dirty inline range {DIRTY_RANGES[0][0]}..{DIRTY_RANGES[0][1]}"
    ]:
        raise Failed("the corpus dirty-range policy did not name the dirty range")

    if outcomes(mixed_secondary) != MIXED_OUTCOMES:
        raise Failed(
            f"mixed fixture recorded {outcomes(mixed_secondary)}, "
            f"expected {MIXED_OUTCOMES}"
        )

    print(
        f"secondary grammar: {compared}/{audited} audited ranges agree; "
        f"clean fixture parses, dirty fixture is recorded dirty without a tree, "
        f"mixed fixture keeps clean outcomes either side of a dirty one"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Failed as exc:
        print(f"FAIL secondary grammar: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
