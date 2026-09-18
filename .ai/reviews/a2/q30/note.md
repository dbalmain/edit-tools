# Q30 done-note

**Status.** Harness sketched; corpus numbers not yet in.

Sibling `harness/bench_format_pass.{py,mjs}`, not an extension of the Q29
files: the clock is `format()`, the arms are shipped vs A1-projected, and the
second term is a counterfactual postcheck. Q29's corpus listing, warmup /
median / max, and control-fails-the-run discipline are reused.

**Already verified, before any timed run.**

- `refusal()` is `harness/prose.py:192`.
- Tracked-corpus `"block acquisition"` count is **32, not 31**. The extra
  paragraph is `corpus/reports/html/report.md` (`1.` — a genuine interruptor).
  8 are in `harness/fixtures/prose-refused.md`. 7 real-document `--` atoms
  match the brief's 7. Prefix-hit paragraphs: 16, as stated.
- Format is on-demand (`markdown.js:536`, width 80, `:w` / `\F`). It is not
  on the 150 ms parse debounce.

**Chosen shape.** Sibling. Q29 times `attachSecondaries` inside `parse()`.
This times `format()` of an already-parsed tree and asks a different question
of the same files.
