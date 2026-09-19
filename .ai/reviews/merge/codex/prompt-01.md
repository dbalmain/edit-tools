# Review: the merge campaign that brings the feature branches onto `main`

You are reviewing a **merge campaign**, not a feature. Read-only sandbox: do
not edit, do not run `./test.sh`, and do not run `git push` under any
circumstances.

The worktree you are in is detached at the head of the campaign. `main` in this
repository is a local branch; nothing has been pushed and `origin/main` is 250+
commits behind. That is deliberate and not the subject of the review.

## What I did

`main` began this session at `406cf85`. It is now seven commits further on.

1. **Fast-forwarded `main` to `a05ba4a`** (branch `wt/a2-1-inline`), 22
   commits. `main` was already an ancestor, so this is a pure fast-forward and
   the tree is the one that branch's own `./test.sh` had already gated. No
   merge commit.
2. `d1b51ff` **merge `wt/prose-partition`** — ancestry only. See below.
3. `c32b6c5` **merge `wt/pending-guests`** — the only merge in the campaign
   that changes code.
4. `9a0996c`, `6101644`, `9fcb8da`, `19480e2`, `80c7c9d` — **five notes-only
   merges** (`wt/parity-sweep`, `wt/ledger-audit`, `wt/reason-rot`,
   `wt/share-line`, `wt/header-silence`). Each contributes only files under
   `.ai/`; `git diff --stat c32b6c5 HEAD -- . ':(exclude).ai'` is empty.

## The claims I want attacked

Each of these is a checkable statement about the repository. **Check it, and
report any divergence** — including ones where I happen to be right for the
wrong reason. Briefs get read by the next agent; a fact I got wrong that you
silently work around costs the next reader.

### Claim 1 — `wt/prose-partition` had already landed, so the merge is ancestry only

