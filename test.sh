#!/bin/sh
# Runtime and harness unit suites, then the harness's own checks and scorers,
# then the tree-interface and manifest-driven injection probes.
#
# check_gate3.py runs before the scorer on purpose: it establishes that gate 3
# still accepts every reference formatter and still rejects destruction. A
# 30/30 from the scorer means nothing if the gate has quietly become a no-op.
#
# Everything here is hermetic. The reference formatters are run by
# harness/gen_reference.py, not from this script, and their output is committed.
set -e
cd "$(dirname "$0")"
./build.sh
cargo test --manifest-path rust/Cargo.toml
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
node --test runtime-js/bundle.test.js
node --test runtime-js/highlight.test.js
python3 -m unittest discover -s harness
./harness/check_gate3.py
./harness/score.py .
./harness/corpus_stats.py
./harness/score_highlight.py .
./harness/probe_tree_interface.py
./harness/probe_injection.py
