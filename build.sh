#!/bin/sh
set -e
cd "$(dirname "$0")"
cargo build --release --manifest-path rust/Cargo.toml --locked
