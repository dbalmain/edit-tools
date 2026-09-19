Verdict: **needs work**. The code merge appears sound, but the campaign introduces misleading tracked documentation, leaves one canonical finding contradicted by newly merged evidence, and exposes a missing artifact from a skipped branch.

## Findings

1. **The merged share-line note disproves current canonical guidance.**

   [.ai/done-share-line.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/.ai/done-share-line.md:13) demonstrates that:

   - The valid leaf output is `a\n # c\n`, not `a # c`.
   - Merely substituting `content_end` creates an extra blank line.
   - The proposed monotonic rule is false: a TOML multiline-string case moves a comment from its own line onto a suffix.

   But [docs/onboarding/FINDINGS.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/docs/onboarding/FINDINGS.md:996) still presents the disproved output and fix as correct, and repeats the safe-direction claim later. This is more than a stale historical note: the newly tracked evidence says the canonical design record is wrong. Update `FINDINGS.md` as part of the campaign or clearly record the correction next to it.

2. **Several newly tracked notes make unqualified claims that current `main` has falsified.**

   Examples:

   - [.ai/done-parity.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/.ai/done-parity.md:5) and [.ai/parity-reachability.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/.ai/parity-reachability.md:3) say there are 12 sites and no load validator. There are now 13 sites, and both runtimes validate loaded trees.
   - [.ai/done-header-silence.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/.ai/done-header-silence.md:7) describes `/1` and `/2` as the accepted formats. Both runtimes now accept 1–3.
   - [.ai/done-ledger.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/.ai/done-ledger.md:9) describes 142 live records and seven bad reasons. The current ledger has 140 records and those reasons have been re-signed.
   - [.ai/done-reason-rot.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/.ai/done-reason-rot.md:24) says the live scan is 9/142. A focused run of `harness/reason_rot.py` reported `0 hits in 140 records`.

   These can remain as historical records, but they need prominent “snapshot at commit X; superseded by Y” headers. Their current-tense openings are unsafe for future agents.

3. **`spike/rust-subwidth` is not fully superseded: canonical documentation links to a report that exists only on that branch.**

   [docs/onboarding/FINDINGS.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/docs/onboarding/FINDINGS.md:1656) links to `corpus/reports/rust/subwidth-spike.md`, but that file is absent from `main`. It exists in the spike’s `4324c57`.

   I would not merge the whole spike: its production work has landed and the rest is obsolete. I would extract that report into a documentation-only commit, or change the link to state explicitly that the artifact is branch-retained. Until then, I would not delete this branch.

4. **A new test mutates a real tracked package file.**

   [harness/test_score.py](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/harness/test_score.py:477) renames `packages/json.json` to `.aside`, restoring it in `finally`. A crash or `SIGKILL` can leave the checkout damaged, and the test cannot run from a genuinely read-only checkout. It should instead construct a temporary package root containing placeholders for the real roster except JSON.

5. **`DESIGN.md` is stale after A2.1.**

   [DESIGN.md](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/DESIGN.md:154) still calls source-range projection future work. At [line 178](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/DESIGN.md:178), it says the harness builds the A1 subset from block grammar alone and that safe-break classification remains a prerequisite.

   A2.1 now uses the secondary inline CST to protect code spans, links, and autolinks, and implements the relevant safe-gap/delimiter refusals. Still true: no package activates `source_partitions`, Markdown remains format 2 and `verbatim`, and the browser/reference path has not adopted the projection.

## Claim audit

1. **Correct, with a stronger explanation.** `d1b51ff` has exactly its first parent’s tree. Moreover, `wt/prose-partition` and `a0735f8` are tree-identical across the entire branch slice—not merely similar in their `source_partitions` change. The merge is therefore provenance-only.

   An empty-tree merge is reasonable if campaign completion and reachability are intentional records. Leaving it unmerged would also be content-correct, but would keep falsely advertising unintegrated work. The merge is defensible because tree equivalence was established.

2. **The conflict resolutions preserve a strict superset, but the resulting design document is stale.** `REVIEW.md` has no branch-only deletions when compared with `a05ba4a`; `main` adds later material. The three factual package claims remain true. The A1/future-projection language does not.

3. **The count is independently correct: 13.** The pre-existing 12 runtime source-byte sites are joined by the node-entry `check_source_partition` read. There are nine `Iterator[Case]` generators and one `partition_cases()` definition on each side and after the merge. A2.1’s harness-side reads are producers/analysis, not new formatter runtime sites.

4. **The result is correct, but “add/add conflicts against an empty base” is not.** Both files existed in the merge base. These were simultaneous insertion/content conflicts at the same junctions in existing files. The first-parent delta adds exactly the branch’s `formatted_guests` function and test class; the main-side `grammar_targets` function and secondary-grammar tests remain intact. No other lines in those two files changed, and the top-level spacing is correct.

5. **The production path is inert on this repository, and the tests do exercise the real function.** A read-only manifest probe found 16 languages and an empty `awaiting_package` result.

   The feature-positive tests call the real `score.awaiting_package`; they do not reimplement its closure. Reverting to the old behavior would fail the direct, transitive, cycle, opaque-region, and missing-info-guest cases. Newly added tests that would still pass under the old behavior are negative controls:

   - present refusing package remains scored, not pending;
   - present guest package does not pend its host;
   - the current package roster pends nobody.

   [check_gate3.py](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/harness/check_gate3.py:839) is not a second scoring mechanism: it continues auditing semantic/reference behavior even when a package is absent. Therefore a transitive host is not inconsistently “scored” there. Its annotation is nevertheless incomplete—it can label only directly missing packages. The label should use the shared transitive result without suppressing the gate-3 audit.

6. **No code was contributed, but there are seven new Markdown files, not six.** The non-`.ai/` diff is empty. The newly tracked notes are exactly seven Markdown files. Several are stale as described above.

7. **Most skipped branches are correctly classified, but `spike/rust-subwidth` retains a required report artifact.** I inspected unique commits and relevant diffs, not just commit distance. I found no hidden production fix in the implementation losers, alternate TOML/YAML arms, old alignment/cell spikes, backup TOML branch, or gate-3 arm. Their useful fixes or construct discoveries are present in evolved form on `main`; some alternate fixture text remains unique but is experimental corpus material, not a missing fix.

## Least-verified change

The change most likely to hide an unnoticed code defect is the new `formatted_guests` dependency graph. Its tests are real and meaningful, but the current repository supplies no missing package, so production always takes the empty-closure path. It also separately models routing rules from `injection.region_for`, creating a future drift seam. The strongest missing check is an end-to-end scorer run over a temporary real roster with one guest package absent—not merely a direct call to `awaiting_package`.

I applied `REVIEW.md`’s standing checks here: independently counted parity sites and performed the requested mutation-style audit of the pending tests. I did not run `./test.sh`, edit anything, or push.