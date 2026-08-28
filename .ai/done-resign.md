# Ledger reason re-signing

Reviewer: `gpt-5`

All eight assigned records remain `design limit`. Their output hashes are unchanged; only the reasons, reviewer, and review timestamps moved.

## Rust

### `rust/leading_pipes.rs@100`

- **Actual diff:** all three match arms retain a leading `|`; rustfmt removes it.
- **What the old reason got wrong:** token deletion is implemented. Deleting the pipes reaches the reference bytes, but the old reason incorrectly said no opcode could do so and incorrectly said gate 3 permitted the complete file.
- **New reason:** “Deleting the redundant leading pipe produces the reference bytes, but gate 3 rejects that rewrite for the `| _` arm: its `or_pattern` contains only anonymous tokens, so the transparent-wrapper skeleton cannot safely elide it. Exact agreement therefore requires the separately parked gate-3 skeleton rework, not a package rule.”
- **Declined:** no verdict change. The failure is a safety/skeleton design limit, not a Rust package omission.

### `rust/leading_pipes.rs@60`

- **Actual diff:** width-independent from @100; the same three leading pipes remain.
- **What the old reason got wrong:** same stale missing-deletion claim and same incorrect gate-3 conclusion as @100.
- **New reason:** “Same width-independent diff as @100: deleting each redundant leading pipe reaches the reference bytes, but gate 3 rejects the `| _` rewrite because that `or_pattern` has no named child for the transparent-wrapper skeleton. The remaining blocker is the parked gate-3 skeleton rework, not token-deletion support in the package IR.”
- **Declined:** no verdict change for the same reason as @100.

### `rust/comments.rs@100`

- **Actual diff:** the mid-expression block comment moves from before `2` to after the statement; `first, second` is packed onto one line instead of one item per line; and comments before the array/record closers use ordinary indentation instead of the preceding trailing-comment column.
- **What the old reason got wrong:** scoped comment cells now ship in the Rust package, so package-wide unscoped alignment is no longer the cause. The remaining comment-column hunks are attachment/placement, while the packed array is a comment-sensitive fill-selection gap.
- **New reason:** “The mid-expression block comment is runtime-attached on the wrong side of `2`, and the comments before closing delimiters are emitted at ordinary indentation rather than the preceding suffix-comment column; package rules cannot reattach them from surrounding syntax (FINDINGS 9). This width also packs `first, second` because predicates cannot inspect comment decoration and switch the array from fill packing to one-item-per-line. Both are runtime/context limits, not an omitted Rust package rule.”
- **Declined:** no package-bug verdict. Neither runtime-owned attachment nor comment-sensitive fill selection is expressible by the Rust package.

### `rust/comments.rs@60`

- **Actual diff:** the mid-expression block comment moves after the statement, and the two comments before closing delimiters lose rustfmt's continuation-column indentation. Width pressure already keeps `first` and `second` on separate lines.
- **What the old reason got wrong:** scoped comment cells have shipped and the @100 packing hunk is absent here. The remaining cause is runtime-owned attachment/placement.
- **New reason:** “The remaining hunks are comment placement, not alignment scope: runtime attachment moves the mid-expression block comment from before `2` to after the statement and emits both comments before closing delimiters at ordinary indentation instead of the preceding suffix-comment column. Package rules cannot reattach or column-place those comments from surrounding syntax (FINDINGS 9). Width pressure already puts the array items on separate lines here.”
- **Declined:** no verdict change; the current diff does not identify a package-only repair.

### `rust/or_patterns.rs@60`

- **Actual diff:** both long or-pattern arms remain flat and overlong; rustfmt packs alternatives across lines with a leading pipe on continuation lines.
- **What the old reason got wrong:** the fieldless-spine refusal has been fixed by the positional fallback. Removing that refusal exposed a second issue: the flattened result breaks every separator, while direct fill sees only each level of the left-nested spine and staircases.
- **New reason:** “The two long arms remain flat. Existing `flatten` now walks the fieldless left-nested spine, but its broken concatenation places every alternative on its own line; `fill` packs only one node level and therefore staircases on that spine. Rustfmt needs fill packing over the flattened run, a composition the IR does not provide, so this remains a design limit rather than a Rust package omission.”
- **Declined:** no package-bug verdict. The required fill-over-flatten composition is not present in the IR.

