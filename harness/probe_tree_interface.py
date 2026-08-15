#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""Probe: can a non-tree-sitter parser feed the unmodified runtimes?

    ./harness/probe_tree_interface.py

1. Parse every `corpus/src/json/` file with `json_cst.py` (no tree-sitter,
   no JSON library on the input).
2. Demand byte-identical trees against `corpus/trees/json__*.tree.json`.
3. Format each probe tree with both runtimes at every scored width, and
   demand byte-identical output against the committed tree-sitter path.
4. Run the experiments JSON cannot pose on its own: no field names,
   `flatten`'s hardcoded fields, comments as ordinary children, a
   whitespace child.

Exit 0 only if every comparison and every named experiment holds.
The report in `docs/tree-interface-probe.md` is written from this output.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import json_cst  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src" / "json"
TREES = ROOT / "corpus" / "trees"
WIDTHS = (88, 60)
JSON_PKG = ROOT / "packages" / "json.json"
# The fmt-rust wrapper forces FMT_PACKAGES to ./packages, so an experiment
# that needs a different package has to call the binary itself. fmt-js
# honours the env var.
FMT_RUST = ROOT / "fmt-rust"
FMT_JS = ROOT / "fmt-js"
RUST_BIN = ROOT / "rust" / "target" / "release" / "docfmt"


class Failed(Exception):
    """One probe step did not hold. The message is the finding."""


