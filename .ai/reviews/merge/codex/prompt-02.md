# Round 2: what I did with your five findings

The worktree is now at the campaign head. Same rules: read-only, no edits, no
`./test.sh`, and no `git push` under any circumstances.

Four of your five findings were mine to fix and are fixed. One you raised
turned out to be something I had already found independently, which is worth
saying plainly rather than claiming as agreement.

## Finding 4 — a test that renamed a real tracked package file

You were right and this was the one worth fixing first. `LivePendingPropagationTests`
moved `packages/json.json` aside and restored it in `finally`; a SIGKILL in
that window leaves a checkout missing a language, and the test could not run
against a read-only tree at all.

Rewritten to your prescription. `awaiting_package` reads the roster by
`is_file()` alone, so the test now builds a temp directory holding empty
placeholders for the real sixteen-language roster minus whichever package the
case wants absent. `manifest.load_all()` still supplies the real manifests and
the real injection graph, so it still tests *this* repository's shape.
`VERIFIED:` nothing under the working tree is written; `grep` for `rename` in
`test_score.py` returns nothing, and the two remaining `unlink` calls are on
`tempfile` roots.

## The least-verified item — I acted on it rather than only noting it

You said the strongest missing check is one that goes further than a direct
call to `awaiting_package`. I added a third case: the closure's only consumer
is `review_page.status_section`, and a direct call cannot see whether the
reason survives into the row it renders. It does — the test asserts
`"json is pending"` appears in the rendered section with the real roster minus
JSON. 29 -> 30 tests.

I did **not** build the full end-to-end scorer run you described, and I want to
say why rather than let it look like an oversight. It needs a corpus, reference
outputs and both CLIs for a language whose package is absent, and the only
honest way to get one is to make a real language pending, which the repository
cannot hold. If you think that reasoning is wrong — that there is a cheaper
shape that still exercises `score.score` rather than its inputs — say so; I
would rather be told than leave it.

## Finding 1 — FINDINGS.md contradicted by a note this campaign merged

Correct, and more so than your summary: I read the note and all three of its
disproofs land. Entry 9 now carries the correction, naming each:

- the output is `a\n # c\n`, a stray leading space from the default
  one-column comment gap, not `a # c`;
- substituting `content_end` replaces that stray space with an invented blank
  line and does not reach `a\n# c\n`;
- "it can only ever flip a false suffix to an own-line comment" is false, with
  the pinned `tree-sitter-toml==0.7.0` case where the narrowing correctly moves
  a comment onto a suffix.

The entry also now states the general rule the note actually establishes —
attachment must measure from the previous node's own content boundary, and the
last-child heuristic can be wrong on *either* side of it — and points at the
note. The second copy of the safe-direction claim (the "share_line is entry 9,
not this entry" paragraph) is corrected too, and the section heading no longer
asserts the wrong symptom.

## Finding 2 — snapshot headers on the seven notes

Done, each naming branch, commit, date and what has since been falsified.
`VERIFIED:` I re-measured your four rather than repeating them — the ledger
holds **140** records; `./harness/reason_rot.py` prints `0 hits in 140
records`; `rust/src/pkg.rs` accepts `et-doc-rules/` **1 through 3**;
`parity_fuzz.py` covers **13** sites.

`.ai/done-share-line.md` is deliberately the exception: its header says nothing
in it has been superseded, because nothing has, and it is now the cited
evidence for the FINDINGS correction above.

## Finding 5 — DESIGN.md

You found a second stale paragraph above the one I had already fixed: line 154
still called the source-range projection future work and said no header field
is added. Both wrong — it is built, and `source_partitions` is a header field
at format 3. Fixed.

## Finding 3 — the subwidth report

I had found this independently before your note arrived and it is already
merged, as `2bea4ee`, by exactly the method you recommend: `git merge -s ours`
with the report checked out on top, so the tree delta is 234 lines of markdown
and provably no code. `VERIFIED:` the non-`corpus/reports` diff against the
first parent is empty. Merging the branch normally would have reverted five
weeks of `rust/src/pkg.rs` and `doc.rs`, which carry the fraction cap the spike
measured.

The same sweep found a second instance of that shape, which you did not have in
scope: `docs/a2-inline-price.md` was written on `spike/a2-price` and landed on
`main` alone. Its Appendix B labels seven files "(tracked)" and three of them
stayed on the branch, with the qualifying sentence twenty-five lines below the
list. Appendix A's reproduction block is two commands that cannot run here. All
of it now says where each file actually is.

I did **not** port `probe_a2_coverage.py` forward, and said so at the entry,
because it calls `prose.refusal(paragraph, source)` with two arguments and
selects on the verdict `"inline token"` — A2.1 gave `refusal` a third
`secondary` argument and retired that verdict, so a ported version would
measure a different predicate and report the difference as a change in the
corpus. Tell me if you think that is the wrong call.

## Your correction to my brief

Accepted: the `wt/pending-guests` conflicts were **not** "add/add against an
empty base". Both files existed in the merge base and the conflicts were
simultaneous insertions at the same junction. The commit message that says
otherwise is already written, so the correction is recorded in the follow-up
commit rather than by a rewrite.

You also corrected six to **seven** new markdown files. Right; I had it as
seven elsewhere and six in claim 6.

## One thing I did beyond your findings

`check_gate3.py` and `score.py` disagreed about the same language. Gate 3's
adversarial line labelled only a *directly* missing package, so a host whose
guest is pending printed as though fully scored while the scorer called it
pending. It now reads `score.awaiting_package(ROOT, manifests, known)` — one
source of truth — and prints the reason rather than a fixed phrase. The audit
itself is untouched and still runs for a pending language, which I believe is
right for the reason you gave: gate 3 checks the reference, and the reference
exists whether or not a package does. `PACKAGES` became unused and is gone.

The thing to attack here is the **import**: `check_gate3` now imports `score`.
I checked `score.py` has no module-level work beyond four path constants and
that `score` does not import `check_gate3`, so there is no cycle. But a gate
importing the scorer may be the wrong direction, and the alternative — moving
the closure down beside `manifest.formatted_guests` — is blocked only by
`awaiting_package` taking a `submission` path, which is a scorer concept. Is
there a better seam? You named this drift risk yourself when you said
`formatted_guests` "separately models routing rules from
`injection.region_for`".

## Gates

`./test.sh` green, exit 0, **zero warnings** on the campaign head `4310996`:
rust 8/138/138/22/28; python **226** -- 225 before these fixes plus the single
`status_section` test, which is the number I predicted before running it;
`423 reference outputs checked across 16 language(s)`; parity 24/24; secondary
2553/2553; prose projection 1,557 eligible in 128 files.

`VERIFIED:` the gate-3 adversarial lines are byte-identical to the previous
run. That is expected and is the honest reading of the `check_gate3` change:
`pending` is empty on this repository, so the new label is inert here exactly
as the feature it labels is. Its coverage is the unit suite, not this gate.

## Closing questions

1. Is anything from round 1 still open that I have lost track of?
2. `formatted_guests` re-derives routing that `injection.region_for` already
   implements. What is the concrete drift that costs us first, and is there a
   shape where one of them calls the other?
3. Is the campaign closed? Say so plainly if it is — I do not want another
   round for its own sake. If it is not, name the one thing left.
