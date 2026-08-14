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
    source: String,
    root: Node,
}

#[derive(Deserialize)]
struct Node {
    #[serde(rename = "type")]
    kind: String,
    start: usize,
    end: usize,
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
    Verbatim,
    Source,
    Sequence {
        gaps: Vec<Gap>,
    },
    Delimited {
        open: String,
        close: String,
        separator: String,
        edge: Gap,
        #[serde(default, rename = "itemsVerbatim")]
        items_verbatim: bool,
        #[serde(default, rename = "preserveTrailing")]
        preserve_trailing: bool,
        #[serde(default, rename = "forceTrailing")]
        force_trailing: bool,
        #[serde(default, rename = "independentItems")]
        independent_items: bool,
        #[serde(default, rename = "reserveLineSuffix")]
        reserve_line_suffix: bool,
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
    Verbatim(String),
    Concat(Vec<Doc>),
    Group(Box<Doc>, bool, usize),
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
            Self::Group(doc, force, _) => *force || doc.breaks(),
            Self::Indent(doc) => doc.breaks(),
            Self::Verbatim(value) => value.contains('\n'),
            Self::Text(_) | Self::Line | Self::Softline => false,
        }
    }

    fn concat(parts: Vec<Self>) -> Self {
        Self::Concat(parts)
    }

    fn forced_group(doc: Self, force: bool) -> Self {
        Self::Group(Box::new(doc), force, 0)
    }

    fn reserved_group(doc: Self, force: bool, reserve: usize) -> Self {
        Self::Group(Box::new(doc), force, reserve)
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

fn validate_subtree(node: &Node, source: &[u8]) -> Result<(), String> {
    if node.start > node.end || node.end > source.len() {
        return Err(format!("{}: source range is out of bounds", node.kind));
    }
    if let Some(value) = &node.text {
        if source.get(node.start..node.end) != Some(value.as_bytes()) {
            return Err(format!("{}: leaf text differs from source", node.kind));
        }
        return Ok(());
    }
    let mut previous_end = node.start;
    for child in &node.children {
        if child.start < previous_end || child.end > node.end {
            return Err(format!("{}: children are reordered or overlap", node.kind));
        }
        validate_subtree(child, source)?;
        previous_end = child.end;
    }
    Ok(())
}

fn source_slice(source: &[u8], start: usize, end: usize, context: &str) -> Result<Doc, String> {
    let bytes = source
        .get(start..end)
        .ok_or_else(|| format!("{context}: source gap is out of bounds"))?;
    let value =
        std::str::from_utf8(bytes).map_err(|_| format!("{context}: source gap splits UTF-8"))?;
    Ok(Doc::Verbatim(value.into()))
}

fn build(node: &Node, rules: &HashMap<String, Rule>, source: &[u8]) -> Result<Doc, String> {
    if let Some(value) = &node.text {
        validate_subtree(node, source)?;
        return Ok(Doc::Text(value.clone()));
    }
    let rule = rules
        .get(&node.kind)
        .ok_or_else(|| format!("no rule for interior node {}", node.kind))?;
    match rule {
        Rule::Verbatim => {
            validate_subtree(node, source)?;
            let value = std::str::from_utf8(&source[node.start..node.end])
                .map_err(|_| format!("{}: source range splits UTF-8", node.kind))?;
            Ok(Doc::Verbatim(value.into()))
        }
        Rule::Source => {
            validate_subtree(node, source)?;
            let mut parts = Vec::new();
            let mut cursor = node.start;
            for child in &node.children {
                parts.push(source_slice(source, cursor, child.start, &node.kind)?);
                parts.push(build(child, rules, source)?);
                cursor = child.end;
            }
            parts.push(source_slice(source, cursor, node.end, &node.kind)?);
            Ok(Doc::concat(parts))
        }
        Rule::Tight => node
            .children
            .iter()
            .map(|child| build(child, rules, source))
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
                parts.push(build(child, rules, source)?);
            }
            Ok(Doc::concat(parts))
        }
        Rule::Delimited { .. } => build_delimited(node, rules, source, rule),
    }
}

