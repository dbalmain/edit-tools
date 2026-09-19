**Verdict: clean with refinements. Consider the merge campaign done; I found no code defect requiring another round.** Three documentation corrections remain.

1. **`DESIGN.md` conflates two protections.** At [line 186](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-final/DESIGN.md:186), gaps flanking every protected span are described as unbreakable. That is false: parsing ``alpha `beta` gamma`` produces breakable gaps at offsets **5 and 12**. Construct interiors are protected whole; bilateral gap protection applies to **block-hazardous atoms**. Change that sentence to distinguish them.

2. **The “no fixed point” claim is false.** [The explanation](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-final/docs/prose-projection.md:520) confuses adding explanatory paragraphs with replacing table numbers. I replaced `1,543` with `9,999` in memory and reparsed the actual document: its histogram remained **43 eligible, 52 inline-construct refusals**. A table with fixed structure and numeric cells can be stable under updating its counts.

   Keeping a historical commit stamp is nevertheless sensible. Remove the impossibility argument—and especially the instruction to dismiss small discrepancies as self-reference. A discrepancy requires measurement, whatever its size.

3. **There is a third stale-path instance.** [docs/parse-all-languages.md:406](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-final/docs/parse-all-languages.md:406) names `spike/scanner-vm/toml.program.js`. Commit `45c76a1` moved it to `harness/scanners/toml.program.js`. Update the path. This predates the campaign; no skipped branch needs merging to recover it. I found it by scanning tracked Markdown references, then checking candidates against the filesystem and history.

On the seven claims:

- **Whole-range accounting:** the literal claim excludes substantial work. `406cf85..HEAD` includes A2.1, the secondary-cost benchmark, browser secondary-attachment switching, and associated gates/tests. **After `a05ba4a`**, the code changes are accounted for by pending-guests and the review fixes. I independently confirmed the tree-identical prose-partition merge, empty non-`.ai` delta across the five notes merges, and report-only subwidth merge.

- **Pending-test sensitivity:** I ran the actual 17 test methods with fixture filesystem operations redirected to memory. Baseline: **17 passed**. Replacing `awaiting_package` with direct absence only: **8 caught the mutation; 9 survived**. The survivors are:

  | Class | Surviving tests |
  |---|---|
  | `AwaitingPackageTests` | Both tests |
  | `PendingGuestTests` | `test_an_opaque_guest_does_not_pending_the_host`; `test_a_present_guest_package_does_not_pending_the_host` |
  | `LivePendingPropagationTests` | `test_the_real_roster_is_complete_so_it_pends_nobody` |
  | `RosterPredicateTests` | `test_roster_on_disk_reports_presence_only` |
  | `AdversarialLabelTests` | All except `test_the_reason_is_the_scorer_s_reason_verbatim` |

  These survivors are appropriate: negative controls, adapter checks, and label tests supplied with an already-computed dictionary. **Sol’s claim that the opaque-region test would fail under direct-only behavior was wrong.**

- **Module seam:** I agree with Sol. Package availability and pending policy belong together; manifest routing remains separately owned. The adapter keeps disk access out of the closure. This is a useful boundary even without an import cycle.

- **Tracked notes:** nothing identified warrants excluding them from the prose corpus. Their historical factual accuracy and their usefulness as parser inputs are separate questions. I independently measured **129 tracked Markdown files, 128 parsing, 1,556 eligible paragraphs**. Version-controlled investigation evidence is defensible, particularly the cited share-line investigation. Routine completion messages do not deserve automatic preservation; durable evidence would be easier to discover under a documented reports directory. I would not reorganize these files to close this campaign.

- **Share-line correction:** the counterexamples support the correction. I independently reproduced the pinned TOML tree’s opening-delimiter-only child and the current JavaScript own-line-comment symptom. The note supports rejecting the last-child heuristic and monotonicity argument; it does not establish a complete repair. The corrected entry already leaves newline ownership and the repair open, which is appropriate.

- **Skipped branches:** I found no reason to merge any of the sixteen. “Superseded or deliberately declined” is more accurate than “contains no unlanded work”: losing implementations and experiments remain unique. Preserve `spike/a2-price` while documentation intentionally routes readers to its historical artifacts.

For your closing question, **A2.1’s block-safety classification is the least-verified change across the full range**. Its strongest residual risk is an admitted shape outside both the fixtures and the parser oracle’s model—the exact failure class your standing checks identify. That is a residual risk, not a newly demonstrated defect or a reason to extend this campaign.

I independently confirmed discovery of **234 Python tests** and an empty pending result for the real **16-language roster**. I did not run `./test.sh`, edit files, or push.