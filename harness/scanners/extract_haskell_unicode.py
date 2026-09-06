#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Turn tree-sitter-haskell's generated `unicode.h` bitmaps into VM class tables.

    ./harness/scanners/extract_haskell_unicode.py [--check] [--out FILE]

`.grammars/haskell/src/unicode.h` is 20 generated codepoint bitmaps behind 24
`is_*_char` predicates. Five of those are the top-level ones the scanner
actually calls (`is_identifier_char`, `is_varid_start_char`,
`is_conid_start_char`, `is_symop_char`, `is_space_char`); the other 19 are
range-split sub-predicates the top-level ones dispatch to. That is data, not
logic, and the VM's `classes` are exactly this shape -- sorted inclusive int32
intervals -- so this converts the bitmaps mechanically rather than linking
against the header or transcribing it.

The unit is the five top-level predicates, each flattened into one class.
Runtime `or`-chains of the numbered sub-predicates would be equivalent and
strictly larger. Scanner.c never calls a numbered sub-predicate.

`--check` re-parses the header, rebuilds the tables, and diffs them against
`--out` (or the committed default). It also walks every bit of every bitmap
and asserts interval membership agrees, so a parser bug cannot silently emit
a plausible-looking but wrong table.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_SRC = ROOT / ".grammars" / "haskell" / "src" / "unicode.h"
DEFAULT_OUT = Path(__file__).resolve().parent / "haskell_unicode.json"

# Top-level predicate -> the numbered bitmaps it dispatches across, in the
# order unicode.h tests them. `space` has no numbered split.
TOP_LEVEL = {
    "identifier": [f"identifier_{i}" for i in range(1, 6)],
    "varid_start": [f"varid_start_{i}" for i in range(1, 5)],
    "conid_start": [f"conid_start_{i}" for i in range(1, 6)],
    "symop": [f"symop_{i}" for i in range(1, 6)],
    "space": ["space"],
}

BITMAP_RE = re.compile(
    r"static uint8_t bitmap_([A-Za-z0-9_]+)\[\] = \{([^}]*)\}",
    re.S,
)
MIN_RE = re.compile(
    r"static int32_t bitmap_([A-Za-z0-9_]+)_min_codepoint = (-?\d+);"
)
MAX_RE = re.compile(
    r"static int32_t bitmap_([A-Za-z0-9_]+)_max_codepoint = (-?\d+);"
)
PRED_RE = re.compile(r"static bool is_([A-Za-z0-9_]+)_char\(int32_t c\)")


def parse_bytes(body: str) -> list[int]:
    out = []
    for tok in body.replace("\n", " ").split(","):
        tok = tok.strip()
        if not tok:
            continue
        out.append(int(tok, 0))
    return out


def bits_to_intervals(bitmap: list[int], lo: int, hi: int) -> list[int]:
    """Inclusive [lo, hi, lo, hi, ...] over set bits in `lo..=hi`."""
    intervals: list[int] = []
    start: int | None = None
    for c in range(lo, hi + 1):
        offset = c - lo
        byte_i = offset >> 3
        on = byte_i < len(bitmap) and (bitmap[byte_i] & (1 << (offset & 7))) != 0
        if on:
            if start is None:
                start = c
        elif start is not None:
            intervals.extend([start, c - 1])
            start = None
    if start is not None:
        intervals.extend([start, hi])
    return intervals


def merge_intervals(*lists: list[int]) -> list[int]:
    pairs: list[tuple[int, int]] = []
    for lst in lists:
        for i in range(0, len(lst), 2):
            pairs.append((lst[i], lst[i + 1]))
    pairs.sort()
    out: list[int] = []
    for lo, hi in pairs:
        if out and lo <= out[-1] + 1:
            if hi > out[-1]:
                out[-1] = hi
        else:
            out.extend([lo, hi])
    return out


def in_intervals(intervals: list[int], c: int) -> bool:
    # Same binary search the VM uses.
    lo, hi = 0, (len(intervals) >> 1) - 1
    while lo <= hi:
        mid = (lo + hi) >> 1
        a, b = intervals[mid * 2], intervals[mid * 2 + 1]
        if c < a:
            hi = mid - 1
        elif c > b:
            lo = mid + 1
        else:
            return True
    return False


