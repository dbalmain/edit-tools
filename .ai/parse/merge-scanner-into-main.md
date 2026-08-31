# Merging `wt/parse-scanner` into main: what it costs, and why it was backed out

Written 2026-08-31 13:35, at the end of the build window. **Not a blocker
report — a map, so the next session does not rediscover this.**

## State

- `main` = `5ce9924`, the **recovery** merge. Green and independently verified:
  json 3/3 + 12/12 broken, go 16/16 + 16/16 broken (fresh transcode), 126
  harness tests, 10 node tests.
- `wt/parse-scanner` = `09e29f4`. Green **on its own branch**: toml 15/15
  through the VM, json/scheme/go unchanged, 126 harness tests, Rust 116/22/8.
- The two have **not** been merged. A merge was attempted twice and backed out
  both times, deliberately.

Nothing is lost. Both branches are intact and each is green.

## Why it was backed out rather than landed

The two slices both extend `harness/ts_lr.mjs`, which I knew and accepted when
I launched them in parallel. The collision is not textual — eight conflicts,
all resolvable, and I resolved them. It is a **type change running through
shared plumbing**:

> The scanner slice converted positions, paddings and sizes from **byte counts**
> to **`Length` records** (`{bytes, row, column}`), because upstream's
> `ts_lexer__do_advance` maintains an extent on every advance and `get_column`
> needs it. The recovery slice was written against the old world, where all
> three were plain numbers.

So every site where recovery does arithmetic on a position is a silent defect
after the merge: `a - b` on two `Length`s is `NaN`, and `a === b` is object
identity, which is always false. `NaN` does not throw — it propagates into cost
comparisons, which are all `<`/`>`, which are all false for `NaN`, so a bounded
loop becomes unbounded. **The observed symptom is a hang, not an error.**

That is exactly the failure class this whole route exists to prevent, so
landing it unverified to beat a deadline would have been the wrong trade.

## The conflicts, and how they resolve

Eight in `ts_lr.mjs`, two in `ts_lr.test.mjs`. None is contentious:

| # | Site | Resolution |
| - | ---- | ---------- |
| 0,1 | header prose | rewrite: row/col and recovery are both implemented now; only a scanner with no packed program still throws |
| 2 | `summarizeChildren` child loop | **union** — scanner's `hasExternalTokens` propagation *and* recovery's `child.symbol === ERROR` test (recovery's defect 3: drop `\|\| child.isMissing`) |
| 3 | stack head init | `subtreeErrorCost(subtree)` (recovery) + `lengthAdd(..., totalSizeLength)` (scanner) |
| 4,5 | new/forked version fields | **union** — `summary: null` + `lastExternalToken` (inherited on fork, null on base) |
| 6 | `Stack` methods | **union**, but `hasAdvancedSinceError` must read the **accessor** `subtreeErrorCost(subtree)`, not the raw field — upstream uses `ts_subtree_error_cost`, and this is recovery's defect 1 in a site the scanner slice wrote |
| 7 | paused-version handling | **take recovery** — it implements the resume that the scanner side only reworded the `throw` for |

Two traps in the mechanical part: a 3-way conflict boundary **cuts a method and
a test mid-body** in this file, so a naive union produces unbalanced braces
(`Unexpected end of input`). And recovery's `TINY` fixture lives *outside* any
`test()` block, so extracting test bodies alone loses it.

## The type seam: every site found so far

Fixed during the attempt, all verified as necessary:

1. `recordSummary` stores `it.node.position` — must be `.bytes`; recovery's cost
   arithmetic and its `entry.position === position` dedupe are both byte-based.
2. `newMissingLeaf` passes literal `0` as size into `newLeaf` — must be
   `LENGTH_ZERO`. Recovery added this function; the scanner slice never saw it.
3. The ERROR-leaf construction in the lexer's skip loop: `errorStart -
   startPosition` and `errorEnd - errorStart` are number-minus-`Length`. Needs
   `Length` twins tracked alongside the byte offsets (`lexer.tokenStartPosition()`
   and `lexer.position()`) and `lengthSub` at the call.
4. `forTests.newLeaf` now takes `Length`s, so recovery's three unit tests must
   pass `len(...)`. Export `len` on `forTests` rather than letting the test
   file invent the record shape.

**After all four, `json --edited` still hangs.** So there is at least one more
site. That is where the next session should start — and it should start by
*instrumenting*, not reading: adding an iteration guard to the three `for (;;)`
loops localised it to the lexer loop at once, after reading had produced only
plausible theories.

## The cheap way to do this properly

Do not hand-merge again. **Convert recovery to `Length` first, on its own
branch, with the recovery corpus green at every step** — `git merge
wt/parse-scanner` afterwards is then nearly textual. Concretely: take
`wt/parse-recover`, cherry-pick only the scanner slice's `Length` plumbing
commit (`cc77079`, row/column, which was deliberately landed in isolation for
this reason), fix the fallout with `--edited` as the gate, and merge the rest.

A grep that finds the remaining sites faster than reading: every `-`, `+`,
`===` or `<`/`>` whose operands are `position`, `padding`, `size`, `tokenStart`
or `startPosition`. In the merged file those are the only NaN sources.

## What the merge is worth

Once landed: one interpreter that does clean parses, broken-input recovery, and
external scanners — 44/44 dirty, 15/15 toml, 34/34 clean across four grammars.
That is the whole of layers 1-3 for the scanner-bearing case, in JS.
