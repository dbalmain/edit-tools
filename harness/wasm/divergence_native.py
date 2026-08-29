#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Native half of the native-vs-wasm divergence experiment.

    harness/wasm/divergence_native.py <workdir>

Reads `<workdir>/cases.json`, parses every case with the pinned grammar wheels
through py-tree-sitter, and writes `<workdir>/native.json`. The wasm half
(`divergence_wasm.js`) does the same and then compares.

The shape dumped here is deliberately RICHER than gen_trees.py's. convert()
records type, offsets and field, which is everything a formatter package reads
and is the right contract for the corpus. It is not enough to settle a
divergence question on broken input: a MISSING node has zero width and the same
`type` as a real one, so two trees can agree on every field convert() emits and
still be different trees. So `named`, `missing`, `extra` and `error` come along,
and the comparison is over all of them.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent


def dump(node) -> dict:
    out = {
        "type": node.type,
        "start": node.start_byte,
        "end": node.end_byte,
        "named": node.is_named,
        "missing": node.is_missing,
        "extra": node.is_extra,
        "error": node.type == "ERROR",
    }
    kids = []
    for i, child in enumerate(node.children):
        entry = dump(child)
        field = node.field_name_for_child(i)
        if field is not None:
            entry["field"] = field
        kids.append(entry)
    if kids:
        out["children"] = kids
    return out


def counts(node) -> dict:
    """Node totals, so a report can say how broken a mutant actually got."""
    total = err = missing = 0
    stack = [node]
    while stack:
        n = stack.pop()
        total += 1
        err += n.type == "ERROR"
        missing += n.is_missing
        stack.extend(n.children)
    return {"nodes": total, "errors": err, "missing": missing}


def char_to_byte(text: str, char_index: int) -> int:
    return len(text[:char_index].encode("utf-8"))


def point_for(text: str, char_index: int) -> tuple[int, int]:
    prefix = text[:char_index]
    row = prefix.count("\n")
    line = prefix.rsplit("\n", 1)[-1]
    return row, len(line.encode("utf-8"))


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: divergence_native.py <workdir>", file=sys.stderr)
        return 2
    work = Path(sys.argv[1]).resolve()
    spec = json.loads((work / "cases.json").read_text())

    known = mf.bootstrap()
    parsers = mf.parsers(known)

    out_cases = {}
    for case in spec["cases"]:
        source = (work / case["file"]).read_bytes()
        tree = parsers[case["language"]].parse(source)
        out_cases[case["id"]] = {
            "root": dump(tree.root_node),
            "counts": counts(tree.root_node),
        }

    out_edits = {}
    for edit in spec["edits"]:
        text = (work / edit["file"]).read_text()
        at = edit["insert_at_char"]
        new_text = text[:at] + " " + text[at:]

        old_bytes = text.encode("utf-8")
        new_bytes = new_text.encode("utf-8")
        start_byte = char_to_byte(text, at)
        row, col = point_for(text, at)

        parser = parsers[edit["language"]]
        old_tree = parser.parse(old_bytes)
        old_tree.edit(
            start_byte=start_byte,
            old_end_byte=start_byte,
            new_end_byte=start_byte + 1,
            start_point=(row, col),
            old_end_point=(row, col),
            new_end_point=(row, col + 1),
        )
        incremental = parser.parse(new_bytes, old_tree)
        fresh = parser.parse(new_bytes)
        out_edits[edit["id"]] = {
            "incremental": dump(incremental.root_node),
            "fresh": dump(fresh.root_node),
            "counts": counts(fresh.root_node),
        }

    versions = {
        name: known[name].grammar for name in sorted(known)
    }
    import importlib.metadata as md

    (work / "native.json").write_text(
        json.dumps(
            {
                "runtime": f"py-tree-sitter {md.version('tree-sitter')}",
                "grammars": versions,
                "cases": out_cases,
                "edits": out_edits,
            }
        )
        + "\n"
    )
    print(f"native: {len(out_cases)} cases, {len(out_edits)} edit cases")
    return 0


if __name__ == "__main__":
    mf.cli(main)
