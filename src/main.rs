#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tree {
    language: String,
    root: Node,
}

#[derive(Deserialize)]
struct Node {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    children: Vec<Node>,
}

#[derive(Deserialize)]
struct LanguagePackage {
    format: String,
    language: String,
    style: Style,
    rules: HashMap<String, Rule>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Style {
    indent: usize,
    final_newline: bool,
}

#[derive(Deserialize)]
#[serde(tag = "layout", rename_all = "camelCase")]
enum Rule {
    Tight,
    Sequence {
        gaps: Vec<Gap>,
    },
    Delimited {
        open: String,
        close: String,
        separator: String,
        edge: Gap,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Gap {
    None,
    Space,
    Line,
    Softline,
    Hardline,
}

enum Doc {
    Text(String),
    Concat(Vec<Doc>),
    Group(Box<Doc>),
    Indent(Box<Doc>),
    Line,
    Softline,
    Hardline,
}

impl Doc {
    fn breaks(&self) -> bool {
        match self {
            Self::Hardline => true,
            Self::Concat(parts) => parts.iter().any(Self::breaks),
            Self::Group(doc) | Self::Indent(doc) => doc.breaks(),
            Self::Text(_) | Self::Line | Self::Softline => false,
        }
    }

    fn concat(parts: Vec<Self>) -> Self {
        Self::Concat(parts)
    }

    fn group(doc: Self) -> Self {
        Self::Group(Box::new(doc))
    }

    fn indent(doc: Self) -> Self {
        Self::Indent(Box::new(doc))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Flat,
    Break,
}

fn gap(kind: Gap) -> Doc {
    match kind {
        Gap::None => Doc::Text(String::new()),
        Gap::Space => Doc::Text(" ".into()),
        Gap::Line => Doc::Line,
        Gap::Softline => Doc::Softline,
        Gap::Hardline => Doc::Hardline,
    }
}

fn separated(docs: Vec<Doc>, separator: &str) -> Doc {
    let mut parts = Vec::new();
    for (index, doc) in docs.into_iter().enumerate() {
        if index > 0 {
            parts.push(Doc::concat(vec![Doc::Text(separator.into()), Doc::Line]));
        }
        parts.push(doc);
    }
    Doc::concat(parts)
}

fn build(node: &Node, rules: &HashMap<String, Rule>) -> Result<Doc, String> {
    if let Some(value) = &node.text {
        return Ok(Doc::Text(value.clone()));
    }
    let rule = rules
        .get(&node.kind)
        .ok_or_else(|| format!("no rule for interior node {}", node.kind))?;
    match rule {
        Rule::Tight => node
            .children
            .iter()
            .map(|child| build(child, rules))
            .collect::<Result<Vec<_>, _>>()
            .map(Doc::concat),
        Rule::Sequence { gaps } => {
            if gaps.len().saturating_add(1) != node.children.len() {
                return Err(format!(
                    "{}: gaps do not partition direct children",
                    node.kind
                ));
            }
            let mut parts = Vec::new();
            for (index, child) in node.children.iter().enumerate() {
                if index > 0 {
                    parts.push(gap(gaps[index - 1]));
                }
                parts.push(build(child, rules)?);
            }
            Ok(Doc::concat(parts))
        }
        Rule::Delimited {
            open,
            close,
            separator,
            edge,
        } => build_delimited(node, rules, open, close, separator, *edge),
    }
}

fn build_delimited(
    node: &Node,
    rules: &HashMap<String, Rule>,
    open: &str,
    close: &str,
    separator: &str,
    edge: Gap,
) -> Result<Doc, String> {
    let Some((first, rest)) = node.children.split_first() else {
        return Err(format!("{}: missing delimiters", node.kind));
    };
    let Some((last, middle)) = rest.split_last() else {
        return Err(format!("{}: missing delimiters", node.kind));
    };
    if first.text.as_deref() != Some(open) || last.text.as_deref() != Some(close) {
        return Err(format!("{}: delimiter mismatch", node.kind));
    }

    let mut items = Vec::new();
    let mut chunks = middle.chunks_exact(2);
    for chunk in &mut chunks {
        items.push(build(&chunk[0], rules)?);
        if chunk[1].text.as_deref() != Some(separator) {
            return Err(format!("{}: separator mismatch", node.kind));
        }
    }
    let remainder = chunks.remainder();
    if let Some(item) = remainder.first() {
        items.push(build(item, rules)?);
    } else if !middle.is_empty() {
        return Err(format!("{}: trailing separator is not allowed", node.kind));
    }
    if items.is_empty() {
        return Ok(Doc::Text(format!("{open}{close}")));
    }

    Ok(Doc::group(Doc::concat(vec![
        Doc::Text(open.into()),
        Doc::indent(Doc::concat(vec![gap(edge), separated(items, separator)])),
        gap(edge),
        Doc::Text(close.into()),
    ])))
}

fn fits(remaining: isize, initial_indent: usize, doc: &Doc, indent_width: usize) -> bool {
    let mut room = remaining;
    let mut stack = vec![(initial_indent, Mode::Flat, doc)];
    while let Some((column, mode, current)) = stack.pop() {
        if room < 0 {
            return false;
        }
        match current {
            Doc::Text(value) => room -= value.chars().count() as isize,
            Doc::Concat(parts) => {
                stack.extend(parts.iter().rev().map(|part| (column, mode, part)));
            }
            Doc::Indent(inner) => stack.push((column + indent_width, mode, inner)),
            Doc::Group(inner) => stack.push((
                column,
                if inner.breaks() {
                    Mode::Break
                } else {
                    Mode::Flat
                },
                inner,
            )),
            Doc::Line => {
                if mode == Mode::Flat {
                    room -= 1;
                } else {
                    return true;
                }
            }
            Doc::Softline if mode != Mode::Flat => return true,
            Doc::Hardline => return true,
            Doc::Softline => {}
        }
    }
    room >= 0
}

fn render(doc: &Doc, width: usize, indent_width: usize) -> String {
    let mut output = String::new();
    let mut position = 0;
    let mut stack = vec![(0, Mode::Break, doc)];
    while let Some((column, mode, current)) = stack.pop() {
        match current {
            Doc::Text(value) => {
                output.push_str(value);
                position += value.chars().count();
            }
            Doc::Concat(parts) => {
                stack.extend(parts.iter().rev().map(|part| (column, mode, part)));
            }
            Doc::Indent(inner) => stack.push((column + indent_width, mode, inner)),
            Doc::Group(inner) => {
                let remaining = width as isize - position as isize;
                let flat = !inner.breaks() && fits(remaining, column, inner, indent_width);
                stack.push((column, if flat { Mode::Flat } else { Mode::Break }, inner));
            }
            Doc::Line => {
                if mode == Mode::Flat {
                    output.push(' ');
                    position += 1;
                } else {
                    newline(&mut output, &mut position, column);
                }
            }
            Doc::Softline if mode != Mode::Flat => newline(&mut output, &mut position, column),
            Doc::Hardline => newline(&mut output, &mut position, column),
            Doc::Softline => {}
        }
    }
    output
}

fn newline(output: &mut String, position: &mut usize, indent: usize) {
    output.push('\n');
    output.extend(std::iter::repeat_n(' ', indent));
    *position = indent;
}

fn package_path(executable: &Path, language: &str) -> Result<PathBuf, String> {
    let root = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "cannot locate formatter root".to_owned())?;
    Ok(root.join("packages").join(format!("{language}.json")))
}

fn run() -> Result<(), String> {
    let mut args = env::args_os();
    let executable = args
        .next()
        .ok_or_else(|| "missing executable path".to_owned())?;
    let tree_path = args
        .next()
        .ok_or_else(|| "usage: fmt-rust <tree.json> <width>".to_owned())?;
    let width = args
        .next()
        .ok_or_else(|| "usage: fmt-rust <tree.json> <width>".to_owned())?
        .to_string_lossy()
        .parse::<usize>()
        .map_err(|_| "width must be a positive integer".to_owned())?;
    if width == 0 || args.next().is_some() {
        return Err("usage: fmt-rust <tree.json> <width>".into());
    }

    let tree: Tree = serde_json::from_str(
        &fs::read_to_string(&tree_path).map_err(|error| format!("cannot read tree: {error}"))?,
    )
    .map_err(|error| format!("malformed tree: {error}"))?;
    let package_file = package_path(Path::new(&executable), &tree.language)?;
    let package: LanguagePackage = serde_json::from_str(
        &fs::read_to_string(&package_file)
            .map_err(|error| format!("cannot read {}: {error}", package_file.display()))?,
    )
    .map_err(|error| format!("malformed package: {error}"))?;
    if package.format != "et-linear-layout/1" {
        return Err("unsupported package format".into());
    }
    if package.language != tree.language {
        return Err("tree and package languages differ".into());
    }

    let body = build(&tree.root, &package.rules)?;
    let document = if package.style.final_newline {
        Doc::concat(vec![body, Doc::Hardline])
    } else {
        body
    };
    print!("{}", render(&document, width, package.style.indent));
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
