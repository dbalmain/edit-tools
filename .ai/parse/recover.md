# Error recovery in the table interpreter

Done-note for the `wt/parse-recover` slice. Kept current as the work proceeds
rather than written at the end, because the session limit has already taken this
analysis once.

## Status

**Done: 44/44 byte-identical on `corpus/trees-edited/` for json, scheme and go,
ERROR and MISSING included. 0 diverged, 0 refused.** The clean corpus is
unchanged at 3/3, 15/15, 16/16.

## What the brief got wrong

Checked rather than trusted, as asked.

| Claim | Truth |
| ----- | ----- |
| `harness/ts_lr.mjs` is ~1,430 lines | **1,508** lines (1,509 with the trailing newline). Off by 5%; nothing depends on it. |
| 33 of 44 json/scheme/go fixtures need recovery: 26 no-parse-action, 7 no-token | **Exactly right.** Reproduced: 33 refused (26 + 7), 11 byte-identical, 0 diverged. |
| The listed functions throw | **Right.** `summarizeChildren` (error-node branch), `ts_parser__lex`'s no-token path, the `RECOVER` action arm, and `condenseStack`'s resume-a-paused-version arm all raise `Unsupported`. |

The 11 that already pass are exactly the `e03` fixture of each of the eleven
bases — the fourth edit per base is the one that happens not to break the parse.
So the split is not 33 hard cases and 11 easy ones scattered; it is one clean
edit per base by construction of the fixture generator.

One non-brief trap worth recording: `/tmp/vsrc/go.blob.json` is **stale** and
does not match a fresh transcode of `/tmp/vsrc/tree_sitter_go-0.25.0/src/parser.c`.
`/tmp/vsrc/json.blob.json` does match. Re-transcode rather than reusing either.

## Baseline measured in this worktree

- `./test.sh` green at 51231a7. **126** harness tests; Rust 116 / 22 / 8.
- Blobs regenerate byte-identically from `parser.c` for all three grammars
  (scheme's `parser.c` is not in any sdist — fetch
  `raw.githubusercontent.com/6cdh/tree-sitter-scheme/9338837/src/parser.c`).
- Clean corpus still byte-identical: json 3/3, scheme 15/15, go 16/16.
- `corpus/trees-edited/` for the three grammars: 12 json + 16 scheme + 16 go = 44.

## The oracle is not quite the one the brief names

`corpus/trees-edited/` fixtures carry a key the clean corpus does not:
`parse_oracle.convert` stamps **`missing: true`** on a MISSING node, and it
stamps it *after* `children`/`text`, so it is last in insertion order.
`ts_check_trees.mjs`'s `convert()` does not emit it at all. So byte-identity
against the dirty corpus needs that key added, in that position — a MISSING node
is otherwise indistinguishable from a real zero-width leaf, which is the whole
reason the oracle track added it.

`harness/parse_conform.py` already has a `dirty` suite over these fixtures with
a structural `diff_root`, and an adapter protocol
(`<adapter> <language>` , source on stdin, tree doc on stdout). That is the
existing comparison style to extend — an adapter that shells to `ts_lr.mjs`
gets the `structure`, `dirty` and `total` suites for free, and `total` is the
one that states the real contract: *"the adapter must not fail on input, however
broken"*.

## The algorithm, as upstream actually writes it

Entry is `ts_parser__handle_error(version, lookahead)`, called from the parse
loop when every version is paused. It is not one algorithm but four stages, and
the arbitrary-looking choices are concentrated in stage 3.

**1. `ts_parser__do_all_potential_reductions(version, 0)`.** Walk every token
symbol `1..token_count`, collect every REDUCE action reachable in the current
state with any lookahead, and perform them all, forking versions. With
`lookahead_symbol == 0` it never removes versions; with a symbol it prunes the
ones that cannot shift it and returns whether any can. This is a
breadth-first closure over the state, and it is the expensive loop: for go,
`token_count` is in the hundreds and it runs per recovery.

**2. Missing-token insertion.** For each version, try every `missing_symbol` in
`1..token_count`: if `next_state(state, missing_symbol)` is a real, different
state, and that state `has_reduce_action` for the lookahead's leaf symbol, then
copy the version, push a zero-width MISSING leaf, and run stage 1 again on the
copy with the lookahead symbol. First symbol that lets the lookahead shift wins
and sets `did_insert_missing_token`. **The winner is decided by symbol-number
order**, which is deterministic but is the single most arbitrary choice in the
whole subsystem — it depends on the grammar's symbol numbering, nothing more.

Then push a `NULL` subtree (a discontinuity) onto every version at
`ERROR_STATE`, merge the forks back into `version`, and
`ts_stack_record_summary(version, MAX_SUMMARY_DEPTH)`.