def extract(src: Path) -> dict:
    text = src.read_text()
    bitmaps = {m.group(1): parse_bytes(m.group(2)) for m in BITMAP_RE.finditer(text)}
    mins = {m.group(1): int(m.group(2)) for m in MIN_RE.finditer(text)}
    maxs = {m.group(1): int(m.group(2)) for m in MAX_RE.finditer(text)}
    preds = PRED_RE.findall(text)

    if bitmaps.keys() != mins.keys() or bitmaps.keys() != maxs.keys():
        raise SystemExit(
            f"bitmap/min/max name mismatch: "
            f"bitmaps={sorted(bitmaps)} mins={sorted(mins)} maxs={sorted(maxs)}"
        )

    leaves: dict[str, list[int]] = {}
    for name, bitmap in bitmaps.items():
        lo, hi = mins[name], maxs[name]
        expected = ((hi - lo) >> 3) + 1
        if len(bitmap) != expected:
            raise SystemExit(
                f"bitmap_{name}: {len(bitmap)} bytes, expected {expected} "
                f"for [{lo}, {hi}]"
            )
        leaves[name] = bits_to_intervals(bitmap, lo, hi)

    classes: dict[str, list[int]] = {}
    for top, parts in TOP_LEVEL.items():
        missing = [p for p in parts if p not in leaves]
        if missing:
            raise SystemExit(f"{top}: missing bitmaps {missing}")
        classes[top] = merge_intervals(*(leaves[p] for p in parts))

    # Walk every bit of every bitmap against the flattened class it belongs to.
    owner = {part: top for top, parts in TOP_LEVEL.items() for part in parts}
    for name, bitmap in bitmaps.items():
        lo, hi = mins[name], maxs[name]
        intervals = classes[owner[name]]
        for c in range(lo, hi + 1):
            offset = c - lo
            on = (bitmap[offset >> 3] & (1 << (offset & 7))) != 0
            if on != in_intervals(intervals, c):
                raise SystemExit(
                    f"membership mismatch: U+{c:04X} bit={on} "
                    f"class={owner[name]}"
                )

    return {
        "note": (
            "Generated by harness/scanners/extract_haskell_unicode.py -- do not edit. "
            "Flattened top-level predicates from tree-sitter-haskell's unicode.h; "
            "sorted inclusive [lo, hi, ...] over code points."
        ),
        "source": "tree-sitter-haskell src/unicode.h",
        "bitmaps": len(bitmaps),
        "predicates": len(preds),
        "counts": {k: len(v) >> 1 for k, v in classes.items()},
        "classes": classes,
    }


def dump(data: dict) -> str:
    # One class per line so a 3k-interval table is still grep-able, without
    # the one-number-per-line blowup of indent=2.
    counts = json.dumps(data["counts"], separators=(", ", ": "))
    lines = [
        "{",
        f" {json.dumps('note')}: {json.dumps(data['note'])},",
        f" {json.dumps('source')}: {json.dumps(data['source'])},",
        f" {json.dumps('bitmaps')}: {data['bitmaps']},",
        f" {json.dumps('predicates')}: {data['predicates']},",
        f" {json.dumps('counts')}: {counts},",
        f" {json.dumps('classes')}: {{",
    ]
    names = list(data["classes"])
    for i, name in enumerate(names):
        arr = json.dumps(data["classes"][name], separators=(",", ":"))
        comma = "," if i < len(names) - 1 else ""
        lines.append(f"  {json.dumps(name)}: {arr}{comma}")
    lines.append(" }")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if not args.src.is_file():
        print(f"missing {args.src}: run harness/ts_grammars.py first", file=sys.stderr)
        return 2
    data = extract(args.src)
    text = dump(data)
    n_intervals = sum(data["counts"].values())
    summary = (
        f"{data['bitmaps']} bitmaps, {data['predicates']} predicates, "
        f"{len(data['classes'])} classes, {n_intervals} intervals "
        f"({', '.join(f'{k}={v}' for k, v in data['counts'].items())})"
    )
    if args.check:
        if not args.out.is_file():
            print(f"{args.out} is missing", file=sys.stderr)
            return 1
        if args.out.read_text() != text:
            print(f"{args.out} is stale: regenerate with {Path(__file__).name}", file=sys.stderr)
            return 1
        print(f"{args.out.name} up to date ({summary})")
        return 0
    args.out.write_text(text)
    print(f"wrote {args.out} ({summary})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
