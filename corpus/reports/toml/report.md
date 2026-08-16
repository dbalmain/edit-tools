# TOML package report (stage C)

```
gate 1 idempotence      pass
gate 2 width            pass   (7 overflow lines; taplo also 7)
gate 3 non-destruction  pass   (method: default named-node + extras)
gate 4 agreement        11/15 @ width 80,  12/15 @ width 60
rust/js parity          identical
refusals                none
size                    package 540 B gzip; runtime 9165 B gzip
                        (+63 trailing trivia, +242 comment boundary, vs main 8860)
```

Scored 30/30 coverage, 30/30 rust/js, 30/30 idempotence, 30/30 non-destruction.
Review coverage 100% at each width: 23 agreements and 7 accepted design
limits, none stale, none unreviewed. Stage D recorded the verdicts and stage E
corrected two of the classifications.

## Divergences

**Seven** cases after stage E, four files, three design limits. Stage D
disproved the eighth: `nested.toml@60` was labelled a design limit and was a
package bug. Moving the array group from `array` to `pair` reproduced taplo
exactly, and the record was retired once the case agreed.

None of the remaining seven are package bugs I chose to leave, and none are
reference quirks.

- `toml/arrays.toml@80` `9e076e377cd80bf7215968223051234389ac2f3cdb63d3710ee7b4aaf3eb0419` — **design limit**. `trail` is the only way to add a comma on break, and it pins the group open when the source already has one. taplo collapses `trailing` and `already_broken` because they fit. A consume-without-pin opcode would win this file; encoding taplo's exception as a one-file rule would not.

- `toml/arrays.toml@60` `cdd5f1a61e0ccaa87e8f0a7e391a8f5b2808c0e135732352d6f3c6b3dbc83478` — **design limit**. Same `trail` coupling as `@80`.

- `toml/comments.toml@80` `6a5217cd830704e1add412c7510955e72e4fefe75765192a5b4ed657fef98b92` — **design limit**. taplo's `align_comments` pads consecutive trailing comments to the longest sibling's formatted width. A node-type table cannot read sibling formatted widths, pad a comment on a different node, or depend on whether a sibling array broke. `comment_gap = 1` is the unaligned house style.

- `toml/comments.toml@60` `6a5217cd830704e1add412c7510955e72e4fefe75765192a5b4ed657fef98b92` — **design limit**. Same pair, same hash: the file is width-independent.

- `toml/nested.toml@80` `73d75298c4762957` (rehashed after the stage-E package fix) — **design limit**. taplo expands nested arrays whenever the parent array is expanded, even when the inner line still fits (`  [1, 2, 3, 4, 5, 6],` is 21 characters). `fits` is line-local; there is no "break this group if an ancestor broke". This is house-style.md's deferred "containers do not share a line" candidate, measured here rather than implemented.

- `toml/nested.toml@60` — **resolved at stage E**, and no longer a divergence.
  Grouping the array at `pair` rather than at `array` reproduces taplo. The
  record was retired rather than re-judged, because a verdict whose subject is
  gone has nothing left to be about.

- `toml/normalisation.toml@80` `606c130045bf1d457ceb4630dad8aac477b4612e09bf5e2cdbb9f7fe05450574` — **design limit**. All nine token-level rewrites match taplo. The only diff is the same sibling comment alignment as `comments.toml`.

- `toml/normalisation.toml@60` `606c130045bf1d457ceb4630dad8aac477b4612e09bf5e2cdbb9f7fe05450574` — **design limit**. Same pair, same hash.

Comment alignment costs **2 files x 2 widths = 4**. Combined with the `trail` pin (2) and the nested-array expand (1, at width 80 only) that is 7. I did not encode taplo's alignment arithmetic into rules that fire on two files.

`kitchen` matches at both scored widths. The stage-A prediction named `kitchen@88`; widths are now `[80, 60]`, `features` breaks at 80, and the sibling-width pad never appears.

## Runtime edits

Two, both in `rust/` and `runtime-js/`, combined **+233 B gzip** on `runtime-js/bundle.js` (8860 → 9093). They were landed together because the second has to compose with the first; I did not produce isolated patches, so the split below is by construct, not by separately gzipped commits.

1. **`blank` at end of children reads trailing trivia** (tree-sitter-toml `table` / `table_array_element`). Those nodes include the blank line before the next header *inside* their range. The parent's `blank` between siblings sees a zero gap. Without this, five files lost every inter-table blank. Tried first: `["blank", 1, ["table", "table_array_element"]]` as a floor — that invents a blank between `[spelling.nested]` and `[spelling.nested.child]`, which the source does not have, and drops the floor to 10/15. Package-level workaround is worse because the information is in the node range, not in a sibling type. `blank` at end of children, using `newlines(last_child.end, node.end) - 1`, is the existing opcode applied to the gap the parent cannot see.

2. **Own-line comments that trail the last sibling are delayed** so `trail` can emit the break-only comma *before* them (TOML array with a comment before `]`). Emitting them in `decorate` put the comma after the comment, which rewrote the comment text (`# …bracket,`) and failed gate 3. They flush at `trail`, at the end of `indent` (so a Python block-trailing comment keeps its indent — without that flush, `comments.py` dropped to column 0), at `blank` at end of children, and at the end of the node as a fallback. Tried first: omit `trail` — then every broken array loses its trailing comma and agreement falls well below 70%. The delay is the smaller change that keeps `trail` usable.

Python and JSON agreement is unchanged from main (20/24 and 4/6). The new unit tests pin both constructs, including the indent-flush that `comments.py` required.

No second runtime *constant* turned up. `comment_gap = 1` and `blank_cap = 2` are taplo's observed values; indent 2 is already a package field. Trailing trivia is a grammar-range fact, not a house-style number.

## Harness edits

None outside `harness/languages/toml.toml` (and none inside it).

## What was hardest

Two grammar facts, not the rule table.

tree-sitter-toml parents the blank line before the next header inside the previous `table`. Dispatch-by-node-type is the right shape for TOML — pairs, headers, arrays, inline tables, dotted keys and every spelling all fall out of emitting what the tree has — but the table's range is not the table's children. That is why `blank` had to grow a "cursor at end" reading.

The one thing I would ask of the design: **sibling-formatted-width comment padding**. Name it as a runtime-owned policy, not an opcode a package could abuse: look at consecutive trailing comments, pad to the longest sibling *after* layout, and let that padding depend on whether a sibling group broke. That is the capability that would win back `comments.toml` and `normalisation.toml` (and `kitchen` at any width where `features` stays flat). It is also the first genuine design limit this project has produced. I would not ask for a consume-without-pin `trail` variant or an ancestor-break signal until that one is decided; those two cost one file each and have honest house-style readings.

Latent, not scored: an empty table whose only children after `]` are comments would attach those comments to the header key. Not in the corpus.

## Template delta

- The brief still reasons about `kitchen@88`. Widths are `[80, 60]`; kitchen matches. The alignment finding is real, the predicted file is not.
- `score.json` has no schema. I stored the report header plus the scorer's `gates` / `measures` so the orchestrator can read either.
- `review_formatter.py` worked. First real user, no complaint: `--json` gave ids and hashes, the terminal form was the right way to classify.
- "Apply stage-B corrections, then start" was already done in this worktree. Harmless, but it is not a step a stage-C builder still has.
- Gate 2 as "no line exceeds the target width" is the general rule; TOML's reference overflows 7 lines (inline tables, long strings). Matching that count is the bar, and the brief's own overflow paragraph is the one to keep.
- `./test.sh` was green before any rule, with TOML reported as awaiting its package. The stage-A harness fix covers this case.
