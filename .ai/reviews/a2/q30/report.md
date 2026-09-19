# Q30: what a second format pass costs

Host: Linux-6.18.43-x86_64-with-glibc2.42 | AMD Ryzen 9 9955HX 16-Core Processor | Node v24.19.0
Warmup: 5 unclocked `format()` calls per arm. Timed: median and max of 11 interleaved shipped/projected runs after warmup, `process.hrtime.bigint()`. Width 80 is the editor (`markdown.js:536`). Width 40 is a wrap-sensitivity check, not a second editor.

## Headline

**The second format pass does not sink option C. It is noise.**

`docs/onboarding/FINDINGS.md` projected `format()` **19.107 ms** median / 25.482 ms max (199173 bytes). Shipped (no projection) 14.975 ms. Q29's block parse of the same file was 432.972 ms; attach stretch 354.014 ms. That is 23× cheaper than the block parse and 19× cheaper than the attach stretch.

Slowest projected median: **19.107 ms** (`docs/onboarding/FINDINGS.md`). Format is the cheap half.

Postcheck, document-level, width 80 (editor): **0/114 genuine**, 0/114 lexical `_ACQUIRES`. Width 40: 0/114 genuine. Expected extra cost at the editor width is **0 ms** on this corpus.

## What was verified about the brief

- sibling `harness/bench_format_pass.{py,mjs}`, not an extension of bench_secondary_cost: different clock (`format()` vs `attachSecondaries`), different arms (shipped vs A1-projected), plus a counterfactual postcheck. Corpus listing, warmup/median/max, and control-fails-the-run are the same.
- refusal() is harness/prose.py:192, as the brief said
- markdown.js:536 formats on demand at width 80; :w and \F in editor.js:301. The 150 ms timer at markdown.js:497 is parse, not format
- format() in runtime-js/bundle.js:1962 prints from tree.root after validateTree; there is no subtree entry point
- negative control: 0 eligible, 0 block-acquisition, no postcheck trip, format accepted
- positive-trip control genuine-trips at width 40 and does not wrap at width 80
- synthetic projected-format medians increase with document size (Pearson r=0.9995)
- tracked-corpus block-acquisition paragraphs: 32 (brief said 31; divergence is reported, not silently corrected)

## Controls

A run that could not have falsified its conclusion is not evidence. The negative control is a fenced block with no paragraph: the postcheck must not fire and there must be no second pass, or the harness is measuring something else. The positive-trip control is a one-line paragraph whose `-` wraps at width 40 and not at 80. The size control is a synthetic eligible paragraph repeated 1..1024 times: projected `format()` must increase with document size, or the clock is not on the walk that scales with the tree.

| id | bytes | eligible | block-acq | shipped ms | projected ms | trip 80 | trip 40 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| __control__/negative.md | 10 | 0 | 0 | 0.059 | 0.054 | no | no |
| __control__/trip.md | 46 | 0 | 1 | 0.018 | 0.018 | no | genuine |
| __control__/synth-1.md | 116 | 1 | 0 | 0.019 | 0.250 | no | no |
| __control__/synth-4.md | 464 | 4 | 0 | 0.043 | 0.546 | no | no |
| __control__/synth-16.md | 1856 | 16 | 0 | 0.108 | 1.103 | no | no |
| __control__/synth-64.md | 7424 | 64 | 0 | 0.318 | 4.445 | no | no |
| __control__/synth-256.md | 29696 | 256 | 0 | 1.591 | 16.019 | no | no |
| __control__/synth-1024.md | 118784 | 1024 | 0 | 4.784 | 72.267 | no | no |

## Corpus

114 tracked markdown files (`git ls-files '*.md'`, excluding this slice's and Q29's note/report).

