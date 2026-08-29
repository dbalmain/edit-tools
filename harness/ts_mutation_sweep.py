#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Measure how much of a transcoded blob the frozen corpus actually exercises.

    ./harness/ts_mutation_sweep.py <blob.json> <language> [--per-table N]

Perturbs one table entry at a time and re-runs `harness/ts_check_trees.mjs`. A
mutation the corpus *catches* is one the acceptance bar would have noticed; a
mutation it *survives* is a table entry those files never reach, so a transcoder
bug there would have produced a green run.

This is not a test of the transcoder. It is a measurement of the oracle. The
frozen corpus is 3 JSON files and 16 Go files, and "byte-identical" means much
less than it sounds like if most of the blob is never touched.

Read the survival rate as a *lower bound* on the bar's strength, not as a claim
that the surviving fraction is silently wrong-able: some survivors are
semantically dead -- unreachable states, actions no valid input can reach, error
entries for symbols that cannot appear in their state. Separating dead from
merely-unexercised needs reachability analysis this does not do.

Originally written by the coordinator against the JSON blob; adopted here,
generalised over languages, and extended to the tables JSON structurally cannot
reach -- fields, aliases, supertypes, reserved words -- which is the whole
reason Go is the more informative subject.

One trap worth keeping: a mutation that does not mutate is indistinguishable in
the results from a mutation the corpus cannot catch. Every mutant is asserted to
differ from the base, and no-ops are counted and reported rather than folded in.
"""

from __future__ import annotations

import argparse
import copy
import json
import random
import subprocess
import sys
from collections import Counter
from pathlib import Path

HARNESS = Path(__file__).resolve().parent


def sites(blob: dict) -> list[tuple[str, object]]:
    """Every entry this sweep knows how to perturb."""
    out: list[tuple[str, object]] = []
    for name in (
        "parseTable",
        "smallParseTable",
        "smallParseTableMap",
        "lexStates",
        "reservedWordSetIds",
        "reservedWords",
        "publicSymbolMap",
        "symbolMetadata",
        "aliasSequences",
        "aliasMap",
        "fieldMapSlices",
        "fieldMapEntries",
        "symbolNames",
    ):
        for i in range(len(blob.get(name) or [])):
            out.append((name, i))
    for i, entry in enumerate(blob["parseActions"]):
        if isinstance(entry, dict):
            for j in range(len(entry["a"])):
                out.append(("parseActions", (i, j)))
    for key in ("lex", "keywordLex"):
        for i, state in enumerate(blob.get(key) or []):
            for j in range(len(state["o"])):
                out.append((key, (i, j)))
    return out


def mutate(blob: dict, kind: str, loc, rnd: random.Random) -> dict:
    m = copy.deepcopy(blob)
    if kind in ("lex", "keywordLex"):
        i, j = loc
        op = m[kind][i]["o"][j]
        n = len(m[kind])
        if op[0] == 0:  # ACCEPT_TOKEN(sym)
            op[1] = (op[1] + 1) % m["symbolCount"]
        elif op[0] == 1:  # ADVANCE_MAP: bend one target
            op[1][1] = (op[1][1] + 1) % n
        elif op[0] == 2:  # guarded action
            op[4] = (op[4] + 1) % n
        elif op[0] == 3:  # unconditional action
            op[2] = (op[2] + 1) % n
        elif op[0] == 4:  # eof-split guard
            op[4] = (op[4] + 1) % n
        else:
            raise SystemExit(f"unknown lex op kind {op[0]}")
    elif kind == "parseActions":
        i, j = loc
        act = m["parseActions"][i]["a"][j]
        act[rnd.randrange(len(act))] += 1
    elif kind == "symbolNames":
        name = m["symbolNames"][loc]
        m["symbolNames"][loc] = ("x" + name) if isinstance(name, str) else "x"
    else:
        m[kind][loc] += 1
    return m


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("blob", type=Path)
    ap.add_argument("language")
    ap.add_argument("--per-table", type=int, default=40, help="0 = every site")
    ap.add_argument("--seed", type=int, default=20260830)
    args = ap.parse_args()

    blob = json.loads(args.blob.read_text())
    rnd = random.Random(args.seed)
    root = HARNESS.parent
    scratch = args.blob.parent / f"_mutant_{args.language}.json"
    base_json = json.dumps(blob, sort_keys=True)

    by_table: dict[str, list] = {}
    for kind, loc in sites(blob):
        by_table.setdefault(kind, []).append((kind, loc))
    chosen: list[tuple[str, object]] = []
    for kind, group in by_table.items():
        rnd.shuffle(group)
        chosen.extend(group if args.per_table == 0 else group[: args.per_table])

    tried: Counter[str] = Counter()
    caught: Counter[str] = Counter()
    noop = 0
    for n, (kind, loc) in enumerate(chosen, 1):
        mutant = mutate(blob, kind, loc, rnd)
        if json.dumps(mutant, sort_keys=True) == base_json:
            noop += 1
            continue
        tried[kind] += 1
        scratch.write_text(json.dumps(mutant, separators=(",", ":")))
        result = subprocess.run(
            [str(HARNESS / "ts_check_trees.mjs"), str(scratch), args.language],
            cwd=root,
            capture_output=True,
        )
        if result.returncode != 0:
            caught[kind] += 1
        print(f"\r  {n}/{len(chosen)}", end="", file=sys.stderr, flush=True)
    scratch.unlink(missing_ok=True)
    print("\r" + " " * 24 + "\r", end="", file=sys.stderr)

    total_sites = Counter(k for k, _ in sites(blob))
    print(f"{'table':<20}{'sites':>8}{'tried':>7}{'caught':>8}{'rate':>7}")
    for kind in sorted(tried):
        rate = 100 * caught[kind] / tried[kind]
        print(f"{kind:<20}{total_sites[kind]:>8}{tried[kind]:>7}{caught[kind]:>8}{rate:>6.0f}%")
    t, c = sum(tried.values()), sum(caught.values())
    print(f"{'TOTAL':<20}{sum(total_sites.values()):>8}{t:>7}{c:>8}{100 * c / t:>6.0f}%")
    print(f"\nno-op mutations skipped: {noop}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
