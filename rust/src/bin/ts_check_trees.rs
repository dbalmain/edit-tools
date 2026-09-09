//! `ts_check_trees <blob.json> <language> [--write-dir DIR|--emit]`: the Rust
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

use serde::Serialize;
use std::io::{BufWriter, Write};
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

/// Node's `path.relative(from, to)`, lexically, over absolute paths.
///
/// `strip_prefix` is not enough: the JS emits `../../..`-style paths for files
/// outside the repository, which is exactly what `--emit` is pointed at. A
/// plain fallback to the absolute path makes the two runtimes' `source_file`
/// fields disagree on every such file -- found by diffing both runtimes over
/// the Go standard library, where it was the only divergence in 7,710 files.
fn relative_path(from: &Path, to: &Path) -> String {
    let (mut f, mut t) = (from.components().peekable(), to.components().peekable());
    while f.peek().is_some() && f.peek() == t.peek() {
        f.next();
        t.next();
    }
    let mut parts: Vec<String> = f.map(|_| "..".to_string()).collect();
    parts.extend(t.map(|c| c.as_os_str().to_string_lossy().into_owned()));
    if parts.is_empty() {
        String::new()
    } else {
        parts.join(std::path::MAIN_SEPARATOR_STR)
    }
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
        // Only the injection track writes a node-level language, or marks a
        // region opaque; the interpreter never does either.
        language: None,
        opaque: false,
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
    // Node's path.relative resolves its arguments against the cwd first, so a
    // relative path on `--emit`'s stdin has to be absolutised the same way.
    let absolute = if source_path.is_absolute() {
        source_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(source_path)
    };
    let relative = relative_path(&repo_root(), &absolute);
    let text = std::str::from_utf8(&source)
        .map_err(|e| format!("{}: not valid UTF-8: {e}", source_path.display()))?;
    Ok(TreeDoc {
        language: language.to_string(),
        source_file: relative,
        source: text.to_string(),
        root: root_node,
    })
}

/// `--emit`: parse the newline-separated paths on stdin and write one compact
/// JSON record per line, in the shape `ts_check_trees.mjs --emit` writes.
/// `harness/ts_differential.py` consumes this to compare a runtime against real
/// tree-sitter over a corpus far larger than the frozen one -- which is where
/// the JS spike found three defects the 34-file corpus could not.
#[derive(Serialize)]
struct EmitOk<'a> {
    path: &'a str,
    doc: TreeDoc,
}

#[derive(Serialize)]
struct EmitErr<'a> {
    path: &'a str,
    error: String,
}

fn emit(blob_path: &str, language: &str) -> Result<bool, String> {
    let raw = std::fs::read(blob_path).map_err(|e| format!("{blob_path}: {e}"))?;
    let blob: Blob = serde_json::from_slice(&raw).map_err(|e| format!("{blob_path}: {e}"))?;
    let lang = Language::new(blob);

    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)
        .map_err(|e| format!("stdin: {e}"))?;
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for path in input.lines().filter(|l| !l.is_empty()) {
        let line = match parse_doc(&lang, language, Path::new(path)) {
            Ok(doc) => serde_json::to_string(&EmitOk { path, doc }),
            Err(error) => serde_json::to_string(&EmitErr { path, error }),
        }
        .map_err(|e| format!("{path}: {e}"))?;
        writeln!(out, "{line}").map_err(|e| format!("{path}: {e}"))?;
    }
    out.flush().map_err(|e| format!("stdout: {e}"))?;
    Ok(true)
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
        eprintln!("usage: ts_check_trees <blob.json> <language> [--write-dir DIR|--emit]");
        return ExitCode::from(2);
    };

    let result = if args.iter().any(|a| a == "--emit") {
        emit(blob_path, language)
    } else {
        run(blob_path, language, write_dir)
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("ts_check_trees: {e}");
            ExitCode::from(2)
        }
    }
}
