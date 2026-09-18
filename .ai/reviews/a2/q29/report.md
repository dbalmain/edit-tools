# Q29: secondary attachment cost on the JS parse path

Host: Linux-6.18.43-x86_64-with-glibc2.42 | unknown CPU
Warmup: 2 unclocked runs per arm. Timed: median and max of 5 interleaved ON/OFF runs after warmup, `process.hrtime.bigint()`.

## Headline

The number that can drop a frame is the **post-load loop inside `attachSecondaries`**, not total `parse()`. After the inline table is in hand the loop does not yield. Longest stretch on this corpus: **16.352 ms** (`web/README.md`, max of 5; median 14.467 ms).

Largest median ON−OFF delta: **14.094 ms** (90.7% of OFF) on `web/README.md` (37 ranges, 6312 inline bytes).

## What was verified about the brief

- web/vendor/ absent (gitignored); web/gen.py:96 still shutil.copy's PARSE_LAYER from harness/ with no transformation
- web/gen.py PARSE_LAYER is lines 88–89 (brief said 92); the copy at line 96 is still shutil.copy with no transformation
- negative delta 0.078 ms on a document with 0 inline ranges
- synthetic deltas increase with range count (Pearson r=1.0000)

## Controls

A run that could not have falsified its conclusion is not evidence. The negative control is a fenced block with no `inline` node: ON minus OFF must be ~0, or the clock is not on secondary attachment. The positive control is a synthetic paragraph repeated 1..1024 times: delta must increase with range count, or the clock is not on the work that scales with attachment.

| id | ranges | inline B | OFF ms | ON ms | Δ ms | Δ% of OFF | stretch ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| __control__/negative.md | 0 | 0 | 0.551 | 0.629 | 0.078 | 14.2% | 0.011 |
| __control__/synth-1.md | 1 | 18 | 0.443 | 0.604 | 0.161 | 36.5% | 0.182 |
| __control__/synth-4.md | 4 | 72 | 0.548 | 0.896 | 0.349 | 63.7% | 0.312 |
| __control__/synth-16.md | 16 | 288 | 1.565 | 2.617 | 1.052 | 67.2% | 1.200 |
| __control__/synth-64.md | 64 | 1152 | 3.809 | 6.919 | 3.110 | 81.6% | 3.192 |
| __control__/synth-256.md | 256 | 4608 | 13.684 | 26.890 | 13.205 | 96.5% | 12.976 |
| __control__/synth-1024.md | 1024 | 18432 | 55.680 | 108.769 | 53.089 | 95.3% | 51.482 |

## Corpus

8 tracked markdown files (`git ls-files '*.md'`).

| file | bytes | ranges | inline B | OFF ms | ON ms | Δ ms | Δ% | stretch median | stretch max | block ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `web/README.md` | 7329 | 37 | 6312 | 15.544 | 29.638 | 14.094 | 90.7% | 14.467 | 16.352 | 14.205 |
| `harness/reviews/README.md` | 3053 | 16 | 2347 | 5.485 | 9.611 | 4.126 | 75.2% | 4.117 | 4.896 | 5.418 |
| `corpus/contrib/README.md` | 2053 | 15 | 1451 | 4.217 | 7.178 | 2.962 | 70.2% | 3.221 | 3.802 | 3.824 |
| `README.md` | 1859 | 11 | 1560 | 3.445 | 6.386 | 2.940 | 85.3% | 2.594 | 3.417 | 3.454 |
| `spike/scanner-vm/rust/README.md` | 1710 | 5 | 1294 | 3.331 | 5.291 | 1.960 | 58.8% | 1.915 | 1.943 | 3.298 |
| `reference/README.md` | 831 | 8 | 766 | 1.678 | 3.129 | 1.451 | 86.5% | 1.445 | 1.470 | 1.665 |
| `spike/scanner-vm/record/README.md` | 787 | 3 | 573 | 1.601 | 2.299 | 0.698 | 43.6% | 0.694 | 0.696 | 1.573 |
| `spike/scanner-vm/locale/README.md` | 620 | 4 | 415 | 1.169 | 1.631 | 0.462 | 39.5% | 0.466 | 0.474 | 1.150 |

## Summary

Corpus median Δ 2.940 ms; max Δ 14.094 ms; max stretch median 14.467 ms; max stretch max 16.352 ms.

Pearson correlation of median Δ with attached range count: 0.9753. With attached inline bytes: 0.9971.


## Falsifiers

- If the negative control's Δ had exceeded 0.5 ms, the clock would have been on something other than `attachSecondaries` and the run would have been void.
- If synthetic Δ had not increased with range count (Pearson r < 0.9), the measurement would not have been measuring attached work.
- If OFF had ever produced a `secondary` array, or ON had disagreed with the host `inline` count, the arms would not have diverged and the driver would have exited 1.

