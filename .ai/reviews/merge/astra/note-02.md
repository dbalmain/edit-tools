**Not quite done at `fcb9d32`: the original findings are addressed, but the new route guard needs correction.** Three focused, in-memory probes established why.

1. **The gate depends on local branch inventory.** [_branches()](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-final/harness/test_repo_layout.py:92) reads only `refs/heads/`, and a test explicitly requires `spike/a2-price`. Simulating a checkout with only local `main` makes **two tests fail**. A normal clone need not have those local branches, even when remote-tracking branches exist.

   Record historical branch references in tracked, document-scoped metadata. Checking whether retained branches still exist can be a separate maintenance check; it should not make the default suite depend on the author’s local refs.

2. **The global exception permits the original defect again.** At [line 136](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-final/harness/test_repo_layout.py:136), an allowlisted path is exempt everywhere. I restored `spike/scanner-vm/toml.program.js` in `docs/parse-all-languages.md` in memory: **all four tests still passed**.

   Keeping the historical quotation is right. Scope its exception to `(document, path)`, with the reason. That preserves the evidence without exempting an incorrect instruction elsewhere.

3. **The negative control bypasses extraction.** [The control](/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/review-final/harness/test_repo_layout.py:164) calls `_resolves` directly. Replacing `_PATH_IN_PROSE` with a regex that matches nothing leaves **all four tests passing**, despite the comment claiming protection against exactly that mutation.

   Feed a synthetic document containing a missing route through the same extraction, filtering, exception handling and resolution used by the corpus scan; assert the exact reported route.

Your closing questions:

- **DESIGN:** yes, it now distinguishes the two mechanisms correctly. More precisely, outer gaps remain *candidates*—the block-hazard rule can subsequently remove them.
- **Historical quotation:** retain it and its reasoned exception, scoped to the document.
- **Done:** the merge decisions and original corrections are closed. Fix or withdraw the newly added guard before calling this head finished. These are demonstrated failures, not a request for another exploratory review round.

One small wording refinement: “Only structural edits move the count” is still too broad; changing paragraph content can change eligibility. Say that **replacing numeric cells in this table preserved its histogram**.

The pending-test mutation result required no additional case. I independently confirmed **238 discovered tests**; the allowlist currently contains **15 entries**, not fourteen. No files edited, full gate run, or push performed.