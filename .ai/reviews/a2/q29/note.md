# Q29 note

Skeleton in. Driver + orchestrator exist. Next: one-file run, then full corpus.

## Brief vs tree

- `web/js/markdown.js:298` `scheduleReparse(0)` on open. Confirmed.
- `:302` default delay 150. Confirmed.
- `dispatch` at 497 calls `scheduleReparse()` (the 150 ms default) after every
  text-changing key. `replaceAll` at 506 uses 0.
- The timer **resets on every changing keystroke**. It does not run while
  someone types without pausing; it runs after 150 ms of quiet. The brief's
  "repeatedly while someone types" is the pause-between-bursts case, not a
  per-keystroke parse.
- `web/js/lang.js:89` `parse()`, `:99` `attachSecondaries`. Confirmed.
- `web/gen.py` PARSE_LAYER is lines 88–89, not 92. `shutil.copy` at 96 is
  still verbatim. `web/vendor/` is gitignored and absent here; a sibling
  worktree at the same SHA has a **stale** vendor (ts_secondary.mjs and
  ts_doc.mjs differ). Fresh copy is the claim, and the claim holds. Bench
  imports `harness/ts_*.mjs` directly.
- FINDINGS.md 199173 B, LEDGER.md 112808 B. Confirmed. 114 tracked `*.md`.
- `attachSecondaries`: one `await load()`, then a fully synchronous range
  loop. After the table is cached, `await` still yields one microtask, then
  the loop runs to completion. Metric 3 is that loop. Brief is right.
- `parse()` at `ts_lr.mjs:2555` does `new Language(blob)` + `new Parser` on
  every call, so every inline slice pays construction. Left inside the clock.
- a2-inline-price.md:597 is the 80–300 ms candidate-subset figure, and it
  does say it is not evidence for per-keystroke reparsing. Confirmed.

## Design departures

- One Node process for the whole corpus, not one per file (blob JSON parse
  would otherwise dominate). Stated in the orchestrator docstring.
- Headline is the post-load stretch, not total `parse()`. Total is still
  measured. `parse()` yields between block parse, attach, and inject, so
  those are separate sync stretches; the one that can drop a frame is the
  longest of them.

## Status

Skeleton ran: `--only README.md` (8 files matching the substring) plus
controls. Negative Δ 0.078 ms. Synthetic Pearson r=1.0000. Largest of
that slice: `web/README.md` stretch 16.4 ms max / 14.5 ms median on 37
ranges. Committed. Full corpus next.
