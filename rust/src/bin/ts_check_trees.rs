//! `ts_check_trees <blob.json> <language> [--write-dir DIR]`: the Rust
//! acceptance bar.
//!
//! The Rust twin of `harness/ts_check_trees.mjs`. Parses a language's corpus
//! sources with the table interpreter and compares the result **byte for byte**
//! against the frozen trees in `corpus/trees/`, which `harness/gen_trees.py`
//! produced from real tree-sitter. Anything less than byte-identical is a
//! negative result.
//!
//! The bar is deliberately the same one the JS runtime is held to, over the
//! same corpus, so that "the two runtimes agree" is a claim about one artifact
//! rather than about two similar-looking ones.

#![forbid(unsafe_code)]

#[path = "../ts/mod.rs"]
mod ts;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use ts::blob::{Blob, Language};
use ts::doc::{to_frozen_bytes, TreeDoc, TreeNode};
use ts::node::{visible_children, VisibleChild};
use ts::parser::Parser;
use ts::subtree::Arena;

/// The repository root, resolved at compile time from the crate's location the
/// way the JS resolves it from `import.meta.dirname`.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf()
}

/// `gen_trees.convert()`: anonymous nodes kept, byte offsets, `field` where the
/// production names one, `text` on leaves.
fn convert(
    lang: &Language,
    arena: &Arena,
    node: &VisibleChild,
    source: &[u8],
) -> Result<TreeNode, String> {
    let tree = arena.get(node.subtree);
    let symbol = if node.alias != 0 {
        node.alias
    } else {
        tree.symbol
    };
    let start = node.start;
    let end = start + tree.size;
    let kids = visible_children(lang, arena, node.subtree, start);
    let (children, text) = if kids.is_empty() {
        let bytes = source
            .get(start..end)
            .ok_or_else(|| format!("node spans {start}..{end}, past the end of the source"))?;
        let text = std::str::from_utf8(bytes)
            .map_err(|e| format!("leaf text at {start}..{end} is not valid UTF-8: {e}"))?;
        (None, Some(text.to_string()))
    } else {
        let mut out = Vec::with_capacity(kids.len());
        for kid in &kids {
            out.push(convert(lang, arena, kid, source)?);
        }
        (Some(out), None)
    };
    Ok(TreeNode {
        kind: lang.symbol_name(symbol).to_string(),
        start,
        end,
        field: node.field.clone(),
        children,
        text,
        // Only the injection track writes a node-level language; the
        // interpreter never does.
        language: None,
    })
}

fn parse_doc(lang: &Language, language: &str, source_path: &Path) -> Result<TreeDoc, String> {
    let source =
        std::fs::read(source_path).map_err(|e| format!("{}: {e}", source_path.display()))?;
    let mut parser = Parser::new(lang, &source);
    let root = parser.parse().map_err(|e| e.to_string())?;
    let start_byte = parser.arena.get(root).padding;
    let node = VisibleChild {
        subtree: root,
        alias: 0,
        start: start_byte,
        field: None,
    };
    let root_node = convert(lang, &parser.arena, &node, &source)?;
    let relative = source_path
        .strip_prefix(repo_root())
        .unwrap_or(source_path)
        .to_string_lossy()
        .into_owned();
    let text = std::str::from_utf8(&source)
        .map_err(|e| format!("{}: not valid UTF-8: {e}", source_path.display()))?;
    Ok(TreeDoc {
        language: language.to_string(),
        source_file: relative,
        source: text.to_string(),
        root: root_node,
    })
}

/// Where two byte strings first differ, rendered the way the JS renders it.
fn first_diff(expected: &[u8], actual: &[u8]) -> String {
    let n = expected.len().min(actual.len());
    for i in 0..n {
        if expected[i] != actual[i] {
            let from = i.saturating_sub(60);
            let to = (i + 60).min(n);
            return format!(
                "first difference at byte {i}\n      want ...{:?}\n      got  ...{:?}",
                String::from_utf8_lossy(&expected[from..to.min(expected.len())]),
                String::from_utf8_lossy(&actual[from..to.min(actual.len())]),
            );
        }
    }
    format!(
        "identical for {n} bytes, then lengths differ ({} vs {})",
        expected.len(),
        actual.len()
    )
}

fn run(blob_path: &str, language: &str, write_dir: Option<&str>) -> Result<bool, String> {
    let raw = std::fs::read(blob_path).map_err(|e| format!("{blob_path}: {e}"))?;
    let blob: Blob = serde_json::from_slice(&raw).map_err(|e| format!("{blob_path}: {e}"))?;
    let lang = Language::new(blob);

    let root = repo_root();
    let src_dir = root.join("corpus").join("src").join(language);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&src_dir)
        .map_err(|e| format!("{}: {e}", src_dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some())
        .collect();
    files.sort();

    if let Some(dir) = write_dir {
        std::fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))?;
    }

    let mut pass = 0usize;
    let mut failures = Vec::new();
    for file in &files {
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = file
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let expected_path = root
            .join("corpus")
            .join("trees")
            .join(format!("{language}__{stem}.tree.json"));
        let Ok(expected) = std::fs::read(&expected_path) else {
            failures.push(format!(
                "{name}: no frozen tree at {}",
                expected_path
                    .strip_prefix(&root)
                    .unwrap_or(&expected_path)
                    .display()
            ));
            continue;
        };
        let started = Instant::now();
        let actual = match parse_doc(&lang, language, file) {
            Ok(doc) => to_frozen_bytes(&doc),
            Err(e) => {
                failures.push(format!("{name}: {e}"));
                continue;
            }
        };
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        if let Some(dir) = write_dir {
            let out = Path::new(dir).join(format!("{language}__{stem}.tree.json"));
            std::fs::write(&out, &actual).map_err(|e| format!("{}: {e}", out.display()))?;
        }
        if actual == expected {
            pass += 1;
            println!("  ok   {language}__{stem}  ({ms:.1} ms)");
        } else {
            failures.push(format!("{name}: {}", first_diff(&expected, &actual)));
        }
    }

    println!("\n{pass}/{} byte-identical", files.len());
    for f in &failures {
        eprintln!("  FAIL {f}");
    }
    Ok(failures.is_empty())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let write_dir = args
        .iter()
        .position(|a| a == "--write-dir")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str);
    // `--write-dir DIR` puts its value in the positional list too; drop it.
    let positional: Vec<&String> = positional
        .into_iter()
        .filter(|a| Some(a.as_str()) != write_dir)
        .collect();

    let (Some(blob_path), Some(language)) = (positional.first(), positional.get(1)) else {
        eprintln!("usage: ts_check_trees <blob.json> <language> [--write-dir DIR]");
        return ExitCode::from(2);
    };

    match run(blob_path, language, write_dir) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("ts_check_trees: {e}");
            ExitCode::from(2)
        }
    }
}