| file | bytes | eligible | block-acq | shipped ms | projected ms | projected max | trip 80 | trip 40 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `docs/onboarding/FINDINGS.md` | 199173 | 52 | 3 | 14.975 | 19.107 | 25.482 | no | no |
| `docs/highlight-design.md` | 66221 | 30 | 1 | 7.136 | 9.104 | 13.854 | no | no |
| `docs/onboarding/LEDGER.md` | 112808 | 15 | 0 | 4.737 | 5.442 | 6.081 | no | no |
| `proposals/grok-1.md` | 40998 | 14 | 1 | 4.825 | 5.436 | 9.083 | no | no |
| `docs/prose-projection.md` | 39072 | 18 | 2 | 1.683 | 4.008 | 7.401 | no | no |
| `docs/gate-narrowing.md` | 46664 | 14 | 0 | 2.074 | 4.002 | 6.926 | no | no |
| `docs/a2-inline-price.md` | 40684 | 13 | 0 | 2.755 | 3.820 | 6.894 | no | no |
| `docs/onboarding/LANGUAGES.md` | 54453 | 12 | 0 | 2.742 | 3.533 | 8.654 | no | no |
| `docs/scanner-vm.md` | 48400 | 16 | 0 | 2.385 | 3.302 | 4.940 | no | no |
| `corpus/reports/html/corpus-report.md` | 36088 | 14 | 0 | 2.792 | 3.193 | 4.283 | no | no |
| `proposals/codex-1.md` | 23525 | 8 | 0 | 2.046 | 3.044 | 4.404 | no | no |
| `DESIGN.md` | 45396 | 6 | 0 | 2.579 | 2.890 | 7.000 | no | no |
| `docs/roadmap.md` | 37011 | 16 | 0 | 1.802 | 2.879 | 4.322 | no | no |
| `corpus/reports/haskell/corpus-report.md` | 34732 | 13 | 0 | 2.288 | 2.820 | 3.992 | no | no |
| `docs/parse-all-languages.md` | 41578 | 10 | 0 | 2.178 | 2.709 | 4.193 | no | no |
| `corpus/reports/scheme/corpus-report.md` | 41636 | 8 | 0 | 2.331 | 2.574 | 4.749 | no | no |
| `docs/onboarding/WORKFLOW.md` | 29335 | 13 | 0 | 1.891 | 2.546 | 5.790 | no | no |
| `corpus/reports/ruby/corpus-report.md` | 33186 | 3 | 0 | 2.241 | 2.401 | 4.463 | no | no |
| `corpus/reports/markdown/corpus-report.md` | 35609 | 5 | 0 | 2.175 | 2.334 | 3.562 | no | no |
| `corpus/reports/typescript/corpus-report.md` | 36989 | 9 | 1 | 2.004 | 2.334 | 5.114 | no | no |
| `corpus/reports/javascript/corpus-report.md` | 35201 | 5 | 1 | 2.088 | 2.247 | 4.499 | no | no |
| `corpus/reports/yaml/corpus-report.md` | 26395 | 6 | 0 | 1.857 | 2.135 | 2.843 | no | no |
| `docs/onboarding/templates/corpus-brief.md` | 29230 | 6 | 0 | 1.758 | 2.109 | 4.832 | no | no |
| `docs/parse-measurements.md` | 28476 | 7 | 1 | 1.771 | 2.098 | 2.164 | no | no |
| `docs/parse-layer.md` | 27996 | 10 | 1 | 1.532 | 2.096 | 4.028 | no | no |
| `docs/injection.md` | 23466 | 8 | 0 | 1.199 | 2.091 | 2.191 | no | no |
| `corpus/reports/rust/corpus-report.md` | 30196 | 7 | 0 | 1.880 | 2.083 | 2.198 | no | no |
| `corpus/reports/xml/corpus-report.md` | 27622 | 8 | 0 | 1.715 | 1.921 | 3.319 | no | no |
| `corpus/reports/css/corpus-report.md` | 23198 | 7 | 0 | 1.607 | 1.854 | 4.209 | no | no |
| `corpus/reports/kotlin/corpus-report.md` | 27982 | 2 | 1 | 1.758 | 1.783 | 2.118 | no | no |
| `REVIEW.md` | 23452 | 1 | 0 | 1.566 | 1.671 | 3.435 | no | no |
| `docs/competition.md` | 14346 | 11 | 0 | 1.055 | 1.669 | 1.779 | no | no |
| `docs/web-editor.md` | 20473 | 6 | 3 | 1.230 | 1.627 | 2.806 | no | no |
| `docs/tree-interface-probe.md` | 18159 | 8 | 0 | 1.042 | 1.489 | 1.517 | no | no |
| `corpus/reports/rust/report.md` | 17575 | 6 | 0 | 1.236 | 1.478 | 3.196 | no | no |
| `docs/cst-contract.md` | 18637 | 8 | 0 | 1.105 | 1.345 | 1.507 | no | no |
| `docs/onboarding/templates/review-brief.md` | 23673 | 2 | 0 | 1.231 | 1.339 | 1.443 | no | no |
| `docs/design.md` | 16408 | 10 | 1 | 0.928 | 1.333 | 1.442 | no | no |
| `corpus/reports/go/corpus-report.md` | 18756 | 4 | 0 | 1.095 | 1.261 | 1.309 | no | no |
| `corpus/reports/toml/corpus-report.md` | 15955 | 5 | 0 | 0.972 | 1.184 | 1.550 | no | no |
| `.ai/parse/recover.md` | 15226 | 5 | 1 | 0.915 | 1.149 | 1.540 | no | no |
| `docs/onboarding/cell-spike.md` | 12332 | 2 | 0 | 1.050 | 1.125 | 2.025 | no | no |
| `proposals/claude-1.md` | 7683 | 5 | 0 | 0.837 | 1.101 | 2.016 | no | no |
| `corpus/reports/typescript/report.md` | 16333 | 1 | 0 | 1.010 | 1.042 | 1.617 | no | no |
| `corpus/reports/haskell/report.md` | 8028 | 6 | 0 | 0.442 | 1.021 | 2.175 | no | no |
| `.ai/parse/length.md` | 8280 | 4 | 0 | 0.584 | 0.933 | 2.259 | no | no |
| `.ai/done-a2-foundation.md` | 12276 | 3 | 1 | 0.718 | 0.920 | 1.346 | no | no |
| `harness/fixtures/scanner/markdown_inline/adversarial.md` | 5858 | 0 | 0 | 0.887 | 0.879 | 0.891 | no | no |
| `corpus/reports/yaml/report.md` | 10686 | 3 | 0 | 0.701 | 0.870 | 0.940 | no | no |
| `.ai/done-corpus-thresholds.md` | 5438 | 7 | 0 | 0.478 | 0.860 | 1.039 | no | no |
| `.ai/parse/scanner.md` | 12121 | 3 | 0 | 0.766 | 0.857 | 0.949 | no | no |
| `docs/markdown-idempotence.md` | 5721 | 8 | 0 | 0.317 | 0.846 | 1.730 | no | no |
| `corpus/reports/ruby/report.md` | 12719 | 1 | 0 | 0.783 | 0.829 | 0.900 | no | no |
| `docs/onboarding/templates/package-brief.md` | 9614 | 5 | 0 | 0.602 | 0.824 | 0.922 | no | no |
| `corpus/reports/scheme/report.md` | 13296 | 4 | 0 | 0.658 | 0.794 | 0.994 | no | no |
| `web/README.md` | 7329 | 4 | 0 | 0.484 | 0.763 | 1.199 | no | no |
| `corpus/reports/html/report.md` | 12508 | 1 | 1 | 0.622 | 0.715 | 0.742 | no | no |
| `corpus/reports/xml/report.md` | 9201 | 2 | 0 | 0.604 | 0.711 | 0.804 | no | no |
| `.ai/done-loader.md` | 5242 | 4 | 0 | 0.482 | 0.693 | 1.612 | no | no |
| `.ai/done-resign.md` | 9129 | 0 | 0 | 0.702 | 0.692 | 1.453 | no | no |
| `corpus/reports/javascript/report.md` | 8688 | 1 | 0 | 0.652 | 0.684 | 0.720 | no | no |
| `corpus/src/markdown/fences.md` | 1045 | 5 | 0 | 0.431 | 0.671 | 1.874 | no | no |
| `corpus/reports/go/report.md` | 8855 | 1 | 0 | 0.607 | 0.650 | 0.657 | no | no |
| `corpus/reports/toml/report.md` | 8185 | 2 | 0 | 0.502 | 0.580 | 0.598 | no | no |
| `docs/host-ctype-divergence.md` | 8453 | 1 | 0 | 0.497 | 0.580 | 1.579 | no | no |
| `corpus/reports/css/report.md` | 6281 | 4 | 0 | 0.426 | 0.542 | 0.580 | no | no |
| `.ai/parse/merge-scanner-into-main.md` | 5510 | 3 | 0 | 0.404 | 0.534 | 0.810 | no | no |
| `corpus/src/markdown/html_blocks.md` | 1726 | 6 | 0 | 0.207 | 0.465 | 0.492 | no | no |
| `corpus/src/markdown/tables.md` | 1384 | 5 | 0 | 0.123 | 0.464 | 1.392 | no | no |
| `docs/phase2-selection.md` | 4788 | 4 | 0 | 0.222 | 0.455 | 0.570 | no | no |
| `corpus/reports/kotlin/report.md` | 4755 | 2 | 0 | 0.339 | 0.436 | 1.374 | no | no |
| `corpus/src/markdown/sections.md` | 1024 | 6 | 0 | 0.169 | 0.435 | 0.459 | no | no |
| `docs/house-style.md` | 6531 | 3 | 0 | 0.317 | 0.424 | 0.588 | no | no |
| `corpus/reports/markdown/prose-wrap.md` | 8643 | 1 | 0 | 0.388 | 0.423 | 0.442 | no | no |
| `harness/reviews/README.md` | 3053 | 3 | 0 | 0.261 | 0.416 | 0.849 | no | no |
| `corpus/reports/markdown/report.md` | 5514 | 1 | 0 | 0.377 | 0.400 | 1.222 | no | no |
| `harness/fixtures/prose-refused.md` | 4628 | 0 | 8 | 0.369 | 0.373 | 0.816 | no | no |
| `corpus/contrib/README.md` | 2053 | 2 | 0 | 0.213 | 0.320 | 0.332 | no | no |
| `corpus/src/markdown/blockquotes.md` | 888 | 3 | 0 | 0.186 | 0.300 | 0.911 | no | no |
| `corpus/src/markdown/comments.md` | 748 | 0 | 0 | 0.272 | 0.257 | 0.382 | no | no |
| `README.md` | 1859 | 1 | 0 | 0.171 | 0.237 | 0.365 | no | no |
| `corpus/src/markdown/nesting.md` | 424 | 0 | 0 | 0.228 | 0.232 | 0.878 | no | no |
| `corpus/src/markdown/kitchen.md` | 520 | 0 | 0 | 0.196 | 0.202 | 0.979 | no | no |
| `harness/bench_break_propagation.md` | 3590 | 0 | 1 | 0.205 | 0.201 | 0.209 | no | no |
| `corpus/src/markdown/leading_sections.md` | 192 | 2 | 0 | 0.041 | 0.200 | 0.300 | no | no |
| `corpus/src/markdown/lists.md` | 574 | 0 | 1 | 0.182 | 0.184 | 0.190 | no | no |
| `reference/README.md` | 831 | 3 | 0 | 0.075 | 0.177 | 0.304 | no | no |
| `corpus/src/markdown/prose_wrap.md` | 1019 | 1 | 0 | 0.054 | 0.145 | 0.154 | no | no |
| `corpus/src/markdown/long_sequences.md` | 412 | 0 | 1 | 0.144 | 0.143 | 0.147 | no | no |
| `spike/scanner-vm/rust/README.md` | 1710 | 0 | 0 | 0.125 | 0.122 | 0.124 | no | no |
| `corpus/src/markdown/tables_nested.md` | 533 | 0 | 0 | 0.114 | 0.113 | 0.141 | no | no |
| `spike/scanner-vm/locale/README.md` | 620 | 1 | 0 | 0.058 | 0.102 | 0.105 | no | no |
| `corpus/src/markdown/normalisation.md` | 456 | 0 | 0 | 0.095 | 0.095 | 0.100 | no | no |
| `corpus/src/markdown/headings.md` | 227 | 2 | 0 | 0.076 | 0.090 | 0.094 | no | no |
| `spike/scanner-vm/record/README.md` | 787 | 0 | 0 | 0.090 | 0.089 | 0.093 | no | no |
| `corpus/src/markdown/indented_code.md` | 460 | 1 | 0 | 0.059 | 0.078 | 0.083 | no | no |
| `corpus/src/markdown/fence_delimiters.md` | 352 | 0 | 0 | 0.077 | 0.078 | 0.104 | no | no |
| `corpus/src/markdown/links.md` | 412 | 0 | 0 | 0.074 | 0.074 | 0.099 | no | no |
| `harness/fixtures/injection/regions.md` | 118 | 0 | 0 | 0.074 | 0.073 | 0.075 | no | no |
| `corpus/src/markdown/json_comment_containers.md` | 57 | 0 | 0 | 0.060 | 0.060 | 0.065 | no | no |
| `corpus/src/markdown/strings.md` | 467 | 0 | 0 | 0.054 | 0.055 | 0.056 | no | no |
| `corpus/src/markdown/list_markers.md` | 99 | 0 | 0 | 0.041 | 0.041 | 0.043 | no | no |
| `harness/fixtures/secondary-mixed.md` | 81 | 0 | 0 | 0.020 | 0.021 | 0.022 | no | no |
| `corpus/src/markdown/emphasis.md` | 95 | 0 | 0 | 0.015 | 0.015 | 0.016 | no | no |
| `harness/fixtures/secondary-dirty.md` | 29 | 0 | 0 | 0.012 | 0.012 | 0.019 | no | no |
| `corpus/src/markdown/thematic.md` | 64 | 0 | 0 | 0.012 | 0.012 | 0.013 | no | no |
| `corpus/src/markdown/indented_code_heading.md` | 14 | 0 | 0 | 0.011 | 0.011 | 0.011 | no | no |
| `harness/fixtures/scanner/markdown_inline/mismatched_backtick.md` | 12 | 0 | 0 | 0.007 | 0.007 | 0.009 | no | no |
| `harness/fixtures/scanner/markdown_inline/mismatched_dollar.md` | 12 | 0 | 0 | 0.007 | 0.007 | 0.009 | no | no |
| `harness/fixtures/scanner/markdown_inline/unclosed_backtick.md` | 48 | 0 | 0 | 0.007 | 0.007 | 0.009 | no | no |
| `harness/fixtures/secondary-clean.md` | 25 | 0 | 0 | 0.007 | 0.007 | 0.007 | no | no |
| `harness/fixtures/scanner/markdown_inline/unclosed_dollar.md` | 49 | 0 | 0 | 0.007 | 0.007 | 0.007 | no | no |
| `docs/parse-survey.md` | 60655 | 9 | 0 | refused | refused | refused | no | no |
| `docs/parse-tables-spike.md` | 37899 | 12 | 2 | refused | refused | refused | no | no |

