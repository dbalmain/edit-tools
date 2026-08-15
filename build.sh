#!/bin/sh
# Builds both runtimes. Hermetic: no network, no package manager, no codegen.
# The JS runtime is already a single file; only Rust needs compiling.
set -e
cd "$(dirname "$0")"
cargo build --release --manifest-path rust/Cargo.toml
