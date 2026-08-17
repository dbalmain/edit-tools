//! Stdin → `align::go` → stdout. Used by `harness/probe_alignment.py --align-only`.

#[path = "../align.rs"]
mod align;

use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    if let Err(err) = io::stdin().read_to_string(&mut input) {
        eprintln!("stdin: {err}");
        std::process::exit(1);
    }
    print!("{}", align::go(&input));
}