## Summary

Projected `format()` corpus median 0.763 ms; max median 19.107 ms; max of maxima 25.482 ms.

Shipped (verbatim paragraphs) corpus median 0.602 ms; max median 14.975 ms.

Pearson correlation of projected median with document bytes: 0.9517.

Document-level postcheck at width 80: 0/114 genuine (0.0%), 0/114 lexical. At width 40: 0/114 genuine.

Term 1, one `format()` pass (projected, width 80): corpus median 0.763 ms, worst 19.107 ms on FINDINGS.md.

Term 2, P(document trips the postcheck) at width 80: 0/114 = **0.000**.

Combined expected extra cost: 0/114 × one pass = **0.000 ms**. Own-median sum over files that trip: **0.000 ms**.

Sensitivity, not the measurement: if `fill` had wrapped every genuine-potential paragraph, 6 documents would retry, and the extra cost would be the sum of their projected medians, **8.056 ms** (`.ai/parse/recover.md`, `corpus/reports/html/report.md`, `corpus/src/markdown/lists.md`, `docs/prose-projection.md`, `docs/web-editor.md`, `harness/fixtures/prose-refused.md`).

Fill of an all-eligible document is more expensive than today's verbatim walk (the 1024-paragraph control, in the table above). FINDINGS.md has 52 eligible paragraphs in 199173 bytes, so projection adds 4.133 ms (19.107 − 14.975). Both stay an order below the block parse.

