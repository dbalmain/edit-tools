#!/bin/sh
set -e
cd "$(dirname "$0")"
node tools/compile-package.js
cargo build --release --manifest-path rust/Cargo.toml --locked
