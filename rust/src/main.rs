//! Dual-runtime formatter: this side is the Rust interpreter.
//! The package (`packages/<lang>.json`) names a layout kind per CST node
//! type; `format` runs those kinds and a Wadler printer.

#![forbid(unsafe_code)]

use std::process::ExitCode;

mod doc;
mod format;
mod node;
mod package;

pub struct Refuse(pub String);

impl std::fmt::Display for Refuse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let [_, tree_path, width] = &args[..] else {
        eprintln!("usage: fmt-rust <tree.json> <width>");
        return ExitCode::FAILURE;
    };

    let raw = match std::fs::read_to_string(tree_path) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("cannot read {tree_path}");
            return ExitCode::FAILURE;
        }
    };
    let tree: node::TreeDoc = match serde_json::from_str(&raw) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("malformed tree: {e}");
            return ExitCode::FAILURE;
        }
    };
    let width: usize = width.parse().unwrap_or(88);

    match format::format_tree(&tree, width) {
        Ok(out) => {
            print!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
