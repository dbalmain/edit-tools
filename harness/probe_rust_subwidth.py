#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""How much of real Rust's layout is decided by a sub-width? (FINDINGS 17)

    ./harness/probe_rust_subwidth.py [--limit N] [--jobs N] [--attribute]

rustfmt carries nine width thresholds, not one: `struct_lit_width = 18`,
`chain_width = 60`, `fn_call_width = 60` and six more, each a fraction of
`max_width`. A construct that fits the line still breaks if it exceeds its
own threshold. Our `group` asks one question — does the flat form fit the
remaining columns — so any file rustfmt laid out that way is unreachable
for us at every width.

`use_small_heuristics = "Max"` raises all nine to `max_width` and changes
nothing else, which turns the question into a subtraction: format each
file twice and see whether the thresholds mattered.

The population is the same trick as `probe_alignment.py`: restrict to
files rustfmt already leaves untouched at its own defaults, so every
difference is real by construction and no expectations are hand-written.
Source tree is `~/.cargo/registry/src/index.crates.io-*`, `/tests/`
skipped, override with `--root`.

`--attribute` is the slower second question: for each file the thresholds
moved, raise one knob at a time and report which ones account for it. A
file can count against more than one knob, so the column does not sum to
the file count.

Recorded results (2026-08-17, rustfmt 1.9.0, seed 20260817): 405 of 905
clean files = 44.8% sub-width decided; attribution over 400 files put
struct_lit_width, chain_width and fn_call_width far ahead of the rest.

Not a gate: needs a rustfmt and a populated cargo registry. Exit 0 even
when files disagree — the headline number is the result. Exit 1 only if
the probe cannot run.
"""

from __future__ import annotations

import argparse
import random
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = [
    "rustfmt",
    "--emit",
    "stdout",
    "--edition",
    "2021",
    "--config-path",
    "/dev/null",
]

# Every width rustfmt derives from max_width, in the order it documents them.
KNOBS = (
    "fn_call_width",
    "attr_fn_like_width",
    "struct_lit_width",
    "struct_variant_width",
    "array_width",
    "chain_width",
    "single_line_if_else_max_width",
    "single_line_let_else_max_width",
    "short_array_element_width_threshold",
)

# Big generated sources (protobuf descriptors, unicode tables) cost seconds
# each and say nothing new; the cutoff keeps a 1200-file run under a minute.
MAX_BYTES = 400_000


def default_root() -> Path | None:
    registry = Path.home() / ".cargo" / "registry" / "src"
    if not registry.is_dir():
        return None
    for child in sorted(registry.iterdir()):
        if child.name.startswith("index.crates.io-"):
            return child
    return None


def rustfmt(src: bytes, config: str) -> bytes | None:
    """Formatted output, or None if rustfmt declined the file."""
    try:
        done = subprocess.run(
            [*BASE, "--config", config], input=src, capture_output=True, timeout=20
        )
    except subprocess.TimeoutExpired:
        return None
    return done.stdout if done.returncode == 0 and done.stdout else None


def readable(path: Path) -> bytes | None:
    try:
        src = path.read_bytes()
    except OSError:
        return None
    return src if src.strip() and len(src) <= MAX_BYTES else None


def classify(path: Path) -> str:
    src = readable(path)
    if src is None:
        return "skipped"
    if (default := rustfmt(src, "max_width=100")) is None:
        return "unparsed"
    if default != src:
        # Not a fixpoint, so a difference would not prove anything.
        return "not-clean"
    wide = rustfmt(src, "max_width=100,use_small_heuristics=Max")
    if wide is None:
        return "unparsed"
    return "sub-width" if wide != src else "max-width-only"


def attribute(path: Path) -> tuple[str, ...]:
    if classify(path) != "sub-width":
        return ()
    src = readable(path)
    assert src is not None  # classify already read it
    return tuple(k for k in KNOBS if rustfmt(src, f"max_width=100,{k}=100") != src)


def sample(root: Path, limit: int) -> list[Path]:
    files = [p for p in root.rglob("*.rs") if "/tests/" not in str(p)]
    random.seed(20260817)
    random.shuffle(files)
    return files[:limit]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=default_root())
    parser.add_argument("--limit", type=int, default=1200)
    parser.add_argument("--jobs", type=int, default=16)
    parser.add_argument(
        "--attribute",
        action="store_true",
        help="also report which individual knobs move the files",
    )
    args = parser.parse_args()

    if args.root is None or not args.root.is_dir():
        print("no cargo registry found; pass --root", file=sys.stderr)
        return 1
    if subprocess.run(["rustfmt", "--version"], capture_output=True).returncode != 0:
        print("rustfmt not on PATH", file=sys.stderr)
        return 1

    files = sample(args.root, args.limit)
    if not files:
        print(f"no .rs files under {args.root}", file=sys.stderr)
        return 1

    work = attribute if args.attribute else classify
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        results = list(pool.map(work, files))

    if args.attribute:
        moved = sum(1 for hits in results if hits)
        tally = {k: sum(1 for hits in results if k in hits) for k in KNOBS}
        print(f"  files a sub-width moved   {moved} / {len(files)} sampled")
        for knob, count in sorted(tally.items(), key=lambda kv: -kv[1]):
            print(f"  {knob:38} {count}")
        return 0

    counts: dict[str, int] = {}
    for verdict in results:
        counts[verdict] = counts.get(verdict, 0) + 1
    for key in sorted(counts):
        print(f"  {key:16} {counts[key]}")

    decided = counts.get("sub-width", 0)
    clean = decided + counts.get("max-width-only", 0)
    if clean:
        print(f"\n  sub-width decided  {decided} / {clean} clean = {100 * decided / clean:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
