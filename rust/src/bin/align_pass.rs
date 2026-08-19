//! Stdin → `align::cells` → stdout. Used by `harness/probe_alignment.py --align-only`.
//!
//! A marker-based pass is a no-op on gofmt output (no vertical tabs), so
//! `--align-only` no longer measures agreement. The full formatter is the
//! probe that counts.

#[path = "../align.rs"]
mod align;

use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    if let Err(err) = io::stdin().read_to_string(&mut input) {
        eprintln!("stdin: {err}");
        std::process::exit(1);
    }
    // gofmt's scope (align a comment cell wherever one survives), which is
    // what this probe's only caller ever measured.
    print!("{}", align::cells(&input, false, " ", usize::MAX));
}