2 files refused `format()` on both arms (`docs/parse-survey.md`, `docs/parse-tables-spike.md`). parse-survey.md is a dirty C injection (`field_declaration_list` separator); parse-tables-spike.md has an injected `continue_statement` with no package rule. Unrelated to prose. Their block-acquisition paragraphs were still mini-formatted and did not trip.

25 corpus files have no eligible and no block-acquisition paragraph. None of them tripped — extra negative controls the corpus happened to contain.

## Block-acquisition paragraphs

32 paragraphs currently refused as `block acquisition` across 19 files. **The brief said 31; this run found 32.** The extra paragraph is `corpus/reports/html/report.md` (`1.`, a genuine interruptor). Of the 32: 10 incomplete-marker prefix hits (`0.5.1,`, `3.9.6`, `0.63`, …), 6 complete ordered markers whose start is not 1 (`81.`, `2026.`, `60.`, …), and 16 genuine-potential openers (8 in `prose-refused.md`, 8 in real documents — seven `--` plus the extra `1.`). The brief's 16 prefix hits are prefix + ordered-n. Its 15 hazards missed the `1.`.

None of the 32 tripped the postcheck at width 80 or 40. Adversarial all-newline reflow would put a genuine opener at a line start in the 16 hazard paragraphs; `fill` at the editor width does not. It wraps *after* a sentence-final `1.` and keeps `--` between words. The fixture `alpha beta gamma - delta …` at width 40 becomes `… zeta` / `eta theta` — the `-` stays on line 1. The `:-` that already sat on its own line was *joined* back onto the previous line.

