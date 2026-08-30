# Error recovery in the table interpreter

Done-note for the `wt/parse-recover` slice. Kept current as the work proceeds
rather than written at the end, because the session limit has already taken this
analysis once.

## Status

Reading complete, implementation not started. Everything below is established
from upstream `lib/src` at the 0.26.0 pin plus measurement in this worktree.

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

## What is unbounded, as of the end of reading

- Stage 1's cost. `do_all_potential_reductions` is O(token_count x actions) per
  recovery and runs twice per missing-token candidate. For go that is a
  hundreds-wide loop inside a hundreds-wide loop. Correctness first, but this is
  where a viewport-latency target would be spent.
- Stage 2's symbol-order dependence is deterministic but untested by anything;
  a fixture only pins the winner it happened to produce.
- `ts_stack_pop_error` / `record_summary` / `resume` are stack machinery this
  port does not have at all yet, and they are the pieces with no clean-parse
  analogue to check against.

## How much of the fortnight is real

Not answerable yet — no line of recovery is written. The reading says the
subsystem is smaller and less arbitrary than the spike doc feared (the four
stages are mechanical, the cost arithmetic is closed-form integer, and the
row dependency evaporates), and that the risk is concentrated in stage 2's
symbol-order choice and in stack machinery that has never been exercised.
