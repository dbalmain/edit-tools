//! `hl-rust <tree.json> [<language>=<package.highlight.json> ...]`: write spans.

#![forbid(unsafe_code)]

#[path = "../hl_eval.rs"]
mod hl_eval;
#[path = "../hl_pkg.rs"]
pub mod hl_pkg;
// This CLI deserializes the formatter's complete shared tree shape, although
// highlighting deliberately ignores leaf text and formatter-only helpers.
#[allow(dead_code)]
#[path = "../tree.rs"]
mod tree;

use std::fmt;
use std::process::ExitCode;

use hl_eval::PackageMap;
use hl_pkg::Package;
use tree::TreeDoc;

#[derive(Debug)]
struct CliError(String);

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String, CliError> {
    let mut args = std::env::args().skip(1);
    let Some(tree_path) = args.next() else {
        return Err(CliError(
            "usage: hl-rust <tree.json> [<language>=<package.highlight.json> ...]".to_owned(),
        ));
    };

    let mut packages = PackageMap::new();
    for argument in args {
        let Some((language, package_path)) = argument.split_once('=') else {
            return Err(CliError(format!(
                "invalid package mapping `{argument}`; expected <language>=<package.highlight.json>"
            )));
        };
        if language.is_empty() || package_path.is_empty() {
            return Err(CliError(format!(
                "invalid package mapping `{argument}`; language and path must be non-empty"
            )));
        }
        let package_raw = std::fs::read_to_string(package_path)
            .map_err(|error| CliError(format!("{package_path}: {error}")))?;
        let package = Package::load(&package_raw)
            .map_err(|error| CliError(format!("malformed package {package_path}: {error}")))?;
        if packages.insert(language.to_owned(), package).is_some() {
            return Err(CliError(format!(
                "duplicate highlight package for language `{language}`"
            )));
        }
    }
    let tree_raw = std::fs::read_to_string(&tree_path)
        .map_err(|error| CliError(format!("{tree_path}: {error}")))?;
    let tree: TreeDoc = serde_json::from_str(&tree_raw)
        .map_err(|error| CliError(format!("malformed tree: {error}")))?;
    let spans = hl_eval::highlight(&tree, &packages);
    serde_json::to_string(&spans).map_err(|error| CliError(error.to_string()))
}