| file | start | class | lexical 80 | genuine 80 | shape 80 | lexical 40 | genuine 40 | shape 40 | hits |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| `.ai/done-a2-foundation.md` | 2763 | prefix | — | — | no | — | — | no | 0.5.1, |
| `.ai/parse/recover.md` | 12955 | hazard | — | — | no | — | — | no | -- |
| `corpus/reports/html/report.md` | 5147 | hazard | — | — | no | — | — | no | 1. |
| `corpus/reports/javascript/corpus-report.md` | 17382 | prefix | — | — | no | — | — | no | 3.9.6: |
| `corpus/reports/kotlin/corpus-report.md` | 4534 | prefix | — | — | no | — | — | no | 0.63 |
| `corpus/reports/typescript/corpus-report.md` | 12725 | prefix | — | — | no | — | — | no | 3.9.6 |
| `corpus/src/markdown/lists.md` | 401 | hazard | — | — | no | — | — | no | -- |
| `corpus/src/markdown/long_sequences.md` | 51 | ordered-n | — | — | no | — | — | no | 81. |
| `docs/design.md` | 2425 | ordered-n | — | — | no | — | — | no | 2026. |
| `docs/highlight-design.md` | 15574 | ordered-n | — | — | no | — | — | no | 10. |
| `docs/onboarding/FINDINGS.md` | 36604 | prefix | — | — | no | — | — | no | 3.9.6 |
| `docs/onboarding/FINDINGS.md` | 42251 | ordered-n | — | — | no | — | — | no | 3. |
| `docs/onboarding/FINDINGS.md` | 86571 | prefix | — | — | no | — | — | no | 1.9.0: |
| `docs/parse-layer.md` | 3125 | ordered-n | — | — | no | — | — | no | 5. |
| `docs/parse-measurements.md` | 22540 | prefix | — | — | no | — | — | no | 0.4, 0.23 |
| `docs/parse-tables-spike.md` | 10638 | prefix | — | — | no | — | — | no | 6.3, 17.5 |
| `docs/parse-tables-spike.md` | 19368 | prefix | — | — | no | — | — | no | 0.26.0 |
| `docs/prose-projection.md` | 6719 | hazard | — | — | no | — | — | no | -- |
| `docs/prose-projection.md` | 14910 | hazard | — | — | no | — | — | no | -- |
| `docs/web-editor.md` | 3903 | hazard | — | — | no | — | — | no | -- |
| `docs/web-editor.md` | 14202 | hazard | — | — | no | — | — | no | -- |
| `docs/web-editor.md` | 16157 | hazard | — | — | no | — | — | no | -- |
| `harness/bench_break_propagation.md` | 1984 | prefix | — | — | no | — | — | no | 20.4x, 8.2x., 1.8x |
| `harness/fixtures/prose-refused.md` | 2037 | hazard | — | — | no | — | — | no | - |
| `harness/fixtures/prose-refused.md` | 2152 | hazard | — | — | no | — | — | no | 1. |
| `harness/fixtures/prose-refused.md` | 2546 | hazard | — | — | no | — | — | no | :- |
| `harness/fixtures/prose-refused.md` | 2638 | hazard | — | — | no | — | — | no | :-: |
| `harness/fixtures/prose-refused.md` | 2717 | hazard | — | — | no | — | — | no | :--- |
| `harness/fixtures/prose-refused.md` | 3214 | hazard | — | — | no | — | — | no | -: |
| `harness/fixtures/prose-refused.md` | 3317 | hazard | — | — | no | — | — | no | -- |
| `harness/fixtures/prose-refused.md` | 4579 | hazard | — | — | no | — | — | no | :- |
| `proposals/grok-1.md` | 6654 | ordered-n | — | — | no | — | — | no | 60. |

