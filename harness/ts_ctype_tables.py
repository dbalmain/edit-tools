#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pin `<wctype.h>` classification as data, so a scanner port cannot inherit a host.

    ./harness/ts_ctype_tables.py [--check] [--locale NAME] [--out FILE]

Nine of the twelve external scanners still to be ported classify characters
with `iswspace`, `iswalnum`, `iswalpha` and friends. Those functions are a
property of the **host process**, not of the grammar -- the finding in
`docs/host-ctype-divergence.md`, where one pinned tree-sitter-css produces three
different trees on three hosts because they disagree about whether U+2003 is
whitespace.

A port that calls its host's `isw*` inherits that divergence into both runtimes,
differently. A port that carries the answer as an interval table does not, and
this generates the table. It is the same shape `ts_transcode.py` already uses
for recovered lexer charsets: inclusive `[lo, hi, lo, hi, ...]` over code
points.

## Which host is authoritative, and why the answer is safe

`gen_trees.pin_ctype` freezes the corpus under the first available of
`C.UTF-8`, `en_US.UTF-8`, `en_AU.UTF-8`, so glibc-under-UTF-8 is the answer the
committed trees encode. That fallback list has always been a small unstated
assumption -- three locales, one corpus, and nothing checking they agree.

**They do agree**: all three resolve to byte-identical tables for all twelve
classes. So the corpus does not depend on which of them a machine happens to
have, and `--check` re-establishes that rather than assuming it.

## The domain stops at U+10FFFF

tree-sitter's `lookahead` is an int32 that is 0 at EOF and -1 on a UTF-8 decode
error. Neither is a character, glibc's answer for them is not something a port
should reproduce, and both are the VM's business rather than the table's.

## The size, which is a real design input

`space` is 8 ranges and 65 bytes gzipped. `alnum` is **802 ranges and 3,492
bytes gzipped** -- against a 6.3 KB interpreter, that is not a rounding error.
Nine scanners want it, so if the tables are embedded per blob they cost roughly
31 KB gz across the language set, and if they are hoisted into the runtime and
shared they cost one copy. That choice belongs with the scanner-production
decision, not to whoever ports the first scanner.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(__file__).resolve().parent / "ctype" / "dump_ctype.c"
DEFAULT_OUT = Path(__file__).resolve().parent / "ctype" / "wctype.utf8.json"

# gen_trees.pin_ctype's fallback list, in its order. The first that resolves is
# authoritative; the rest are checked to agree with it.
LOCALES = ("C.UTF-8", "en_US.UTF-8", "en_AU.UTF-8")

# From docs/host-ctype-divergence.md's measured table. Each row discriminates:
# the C locale answers False for U+2003 and U+3000, and musl/emscripten answers
# True for U+00A0. A table matching all four came from the right host.
CONTROLS = (
    ("space", 0x0020, True, "ASCII space -- the positive control"),
    ("space", 0x2003, True, "EM SPACE -- False under the C locale"),
    ("space", 0x3000, True, "IDEOGRAPHIC SPACE -- False under the C locale"),
    ("space", 0x00A0, False, "NO-BREAK SPACE -- True under musl/emscripten"),
)


class CtypeError(Exception):
    """The tables could not be generated, or disagree with what they must be."""


def dump(locale: str, binary: Path) -> dict:
    done = subprocess.run([str(binary), locale], capture_output=True, text=True)
    if done.returncode != 0:
        raise CtypeError(done.stderr.strip() or f"{locale}: dump failed")
    return json.loads(done.stdout)


def generate() -> dict:
    """The authoritative tables, having checked every available UTF-8 locale agrees."""
    compiler = shutil.which(os.environ.get("CC", "cc")) or shutil.which("cc")
    if compiler is None:
        raise CtypeError("no C compiler; these tables are glibc's answer, not Python's")
    with tempfile.TemporaryDirectory() as tmp:
        binary = Path(tmp) / "dump_ctype"
        build = subprocess.run(
            [compiler, "-O2", "-o", str(binary), str(SOURCE)],
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            raise CtypeError(f"compiling dump_ctype failed\n{build.stderr.strip()}")

        primary, agreed, missing = None, [], []
        for locale in LOCALES:
            try:
                result = dump(locale, binary)
            except CtypeError:
                missing.append(locale)
                continue
            if primary is None:
                primary = result
            elif result["classes"] != primary["classes"]:
                differ = sorted(
                    k for k in primary["classes"]
                    if primary["classes"][k] != result["classes"][k]
                )
                raise CtypeError(
                    f"{locale} disagrees with {primary['locale']} on {', '.join(differ)}; "
                    "the frozen corpus depends on which locale generated it"
                )
            else:
                agreed.append(locale)

    if primary is None:
        raise CtypeError(
            f"none of {', '.join(LOCALES)} is available; character classification "
            "in grammar scanners is locale-dependent, so these tables would not "
            "be the committed ones"
        )
    return {
        "note": (
            "Generated by harness/ts_ctype_tables.py -- do not edit. glibc's "
            "<wctype.h> classification under UTF-8, which is what gen_trees.py "
            "freezes the corpus with. Inclusive [lo, hi, ...] over code points."
        ),
        "authority": primary["resolved"],
        "agreed": agreed,
        "unavailable": missing,
        "classes": primary["classes"],
    }


def controls(classes: dict) -> list[str]:
    """Every documented measurement these tables fail to reproduce."""
    problems = []
    for name, cp, expected, why in CONTROLS:
        ranges = classes[name]
        got = any(ranges[i] <= cp <= ranges[i + 1] for i in range(0, len(ranges), 2))
        if got != expected:
            problems.append(f"{name}(U+{cp:04X}) is {got}, expected {expected} -- {why}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify, write nothing")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    try:
        tables = generate()
    except CtypeError as e:
        print(f"ts_ctype_tables: {e}", file=sys.stderr)
        return 1

    if problems := controls(tables["classes"]):
        for p in problems:
            print(f"ts_ctype_tables: {p}", file=sys.stderr)
        return 1

    text = json.dumps(tables, indent=1) + "\n"
    if args.check:
        if not args.out.is_file():
            print(f"ts_ctype_tables: {args.out} does not exist", file=sys.stderr)
            return 1
        if args.out.read_text(encoding="utf-8") != text:
            print(f"ts_ctype_tables: {args.out} is stale", file=sys.stderr)
            return 1
        print(f"{args.out.relative_to(ROOT)} up to date ({tables['authority']}, "
              f"{len(tables['agreed']) + 1} locales agree)")
        return 0

    args.out.write_text(text, encoding="utf-8")
    sizes = ", ".join(
        f"{k} {len(v) // 2}" for k, v in sorted(tables["classes"].items())
    )
    print(f"wrote {args.out.relative_to(ROOT)} from {tables['authority']}")
    print(f"  ranges per class: {sizes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
