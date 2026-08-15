# Break-propagation benchmark

`bench_break_propagation.py` measures the two runtimes on identical,
deterministically generated JSON trees. Flat arrays vary document size while
holding layout-group depth at one. Unary nested arrays vary group depth while
holding breadth at one. The width is 1,000,000 so every group stays flat and
`fits` must inspect the whole remaining line.

The script first invokes the shipped `fmt-rust` and `fmt-js` entry points and
requires byte-identical output. It then uses the small in-process timing drivers
to exclude process startup, tree parsing, and package parsing from the clock.
The timed region is repeated evaluation of the same tree into Doc IR plus
printing. Iteration counts are calibrated against the slower runtime so that
each sample lasts at least 0.15 seconds.

This lives in `harness/` because it is cross-runtime measurement rather than a
Rust microbenchmark, and because the other project measurement scripts already
live here. Run it after a release build:

```sh
./build.sh
./harness/bench_break_propagation.py
```

## Before caching

Measured at commit `5553568307eb14f5b3f677eff4e9e65b56e7c2c7` on 2026-08-15.
Host: Linux 6.18.43, AMD Ryzen 9 9955HX (boost disabled, 2.5 GHz maximum),
Rust 1.95.0, Node 24.18.1, Python 3.13.14. Times are the median of seven
samples and are per format call.

| axis | value | tree nodes | tree bytes | iterations | Rust ms | JS ms | Rust/JS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| size | 32 | 163 | 8,236 | 8,192 | 0.034 | 0.112 | 0.30x |
| size | 256 | 1,283 | 66,542 | 1,024 | 0.244 | 0.908 | 0.27x |
| size | 2,048 | 10,243 | 550,382 | 128 | 1.927 | 7.254 | 0.27x |
| size | 8,192 | 40,963 | 2,266,188 | 32 | 7.974 | 32.586 | 0.24x |
| depth | 4 | 17 | 828 | 32,768 | 0.006 | 0.015 | 0.41x |
| depth | 16 | 53 | 2,506 | 4,096 | 0.052 | 0.072 | 0.73x |
| depth | 32 | 101 | 4,746 | 1,024 | 0.234 | 0.209 | 1.12x |
| depth | 56 | 173 | 8,154 | 256 | 1.060 | 0.588 | 1.80x |

Flat-size scaling is approximately linear in both runtimes. Depth is different:
from 16 to 56 groups (3.5x), Rust time grows 20.4x while JavaScript grows 8.2x.
Rust overtakes JavaScript by depth 32 and is 1.8x slower at depth 56, despite
remaining substantially faster on every flat-size case. This supports fixing
the extra recursive break-propagation scans in Rust; it does not establish that
the JavaScript printer as a whole is linear in nesting depth.