fn build_delimited(
    node: &Node,
    rules: &HashMap<String, Rule>,
    source: &[u8],
    rule: &Rule,
) -> Result<Doc, String> {
    let Rule::Delimited {
        open,
        close,
        separator,
        edge,
        items_verbatim,
        preserve_trailing,
        force_trailing,
        independent_items,
        reserve_line_suffix,
    } = rule
    else {
        return Err("internal error: expected delimited rule".into());
    };
    let (open, close, separator, edge) = (open.as_str(), close.as_str(), separator.as_str(), *edge);
    let (items_verbatim, preserve_trailing, force_trailing, independent_items, reserve_line_suffix) = (
        *items_verbatim,
        *preserve_trailing,
        *force_trailing,
        *independent_items,
        *reserve_line_suffix,
    );
    let Some((first, rest)) = node.children.split_first() else {
        return Err(format!("{}: missing delimiters", node.kind));
    };
    let Some((last, middle)) = rest.split_last() else {
        return Err(format!("{}: missing delimiters", node.kind));
    };
    if first.text.as_deref() != Some(open) || last.text.as_deref() != Some(close) {
        return Err(format!("{}: delimiter mismatch", node.kind));
    }

    let (content, has_trailing) =
        if middle.last().and_then(|child| child.text.as_deref()) == Some(separator) {
            if !preserve_trailing {
                return Err(format!("{}: trailing separator is not allowed", node.kind));
            }
            (&middle[..middle.len() - 1], true)
        } else {
            (middle, false)
        };

    let mut items = Vec::new();
    let mut chunks = content.chunks_exact(2);
    for chunk in &mut chunks {
        items.push(if items_verbatim {
            validate_subtree(&chunk[0], source)?;
            source_slice(source, chunk[0].start, chunk[0].end, &node.kind)?
        } else {
            build(&chunk[0], rules, source)?
        });
        if chunk[1].text.as_deref() != Some(separator) {
            return Err(format!("{}: separator mismatch", node.kind));
        }
    }
    let remainder = chunks.remainder();
    if let Some(item) = remainder.first() {
        items.push(if items_verbatim {
            validate_subtree(item, source)?;
            source_slice(source, item.start, item.end, &node.kind)?
        } else {
            build(item, rules, source)?
        });
    } else if !content.is_empty() {
        return Err(format!(
            "{}: children are not a delimited partition",
            node.kind
        ));
    }
    if items.is_empty() {
        return Ok(Doc::Text(format!("{open}{close}")));
    }

    let mut item_doc = separated(items, separator);
    if independent_items {
        item_doc = Doc::forced_group(item_doc, has_trailing && force_trailing);
    }
    if has_trailing {
        item_doc = Doc::concat(vec![item_doc, Doc::Text(separator.into())]);
    }
    let reserve = if reserve_line_suffix {
        let suffix = source
            .get(node.end..)
            .and_then(|bytes| bytes.split(|byte| *byte == b'\n').next())
            .ok_or_else(|| format!("{}: cannot inspect line suffix", node.kind))?;
        std::str::from_utf8(suffix)
            .map_err(|_| format!("{}: line suffix is not UTF-8", node.kind))?
            .chars()
            .count()
    } else {
        0
    };
    Ok(Doc::reserved_group(
        Doc::concat(vec![
            Doc::Text(open.into()),
            Doc::indent(Doc::concat(vec![gap(edge), item_doc])),
            gap(edge),
            Doc::Text(close.into()),
        ]),
        has_trailing && force_trailing,
        reserve,
    ))
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
            Doc::Verbatim(value) => {
                if value.contains('\n') {
                    return true;
                }
                room -= value.chars().count() as isize;
            }
            Doc::Concat(parts) => {
                stack.extend(parts.iter().rev().map(|part| (column, mode, part)));
            }
            Doc::Indent(inner) => stack.push((column + indent_width, mode, inner)),
            Doc::Group(inner, force, _) => stack.push((
                column,
                if *force || inner.breaks() {
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
            Doc::Verbatim(value) => {
                output.push_str(value);
                if let Some(last_line) = value.rsplit('\n').next() {
                    if value.contains('\n') {
                        position = last_line.chars().count();
                    } else {
                        position += value.chars().count();
                    }
                }
            }
            Doc::Concat(parts) => {
                stack.extend(parts.iter().rev().map(|part| (column, mode, part)));
            }
            Doc::Indent(inner) => stack.push((column + indent_width, mode, inner)),
            Doc::Group(inner, force, reserve) => {
                let remaining = width as isize - position as isize - *reserve as isize;
                let flat =
                    !force && !inner.breaks() && fits(remaining, column, inner, indent_width);
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

    let body = build(&tree.root, &package.rules, tree.source.as_bytes())?;
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