## Is a subtree reformat sound?

`format()` in `runtime-js/bundle.js` prints from `tree.root`, runs `validateTree` on the whole tree, then `alignCells` on the whole string. Markdown's `comment_cells` is unset (`CELLS_OFF`), and `hard` resets the print column to the current indent, so a top-level paragraph's `fill` does not share a line with its siblings. Layout of one paragraph is therefore independent of the others. The public contract still has no subtree entry point and no node-to-output map: a retry implemented against `format()` is a second whole-document pass. Splicing a verbatim paragraph back into the first-pass string would need output spans the printer does not return; diffing two whole-document formats to find those spans pays for the pass the splice was meant to avoid.

A mini-document of one paragraph is what a subtree API would format. Those times sit next to the whole-document times for the same files. They do not make the whole-document question moot today.

| file | start | subtree ms | whole projected ms |
| --- | ---: | ---: | ---: |
| `.ai/done-a2-foundation.md` | 2763 | 0.245 | 0.920 |
| `.ai/parse/recover.md` | 12955 | 0.095 | 1.149 |
| `corpus/reports/html/report.md` | 5147 | 0.158 | 0.715 |
| `corpus/reports/javascript/corpus-report.md` | 17382 | 0.039 | 2.247 |
| `corpus/reports/kotlin/corpus-report.md` | 4534 | 0.047 | 1.783 |
| `corpus/reports/typescript/corpus-report.md` | 12725 | 0.118 | 2.334 |
| `corpus/src/markdown/lists.md` | 401 | 0.093 | 0.184 |
| `corpus/src/markdown/long_sequences.md` | 51 | 0.106 | 0.143 |
| `docs/design.md` | 2425 | 0.055 | 1.333 |
| `docs/highlight-design.md` | 15574 | 0.062 | 9.104 |
| `docs/onboarding/FINDINGS.md` | 36604 | 0.074 | 19.107 |
| `docs/onboarding/FINDINGS.md` | 42251 | 0.115 | 19.107 |
| `docs/onboarding/FINDINGS.md` | 86571 | 0.035 | 19.107 |
| `docs/parse-layer.md` | 3125 | 0.140 | 2.096 |
| `docs/parse-measurements.md` | 22540 | 0.110 | 2.098 |
| `docs/parse-tables-spike.md` | 10638 | 0.118 | refused |
| `docs/parse-tables-spike.md` | 19368 | 0.034 | refused |
| `docs/prose-projection.md` | 6719 | 0.293 | 4.008 |
| `docs/prose-projection.md` | 14910 | 0.222 | 4.008 |
| `docs/web-editor.md` | 3903 | 0.111 | 1.627 |
| `docs/web-editor.md` | 14202 | 0.160 | 1.627 |
| `docs/web-editor.md` | 16157 | 0.095 | 1.627 |
| `harness/bench_break_propagation.md` | 1984 | 0.254 | 0.201 |
| `harness/fixtures/prose-refused.md` | 2037 | 0.034 | 0.373 |
| `harness/fixtures/prose-refused.md` | 2152 | 0.034 | 0.373 |
| `harness/fixtures/prose-refused.md` | 2546 | 0.030 | 0.373 |
| `harness/fixtures/prose-refused.md` | 2638 | 0.030 | 0.373 |
| `harness/fixtures/prose-refused.md` | 2717 | 0.030 | 0.373 |
| `harness/fixtures/prose-refused.md` | 3214 | 0.030 | 0.373 |
| `harness/fixtures/prose-refused.md` | 3317 | 0.030 | 0.373 |
| `harness/fixtures/prose-refused.md` | 4579 | 0.033 | 0.373 |
| `proposals/grok-1.md` | 6654 | 0.044 | 5.436 |

