#!/bin/sh
# Both unit suites, then the harness scorer over the whole corpus.
set -e
cd "$(dirname "$0")"
cargo test --manifest-path rust/Cargo.toml
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
node --test runtime-js/bundle.test.js
./harness/score.py .
