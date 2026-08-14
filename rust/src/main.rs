//! `fmt-rust <tree.json> <width>`: format a corpus tree to stdout.
//!
//! Non-zero exit means "I refuse to format this", which is a legitimate
//! answer: an unknown node type, a rule that does not account for every child,
//! or a package that is missing.

#![forbid(unsafe_code)]

mod attach;
mod doc;
mod eval;
mod pkg;
mod tree;

use std::fmt;
use std::path::PathBuf;
use std::process::ExitCode;

use crate::pkg::Package;
use crate::tree::TreeDoc;

/// Why we will not format this file.
#[derive(Debug)]
pub struct Refusal(pub String);

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(Refusal(why)) => {
            eprintln!("{why}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String, Refusal> {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(width)) = (args.next(), args.next()) else {
        return Err(Refusal("usage: fmt-rust <tree.json> <width>".to_owned()));
    };
    let width: usize = width
        .parse()
        .map_err(|_| Refusal(format!("width `{width}` is not a number")))?;

    let raw = std::fs::read_to_string(&path).map_err(|e| Refusal(format!("{path}: {e}")))?;
    let tree: TreeDoc =
        serde_json::from_str(&raw).map_err(|e| Refusal(format!("malformed tree: {e}")))?;
    let package = Package::load(&packages_dir(), &tree.language)?;
    eval::format(&tree, &package, width)
}

/// Packages ship as data beside the runtime; the wrapper script points here.
fn packages_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("FMT_PACKAGES") {
        return PathBuf::from(dir);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(PathBuf::from))
        .unwrap_or_default()
        .join("packages")
}
