//! Stdin → `align::go` → stdout. Used by `harness/probe_alignment.py --align-only`.

#[path = "../align.rs"]
mod align;

// Compiled here so clippy sees the marker pass in this binary too.
const _: fn(&str) -> String = align::cells;

use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    if let Err(err) = io::stdin().read_to_string(&mut input) {
        eprintln!("stdin: {err}");
        std::process::exit(1);
    }
    print!("{}", align::go(&input));
}