## Cost model

Format is not on a keystroke path. `web/js/markdown.js:536` binds `:w` and `\F` to `formatText(text, "markdown", 80)`. The 150 ms debounce Q29 measured is `scheduleReparse` in `markdown.js`, reset on every text-changing key; it does not call `format()`. A second format pass is extra latency on an explicit format, not a frame drop while typing. `P(trip) × one pass` is the right model for that extra latency. It is the wrong model for input latency, because format is not on that path.

The retry must re-project the existing tree and call `format()` again. If it went back through `formatText`, it would re-parse and pay Q29's attach stretch (354 ms on FINDINGS.md). That implementation would sink option C. The one specified does not.

Adversarial all-newline reflow is a different question from this postcheck. The brief's 15 reflow-reachable hazards count gap assignments `fill` does not produce at width 80 or 40. Sensitivity: even if every genuine-potential paragraph's document retried, that is six files whose projected medians sum to well under a frame.

## Falsifiers

- If the negative control had tripped, or had grown an eligible paragraph, the harness would have been measuring something other than a postcheck over reflowed prose and the run would have been void.
- If the positive-trip control had not genuine-tripped at width 40, the line-start scan would not have been looking at formatted wrap.
- If synthetic projected medians had not increased with document size (Pearson r < 0.9), the clock would not have been on work that scales with the tree.
- If a document with no eligible and no block-acquisition paragraph had shown a retry, the second pass would have been coming from somewhere else.

