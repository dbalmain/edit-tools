One round-one item remains open: [DESIGN.md:196](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/DESIGN.md:196) still says safe-break classification remains a prerequisite. For A2.1’s admitted set, it is closed; [docs/prose-projection.md:570](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/docs/prose-projection.md:570) says exactly that. The remaining prerequisites are extending the classification to A2.2–A2.4 and establishing gate-3 equivalence. I would rewrite that one sentence accordingly.

Everything else from round 1 is closed. I verified the subwidth merge independently: its first-parent delta is exactly the report. You had already found that missing artifact; the resulting fix agrees with my later finding, but the discovery was yours. Not porting `probe_a2_coverage.py` was also correct. It is the executable definition of a historical measurement; adapting it to A2.1 would create a new measurement under an old name. A future live measurement should be a new probe with a new baseline.

Your end-to-end reasoning is sound, with one correction: `score.score()` cannot test pending propagation because it is downstream of the decision. `score.main()` computes pending and removes those manifests before calling `score.score()`. The existing [PendingMainTests](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/harness/test_score.py:529) already exercise the cheapest honest boundary by invoking `main()` and checking what reaches the mocked scorer. Running real CLIs would add expense without testing the closure more directly.

The new review-page test is useful, but its comment at [test_score.py:515](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/harness/test_score.py:515) is factually wrong: `status_section` is not “the one thing” that reads the result. `score.main` and `check_gate3.main` also consume it. That wording is a refinement, not a blocker. The new `check_gate3` display branch itself has no direct pending-output test, although the shared closure is well covered.

The `check_gate3 -> score` import is safe today, but it is not the best permanent seam. The clean split is:

- A neutral `package_status.py` owns `awaiting_package`.
- Its pure input is the selected manifests, the complete manifest roster, and an available-package set or `has_package(name)` predicate.
- `score`, `review_page`, and `check_gate3` each obtain availability from their submission root and call that helper.
- `manifest` continues to own the pure dependency graph.

That removes the submission-path objection: the closure does not inherently need a path.

There are two concrete routing risks:

1. The first operational cost is already encoded deliberately: an info-routed site makes every alias a capability edge. Therefore the next package-less language added to the roster will also make Markdown pending even if no frozen Markdown tree contains a fence for that language. That is conservative policy, not accidental drift, but it reduces unrelated scoring coverage during staged onboarding.

2. A real semantic mismatch is currently accepted by the schema. [_injections](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/harness/manifest.py:179) does not reject two declarations with the same `node`. [region_for](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/harness/injection.py:32) uses the first declaration, while [formatted_guests](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-merge/harness/manifest.py:562) accumulates all of them. Rejecting duplicate injection node names at manifest load is the simplest guard. No current manifest triggers it, so I would treat this as schema hardening rather than hold this campaign for it.

One factual correction to the brief: the seven snapshot headers name branch and commit, but they do not explicitly name a date. The commit makes the date recoverable, so I do not consider that material.

The campaign is **not quite closed because the stale safe-break sentence from round 1 remains**. Fix that sentence, and I would close it without requesting another review round. I found no remaining code defect that should keep the campaign open. I did not run `./test.sh`, modify the tree, or push.