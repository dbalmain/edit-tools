#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Gate 1 at every width, not just the two scored ones.

Gate 1 compares the two runtimes at widths 88 and 60. That is enough to catch a
runtime that hardcodes breaks, and it is *not* enough to catch a width-measurement
bug: a divergence only becomes visible when a mis-measured character sits exactly
on a fit boundary, and whether that happens depends on the width.

Measured, on this corpus: a JS runtime using `.length` instead of `[...s].length`
diverges from Rust on exactly one file (`python__strings`) at exactly two width
runs -- 56-59 and 74-77. The scored widths are 60 and 88. Width 59 catches it;
width 60 does not.

So the contract warns about this bug in writing -- after grok diagnosed it in the
reference implementation during Phase 1 -- and then scores at two widths that
cannot detect it. A submission could have shipped it and passed gate 1 on all 30
runs. (All three submissions were checked and none had it, but the gate is not
what established that.)

The fix is not to hunt for corpus cases that land on the boundary at 88 or 60 --
that chases one bug's arithmetic and would not generalise to the next
width-measurement defect. Sweeping the width instead makes the property hold for
every boundary the corpus can express. Cross-runtime agreement is cheap; run it
at 100 widths rather than 2.

Usage: check_width.py <submission-dir> [lo] [hi] [--language NAME]

`--language` matters more than it looks. The sweep is (hi - lo + 1) x trees x 2
runtime invocations: 3,030 today, and roughly 45,000 once fifteen languages are
merged. A builder in a worktree should sweep their own language; the whole-corpus
sweep is the orchestrator's, between rounds.
"""

import subprocess
import sys
from pathlib import Path

DEFAULT_LO, DEFAULT_HI = 20, 120


def run(exe: Path, tree: Path, width: int) -> tuple[int, bytes]:
    p = subprocess.run(
        [str(exe), str(tree), str(width)], capture_output=True
    )
    return p.returncode, p.stdout


def main() -> int:
    argv = sys.argv[1:]
    language = None
    if "--language" in argv:
        i = argv.index("--language")
        language = argv[i + 1]
        del argv[i : i + 2]

    sub = Path(argv[0]).resolve()
    lo = int(argv[1]) if len(argv) > 1 else DEFAULT_LO
    hi = int(argv[2]) if len(argv) > 2 else DEFAULT_HI

    pattern = f"{language}__*.tree.json" if language else "*.tree.json"
    trees = sorted((Path(__file__).parent.parent / "corpus" / "trees").glob(pattern))
    if not trees:
        sys.exit(f"no trees matching {pattern}")
    rust, js = sub / "fmt-rust", sub / "fmt-js"

    disagreements = []
    for width in range(lo, hi + 1):
        for tree in trees:
            rc_r, out_r = run(rust, tree, width)
            rc_j, out_j = run(js, tree, width)
            # A shared refusal is agreement: both runtimes declining the same
            # input is the linearity invariant working, not a divergence.
            if (rc_r == 0) != (rc_j == 0) or (rc_r == 0 and out_r != out_j):
                disagreements.append((tree.name.removesuffix(".tree.json"), width))

    runs = (hi - lo + 1) * len(trees)
    if disagreements:
        print(f"[FAIL] width-sweep  {len(disagreements)}/{runs} disagree")
        for name, width in disagreements[:40]:
            print(f"       {name} @{width}")
        if len(disagreements) > 40:
            print(f"       ... and {len(disagreements) - 40} more")
        return 1

    print(f"[PASS] width-sweep  {runs}/{runs} agree  (widths {lo}-{hi})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
