#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Verify a transcoded blob against the same `parser.c`, compiled.

    ./harness/ts_verify_blob.py <path/to/parser.c> <blob.json> [--keep]

Compiles `harness/ts_dump_tables.c` with `parser.c` in the same translation
unit, so every `static` array is visible and `sizeof` gives its true length,
then compares **every entry** of every table against the blob.

This is the answer to the mutation sweep's ceiling. That sweep can only reach
entries some corpus file exercises -- 44% of the JSON blob, 27% of the Go one --
and leaves the rest untested rather than known-good. The compiler has no such
blind spot, so this turns an input-generation problem into an equality check:
7 tables plus the parse actions, entry for entry, including every entry no
source could reach.

It also checks the four array lengths the transcoder has to *derive* rather than
read (`parse_actions`, `small_parse_table`, `field_map_entries`,
`alias_map`). Those are the ones a wrong bound would silently truncate, and
`harness/ts_transcode.py` currently derives them from the initializer text and
cross-checks them against `wasm_store.c`'s formulas -- which is a good proxy and
not the thing itself.

Requires a C compiler and the grammar's own `src/tree_sitter/parser.h`. Five
sdists ship that header; for the rest, take it from the grammar's git tag (see
`docs/parse-survey.md` §1).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HARNESS = Path(__file__).resolve().parent

SCALARS = [
    "abi", "symbolCount", "aliasCount", "tokenCount", "stateCount",
    "largeStateCount", "productionIdCount", "fieldCount",
    "maxAliasSequenceLength", "maxReservedWordSetSize",
]

ARRAYS = [
    "symbolNames", "symbolMetadata", "publicSymbolMap", "fieldNames",
    "fieldMapSlices", "fieldMapEntries", "aliasSequences", "aliasMap",
    "parseTable", "smallParseTable", "smallParseTableMap",
    "lexStates", "externalLexStates", "reservedWordSetIds", "reservedWords",
]

DERIVED_LENGTHS = {
    "len_smallParseTable": "smallParseTable",
    "len_smallParseTableMap": "smallParseTableMap",
    "len_aliasMap": "aliasMap",
}


def dump(parser_c: Path, keep: bool) -> dict:
    include = parser_c.parent
    if not (include / "tree_sitter" / "parser.h").is_file():
        raise SystemExit(
            f"{include}/tree_sitter/parser.h is missing; take it from the "
            f"grammar's git tag (docs/parse-survey.md §1)"
        )
    with tempfile.TemporaryDirectory() as tmp:
        binary = Path(tmp) / "dump"
        cmd = [
            "cc", "-O0", "-w",
            "-I", str(include),
            f"-DTS_PARSER_C=\"{parser_c}\"",
            str(HARNESS / "ts_dump_tables.c"),
            "-o", str(binary),
        ]
        build = subprocess.run(cmd, capture_output=True, text=True)
        if build.returncode != 0:
            raise SystemExit(f"compile failed:\n{build.stderr[-3000:]}")
        run = subprocess.run([str(binary)], capture_output=True, text=True)
        if run.returncode != 0:
            raise SystemExit(f"dump failed:\n{run.stderr[-3000:]}")
        if keep:
            out = Path.cwd() / f"{parser_c.parent.parent.name}.tables.json"
            out.write_text(run.stdout)
            print(f"wrote {out}", file=sys.stderr)
        return json.loads(run.stdout)


def first_diff(name: str, want: list, got: list) -> str:
    if len(want) != len(got):
        head = f"{name}: length {len(got)}, compiled says {len(want)}"
        for i, (a, b) in enumerate(zip(want, got)):
            if a != b:
                return f"{head}; first value differs at {i}: {b!r} vs {a!r}"
        return head
    for i, (a, b) in enumerate(zip(want, got)):
        if a != b:
            return f"{name}[{i}]: blob {b!r}, compiled {a!r}"
    return f"{name}: equal"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("parser_c", type=Path)
    ap.add_argument("blob", type=Path)
    ap.add_argument("--keep", action="store_true", help="save the raw dump")
    args = ap.parse_args()

    truth = dump(args.parser_c, args.keep)
    blob = json.loads(args.blob.read_text())

    failures: list[str] = []
    checked = 0

    for key in SCALARS:
        if truth.get(key) != blob.get(key):
            failures.append(f"{key}: blob {blob.get(key)!r}, compiled {truth.get(key)!r}")
        checked += 1

    for key in ARRAYS:
        want, got = truth.get(key, []), blob.get(key) or []
        # Python None vs the C dump's JSON null already agree after json.loads.
        if want != got:
            failures.append(first_diff(key, want, got))
        checked += len(want)

    for length_key, array_key in DERIVED_LENGTHS.items():
        want = truth[length_key]
        got = len(blob.get(array_key) or [])
        if want != got:
            failures.append(
                f"{array_key}: transcoder derived length {got}, compiled says {want}"
            )
        checked += 1

    # field_map_entries is three ints per entry in the blob.
    want_entries = truth["len_fieldMapEntries"]
    got_entries = len(blob["fieldMapEntries"]) // 3
    if want_entries != got_entries:
        failures.append(
            f"fieldMapEntries: transcoder derived {got_entries} entries, "
            f"compiled says {want_entries}"
        )
    checked += 1

    # Parse actions: the C dump emits (index, count, reusable, actions) for
    # every header slot, walking the union exactly as ts_language_table_entry
    # does. Only header slots are addressable from the parse table.
    for index, count, reusable, actions in truth["parseActions"]:
        entry = blob["parseActions"][index] if index < len(blob["parseActions"]) else None
        if entry is None:
            failures.append(f"parseActions[{index}]: missing from blob")
        elif entry["c"] != count or entry["r"] != reusable or entry["a"] != actions:
            failures.append(
                f"parseActions[{index}]: blob "
                f"{{c:{entry['c']},r:{entry['r']},a:{entry['a']}}}, compiled "
                f"{{c:{count},r:{reusable},a:{actions}}}"
            )
        checked += 1 + count

    print(f"{checked} table entries compared against compiled memory")
    if failures:
        print(f"\n{len(failures)} MISMATCHES", file=sys.stderr)
        for f in failures[:20]:
            print(f"  {f}", file=sys.stderr)
        if len(failures) > 20:
            print(f"  ... and {len(failures) - 20} more", file=sys.stderr)
        return 1
    print("every entry agrees")
    return 0


if __name__ == "__main__":
    sys.exit(main())
