//! `ts_check_trees <blob.json> <language>`: the Rust acceptance bar.
//!
//! The Rust twin of `harness/ts_check_trees.mjs`. Parses a language's corpus
//! sources with the table interpreter and compares the result **byte for byte**
//! against the frozen trees in `corpus/trees/`, which `harness/gen_trees.py`
//! produced from real tree-sitter. Anything less than byte-identical is a
//! negative result.

#![forbid(unsafe_code)]

// Scaffolding: the module lands ahead of the `main` that drives it, so that
// the serialisation agreement it pins is on disk and under test from the
// first commit. The allow goes away once the parser is wired up here.
#[allow(dead_code)]
#[path = "../ts/mod.rs"]
mod ts;

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("ts_check_trees: not implemented yet");
    ExitCode::from(2)
}
