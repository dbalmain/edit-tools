#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Probe Markdown fence splicing through both runtimes and gate 2's reparse."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402
import gate3  # noqa: E402
import injection  # noqa: E402
import manifest as mf  # noqa: E402
import score  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "harness" / "fixtures" / "injection"
SOURCE = FIXTURES / "regions.md"
MARKDOWN_MANIFEST = FIXTURES / "markdown.toml"
MARKDOWN_PACKAGE = FIXTURES / "markdown.json"
JSON_PACKAGE = ROOT / "packages" / "json.json"
FMT_JS = ROOT / "fmt-js"
RUST_BIN = ROOT / "rust" / "target" / "release" / "docfmt"
QUOTED_SOURCE = (
    b'> ```json\n'
    b'> {\n'
    b'>   "alpha": [1, 2],\n'
    b'>   "beta": {"x": true}\n'
    b'> }\n'
    b'> ```\n'
)
FRONT_MATTER_SOURCE = b"---\ntags: [alpha,beta]\n---\n"


class Failed(Exception):
    """One probe assertion did not hold."""


def walk(node: dict):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def direct(node: dict, kind: str) -> dict | None:
    return next(
        (child for child in node.get("children", []) if child["type"] == kind),
        None,
    )


def tree_sitter_node(root, kind: str):
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == kind:
            return node
        stack.extend(node.children)
    return None


def without_continuations(content, source: bytes) -> bytes:
    """The tempting quoted-fence patch, retained here only to disprove it."""
    parts = []
    at = content.start_byte
    for child in content.children:
        if child.type != "block_continuation":
            continue
        parts.append(source[at:child.start_byte])
        at = child.end_byte
    parts.append(source[at:content.end_byte])
    return b"".join(parts)


def scalar_base_mismatches(
    root, guest: bytes, host: bytes, base: int
) -> tuple[int, int]:
    """How many guest leaves a single additive host base misreads."""
    mismatches = leaves = 0
    stack = [root]
    while stack:
        node = stack.pop()
        if not node.children:
            leaves += 1
            guest_text = guest[node.start_byte:node.end_byte]
            host_text = host[base + node.start_byte:base + node.end_byte]
            mismatches += guest_text != host_text
        stack.extend(node.children)
    return mismatches, leaves


def info(fence: dict, source: bytes) -> str | None:
    node = direct(fence, "info_string")
    if node is None:
        return None
    return source[node["start"] : node["end"]].decode("utf-8").split()[0]


def check_offsets(node: dict, source: bytes, parent: dict | None = None) -> None:
    start, end = node["start"], node["end"]
    if not 0 <= start <= end <= len(source):
        raise Failed(f"{node['type']} has invalid outer offsets [{start}, {end})")
    if parent is not None and not parent["start"] <= start <= end <= parent["end"]:
        raise Failed(f"{node['type']} sits outside {parent['type']}")
    if "text" in node:
        got = source[start:end].decode("utf-8")
        if node["text"] != got:
            raise Failed(
                f"{node['type']} text disagrees with outer source at [{start}, {end})"
            )
    previous = start
    for child in node.get("children", []):
        if child["start"] < previous:
            raise Failed(f"children of {node['type']} overlap or are out of order")
        check_offsets(child, source, node)
        previous = child["end"]


def invoke(exe: Path, tree: Path, packages: Path) -> str:
    env = {**os.environ, "FMT_PACKAGES": str(packages)}
    proc = subprocess.run(
        [str(exe), str(tree), "60"],
        capture_output=True,
        timeout=60,
        env=env,
    )
    if proc.returncode != 0:
        error = proc.stderr.decode("utf-8", "replace").strip()
        raise Failed(f"{exe.name} refused the spliced tree: {error}")
    return proc.stdout.decode("utf-8")


