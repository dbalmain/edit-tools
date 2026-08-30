#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check the recovered lex DFA against the real `ts_lex`, exhaustively.

    ./harness/ts_verify_lex.py <path/to/parser.c> <blob.json>

`harness/ts_verify_blob.py` compares every static table against compiled memory.
The lex DFA has no static array to compare against -- it is recovered from
generated *code*, which is the one genuinely novel step in route C3 and the one
with no oracle. This is that oracle.

Method. `ts_lex` observes the world through exactly three operations:
`lexer->lookahead`, `lexer->eof(lexer)`, and calls to `advance` / `mark_end`
(`docs/parse-survey.md` §3g). So a fake lexer over a fixed codepoint sequence
sees its complete behaviour, and the same fake lexer driving `Lexer.run` -- the
real interpreter, not a paraphrase -- sees the recovered DFA's.

Coverage. The codepoints are every interval boundary the recovered DFA contains,
each with its neighbours, which is the **partition of int32 that the DFA
induces**: two codepoints inside one cell cannot be told apart by any guard in
any state, so one representative per cell is exhaustive rather than sampled.
Every lex state is run against every representative, at EOF and not, with two
different following characters.

What it cannot see: a guard the transcoder dropped entirely would remove its own
boundaries from the partition. That is why `ts_transcode.py` raises on
unrecognised syntax instead of skipping, and why the op totals are cross-checked
against `docs/parse-survey.md` §3's independent count.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HARNESS = Path(__file__).resolve().parent
INT32_MIN, INT32_MAX = -(2**31), 2**31 - 1


def boundaries(states: list[dict]) -> set[int]:
    """Every value any guard in any state can distinguish."""
    out: set[int] = {0}
    for state in states:
        for op in state["o"]:
            if op[0] == 1:  # ADVANCE_MAP
                out.update(op[1][0::2])
            elif op[0] == 2:  # guarded action
                out.update(op[2])
            elif op[0] == 4:  # eof-split guard
                out.update(op[1])
                out.update(op[2])
    return out


def representatives(states: list[dict]) -> list[int]:
    reps: set[int] = set()
    for b in boundaries(states):
        for v in (b - 1, b, b + 1):
            if INT32_MIN <= v <= INT32_MAX:
                reps.add(v)
    return sorted(reps)


def compile_probe(parser_c: Path, tmp: Path, has_keyword_lex: bool) -> Path:
    include = parser_c.parent
    if not (include / "tree_sitter" / "parser.h").is_file():
        raise SystemExit(
            f"{include}/tree_sitter/parser.h is missing; take it from the "
            f"grammar's git tag (docs/parse-survey.md §1)"
        )
    binary = tmp / "probe"
    build = subprocess.run(
        [
            "cc", "-O0", "-w", "-I", str(include),
            f"-DTS_PARSER_C=\"{parser_c}\"",
            *(["-DTS_HAS_KEYWORD_LEX=1"] if has_keyword_lex else []),
            str(HARNESS / "ts_probe_lex.c"), "-o", str(binary),
        ],
        capture_output=True, text=True,
    )
    if build.returncode != 0:
        raise SystemExit(f"compile failed:\n{build.stderr[-3000:]}")
    return binary


def hashes(cmd: list[str], stdin_text: str) -> dict[int, int]:
    run = subprocess.run(cmd, input=stdin_text, capture_output=True, text=True)
    if run.returncode != 0:
        raise SystemExit(f"{cmd[0]} failed:\n{run.stderr[-3000:]}")
    out = {}
    for line in run.stdout.split("\n"):
        if not line.strip():
            continue
        state, value = line.split()
        out[int(state)] = int(value)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("parser_c", type=Path)
    ap.add_argument("blob", type=Path)
    args = ap.parse_args()

    blob = json.loads(args.blob.read_text())
    failures = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        binary = compile_probe(
            args.parser_c, Path(tmpdir), bool(blob.get("keywordLex"))
        )
        for which, fn_name in (("lex", "ts_lex"), ("keywordLex", "ts_lex_keywords")):
            states = blob.get(which)
            if not states:
                continue
            reps = representatives(states)
            stdin_text = "\n".join(str(v) for v in reps) + "\n"
            want = hashes([str(binary), str(len(states)), fn_name], stdin_text)
            got = hashes(
                ["node", str(HARNESS / "ts_probe_lex.mjs"), str(args.blob), which],
                stdin_text,
            )
            bad = sorted(s for s in want if want[s] != got.get(s))
            runs = len(states) * (1 + 3 * len(reps))
            print(
                f"{fn_name}: {len(states)} states x {len(reps)} codepoint classes "
                f"= {runs:,} runs, {len(bad)} disagree"
            )
            for s in bad[:10]:
                print(f"  state {s}: C {want[s]}, recovered {got.get(s)}", file=sys.stderr)
            failures += len(bad)
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