def _run(
    tree_path: Path, width: int, packages: Path | None, rust: bool
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if packages is not None:
        env["FMT_PACKAGES"] = str(packages)
        exe = RUST_BIN if rust else FMT_JS
    else:
        exe = FMT_RUST if rust else FMT_JS
    return subprocess.run(
        [str(exe), str(tree_path), str(width)],
        capture_output=True,
        timeout=60,
        env=env,
    )


def invoke(tree_path: Path, width: int, packages: Path | None = None, *, rust: bool = True) -> str:
    which = "rust" if rust else "js"
    proc = _run(tree_path, width, packages, rust)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise Failed(f"{which} refused {tree_path.name}@{width}: {err}")
    return proc.stdout.decode("utf-8")


def refuse(tree_path: Path, width: int, packages: Path | None = None) -> str:
    proc = _run(tree_path, width, packages, rust=True)
    if proc.returncode == 0:
        raise Failed(f"rust accepted {tree_path.name}@{width}; expected a refusal")
    return proc.stderr.decode("utf-8", "replace").strip()


def first_diff(got: str, want: str) -> str:
    if got == want:
        return "identical"
    g_lines, w_lines = got.splitlines(), want.splitlines()
    for i, (a, b) in enumerate(zip(g_lines, w_lines), 1):
        if a != b:
            return f"first differ at line {i}:\n    got:  {a!r}\n    want: {b!r}"
    if len(g_lines) != len(w_lines):
        return f"length {len(g_lines)} vs {len(w_lines)} lines"
    return "differ (no line split?)"


def json_sources() -> list[Path]:
    found = sorted(SRC.glob("*.json"))
    if not found:
        raise Failed(f"no JSON corpus files in {SRC}")
    return found


def probe_json_trees() -> list[tuple[str, Path, Path]]:
    """Parse each source; write the probe tree; compare to the committed one.

    Returns (stem, probe_path, committed_path) for the format step.
    """
    out_dir = Path(tempfile.mkdtemp(prefix="tree-probe-json-"))
    pairs = []
    for src in json_sources():
        rel = str(src.relative_to(ROOT))
        doc = json_cst.tree_doc(src.read_bytes(), "json", rel)
        probe = out_dir / f"json__{src.stem}.tree.json"
        probe.write_text(json_cst.dumps(doc))
        committed = TREES / f"json__{src.stem}.tree.json"
        if not committed.is_file():
            raise Failed(f"no committed tree {committed.name}")
        got, want = probe.read_text(), committed.read_text()
        if got != want:
            raise Failed(
                f"tree {src.name} is not byte-identical to {committed.name}: "
                f"{first_diff(got, want)}"
            )
        print(f"  tree  {src.name}: byte-identical to {committed.name}")
        pairs.append((src.stem, probe, committed))
    return pairs


def probe_json_format(pairs: list[tuple[str, Path, Path]]) -> None:
    for stem, probe, committed in pairs:
        for width in WIDTHS:
            tag = f"{stem}@{width}"
            r_probe = invoke(probe, width)
            j_probe = invoke(probe, width, rust=False)
            r_ts = invoke(committed, width)
            j_ts = invoke(committed, width, rust=False)
            if r_probe != j_probe:
                raise Failed(f"{tag}: rust and js disagree on the probe tree")
            if r_ts != j_ts:
                raise Failed(f"{tag}: rust and js disagree on the committed tree")
            if r_probe != r_ts:
                raise Failed(
                    f"{tag}: probe output != tree-sitter path: "
                    f"{first_diff(r_probe, r_ts)}"
                )
            print(f"  fmt   {tag}: rust=js=committed ({len(r_probe)} bytes)")


def strip_fields(node: dict) -> dict:
    out = {k: v for k, v in node.items() if k != "field"}
    if "children" in out:
        out["children"] = [strip_fields(c) for c in out["children"]]
    return out


def write_tree(dir: Path, name: str, language: str, source: str, root: dict) -> Path:
    path = dir / f"{name}.tree.json"
    path.write_text(
        json.dumps({"language": language, "source": source, "root": root})
    )
    return path


def write_pkg(dir: Path, name: str, pkg: dict) -> None:
    (dir / f"{name}.json").write_text(json.dumps(pkg))


def experiment_no_fields() -> None:
    """JSON's package selects `f:key`/`f:value`. Drop the fields and it refuses.

    Rewrite those two selectors as `named` and the same tree formats again,
    byte-identical to the field-bearing path. Fields are a package vocabulary,
    not a runtime requirement — except inside `flatten`, tested separately.
    """
    src = SRC / "basic.json"
    doc = json_cst.tree_doc(src.read_bytes(), "json", str(src.relative_to(ROOT)))
    stripped = {**doc, "root": strip_fields(doc["root"])}

    pkg = json.loads(JSON_PKG.read_text())
    alt = json.loads(JSON_PKG.read_text())
    alt["rules"]["pair"] = [
        "seq",
        ["child", "named"],
        ["tok", ":"],
        ["sp"],
        ["child", "named"],
    ]

    with tempfile.TemporaryDirectory(prefix="tree-probe-fields-") as tmp:
        tmp_path = Path(tmp)
        bare = write_tree(tmp_path, "bare", "json", stripped["source"], stripped["root"])
        pkgs = tmp_path / "pkgs"
        pkgs.mkdir()
        write_pkg(pkgs, "json", pkg)
        why = refuse(bare, 88, pkgs)
        if "pair" not in why or "key" not in why:
            raise Failed(f"no-fields refusal did not name the missing field: {why}")
        print(f"  exp   no-fields + original package: refused ({why})")

        write_pkg(pkgs, "json", alt)
        got = invoke(bare, 88, pkgs)
        want = invoke(TREES / "json__basic.tree.json", 88)
        if got != want:
            raise Failed(
                f"named-not-field rewrite diverged from the field-bearing path: "
                f"{first_diff(got, want)}"
            )
        print("  exp   no-fields + named selectors: byte-identical to f:key path")


def _sum_chain(leaves: list[tuple[str, int, int]], ops: list[tuple[int, int]]) -> dict:
    """Left-nested `sum` spine. Each op is (start, end) into the source."""
    node: dict = {
        "type": "name",
        "start": leaves[0][1],
        "end": leaves[0][2],
        "text": leaves[0][0],
    }
    for i, (op_start, op_end) in enumerate(ops):
        left = {**node, "field": "left"}
        right = {
            "type": "name",
            "start": leaves[i + 1][1],
            "end": leaves[i + 1][2],
            "field": "right",
            "text": leaves[i + 1][0],
        }
        operator = {
            "type": "+",
            "start": op_start,
            "end": op_end,
            "field": "operator",
            "text": "+",
        }
        node = {
            "type": "sum",
            "start": left["start"],
            "end": right["end"],
            "children": [left, operator, right],
        }
    return node


def experiment_flatten() -> None:
    """`flatten` walks `field == "left"` / `"right"` / `"operator"`.

    A well-formed left-nested chain with those three names formats. The same
    chain with the fields renamed to `lhs`/`rhs`/`op` is refused, and there
    is no package rewrite that saves it: the names live in the opcode.
    """
    source = "aaa + bbb + ccc"
    # aaa(0-3) +(4-5) bbb(6-9) +(10-11) ccc(12-15)
    root = _sum_chain(
        [("aaa", 0, 3), ("bbb", 6, 9), ("ccc", 12, 15)],
        [(4, 5), (10, 11)],
    )
    pkg = {
        "format": "et-doc-rules/1",
        "indent": 2,
        "tokens": ["+"],
        "comments": [],
        "descend": [],
        "optional_parens": [],
        "precedence": {"+": 5, "*": 4},
        "rules": {
            "sum": [
                "group",
                [
                    "flatten",
                    "sum",
                    ["seq", ["line"], ["child", "f:operator"], ["sp"]],
                ],
            ]
        },
    }
    with tempfile.TemporaryDirectory(prefix="tree-probe-flat-") as tmp:
        tmp_path = Path(tmp)
        pkgs = tmp_path / "pkgs"
        pkgs.mkdir()
        write_pkg(pkgs, "toy", pkg)
        tree = write_tree(tmp_path, "chain", "toy", source, root)
        r_out = invoke(tree, 80, pkgs)
        j_out = invoke(tree, 80, pkgs, rust=False)
        if r_out != j_out:
            raise Failed("flatten: rust and js disagree on the well-named chain")
        if r_out != "aaa + bbb + ccc\n":
            raise Failed(f"flatten: unexpected flat output {r_out!r}")
        broken = invoke(tree, 4, pkgs)
        if broken != "aaa\n+ bbb\n+ ccc\n":
            raise Failed(f"flatten: unexpected broken output {broken!r}")
        print("  exp   flatten with left/right/operator: rust=js at 80 and 4")

        def rename(node: dict) -> dict:
            mapping = {"left": "lhs", "right": "rhs", "operator": "op"}
            out = dict(node)
            if out.get("field") in mapping:
                out["field"] = mapping[out["field"]]
            if "children" in out:
                out["children"] = [rename(c) for c in out["children"]]
            return out

        alt_tree = write_tree(tmp_path, "renamed", "toy", source, rename(root))
        why = refuse(alt_tree, 80, pkgs)
        if "left" not in why:
            raise Failed(f"flatten rename refused for the wrong reason: {why}")
        print(f"  exp   flatten with lhs/rhs/op: refused ({why})")


def experiment_comments() -> None:
    """Comments must arrive as ordinary children, in source order.

    A `# c` sitting between two names, listed in `comments`, is attached and
    printed. The same source with the comment omitted from the tree loses it
    — the runtime has no other channel.
    """
    source = "aaa\n# c\nbbb\n"
    pkg = {
        "format": "et-doc-rules/1",
        "indent": 2,
        "tokens": [],
        "comments": ["comment"],
        "descend": [],
        "optional_parens": [],
        "precedence": {},
        "rules": {
            "file": ["each", "named", ["hard"]],
        },
    }
    with_comment = {
        "type": "file",
        "start": 0,
        "end": 12,
        "children": [
            {"type": "name", "start": 0, "end": 3, "text": "aaa"},
            {"type": "comment", "start": 4, "end": 7, "text": "# c"},
            {"type": "name", "start": 8, "end": 11, "text": "bbb"},
        ],
    }
    without = {
        "type": "file",
        "start": 0,
        "end": 12,
        "children": [
            {"type": "name", "start": 0, "end": 3, "text": "aaa"},
            {"type": "name", "start": 8, "end": 11, "text": "bbb"},
        ],
    }
    with tempfile.TemporaryDirectory(prefix="tree-probe-cmt-") as tmp:
        tmp_path = Path(tmp)
        pkgs = tmp_path / "pkgs"
        pkgs.mkdir()
        write_pkg(pkgs, "toy", pkg)
        kept = invoke(write_tree(tmp_path, "kept", "toy", source, with_comment), 80, pkgs)
        lost = invoke(write_tree(tmp_path, "lost", "toy", source, without), 80, pkgs)
        if "# c" not in kept:
            raise Failed(f"comment child was not printed: {kept!r}")
        if kept != "aaa\n# c\nbbb\n":
            raise Failed(f"comment attachment printed {kept!r}")
        if "# c" in lost:
            raise Failed("a tree with no comment child still printed one")
        if lost != "aaa\nbbb\n":
            raise Failed(f"comment-less tree printed {lost!r}")
        print("  exp   comment as a child: attached and printed")
        print("  exp   same source, comment omitted from the tree: lost")


def experiment_whitespace_child() -> None:
    """A whitespace child is an unconsumed item. Gaps must stay gaps."""
    source = "{ }"
    root = {
        "type": "object",
        "start": 0,
        "end": 3,
        "children": [
            {"type": "{", "start": 0, "end": 1, "text": "{"},
            {"type": "ws", "start": 1, "end": 2, "text": " "},
            {"type": "}", "start": 2, "end": 3, "text": "}"},
        ],
    }
    with tempfile.TemporaryDirectory(prefix="tree-probe-ws-") as tmp:
        tmp_path = Path(tmp)
        tree = write_tree(tmp_path, "ws", "json", source, root)
        why = refuse(tree, 88)
        if "unconsumed" not in why and "ws" not in why:
            raise Failed(f"whitespace child refused for the wrong reason: {why}")
        print(f"  exp   whitespace child: refused ({why})")


def experiment_gaps_are_fine() -> None:
    """Children do not have to tile the parent. JSON already proves this
    (whitespace lives in the gaps), and so does `verbatim`: the string
    `\"hi\"` with only the quotes as children still emits the slice."""
    source = '"hi"'
    pkg = {
        "format": "et-doc-rules/1",
        "indent": 2,
        "tokens": ['"'],
        "comments": [],
        "descend": [],
        "optional_parens": [],
        "precedence": {},
        "rules": {"quote": ["verbatim"]},
    }
    # Quotes only; the two letters sit in the gap. verbatim still emits "hi".
    root = {
        "type": "quote",
        "start": 0,
        "end": 4,
        "children": [
            {"type": '"', "start": 0, "end": 1, "text": '"'},
            {"type": '"', "start": 3, "end": 4, "text": '"'},
        ],
    }
    with tempfile.TemporaryDirectory(prefix="tree-probe-gap-") as tmp:
        tmp_path = Path(tmp)
        pkgs = tmp_path / "pkgs"
        pkgs.mkdir()
        write_pkg(pkgs, "toy", pkg)
        tree = write_tree(tmp_path, "gap", "toy", source, root)
        got = invoke(tree, 80, pkgs)
        if got != '"hi"\n':
            raise Failed(f"verbatim with a gap emitted {got!r}")
        print("  exp   verbatim with a hole between children: emits the parent slice")


def main() -> int:
    if not RUST_BIN.is_file():
        raise Failed("rust/target/release/docfmt is missing; run ./build.sh first")

    print("JSON corpus (hand-rolled parser vs committed tree-sitter trees)")
    pairs = probe_json_trees()
    probe_json_format(pairs)

    print("\nWhat the JSON corpus cannot ask")
    experiment_no_fields()
    experiment_flatten()
    experiment_comments()
    experiment_whitespace_child()
    experiment_gaps_are_fine()

    print("\nall probes held")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Failed as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
