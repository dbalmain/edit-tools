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

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "harness"
AUDIT_COMMIT = "f2819822fa033987e86db79143ab8ffecb900a35"
BLOCK_BLOB = ROOT / "web" / "data" / "blobs" / "markdown.blob.json"
INLINE_BLOB = ROOT / "web" / "data" / "blobs" / "markdown_inline.blob.json"
CLEAN = HARNESS / "fixtures" / "secondary-clean.md"
DIRTY = HARNESS / "fixtures" / "secondary-dirty.md"


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
) -> tuple[list[dict], str | None]:
    tree = parsers[manifest.name].parse(source)
    if tree.root_node.has_error:
        raise Failed(f"{source_file}: block root is dirty")
    root = gen_trees.convert(tree.root_node, source, None)
    secondary, problems = gen_trees.secondary_trees(
        manifest, source, root, parsers, source_file
    )
    if problems:
        return [], problems[0]
    if ranges is not None:
        secondary = [
            entry
            for entry in secondary
            if (entry["start"], entry["end"]) in ranges
        ]
    return secondary, None


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
        secondary, error = native_case(path, source, ranges, markdown, parsers)
        expected.append((secondary, error))
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

    for fixture in (CLEAN, DIRTY):
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
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise Failed(f"browser producer failed: {proc.stderr.strip()}")
    got = json.loads(proc.stdout)
    if len(got) != len(expected):
        raise Failed(f"browser returned {len(got)} cases, expected {len(expected)}")
    for item, (want_secondary, want_error), case in zip(
        got, expected, payload, strict=True
    ):
        if item["error"] != want_error:
            raise Failed(
                f"{case['source_file']}: refusal differs: native={want_error!r}, "
                f"browser={item['error']!r}"
            )
        if item["secondary"] != want_secondary:
            raise Failed(f"{case['source_file']}: rebased secondary CST differs")

    dirty_error = expected[-1][1]
    if dirty_error is None:
        raise Failed("dirty fixture did not reach the secondary-root refusal")
    print(
        f"secondary grammar: {audited}/{audited} audited ranges agree; "
        f"clean fixture agrees; dirty fixture refuses identically: {dirty_error}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Failed as exc:
        print(f"FAIL secondary grammar: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
