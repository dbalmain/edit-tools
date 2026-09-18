# Q29: secondary attachment cost on the JS parse path

Host: Linux-6.18.43-x86_64-with-glibc2.42 | AMD Ryzen 9 9955HX 16-Core Processor | Node v24.19.0
Warmup: 5 unclocked runs per arm. Timed: median and max of 11 interleaved ON/OFF runs after warmup, `process.hrtime.bigint()`.

## Headline

The number that can drop a frame is the **post-load loop inside `attachSecondaries`**, not total `parse()`. `parse()` yields between the block parse, the attach loop, and inject; those are separate synchronous stretches. After the inline table is in hand the range loop does not yield.

Longest attach stretch: **398.539 ms** (`docs/onboarding/FINDINGS.md`, max of 11; median 354.014 ms). That file's block parse is 432.972 ms — a longer stretch that already existed. Secondary attachment is new, the same order of magnitude, and it does not yield.

Largest median ON−OFF delta: **358.125 ms** (79.9% of OFF) on `docs/onboarding/FINDINGS.md` (594 ranges, 128635 inline bytes, 2.75 µs/inline-byte).

58/114 tracked markdown files have an attach-stretch median over 16 ms (one frame at 60 Hz) on this machine.

## What was verified about the brief

- web/vendor/ absent (gitignored); web/gen.py:96 still shutil.copy's PARSE_LAYER from harness/ with no transformation
- web/gen.py PARSE_LAYER is lines 88–89 (brief said 92); the copy at line 96 is still shutil.copy with no transformation
- markdown.js:298 opens with scheduleReparse(0); :302 defaults to 150 ms; dispatch at 497 resets that timer on every text-changing key; replaceAll at 506 uses 0. The parse runs after 150 ms of quiet, not per keystroke and not continuously while someone types
- lang.js:89 parse() calls attachSecondaries at :99, then injectAll. OFF skips only the attachSecondaries call
- attachSecondaries awaits load() once per site, then parses every matching range synchronously. After the table is cached, await still yields one microtask; the stretch figure includes that yield (microseconds) and then the range loop
- FINDINGS.md is 199173 B, LEDGER.md 112808 B, 116 tracked *.md files (2 of them this slice's force-added note/report, excluded from the corpus table). Brief was right on the sizes; the 114 was before those two files were added.
- negative delta 0.004 ms on a document with 0 inline ranges
- synthetic deltas increase with range count (Pearson r=0.9999)

## Controls

A run that could not have falsified its conclusion is not evidence. The negative control is a fenced block with no `inline` node: ON minus OFF must be ~0, or the clock is not on secondary attachment. The positive control is a synthetic paragraph repeated 1..1024 times: delta must increase with range count, or the clock is not on the work that scales with attachment.

| id | ranges | inline B | OFF ms | ON ms | Δ ms | Δ% of OFF | stretch ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| __control__/negative.md | 0 | 0 | 0.415 | 0.419 | 0.004 | 1.1% | 0.005 |
| __control__/synth-1.md | 1 | 18 | 0.397 | 0.586 | 0.189 | 47.5% | 0.149 |
| __control__/synth-4.md | 4 | 72 | 0.521 | 0.789 | 0.268 | 51.4% | 0.279 |
| __control__/synth-16.md | 16 | 288 | 0.986 | 1.918 | 0.932 | 94.5% | 0.898 |
| __control__/synth-64.md | 64 | 1152 | 3.156 | 6.776 | 3.620 | 114.7% | 3.444 |
| __control__/synth-256.md | 256 | 4608 | 13.955 | 27.135 | 13.181 | 94.5% | 12.803 |
| __control__/synth-1024.md | 1024 | 18432 | 53.656 | 103.794 | 50.138 | 93.4% | 50.269 |

## Corpus

114 tracked markdown files (`git ls-files '*.md'`, excluding this slice's own note/report).

| file | bytes | ranges | inline B | OFF ms | ON ms | Δ ms | Δ% | stretch median | stretch max | block ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `docs/onboarding/FINDINGS.md` | 199173 | 594 | 128635 | 448.487 | 806.612 | 358.125 | 79.9% | 354.014 | 398.539 | 432.972 |
| `docs/onboarding/LEDGER.md` | 112808 | 134 | 107725 | 196.659 | 486.317 | 289.658 | 147.3% | 291.298 | 317.008 | 192.391 |
| `docs/onboarding/LANGUAGES.md` | 54453 | 157 | 50516 | 122.789 | 295.593 | 172.804 | 140.7% | 175.135 | 182.618 | 118.066 |
| `docs/scanner-vm.md` | 48400 | 151 | 36968 | 95.221 | 204.924 | 109.703 | 115.2% | 110.946 | 114.415 | 93.982 |
| `docs/parse-survey.md` | 60655 | 172 | 34014 | 128.429 | 236.831 | 108.402 | 84.4% | 108.119 | 113.647 | 119.403 |
| `docs/parse-all-languages.md` | 41578 | 141 | 37432 | 86.943 | 192.143 | 105.200 | 121.0% | 106.067 | 110.255 | 84.641 |
| `docs/highlight-design.md` | 66221 | 276 | 49435 | 154.320 | 258.352 | 104.032 | 67.4% | 109.676 | 116.184 | 135.769 |
| `docs/roadmap.md` | 37011 | 150 | 36355 | 71.127 | 161.937 | 90.810 | 127.7% | 89.069 | 96.446 | 70.532 |
| `docs/onboarding/templates/corpus-brief.md` | 29230 | 105 | 28271 | 61.839 | 146.206 | 84.367 | 136.4% | 85.776 | 89.685 | 58.811 |
| `docs/prose-projection.md` | 39072 | 103 | 36540 | 74.794 | 152.388 | 77.593 | 103.7% | 76.121 | 76.883 | 73.512 |
| `DESIGN.md` | 45396 | 108 | 39032 | 90.501 | 167.367 | 76.866 | 84.9% | 77.052 | 81.624 | 86.894 |
| `docs/onboarding/templates/review-brief.md` | 23673 | 71 | 23367 | 47.660 | 123.414 | 75.754 | 158.9% | 77.349 | 81.695 | 45.070 |
| `docs/parse-tables-spike.md` | 37899 | 119 | 28865 | 81.088 | 156.584 | 75.496 | 93.1% | 74.809 | 92.303 | 76.248 |
| `proposals/grok-1.md` | 40998 | 168 | 32425 | 97.595 | 165.481 | 67.886 | 69.6% | 67.472 | 69.792 | 89.332 |
| `docs/a2-inline-price.md` | 40684 | 170 | 32247 | 76.738 | 144.059 | 67.321 | 87.7% | 66.765 | 69.747 | 76.100 |
| `docs/parse-layer.md` | 27996 | 106 | 24870 | 57.846 | 124.246 | 66.400 | 114.8% | 66.410 | 67.076 | 57.106 |
| `docs/onboarding/WORKFLOW.md` | 29335 | 106 | 21535 | 59.815 | 125.741 | 65.925 | 110.2% | 63.860 | 67.521 | 57.922 |
| `REVIEW.md` | 23452 | 77 | 23155 | 45.133 | 107.155 | 62.023 | 137.4% | 62.924 | 63.623 | 43.113 |
| `harness/fixtures/scanner/markdown_inline/adversarial.md` | 5858 | 1 | 5857 | 20.247 | 78.751 | 58.504 | 289.0% | 58.755 | 61.069 | 19.470 |
| `corpus/reports/rust/corpus-report.md` | 30196 | 117 | 27111 | 57.381 | 111.108 | 53.727 | 93.6% | 52.432 | 53.650 | 57.837 |
| `docs/gate-narrowing.md` | 46664 | 109 | 37245 | 83.349 | 135.998 | 52.649 | 63.2% | 52.638 | 57.706 | 79.560 |
| `corpus/reports/html/corpus-report.md` | 36088 | 149 | 24944 | 70.920 | 123.475 | 52.556 | 74.1% | 53.027 | 54.102 | 66.612 |
| `corpus/reports/markdown/corpus-report.md` | 35609 | 117 | 23807 | 70.773 | 121.062 | 50.289 | 71.1% | 51.086 | 52.644 | 66.053 |
| `corpus/reports/javascript/corpus-report.md` | 35201 | 105 | 22158 | 65.905 | 114.996 | 49.092 | 74.5% | 48.642 | 49.866 | 62.666 |
| `docs/parse-measurements.md` | 28476 | 101 | 17030 | 59.867 | 107.122 | 47.256 | 78.9% | 46.681 | 48.015 | 58.876 |
| `corpus/reports/haskell/corpus-report.md` | 34732 | 129 | 22892 | 67.072 | 113.873 | 46.801 | 69.8% | 46.916 | 53.295 | 65.832 |
| `docs/web-editor.md` | 20473 | 86 | 16679 | 43.346 | 89.306 | 45.960 | 106.0% | 45.857 | 48.112 | 42.257 |
| `corpus/reports/rust/report.md` | 17575 | 76 | 15395 | 34.364 | 79.748 | 45.383 | 132.1% | 44.633 | 45.672 | 33.781 |
| `corpus/reports/kotlin/corpus-report.md` | 27982 | 104 | 20638 | 52.248 | 97.264 | 45.016 | 86.2% | 44.332 | 45.130 | 51.603 |
| `docs/injection.md` | 23466 | 87 | 22759 | 43.378 | 87.949 | 44.572 | 102.8% | 44.908 | 45.181 | 41.819 |
| `corpus/reports/scheme/corpus-report.md` | 41636 | 113 | 18206 | 71.496 | 111.643 | 40.148 | 56.2% | 38.628 | 40.302 | 71.297 |
| `corpus/reports/ruby/corpus-report.md` | 33186 | 106 | 17980 | 65.394 | 105.146 | 39.752 | 60.8% | 39.131 | 42.728 | 63.318 |
| `corpus/reports/typescript/corpus-report.md` | 36989 | 99 | 20171 | 65.937 | 105.018 | 39.081 | 59.3% | 37.175 | 39.823 | 66.653 |
| `docs/cst-contract.md` | 18637 | 63 | 12738 | 34.536 | 70.641 | 36.105 | 104.5% | 35.750 | 36.754 | 34.148 |
| `corpus/reports/yaml/corpus-report.md` | 26395 | 105 | 18710 | 51.286 | 85.663 | 34.377 | 67.0% | 34.594 | 34.932 | 48.572 |
| `.ai/parse/recover.md` | 15226 | 63 | 13814 | 28.435 | 61.871 | 33.436 | 117.6% | 34.658 | 35.169 | 26.891 |
| `corpus/reports/ruby/report.md` | 12719 | 43 | 11496 | 24.939 | 57.168 | 32.229 | 129.2% | 32.084 | 35.393 | 24.744 |
| `corpus/reports/xml/corpus-report.md` | 27622 | 103 | 16481 | 49.534 | 81.154 | 31.619 | 63.8% | 30.643 | 31.905 | 49.880 |
| `docs/tree-interface-probe.md` | 18159 | 72 | 15290 | 36.815 | 68.422 | 31.607 | 85.9% | 31.342 | 34.204 | 35.591 |
| `corpus/reports/typescript/report.md` | 16333 | 55 | 11203 | 28.775 | 58.871 | 30.096 | 104.6% | 28.439 | 29.287 | 30.119 |
| `docs/competition.md` | 14346 | 86 | 13097 | 27.429 | 57.469 | 30.040 | 109.5% | 28.777 | 29.675 | 26.766 |
| `corpus/reports/yaml/report.md` | 10686 | 47 | 10171 | 16.480 | 45.678 | 29.198 | 177.2% | 28.741 | 30.320 | 16.302 |
| `.ai/parse/scanner.md` | 12121 | 55 | 11195 | 22.129 | 51.028 | 28.899 | 130.6% | 28.656 | 29.665 | 22.046 |
| `docs/design.md` | 16408 | 74 | 12771 | 29.373 | 57.144 | 27.771 | 94.5% | 27.241 | 27.839 | 29.290 |
| `docs/onboarding/cell-spike.md` | 12332 | 58 | 9277 | 26.865 | 54.132 | 27.267 | 101.5% | 26.882 | 31.661 | 25.937 |
| `corpus/reports/html/report.md` | 12508 | 43 | 10833 | 20.511 | 47.387 | 26.876 | 131.0% | 26.931 | 27.945 | 20.090 |
| `corpus/reports/scheme/report.md` | 13296 | 46 | 11974 | 24.357 | 50.765 | 26.408 | 108.4% | 25.661 | 27.140 | 24.118 |
| `docs/onboarding/templates/package-brief.md` | 9614 | 56 | 9031 | 18.154 | 44.514 | 26.360 | 145.2% | 25.564 | 26.583 | 18.534 |
| `corpus/reports/go/corpus-report.md` | 18756 | 78 | 14195 | 33.627 | 59.953 | 26.326 | 78.3% | 25.740 | 26.256 | 33.834 |
| `proposals/codex-1.md` | 23525 | 66 | 19061 | 45.656 | 71.908 | 26.252 | 57.5% | 24.345 | 25.382 | 42.012 |
| `corpus/reports/javascript/report.md` | 8688 | 44 | 8145 | 13.595 | 39.503 | 25.908 | 190.6% | 25.667 | 26.808 | 13.435 |
| `corpus/reports/css/corpus-report.md` | 23198 | 110 | 14879 | 41.419 | 67.200 | 25.781 | 62.2% | 26.286 | 26.697 | 40.064 |
| `corpus/reports/toml/report.md` | 8185 | 35 | 7629 | 13.388 | 35.491 | 22.102 | 165.1% | 21.943 | 23.004 | 13.220 |
| `.ai/done-resign.md` | 9129 | 52 | 8938 | 13.014 | 34.876 | 21.862 | 168.0% | 20.875 | 24.448 | 12.960 |
| `docs/host-ctype-divergence.md` | 8453 | 33 | 7306 | 14.983 | 36.213 | 21.230 | 141.7% | 20.708 | 22.035 | 14.789 |
| `corpus/reports/toml/corpus-report.md` | 15955 | 68 | 12377 | 29.112 | 50.074 | 20.962 | 72.0% | 21.159 | 22.237 | 27.646 |
| `corpus/reports/xml/report.md` | 9201 | 32 | 7687 | 17.495 | 37.891 | 20.396 | 116.6% | 20.431 | 21.345 | 16.423 |
| `.ai/done-a2-foundation.md` | 12276 | 42 | 12042 | 21.165 | 40.933 | 19.768 | 93.4% | 19.074 | 20.375 | 20.827 |
| `docs/house-style.md` | 6531 | 33 | 6433 | 11.063 | 25.643 | 14.580 | 131.8% | 14.517 | 15.148 | 10.980 |
| `.ai/parse/length.md` | 8280 | 37 | 7242 | 15.011 | 29.439 | 14.427 | 96.1% | 14.452 | 14.683 | 14.717 |
| `web/README.md` | 7329 | 37 | 6312 | 15.116 | 28.745 | 13.629 | 90.2% | 13.477 | 14.001 | 14.311 |
| `proposals/claude-1.md` | 7683 | 37 | 5923 | 15.675 | 27.780 | 12.105 | 77.2% | 11.515 | 12.028 | 14.578 |
| `corpus/reports/markdown/report.md` | 5514 | 23 | 4206 | 9.557 | 19.927 | 10.370 | 108.5% | 10.539 | 12.568 | 9.254 |
| `corpus/reports/markdown/prose-wrap.md` | 8643 | 26 | 7395 | 14.397 | 24.551 | 10.154 | 70.5% | 9.940 | 11.382 | 14.228 |
| `corpus/reports/haskell/report.md` | 8028 | 30 | 6433 | 13.182 | 23.209 | 10.027 | 76.1% | 10.149 | 10.758 | 12.793 |
| `corpus/reports/go/report.md` | 8855 | 37 | 4748 | 15.980 | 25.156 | 9.176 | 57.4% | 8.760 | 10.207 | 15.650 |
| `.ai/parse/merge-scanner-into-main.md` | 5510 | 27 | 4426 | 10.663 | 19.152 | 8.489 | 79.6% | 9.032 | 9.096 | 9.948 |
| `docs/phase2-selection.md` | 4788 | 20 | 3639 | 8.275 | 16.145 | 7.870 | 95.1% | 7.765 | 8.636 | 8.169 |
| `harness/fixtures/prose-refused.md` | 4628 | 60 | 4349 | 8.978 | 16.385 | 7.407 | 82.5% | 7.579 | 7.977 | 8.389 |
| `corpus/reports/css/report.md` | 6281 | 23 | 3269 | 10.449 | 16.776 | 6.327 | 60.5% | 6.264 | 7.563 | 10.164 |
| `corpus/reports/kotlin/report.md` | 4755 | 27 | 3500 | 8.553 | 14.402 | 5.849 | 68.4% | 5.873 | 5.954 | 8.390 |
| `docs/markdown-idempotence.md` | 5721 | 21 | 4896 | 10.009 | 15.742 | 5.733 | 57.3% | 5.666 | 6.288 | 9.945 |
| `.ai/done-corpus-thresholds.md` | 5438 | 35 | 4906 | 9.529 | 14.957 | 5.428 | 57.0% | 5.406 | 6.077 | 9.036 |
| `.ai/done-loader.md` | 5242 | 38 | 4224 | 9.678 | 15.000 | 5.321 | 55.0% | 5.278 | 5.812 | 9.480 |
| `harness/reviews/README.md` | 3053 | 16 | 2347 | 5.435 | 9.460 | 4.026 | 74.1% | 3.946 | 4.096 | 5.428 |
| `corpus/contrib/README.md` | 2053 | 15 | 1451 | 3.792 | 6.804 | 3.011 | 79.4% | 2.999 | 3.360 | 3.744 |
| `harness/bench_break_propagation.md` | 3590 | 10 | 2226 | 7.657 | 10.425 | 2.768 | 36.1% | 2.658 | 2.764 | 7.519 |
| `README.md` | 1859 | 11 | 1560 | 3.331 | 5.793 | 2.462 | 73.9% | 2.453 | 2.587 | 3.293 |
| `spike/scanner-vm/rust/README.md` | 1710 | 5 | 1294 | 3.398 | 5.392 | 1.994 | 58.7% | 1.989 | 2.508 | 3.345 |
| `corpus/src/markdown/prose_wrap.md` | 1019 | 5 | 962 | 1.895 | 3.792 | 1.897 | 100.1% | 1.895 | 1.943 | 1.752 |
| `corpus/src/markdown/html_blocks.md` | 1726 | 15 | 1236 | 4.864 | 6.486 | 1.622 | 33.3% | 1.622 | 1.654 | 3.292 |
| `reference/README.md` | 831 | 8 | 766 | 1.685 | 3.177 | 1.491 | 88.5% | 1.478 | 2.075 | 1.669 |
| `corpus/src/markdown/sections.md` | 1024 | 21 | 813 | 2.090 | 3.045 | 0.955 | 45.7% | 0.947 | 0.999 | 1.928 |
| `corpus/src/markdown/blockquotes.md` | 888 | 21 | 644 | 2.430 | 3.326 | 0.896 | 36.9% | 0.887 | 0.920 | 2.153 |
| `corpus/src/markdown/tables.md` | 1384 | 5 | 647 | 3.540 | 4.288 | 0.748 | 21.1% | 0.743 | 0.755 | 3.216 |
| `spike/scanner-vm/record/README.md` | 787 | 3 | 573 | 1.621 | 2.331 | 0.710 | 43.8% | 0.711 | 0.719 | 1.591 |
| `corpus/src/markdown/kitchen.md` | 520 | 9 | 147 | 1.784 | 2.439 | 0.655 | 36.7% | 0.654 | 0.691 | 1.467 |
| `corpus/src/markdown/lists.md` | 574 | 20 | 421 | 1.642 | 2.218 | 0.576 | 35.1% | 0.575 | 0.622 | 1.467 |
| `corpus/src/markdown/fences.md` | 1045 | 6 | 444 | 3.877 | 4.424 | 0.547 | 14.1% | 0.518 | 0.553 | 2.566 |
| `corpus/src/markdown/normalisation.md` | 456 | 8 | 340 | 1.211 | 1.741 | 0.530 | 43.8% | 0.521 | 0.566 | 1.049 |
| `corpus/src/markdown/strings.md` | 467 | 5 | 406 | 1.206 | 1.692 | 0.486 | 40.3% | 0.482 | 0.488 | 1.067 |
| `spike/scanner-vm/locale/README.md` | 620 | 4 | 415 | 1.168 | 1.652 | 0.485 | 41.5% | 0.479 | 0.655 | 1.149 |
| `corpus/src/markdown/links.md` | 412 | 4 | 292 | 1.165 | 1.628 | 0.463 | 39.7% | 0.449 | 0.490 | 1.034 |
| `corpus/src/markdown/comments.md` | 748 | 7 | 223 | 2.780 | 3.222 | 0.441 | 15.9% | 0.442 | 0.468 | 1.828 |
| `harness/fixtures/secondary-mixed.md` | 81 | 3 | 76 | 0.352 | 0.668 | 0.316 | 89.9% | 0.317 | 0.329 | 0.345 |
| `corpus/src/markdown/indented_code.md` | 460 | 5 | 225 | 1.157 | 1.472 | 0.315 | 27.3% | 0.314 | 0.316 | 1.035 |
| `corpus/src/markdown/long_sequences.md` | 412 | 1 | 173 | 1.604 | 1.845 | 0.240 | 15.0% | 0.220 | 0.234 | 1.238 |
| `corpus/src/markdown/headings.md` | 227 | 9 | 112 | 0.741 | 0.966 | 0.224 | 30.3% | 0.226 | 0.410 | 0.606 |
| `corpus/src/markdown/nesting.md` | 424 | 6 | 187 | 1.606 | 1.829 | 0.223 | 13.9% | 0.232 | 0.234 | 1.176 |
| `corpus/src/markdown/tables_nested.md` | 533 | 6 | 129 | 1.667 | 1.866 | 0.199 | 12.0% | 0.195 | 0.199 | 1.438 |
| `harness/fixtures/secondary-dirty.md` | 29 | 1 | 28 | 0.241 | 0.434 | 0.194 | 80.5% | 0.195 | 0.241 | 0.237 |
| `corpus/src/markdown/leading_sections.md` | 192 | 4 | 175 | 0.494 | 0.685 | 0.191 | 38.7% | 0.189 | 0.195 | 0.489 |
| `corpus/src/markdown/emphasis.md` | 95 | 1 | 52 | 0.436 | 0.564 | 0.129 | 29.6% | 0.131 | 0.135 | 0.334 |
| `harness/fixtures/secondary-clean.md` | 25 | 1 | 24 | 0.193 | 0.258 | 0.066 | 34.1% | 0.063 | 0.070 | 0.192 |
| `corpus/src/markdown/list_markers.md` | 99 | 4 | 36 | 0.496 | 0.560 | 0.064 | 12.9% | 0.062 | 0.074 | 0.389 |
| `harness/fixtures/scanner/markdown_inline/unclosed_backtick.md` | 48 | 1 | 47 | 0.224 | 0.281 | 0.057 | 25.4% | 0.058 | 0.073 | 0.221 |
| `harness/fixtures/scanner/markdown_inline/unclosed_dollar.md` | 49 | 1 | 48 | 0.225 | 0.281 | 0.056 | 25.1% | 0.057 | 0.058 | 0.222 |
| `harness/fixtures/scanner/markdown_inline/mismatched_dollar.md` | 12 | 1 | 11 | 0.183 | 0.216 | 0.033 | 18.1% | 0.030 | 0.033 | 0.183 |
| `harness/fixtures/scanner/markdown_inline/mismatched_backtick.md` | 12 | 1 | 11 | 0.189 | 0.217 | 0.028 | 15.0% | 0.031 | 0.035 | 0.185 |
| `corpus/src/markdown/indented_code_heading.md` | 14 | 1 | 1 | 0.197 | 0.207 | 0.009 | 4.6% | 0.011 | 0.012 | 0.193 |
| `corpus/src/markdown/fence_delimiters.md` | 352 | 0 | 0 | 0.952 | 0.959 | 0.007 | 0.8% | 0.002 | 0.002 | 0.793 |
| `harness/fixtures/injection/regions.md` | 118 | 0 | 0 | 0.555 | 0.558 | 0.003 | 0.6% | 0.002 | 0.003 | 0.448 |
| `corpus/src/markdown/thematic.md` | 64 | 0 | 0 | 0.381 | 0.381 | 0.000 | 0.0% | 0.001 | 0.003 | 0.283 |
| `corpus/src/markdown/json_comment_containers.md` | 57 | 0 | 0 | 0.412 | 0.411 | -0.000 | -0.1% | 0.002 | 0.002 | 0.355 |

## Summary

Corpus median Δ 20.396 ms; max Δ 358.125 ms; median stretch 20.431 ms; max stretch median 354.014 ms; max stretch max 398.539 ms. 58/114 files have stretch median > 16 ms.

Pearson correlation of median Δ with attached range count: 0.8593. With attached inline bytes: 0.9785. Bytes are the better predictor because ranges vary in length.

Attach stretch / ON−OFF Δ is 0.992 at the median on files with Δ > 1 ms. The delta of `parse()` is the attach loop, not something else that moved with it.

- `docs/onboarding/FINDINGS.md`: 199173 bytes, 594 ranges, 128635 inline bytes (2.75 µs/inline-byte). OFF 448.487 ms, ON 806.612 ms, Δ 358.125 ms (79.9% of OFF). Stretch median 354.014 ms, max 398.539 ms. Block parse 432.972 ms. `new Language(blob)` × 594 took 0.041 ms (0.1 µs/range, 0.0% of the stretch). The A2 review's per-slice construction is real and is inside the clock; it is not the term that matters. Parser construction is not separately exported, so this number is Language only; the rest of the stretch is `parse()` of each slice.
- `docs/onboarding/LEDGER.md`: 112808 bytes, 134 ranges, 107725 inline bytes (2.70 µs/inline-byte). OFF 196.659 ms, ON 486.317 ms, Δ 289.658 ms (147.3% of OFF). Stretch median 291.298 ms, max 317.008 ms. Block parse 192.391 ms. `new Language(blob)` × 134 took 0.005 ms (0.0 µs/range, 0.0% of the stretch). The A2 review's per-slice construction is real and is inside the clock; it is not the term that matters. Parser construction is not separately exported, so this number is Language only; the rest of the stretch is `parse()` of each slice.

4 corpus files have no `inline` node (`corpus/src/markdown/fence_delimiters.md`, `corpus/src/markdown/json_comment_containers.md`, `corpus/src/markdown/thematic.md`, `harness/fixtures/injection/regions.md`). Their ON−OFF deltas are 0.007 ms, -0.000 ms, 0.000 ms, 0.003 ms — extra negative controls the corpus happened to contain.

Syntax-density outlier: `harness/fixtures/scanner/markdown_inline/adversarial.md` (1 range(s), 5857 inline bytes, stretch 58.755 ms, 10.03 µs/byte). Prose sits around 2.5–3.5 µs/byte; this file is a scanner-stress fixture, not typical editing.

## Is a real-browser input-latency run worth doing?

Node already closes the worst-case question. `docs/onboarding/FINDINGS.md` holds the main thread for 354.014 ms median inside `attachSecondaries` on byte-identical JS. A browser run cannot turn that into a frame. The 150 ms debounce means this cost is paid on pause, after the user has already waited, and then the editor still cannot render until `parse()` finishes.

A browser run would only refine the 5–16 ms band, where main-thread contention (layout, this editor's own render) could push a maybe-fine file over a frame. That is not the go/no-go. The with-versus-without baseline this slice exists to capture is the Node number.

## Falsifiers

- If the negative control's Δ had exceeded 0.5 ms, the clock would have been on something other than `attachSecondaries` and the run would have been void.
- If synthetic Δ had not increased with range count (Pearson r < 0.9), the measurement would not have been measuring attached work.
- If OFF had ever produced a `secondary` array, or ON had disagreed with the host `inline` count, the arms would not have diverged and the driver would have exited 1.
- If stretch/Δ had been far from 1 on large files, total `parse()` would have been moving for a reason other than the attach loop.

