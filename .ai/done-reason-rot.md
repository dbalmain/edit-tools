# Reason-rot detector

`./harness/reason_rot.py` is a worklist, not a gate. It does not edit
`harness/reviews/` and is not wired into `score.py`.

## What it keys on

Two channels, against live sources of truth (not a hardcoded opcode list):

1. **FINDINGS citation as cause.** The reason names `Entry N` / `FINDINGS N`
   as the blocking claim, and that entry's status now contains the word
   `built` (including "Opcode built" while parked). Citations already treated
   as fixed, as an extension, as a boundary, or as *not* the cause (`rather
   than entry 2`, `Not entry 11`) are skipped.
2. **Absence language next to an IR name.** `lacks fill`, `proposed drop
   opcode`, `no drop opcode`, `the IR lacks X`. Opcode and predicate names
   are parsed from `rust/src/pkg.rs`. Short English-overlapping names
   (`group`, `line`, `each`, …) only match the tight absence forms, not
   `has no group to break`.

`packages/*.json` is evidence that a capability is in use, printed on a hit,
not a third matching channel.

## The three fixtures, without special-casing

All three flag. `reason_rot.py` does not contain their record ids.

| record | phrase | capability |
| --- | --- | --- |
| `css/custom_properties.css@80` | `lacks fill` | opcode `fill` |
| `rust/leading_pipes.rs@100` | `Entry 13` + `proposed drop opcode` | FINDINGS 13, opcode `drop` |
| `rust/leading_pipes.rs@60` | same | same |

Paraphrases of the same claims also hit (`The Doc IR lacks fill.`,
`there is no fill opcode`, `Existing entry 13 still blocks this.`). The
css record never cites FINDINGS 8; channel 2 is what catches it.

`harness/languages/rust.toml` already describes the post-`drop` situation
for `leading_pipes.rs`. The ledger reason is the only artefact still saying
the opcode is missing.

## Full-ledger scan: 11 hits / 9 records / 142

First raw pass also fired on three English false positives (`has no group`
in "group-fit" / "has no group to break", `has no comments` against the
package `comments` header). Those were suppressed; the tests keep them
silent. After that, 9 unique records. Hand-check of every one:

### Survived (9/9)

The three fixtures above, plus:

| record | what the reason still says | what is true now | remaining? |
| --- | --- | --- | --- |
| `javascript/normalisation.js@80` | FINDINGS 13, "no opcode drops a token" | `drop` exists; TS re-reviewed the same construct four days later and said drop *does* delete the parens | FINDINGS 10 (parent position) and ASI insertion, which is not deletion |
| `javascript/normalisation.js@40` | same hash | same | same |
| `javascript/control_flow.js@40` | FINDINGS 13, "no opcode deletes a token" | `drop` exists | parent/ancestor-sensitive deletion (FINDINGS 10 / 2) |
| `rust/comments.rs@100` | Entry 22: `comment_cells` is unscoped | `"comment_cells": "block"` in `packages/rust.json`; FINDINGS 22 names this file | Entries 9 and 7, still open. Do not retire; re-reason. |
| `rust/comments.rs@60` | same | same | same |
| `rust/or_patterns.rs@60` | Entry 23: flatten refuses because the spine has no fields | FINDINGS 23 built the positional fallback; flatten no longer refuses | fill-over-flatten packing, which the same reason already measured |

None of the extras is a clean "the divergence is gone". They are WRONG-CAUSE
on the cited capability, with another cause still in the same paragraph.
That is why a coverage checker against the hunks scored 0 on this 142: the
hunks are still real.

`typescript/normalisation.ts@80` is the control. It was re-reviewed *after*
`drop` shipped, says "`drop` now reaches both parens", and cites FINDINGS
10 for what remains. The detector correctly leaves it alone.

### False negatives

`go/normalisation.go@80` wants "a declared consume-without-emit policy" and
does not cite FINDINGS 13 or name `drop`. Channel 1 and 2 both miss it.
FINDINGS 10 is still a valid remaining cause in that reason, so a hit would
have been the same partial shape as the JS records. Catching it would mean
matching prose aliases of `drop` (`consume-without-emit`, "deleting a
token") — high-recall in the wrong direction, and I did not add it.

## False-positive rate

On the live 142, after the English suppressions: **0 of 9 reported records
were false**, against a first-pass raw list of 14 hits that included 3
English FPs (21%). The remaining 9 are all real rot under hand-check.

That 0 is a statement about *this* ledger, not a precision guarantee. The
matcher will fire on any future "lacks fill" that a reviewer wrote knowing
fill exists and meaning a further gap. That is why it prints a quoted
phrase and evidence rather than exiting 1.

## Should this become a gate?

No.

- A hit is often *partial*: one of two causes in the reason is stale. Failing
  the scorer on that would punish an otherwise-correct `design-limit`.
- FINDINGS 13 is parked. The opcode exists; using it on `leading_pipes.rs`
  still fails gate 3. "Built" and "this pair now agrees" are different
  claims, and a gate cannot tell them apart from the reason text.
- The ledger's provenance rule is the point: a record is re-signed by a
  reviewer of a different model family. A detector producing a worklist
  preserves that. A detector rewriting reasons, or `score.py` treating
  these as `stale`, does not.
- English matching is the wrong artefact to hang a merge bar on.

Keep it as `./harness/reason_rot.py`, run when FINDINGS or the opcode set
moves, next to the reviewer's other pre-merge checks.

## Design change worth making, separately

`review_ledger.state()` only returns `stale` when `review.hash != digest`.
That is the right test for "the outputs moved". It is blind to "the cited
cause shipped".

A deliberate follow-up, not slipped in here: **also treat a record as stale
when a FINDINGS entry it cites as blocking has changed status since
`reviewed_at`.** That would have caught every channel-1 hit in this scan
(13, 22, 23, the JS 13s) without parsing English. It would *not* have
caught `css/custom_properties.css@80`, which never cites FINDINGS 8.

So the two mechanisms cover different holes:

| mechanism | catches | misses |
| --- | --- | --- |
| hash moved | output changed | capability shipped, bytes didn't |
| cited FINDINGS status moved | channel 1 (numbered causes) | unnamed "lacks fill" |
| this detector | both channels, as a worklist | prose aliases with no name and no number |

Do the FINDINGS-status stale change on purpose, with a stored citation list
or a parse of the reason at approve time, and keep this script for the
unnamed-opcode case. Do not make the script the gate.

`leading_pipes.rs` is also `[incomparable]`, so even a FINDINGS-status stale
bit in `score.py` would not see it: excluded files never produce a digest
to compare. The detector walks the ledger files directly, which is why it
still flags those two.

## Gates

- `uv run harness/test_reason_rot.py` — 24 tests, including the three
  fixtures, paraphrases, and the English FPs as negatives
- `python3 -m unittest discover -s harness` — 101 tests
- `./harness/score.py .` — gates passed, 0 stale, 0 unreviewed (this slice
  does not change scoring)
- Did not run `./build.sh` as part of the slice; the worktree had no
  `docfmt` binary, so one was built locally to *run* score.py, not because
  rust sources changed