**3. `ts_parser__recover(version, lookahead)` — two strategies.**

*Strategy 1, recover to a previous state.* Walk the recorded summary; for each
entry, skip if it is the error state or at the current position; skip if
recovering there would duplicate an existing version; compute

```
new_cost = current_error_cost
         + entry.depth                        * ERROR_COST_PER_SKIPPED_TREE(100)
         + (position.bytes - entry.position.bytes) * ERROR_COST_PER_SKIPPED_CHAR(1)
         + (position.row   - entry.position.row)   * ERROR_COST_PER_SKIPPED_LINE(30)
```

and **break out of the loop entirely** if `better_version_exists`. Otherwise, if
the lookahead has actions in that state, `recover_to_state` pops `depth`
subtrees, wraps them in an ERROR node, and pushes it.

*Strategy 2, skip the token.* Wrap the lookahead in an `ERROR_REPEAT` node; if
tokens were already skipped, pop the existing ERROR and merge the two into one
larger `ERROR_REPEAT`; push at `ERROR_STATE`. Guarded by the same cost formula
with `ERROR_COST_PER_SKIPPED_TREE` for one tree.

EOF is special-cased before strategy 2: wrap everything in an ERROR node and
accept.

**4. Error cost accrual** in `ts_subtree_summarize_children`, for a node whose
symbol is ERROR or ERROR_REPEAT:

```
per child that is not extra and not a childless error:
    visible child          -> += 100
    invisible with kids    -> += 100 * child.visible_child_count
once, for the node itself:
    += 500 + 1 * size.bytes + 30 * size.extent.row
```

## The one place row extents are load-bearing — and it is cheaper than feared

The brief says row/column tracking is another agent's scope and offers a stub.
It does not need one. `extent.row` is read in exactly three places, all in the
cost arithmetic above, and every one of them is *"how many newlines lie in this
byte span of the source"*:

1. `summarize_children`: `30 * size.extent.row` of the ERROR node.
2. `recover` strategy 1: `(position.row - entry.position.row) * 30`.
3. `recover` strategy 2: `total_size(lookahead).extent.row * 30`.

Subtree spans are contiguous byte ranges over the same buffer the lexer walks,
so counting `\n` in `source[from..to)` gives *exactly* the number upstream
accumulated — it is the same quantity computed a different way, not an
approximation. That is a ~5-line helper over the source buffer, and it does not
touch the `Length`/extent plumbing the concurrent row/column agent is adding,
so the two changes should not collide. When their work lands, these three call
sites should switch to the real extents and the helper should go.

**This matters for the estimate**: "error cost per line needs row tracking" was
the one place the recovery slice looked like it had a hard dependency on another
slice, and it does not.

## Can this be byte-identical across two runtimes?

Nothing found so far says no. Every choice upstream makes during recovery is a
deterministic function of the tables and the source bytes: symbol-number order
for missing-token insertion, integer cost arithmetic with no floating point,
`subtree_compare` as the final tie-break, and version order in the summary.
There is no hashing, no pointer comparison, and no iteration over an unordered
container in any of the four stages.

The caveat, which is real: `docs/parse-layer.md` records that route A's *own*
native and wasm hosts diverge on 8 of 922 broken-input cases. So byte-identity
between **our** two runtimes is achievable in principle, while byte-identity
against **tree-sitter** on arbitrary broken input is a bar upstream itself does
not meet across its hosts. The frozen fixtures are a fixed oracle produced by
one host, so they are a fair target; arbitrary fuzzed input is not.

## The three defects, and what found them

All three were invisible to the clean corpus and all three were found by one
instrument: **py-tree-sitter exposes `parser.logger`**, so tree-sitter will emit
its own recovery decisions (`detect_error`, `skip_token`, `recover_to_previous`,
`recover_with_missing`, `recover_eof`). Logging the same five events here and
diffing the two sequences localises a defect to the exact decision that first
differs, which is far sharper than diffing trees.

That instrument is not in the spike's plan and it is the single most useful
thing this slice produces for whoever writes the Rust runtime.

1. **`ts_subtree_error_cost` is an accessor, not a field.** It special-cases
   MISSING at `110 + 500`; this port read the raw field in seven places. An
   invented missing token therefore looked free, always won
   `better_version_exists`, and suppressed recovery strategy 1 everywhere one
   had been inserted. 27 -> 36 fixtures.
2. **`ts_stack_renumber_version` carries the summary across.** Three lines: if
   the target head has a summary and the source does not, the summary moves to
   the source. A version created by popping never has one, and recovery
   renumbers exactly such a version over one that does -- so without the clause
   the recovered version loses its record of where it may rewind to, strategy 1
   stops firing for the rest of the parse, and ERROR nodes run far past where
   upstream closed them. 36 -> 44 fixtures.