`VERIFIED:` after resolving both conflicts, `git diff HEAD` against the merged
index was **empty** — the merge result is byte-identical to `a05ba4a`. My
explanation is that the `source_partitions` slice reached `main` as commit
`a0735f8` ("source_partitions: a package may declare total coverage, at format
3") rather than through this branch.

Is that the right explanation, and is an empty-tree merge commit the right
thing to record here at all, versus deleting the branch or leaving it unmerged?

### Claim 2 — both `wt/prose-partition` conflicts resolve to `main` because `main` is a superset, not because I preferred it

- `REVIEW.md`: I split the branch's file into 16 paragraph-blocks and checked
  each for literal presence in `main`'s version. **0 missing.** `main` also
  carries ten later findings the branch does not.
- `DESIGN.md`: the branch's side deleted a paragraph `main` had added. I kept
  `main`'s. That paragraph makes three claims, and I re-checked all three
  against the merged tree: no package under `packages/` declares
  `source_partitions`; `packages/markdown.json` is `et-doc-rules/2`; it still
  emits paragraphs `verbatim`.

**The thing I most want checked here:** that same `DESIGN.md` paragraph says
`harness/prose.py` "now build[s] that view for the **A1** subset". A2.1 shipped
in this campaign's first step and the harness now does considerably more than
A1. Is `DESIGN.md` now stale in a way the merge should have fixed, and what
else in `DESIGN.md` did A2.1 falsify? I did not audit `DESIGN.md` against A2.1
and I think that is the weakest part of the campaign.

### Claim 3 — both sides moved the `parity_fuzz.py` docstring 12 → 13, and it is the same site

`VERIFIED:` `partition_cases()` appears once in the merged file, and both sides'
diffs from the merge base add the same function. Nine `*_cases() -> Iterator[Case]`
generators on each side and nine after the merge.

But the docstring count is prose, and `REVIEW.md`'s first standing check says
exactly this is unguarded. **Does 13 actually match the sites the file covers?**
I did not count them independently — I only checked the two sides agreed.

### Claim 4 — `wt/pending-guests` merges cleanly and loses nothing

Two add/add conflicts against an empty base, both resolved by keeping both
sides: `manifest.py` (`main` added `grammar_targets` for A2.0 secondary
grammars; the branch added `formatted_guests`) and `test_manifest.py` (two
independent test classes). `VERIFIED:` the staged delta against `main` was
exactly the branch's `501 insertions(+), 26 deletions(-)` across five files.

I also re-indented the junction to restore two blank lines between top-level
definitions. Confirm that did not touch anything else in those two files.

### Claim 5 — the pending-guests production path is inert on this repo

This is the one I would most expect to be a real finding.

`awaiting_package` now walks the manifest injection graph so a host is pending
when a guest it formats is. But **every** language in `packages/` has a
package, so `missing` is empty, the transitive closure is empty, and the new
code never fires outside its unit suite. `VERIFIED:` `./test.sh` reported
"423 reference outputs checked across 16 language(s)" both before and after the
merge — no language changed status.

Two questions:

1. `harness/test_score.py` grew by 322 lines. **Do those tests drive the real
   `score.awaiting_package`, or do they re-state its rule in a test helper?**
   This repository's recurring defect is a gate that passes for a reason other
   than the one it names. If reverting `awaiting_package` to `main`'s version
   would leave any of the new tests passing, say which.
2. `harness/check_gate3.py:850` emits "package pending, not scored" — a
   **second** pending mechanism the branch did not make transitive. Is that a
   real gap, and would a host embedding a package-less guest now be scored
   inconsistently between `score.py` and `check_gate3.py`?

### Claim 6 — the five notes-only branches contribute no code

`VERIFIED:` empty non-`.ai/` diff, as above. Each had an add/add conflict on a
code file it originally introduced (`parity_fuzz.py`, `test_reason_rot.py`),
resolved to `main`, on the reasoning that `main`'s version is the evolved one.

`.ai/` is gitignored (`.gitignore:4`) but fifteen files under it were
force-tracked before this campaign; it is now twenty-two. The prose projection
probe sweeps `git ls-files '*.md'`, so the six new markdown files joined the
corpus.

**What I want checked:** these are done-notes written three or more weeks ago,
entering a repository that has moved a long way since. Do any of them assert
something `main` has falsified? A tracked note that is wrong is worse than an
untracked one, because the next reader has no way to know it was frozen.

### Claim 7 — the branches I did NOT merge are genuinely superseded

I merged nothing from these, and I want the classification attacked rather than
accepted:

| Branch | Why I skipped it |
| --- | --- |
| `wt/md-stage-d` | Its nine ledger rows are dated 2026-08-25; `main`'s are 2026-09-08/09-10 and cite later work (a FINDINGS 24 fix, an idempotence repair, two new fixtures). Merging would move the ledger **backwards**. |
| `spike/a2-price` | A spike. Its findings landed as `a14f19c`; the branch itself carries a 60,921-line `E2-COVERAGE.json`. |
| `wt/impl-grok`, `wt/impl-codex`, `wt/impl-grok-bytecode`, `wt/grok-proposal`, `wt/codex-proposal` | Losing arms of A/B implementation competitions. 732–736 commits behind. |
| `wt/lang-toml-{deepseek,terra,luna}`, `wt/lang-yaml-{terra,deepseek}`, `backup/wt-lang-toml-stage-e-pre-split` | Losing arms of per-language onboarding competitions; the winners' packages are on `main`. 612–706 behind. |
| `spike/rust-subwidth`, `spike/rust-alignment`, `spike/cell-node-agy`, `wip/gate3-adversarial-arm` | Old spikes, 461–702 behind. |

**Is any of these carrying work that never landed by another path?** I decided
this from commit distance and file-level adds; I did not read their diffs. A
single unlanded fix hiding in an A/B loser is exactly the thing this method
would miss.

## The gates

`./test.sh` ran green, exit 0, **zero warnings**, on the tree at `c32b6c5` and
again on the tree at `d1b51ff`:

- rust `8 / 138 / 138 / 22 / 28`
- python **209** at `d1b51ff`, **225** at `c32b6c5` (+16, the direction the 397
  new test lines predict)
- `423 reference outputs checked across 16 language(s)`
- `injection tree parity: 24/24`
- `secondary grammar: 2553/2553`
- `prose projection: 1457 eligible paragraphs in 120 files`

And a third time on the campaign head `80c7c9d`, same shape, with the prose
projection moving to **1543 eligible paragraphs in 127 files** -- exactly the
seven markdown files the notes merges added, and every one of the 86 new
eligible paragraphs survives the adversarial reflow-and-reparse sweep.

**Do not run `./test.sh` yourself.**

Note the python count is the number to watch, not the exit status — a suite
that stops being collected exits 0 too.

## Ground rules

- If my diagnosis of any claim above is wrong, say so and give the better
  account rather than working around it. A correct "this is actually X" is
  worth more to me than agreement.
- Figures in this brief are **mine**. I measured them; you did not. Do not
  repeat them as though you verified them unless you did.
- Read `REVIEW.md`'s standing checks and apply them — they are this repo's
  accumulated review criteria and several bear directly on this campaign.

## Closing question

Of everything in this campaign, **what is the single change most likely to be
wrong in a way neither of us has noticed?** Not the most severe — the least
verified. And: is there a branch in claim 7's table you would not have skipped?
