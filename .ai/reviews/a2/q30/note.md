# Q30 done-note

**Headline.** The second format pass does not sink option C. It is noise.

**Term 1.** One projected `format()` on FINDINGS.md is **19.107 ms** median
/ 25.482 ms max (shipped 14.975 ms). Q29's block parse of that file was
433 ms; attach stretch 354 ms. Format is the cheap half (~23×). Corpus
median 0.763 ms. Warmup 5, timed 11, interleaved, `process.hrtime.bigint()`.

**Term 2.** Document-level postcheck at width 80: **0/114 genuine, 0/114
lexical**. Same at width 40. The precheck's 32 `"block acquisition"`
paragraphs (brief said 31; extra is `corpus/reports/html/report.md` `1.`)
do not wrap their opener onto a new line under `fill`.

**Combined.** `0/114 × 19 ms = 0 ms`. Sensitivity if every genuine-potential
paragraph's document retried: six files, **8.056 ms** sum.

**Subtree.** Layout of a top-level paragraph is independent (`hard` resets
column; markdown `comment_cells` is off). The public `format()` still
prints from `tree.root` with no node-to-output map, so a retry against
today's contract is a whole-document pass. Mini-doc format of one
paragraph is 0.03–0.3 ms; that API does not exist. Moot either way at
P=0.

**Cost model.** Format is on-demand (`:w` / `\F` at width 80), not on the
150 ms parse debounce. `P(trip) × one pass` is extra latency on an
explicit format, not a frame drop while typing. Re-entering via
`formatText` would re-parse and pay the attach stretch; that would sink
option C. The specified retry (re-project, `format()` again) does not.

Sibling `harness/bench_format_pass.{py,mjs}`, not an extension of Q29:
different clock, same corpus and controls discipline. Negative control
did not trip. Positive-trip control genuine-trips at 40, not at 80.
Synthetic format scales with size (Pearson r=0.9995).