3. **A latent one, fixed on the way in.** `summarizeChildren`'s fragile-parent
   branch tested `child.symbol === ERROR || child.isMissing`; upstream tests
   only `ts_subtree_is_error` (checked in 0.25.2, 0.26.0 and 0.26.8). Dead while
   no missing leaf could exist, live the moment this slice created one.

The shape they share is worth naming: **every one is a place where upstream
hides a special case behind something that reads like a plain field or a plain
utility.** Not one was an algorithm the port got wrong; all three were accessors
and helpers whose bodies nobody thinks to read. That is the defect class the
Rust runtime should be reviewed for, because it will hit exactly the same three.

## Were the last 8 one mechanism or eight?

**One.** All eight remaining failures -- across all three grammars -- were the
single `renumber_version` summary clause. That is the good answer to the
question the tail risk was about: the failures were not eight unrelated
arbitrary choices, they were one three-line omission with a wide blast radius,
and the fixtures were correlated because they all depend on strategy 1 still
working later in the same parse.

## The revised estimate

| | Spike's estimate | Actual |
| --- | ---: | ---: |
| JS code lines for recovery | ~430 | **437** |
| Total diff | -- | 623 +, 45 - |

The line estimate was almost exactly right, which is worth recording because
the spike itself called lines "the number I trust least".

**The time estimate was too pessimistic for recovery specifically.** The spike
priced ~1,100 lines and a fortnight for recovery *and* incremental reparse, with
"the tail risk in recovery rather than in incrementality". Recovery took a few
hours of focused work: read upstream, port four stages, then three defects each
localised in one log-diff. It did not behave like an open-ended chase.

Two reasons it came in under, and both are specific rather than luck:

* **The arbitrariness is smaller than it looks.** Upstream's recovery reads as
  though it is full of coin-flips -- which version to resume, how far to rewind,
  what to charge. It is not. It is one integer cost function, evaluated in a
  fixed order, with no floating point and no unordered iteration anywhere. Once
  the cost function is right the decisions follow, and *every* defect above was
  a wrong cost or a lost summary rather than a wrong choice.
* **The oracle is a decision log, not a tree.** Diffing trees tells you that
  something went wrong somewhere; diffing decision sequences tells you which
  decision, and the first divergence is nearly always the cause.

**What I would quote now**, for the second (Rust) runtime, given this one exists
as a reference: **2-4 days for recovery**, not a week -- provided it is built
against the same log-diff instrument. The 0.65 C-to-JS line ratio the spike
derived held, so a Rust port should be sized off 437 JS lines rather than off
657 C lines.

**I would not revise the incremental-reparse half.** Nothing here touched it,
and it is the larger of the two (670 estimated JS lines against recovery's 430).

## What the 44/44 does *not* establish

Stated plainly, because "44/44 byte-identical" is exactly the kind of number
that gets quoted without its scope -- and this document's own predecessor was
written to make that mistake hard.

* **44 fixtures is a narrower oracle than the clean corpus was, and the clean
  corpus was already too narrow.** The spike's own history is the argument: of
  its four defects, two were invisible to the 34-file clean corpus and needed a
  7,940-file differential and a review. There is no differential for *broken*
  input, so recovery today has the weaker of the two oracles, not the stronger.
* **Three grammars, all scanner-free.** Nothing here is evidence about recovery
  in a grammar with an external scanner, where recovery and scanner state
  interact (`ts_subtree_has_external_scanner_state_change` gates one of
  `recover`'s early returns, and is stubbed false here).
* **Upstream's own hosts disagree on recovery.** `docs/parse-layer.md` records
  route A diverging between native and wasm on 8 of 922 broken-input cases, so
  byte-identity against tree-sitter on *arbitrary* broken input is a bar
  upstream does not itself meet. The frozen fixtures are a fixed oracle from one
  host, which is why they are a fair target and arbitrary fuzzed input is not.
* **Row extents are a newline count, not real extents.** Exact for every input
  here, and it stays exact -- but it is a second implementation of a quantity the
  concurrent row/column branch is about to provide properly.

## What is unbounded, as of the end of the slice

Not the line count and not the algorithm -- **the validation breadth**. The
honest remaining risk is that 44 fixtures cannot carry error recovery any more
than 34 files could carry a 372 KB table blob, and the instrument that would
close it (a differential over broken input, in the shape of
`harness/ts_differential.py` but without its skip-unclean filter) does not exist
yet. That is the next thing worth building, and it is a day, not a fortnight.

Stage 1's cost also stays unpriced: `do_all_potential_reductions` is
O(token_count x actions) per recovery and runs once per missing-token candidate,
which for go is a hundreds-wide loop inside a hundreds-wide loop. Correctness
first, but a viewport-latency target would be spent here.
