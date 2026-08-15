//! In-process timing driver for `harness/bench_break_propagation.py`.

#![forbid(unsafe_code)]

#[path = "../attach.rs"]
mod attach;
#[path = "../doc.rs"]
mod doc;
#[path = "../eval.rs"]
mod eval;
#[path = "../pkg.rs"]
mod pkg;
#[path = "../tree.rs"]
mod tree;

use std::fmt;
use std::hint::black_box;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use pkg::Package;
use tree::TreeDoc;

#[derive(Debug)]
pub struct Refusal(pub String);

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(nanos) => {
            print!("{nanos}");
            ExitCode::SUCCESS
        }
        Err(Refusal(why)) => {
            eprintln!("{why}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u128, Refusal> {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(width), Some(iterations)) = (args.next(), args.next(), args.next())
    else {
        return Err(Refusal(
            "usage: bench_format <tree.json> <width> <iterations>".to_owned(),
        ));
    };
    let width = parse_number("width", &width)?;
    let iterations = parse_number("iterations", &iterations)?;
    let raw =
        std::fs::read_to_string(&path).map_err(|error| Refusal(format!("{path}: {error}")))?;
    let tree: TreeDoc =
        serde_json::from_str(&raw).map_err(|error| Refusal(format!("malformed tree: {error}")))?;
    let package = Package::load(&packages_dir(), &tree.language)?;

    for _ in 0..10 {
        black_box(eval::format(&tree, &package, width)?);
    }
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(eval::format(&tree, &package, width)?);
    }
    Ok(started.elapsed().as_nanos())
}

fn parse_number(label: &str, value: &str) -> Result<usize, Refusal> {
    value
        .parse()
        .map_err(|_| Refusal(format!("{label} `{value}` is not a number")))
}

fn packages_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(PathBuf::from))
        .unwrap_or_default()
        .join("packages")
}
