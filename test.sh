#!/bin/sh
# Both unit suites, then the harness's own checks, then the scorer.
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
./harness/check_gate3.py
./harness/score.py .