def main() -> int:
    if not RUST_BIN.is_file():
        raise Failed("rust/target/release/docfmt is missing; run ./build.sh first")

    markdown = mf.parse(MARKDOWN_MANIFEST)
    manifests = {**mf.load_all(), markdown.name: markdown}
    manifests = mf.bootstrap(manifests)
    parsers = mf.parsers(manifests)
    source = SOURCE.read_bytes()
    doc, problems = gen_trees.parse_doc(
        markdown,
        source,
        str(SOURCE.relative_to(ROOT)),
        manifests,
        parsers,
    )
    if problems:
        raise Failed(f"Markdown fixture did not parse cleanly: {problems}")
    if any(node["type"] == "ERROR" for node in walk(doc["root"])):
        raise Failed("the emitted outer tree contains ERROR")
    check_offsets(doc["root"], source)

    fences = [
        node for node in walk(doc["root"]) if node["type"] == "fenced_code_block"
    ]
    by_info = {info(fence, source): fence for fence in fences}
    if len(fences) != 4 or set(by_info) != {"json", None, "unknown"}:
        raise Failed("fixture did not yield the expected four Markdown fences")

    json_fences = [fence for fence in fences if info(fence, source) == "json"]
    stamped = [
        node
        for fence in json_fences
        for node in fence["children"]
        if node.get("language") == "json"
    ]
    if len(stamped) != 1:
        raise Failed("exactly the clean JSON fence root must be stamped")
    embedded = stamped[0]
    clean = next(fence for fence in json_fences if embedded in fence["children"])
    if direct(clean, "code_fence_content") is not None:
        raise Failed("the embedded root did not replace the Markdown content node")
    if embedded["type"] != "document":
        raise Failed(f"stamped {embedded['type']}, expected JSON root `document`")
    json_package = json.loads(JSON_PACKAGE.read_text())
    if embedded["type"] not in json_package["rules"]:
        raise Failed("the JSON package has no rule for the stamped root")
    if any(node is not embedded and "language" in node for node in walk(doc["root"])):
        raise Failed("language was stamped anywhere except the embedded parse root")
    claimed = source[embedded["start"] : embedded["end"]].decode("utf-8")
    if claimed != '{"outer":{"items":[1,2]}}\n':
        raise Failed(f"rebased JSON root claims the wrong outer bytes: {claimed!r}")
    print("  clean JSON: embedded `document` root stamped and rebased")

    for label, fence in (("no info", by_info[None]), ("unknown", by_info["unknown"])):
        if any("language" in node for node in walk(fence)):
            raise Failed(f"{label} fence was stamped")
        if direct(fence, "code_fence_content") is None:
            raise Failed(f"{label} fence did not remain ordinary Markdown content")
        print(f"  {label}: unstamped verbatim Markdown content")

    broken = next(
        fence for fence in json_fences
        if direct(fence, "code_fence_content") is not None
    )
    broken_content = direct(broken, "code_fence_content")
    broken_bytes = source[broken_content["start"] : broken_content["end"]]
    parsed_broken = parsers["json"].parse(broken_bytes).root_node
    if not gen_trees.check_clean(parsed_broken, SOURCE):
        raise Failed("the malformed JSON fixture unexpectedly parsed cleanly")
    if any("language" in node for node in walk(broken)):
        raise Failed("the malformed JSON fence was stamped")
    print("  malformed JSON: unstamped; emitted outer tree stays ERROR-free")

    quoted_root = parsers[markdown.name].parse(QUOTED_SOURCE).root_node
    quoted_fence = tree_sitter_node(quoted_root, "fenced_code_block")
    if quoted_fence is None:
        raise Failed("quoted fixture did not yield a fenced code block")
    quoted_content = tree_sitter_node(quoted_fence, "code_fence_content")
    quoted_region = injection.region_for(
        quoted_fence,
        QUOTED_SOURCE,
        markdown,
        mf.injection_map(manifests),
    )
    if quoted_content is None or quoted_region is None:
        raise Failed("quoted fixture did not yield its declared injection region")
    if injection.parse(quoted_region, parsers) is not None:
        raise Failed("quoted JSON unexpectedly parsed with its continuation markers")
    stripped = without_continuations(quoted_content, QUOTED_SOURCE)
    stripped_root = parsers["json"].parse(stripped).root_node
    if gen_trees.check_clean(stripped_root, SOURCE):
        raise Failed("continuation-stripped quoted JSON did not parse cleanly")
    mismatches, leaves = scalar_base_mismatches(
        stripped_root,
        stripped,
        QUOTED_SOURCE,
        quoted_content.start_byte,
    )
    if mismatches == 0:
        raise Failed("naive continuation stripping no longer disproves scalar rebasing")
    quoted_doc, quoted_problems = gen_trees.parse_doc(
        markdown,
        QUOTED_SOURCE,
        "quoted.md",
        manifests,
        parsers,
    )
    if quoted_problems or any("language" in node for node in walk(quoted_doc["root"])):
        raise Failed("quoted JSON did not conservatively remain host content")
    print(
        "  quoted JSON: verbatim; naive stripping parses but scalar rebasing "
        f"misreads {mismatches}/{leaves} leaves"
    )

    front_matter_doc, front_matter_problems = gen_trees.parse_doc(
        markdown,
        FRONT_MATTER_SOURCE,
        "front-matter.md",
        manifests,
        parsers,
    )
    yaml_roots = [
        node
        for node in walk(front_matter_doc["root"])
        if node.get("language") == "yaml"
    ]
    if front_matter_problems or len(yaml_roots) != 1:
        raise Failed("host-node YAML front matter did not splice exactly once")
    if any(
        node["type"] == "minus_metadata"
        for node in walk(front_matter_doc["root"])
    ):
        raise Failed("the YAML root did not replace the host-node region")
    check_offsets(front_matter_doc["root"], FRONT_MATTER_SOURCE)
    before = FRONT_MATTER_SOURCE.decode()
    after = "---\ntags: [alpha, beta]\n---\n"
    if gate3.signature(before, markdown, parsers[markdown.name], manifests, parsers) != (
        gate3.signature(after, markdown, parsers[markdown.name], manifests, parsers)
    ):
        raise Failed("gate 3 rejected a valid host-node guest reformat")
    print("  host-node region: YAML front matter spliced and gate 3 accepted reformat")

    with tempfile.TemporaryDirectory(prefix="injection-probe-") as tmp:
        tmp_path = Path(tmp)
        packages = tmp_path / "packages"
        packages.mkdir()
        shutil.copyfile(MARKDOWN_PACKAGE, packages / "markdown.json")
        shutil.copyfile(JSON_PACKAGE, packages / "json.json")
        tree = tmp_path / "regions.tree.json"
        tree.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
        rust = invoke(RUST_BIN, tree, packages)
        js = invoke(FMT_JS, tree, packages)
        if rust != js:
            raise Failed("Rust and JS emitted different bytes")
        expected = (
            '{ "outer": { "items": [1, 2] } }',
            "no language",
            "leave unknown",
            '{"broken": [1,}',
        )
        for text in expected:
            if text not in rust:
                raise Failed(f"formatted output lost fixture text {text!r}")
        print(f"  format: rust=js with Markdown+JSON package map ({len(rust)} bytes)")

        round2_doc = score.as_tree_doc(rust, markdown, manifests, parsers)
        if round2_doc is None:
            raise Failed("gate 2 could not parse the formatted Markdown")
        round2_source = rust.encode("utf-8")
        round2_json = [
            node
            for node in walk(round2_doc["root"])
            if node.get("language") == "json"
        ]
        if len(round2_json) != 1 or round2_json[0]["type"] != "document":
            raise Failed("gate 2 did not splice the clean JSON fence in round 2")
        check_offsets(round2_doc["root"], round2_source)
        print("  gate 2: round-two Markdown tree re-spliced the JSON document")
        round2_tree = tmp_path / "regions-round2.tree.json"
        round2_tree.write_text(json.dumps(round2_doc, indent=1, ensure_ascii=False) + "\n")
        rust_again = invoke(RUST_BIN, round2_tree, packages)
        js_again = invoke(FMT_JS, round2_tree, packages)
        if rust_again != js_again:
            raise Failed("Rust and JS disagreed on the round-two spliced tree")
        if rust_again == rust:
            print("  gate 2: fixture output is idempotent through the spliced path")
        else:
            delta = len(rust_again.encode("utf-8")) - len(rust.encode("utf-8"))
            print(
                "  gate 2: fixture blank-line tension remains after re-splicing "
                f"({delta:+d} bytes)"
            )

    print("\nall injection probes held")
    return 0


if __name__ == "__main__":
    try:
        mf.cli(main)
    except Failed as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