## JavaScript

### `javascript/normalisation.js@80`

- **Actual diff:** redundant double parentheses remain around `1 + 2`, and semicolons are absent after both assignments inside the `if` and after `trailingSpaces`.
- **What the old reason got wrong:** token deletion exists. The real parenthesis blocker is that the same `parenthesized_expression` rule also serves required control-flow parentheses. ASI semicolon insertion remains a separate, valid cause.
- **New reason:** “The exact diff contains the redundant `((1 + 2))` pairs and three ASI semicolons. Existing `drop` reaches the parentheses, but applying it to every `parenthesized_expression` also removes the required `if` condition parentheses in this same file because rule dispatch cannot vary by parent position (FINDINGS 10). The source CST omits all three statement terminators, and the IR has no sanctioned unconditional statement-terminator insertion policy; both remaining causes are design limits.”
- **Declined:** no package-bug verdict. Parent-sensitive dispatch and unconditional statement-terminator insertion are unavailable.

### `javascript/normalisation.js@40`

- **Actual diff:** byte-for-byte and hash-identical to @80: redundant double parentheses plus the same three missing semicolons.
- **What the old reason got wrong:** it grouped parenthesis deletion under the obsolete missing-token-deletion cause. The parent-position and ASI causes are the same as @80.
- **New reason:** “Same hash and exact diff as @80. Existing `drop` can remove the redundant `((1 + 2))` pairs, but node-type-only dispatch also removes required `if` condition parentheses; selecting only the redundant occurrences needs parent-position-sensitive rules (FINDINGS 10). The three ASI semicolons separately require an unconditional statement-terminator insertion policy that the IR does not expose.”
- **Declined:** no verdict change for the same reasons as @80.

### `javascript/control_flow.js@40`

- **Actual diff:** the only difference is the nested ternary: our output retains `(pending ? "pending" : "ready")`, while Prettier removes the parentheses after the outer ternary breaks. At @80 the parentheses remain and the file agrees.
- **What the old reason got wrong:** token deletion exists. The actual missing input is the enclosing layout decision: deletion is wanted only when the ancestor ternary breaks.
- **New reason:** “The sole hunk is width-sensitive: Prettier retains the nested-ternary parentheses at @80 but removes them when the outer ternary breaks at @40. Existing `drop` can consume the punctuation, but a node-local `parenthesized_expression` rule cannot condition that deletion on an enclosing group decision. Exact agreement needs ancestor-break-sensitive token deletion or layout-candidate selection (FINDINGS 2/15), so retaining the source pair is a design limit.”
- **Declined:** no package-bug verdict; an unconditional JavaScript package edit would make @80 wrong.

## Validation

- `./harness/score.py .`: pass; gates 0–3 remain 405/405, reference agreement 251/384, 0 stale, 0 unreviewed, and 0 package bug.
- `./harness/reason_rot.py`: the eight assigned records are gone. The sole remaining hit is the explicitly out-of-scope `css/custom_properties.css@80` record.
- `uv run harness/test_reason_rot.py`: **fails in the pre-existing live-ledger fixture**, which hard-codes `rust/leading_pipes.rs@100` and `@60` as records that must be reported. The detector correctly no longer reports them after this slice, producing two failures and one dependent `KeyError`.
- `python3 -m unittest discover -s harness`: the same two failures and one error; the other 98 tests pass.

I did not edit `harness/test_reason_rot.py` because this slice restricts implementation changes to formatter ledger JSONL files through the approval tool. Its `KNOWN_REASONS` / `LiveLedgerTests` fixture needs to be updated alongside the independently owned CSS re-signing (or changed to use an isolated fixture rather than the live ledger).

I also did not change `review_ledger.state()`. Making finding-status changes stale is the separately queued systemic fix described in the task, and does not belong in this prose-only slice.
