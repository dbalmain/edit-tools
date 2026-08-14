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
    field: Option<String>,
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
    Source {
        #[serde(default, rename = "baseIndent")]
        base_indent: bool,
    },
    Sequence {
        gaps: Vec<Gap>,
    },
    ContinuationList {
        marker: String,
        open: String,
        close: String,
        separator: String,
        #[serde(default, rename = "addTrailing")]
        add_trailing: bool,
    },
    Flow {
        open: String,
        close: String,
        edge: Gap,
        #[serde(default, rename = "itemsVerbatim")]
        items_verbatim: bool,
        #[serde(default, rename = "independentItems")]
        independent_items: bool,
    },
    Chain {
        open: String,
        close: String,
        #[serde(default, rename = "reserveLineSuffix")]
        reserve_line_suffix: bool,
    },
    SelectorChain {
        open: String,
        close: String,
        #[serde(default, rename = "reserveLineSuffix")]
        reserve_line_suffix: bool,
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
        #[serde(default, rename = "verbatimWithComments")]
        verbatim_with_comments: bool,
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
    IfBreak(Box<Doc>, Box<Doc>),
    Indent(Box<Doc>),
    Align(Box<Doc>, usize),
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
            Self::IfBreak(broken, flat) => broken.breaks() || flat.breaks(),
            Self::Indent(doc) => doc.breaks(),
            Self::Align(doc, _) => doc.breaks(),
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

    fn if_break(broken: Self, flat: Self) -> Self {
        Self::IfBreak(Box::new(broken), Box::new(flat))
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

fn joined_lines(docs: Vec<Doc>) -> Doc {
    let mut parts = Vec::new();
    for (index, doc) in docs.into_iter().enumerate() {
        if index > 0 {
            parts.push(Doc::Line);
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
        Rule::Source { base_indent } => {
            validate_subtree(node, source)?;
            let mut parts = Vec::new();
            let mut cursor = node.start;
            for child in &node.children {
                parts.push(source_slice(source, cursor, child.start, &node.kind)?);
                parts.push(build(child, rules, source)?);
                cursor = child.end;
            }
            parts.push(source_slice(source, cursor, node.end, &node.kind)?);
            let doc = Doc::concat(parts);
            if *base_indent {
                let before = source
                    .get(..node.start)
                    .ok_or_else(|| format!("{}: source offset is out of bounds", node.kind))?;
                let line = before
                    .rsplit(|byte| *byte == b'\n')
                    .next()
                    .unwrap_or(before);
                let column = std::str::from_utf8(line)
                    .map_err(|_| format!("{}: indentation is not UTF-8", node.kind))?
                    .chars()
                    .count();
                Ok(Doc::Align(Box::new(doc), column))
            } else {
                Ok(doc)
            }
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
        Rule::ContinuationList { .. } => build_continuation_list(node, source, rule),
        Rule::Chain { .. } => build_chain(node, source, rule),
        Rule::SelectorChain { .. } => build_selector_chain(node, source, rule),
        Rule::Flow { .. } => build_flow(node, rules, source, rule),
        Rule::Delimited { .. } => build_delimited(node, rules, source, rule),
    }
}

fn flatten_selectors(node: &Node, source: &[u8], output: &mut Vec<Doc>) -> Result<(), String> {
    validate_subtree(node, source)?;
    let children = &node.children;
    if node.kind == "attribute" && children.len() == 3 && children[1].text.as_deref() == Some(".") {
        flatten_selectors(&children[0], source, output)?;
        output.push(source_slice(
            source,
            children[1].start,
            children[2].end,
            &node.kind,
        )?);
        return Ok(());
    }
    if node.kind == "subscript"
        && children.len() >= 3
        && children[1].text.as_deref() == Some("[")
        && children.last().and_then(|child| child.text.as_deref()) == Some("]")
    {
        flatten_selectors(&children[0], source, output)?;
        let Some(last) = children.last() else {
            return Err("subscript lost its checked closer".into());
        };
        output.push(source_slice(
            source,
            children[1].start,
            last.end,
            &node.kind,
        )?);
        return Ok(());
    }
    if node.kind == "call" && children.len() == 2 && children[1].kind == "argument_list" {
        flatten_selectors(&children[0], source, output)?;
        let Some(previous) = output.pop() else {
            return Err(format!("{}: call has no function region", node.kind));
        };
        output.push(Doc::concat(vec![
            previous,
            source_slice(source, children[1].start, children[1].end, &node.kind)?,
        ]));
        return Ok(());
    }
    output.push(source_slice(source, node.start, node.end, &node.kind)?);
    Ok(())
}

fn build_selector_chain(node: &Node, source: &[u8], rule: &Rule) -> Result<Doc, String> {
    let Rule::SelectorChain {
        open,
        close,
        reserve_line_suffix,
    } = rule
    else {
        return Err("internal error: expected selector-chain rule".into());
    };
    let mut pieces = Vec::new();
    flatten_selectors(node, source, &mut pieces)?;
    if pieces.len() < 2 {
        return Err(format!("{}: selector chain has no selector", node.kind));
    }
    let mut iter = pieces.into_iter();
    let Some(first) = iter.next() else {
        return Err(format!("{}: selector chain is empty", node.kind));
    };
    let mut body = vec![first];
    for selector in iter {
        body.extend([Doc::Softline, selector]);
    }
    let reserve = if *reserve_line_suffix {
        line_suffix_width(node, source)?
    } else {
        0
    };
    Ok(Doc::reserved_group(
        Doc::concat(vec![
            Doc::if_break(Doc::Text(open.into()), Doc::Text(String::new())),
            Doc::indent(Doc::concat(vec![Doc::Softline, Doc::concat(body)])),
            Doc::Softline,
            Doc::if_break(Doc::Text(close.into()), Doc::Text(String::new())),
        ]),
        false,
        reserve,
    ))
}

fn flatten_chain(
    node: &Node,
    kind: &str,
    source: &[u8],
    output: &mut Vec<Doc>,
) -> Result<(), String> {
    validate_subtree(node, source)?;
    if node.kind != kind {
        output.push(source_slice(source, node.start, node.end, kind)?);
        return Ok(());
    }
    if node.children.len() < 3 || node.children.len().is_multiple_of(2) {
        return Err(format!("{kind}: chain is not alternating"));
    }
    for (index, child) in node.children.iter().enumerate() {
        if index % 2 == 0 {
            flatten_chain(child, kind, source, output)?;
        } else {
            if !matches!(child.field.as_deref(), Some("operator" | "operators")) {
                return Err(format!("{kind}: child {index} is not an operator"));
            }
            output.push(source_slice(source, child.start, child.end, kind)?);
        }
    }
    Ok(())
}

fn line_suffix_width(node: &Node, source: &[u8]) -> Result<usize, String> {
    let suffix = source
        .get(node.end..)
        .and_then(|bytes| bytes.split(|byte| *byte == b'\n').next())
        .ok_or_else(|| format!("{}: cannot inspect line suffix", node.kind))?;
    Ok(std::str::from_utf8(suffix)
        .map_err(|_| format!("{}: line suffix is not UTF-8", node.kind))?
        .chars()
        .count())
}

fn build_chain(node: &Node, source: &[u8], rule: &Rule) -> Result<Doc, String> {
    let Rule::Chain {
        open,
        close,
        reserve_line_suffix,
    } = rule
    else {
        return Err("internal error: expected chain rule".into());
    };
    let mut pieces = Vec::new();
    flatten_chain(node, &node.kind, source, &mut pieces)?;
    if pieces.len() < 3 || pieces.len().is_multiple_of(2) {
        return Err(format!("{}: flattened chain is invalid", node.kind));
    }
    let mut iter = pieces.into_iter();
    let Some(first) = iter.next() else {
        return Err(format!("{}: flattened chain is empty", node.kind));
    };
    let mut body = vec![first];
    while let Some(operator) = iter.next() {
        let Some(operand) = iter.next() else {
            return Err(format!("{}: operator has no operand", node.kind));
        };
        body.extend([Doc::Line, operator, Doc::Text(" ".into()), operand]);
    }
    let reserve = if *reserve_line_suffix {
        line_suffix_width(node, source)?
    } else {
        0
    };
    Ok(Doc::reserved_group(
        Doc::concat(vec![
            Doc::if_break(Doc::Text(open.into()), Doc::Text(String::new())),
            Doc::indent(Doc::concat(vec![Doc::Softline, Doc::concat(body)])),
            Doc::Softline,
            Doc::if_break(Doc::Text(close.into()), Doc::Text(String::new())),
        ]),
        false,
        reserve,
    ))
}

fn build_flow(
    node: &Node,
    rules: &HashMap<String, Rule>,
    source: &[u8],
    rule: &Rule,
) -> Result<Doc, String> {
    let Rule::Flow {
        open,
        close,
        edge,
        items_verbatim,
        independent_items,
    } = rule
    else {
        return Err("internal error: expected flow rule".into());
    };
    let Some((first, rest)) = node.children.split_first() else {
        return Err(format!("{}: flow is missing delimiters", node.kind));
    };
    let Some((last, middle)) = rest.split_last() else {
        return Err(format!("{}: flow is missing delimiters", node.kind));
    };
    if middle.is_empty()
        || first.text.as_deref() != Some(open)
        || last.text.as_deref() != Some(close)
    {
        return Err(format!(
            "{}: flow delimiters do not partition children",
            node.kind
        ));
    }
    let items = middle
        .iter()
        .map(|child| {
            if *items_verbatim {
                validate_subtree(child, source)?;
                source_slice(source, child.start, child.end, &node.kind)
            } else {
                build(child, rules, source)
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut item_doc = joined_lines(items);
    if *independent_items {
        item_doc = Doc::forced_group(item_doc, false);
    }
    Ok(Doc::forced_group(
        Doc::concat(vec![
            Doc::Text(open.into()),
            Doc::indent(Doc::concat(vec![gap(*edge), item_doc])),
            gap(*edge),
            Doc::Text(close.into()),
        ]),
        false,
    ))
}

fn build_continuation_list(node: &Node, source: &[u8], rule: &Rule) -> Result<Doc, String> {
    let Rule::ContinuationList {
        marker,
        open,
        close,
        separator,
        add_trailing,
    } = rule
    else {
        return Err("internal error: expected continuation-list rule".into());
    };
    validate_subtree(node, source)?;
    let marker_index = node
        .children
        .iter()
        .position(|child| child.text.as_deref() == Some(marker))
        .ok_or_else(|| format!("{}: list marker is missing", node.kind))?;
    let mut first = marker_index + 1;
    let mut last = node.children.len();
    let wrapped = node
        .children
        .get(first)
        .and_then(|child| child.text.as_deref())
        == Some(open);
    if wrapped {
        if node.children.last().and_then(|child| child.text.as_deref()) != Some(close) {
            return Err(format!("{}: continuation wrapper is unbalanced", node.kind));
        }
        first += 1;
        last -= 1;
    }
    let has_trailing = node
        .children
        .get(last.saturating_sub(1))
        .and_then(|child| child.text.as_deref())
        == Some(separator);
    if has_trailing {
        last -= 1;
    }

    let mut items = Vec::new();
    let mut index = first;
    while index < last {
        let item = &node.children[index];
        validate_subtree(item, source)?;
        items.push(source_slice(source, item.start, item.end, &node.kind)?);
        index += 1;
        if index < last {
            if node.children[index].text.as_deref() != Some(separator) {
                return Err(format!(
                    "{}: expected separator at child {index}",
                    node.kind
                ));
            }
            index += 1;
        }
    }
    if items.is_empty() || index != last {
        return Err(format!("{}: invalid continuation list", node.kind));
    }

    let marker_end = node.children[marker_index].end;
    let prefix = source_slice(source, node.start, marker_end, &node.kind)?;
    let flat_trailing = if has_trailing {
        Doc::Text(separator.into())
    } else {
        Doc::Text(String::new())
    };
    let trailing = if *add_trailing {
        Doc::if_break(Doc::Text(separator.into()), flat_trailing)
    } else {
        flat_trailing
    };
    Ok(Doc::forced_group(
        Doc::concat(vec![
            prefix,
            Doc::Text(" ".into()),
            Doc::if_break(Doc::Text(open.into()), Doc::Text(String::new())),
            Doc::indent(Doc::concat(vec![
                Doc::Softline,
                separated(items, separator),
                trailing,
            ])),
            Doc::Softline,
            Doc::if_break(Doc::Text(close.into()), Doc::Text(String::new())),
        ]),
        wrapped && has_trailing,
    ))
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
        verbatim_with_comments,
    } = rule
    else {
        return Err("internal error: expected delimited rule".into());
    };
    let (open, close, separator, edge) = (open.as_str(), close.as_str(), separator.as_str(), *edge);
    let (
        items_verbatim,
        preserve_trailing,
        force_trailing,
        independent_items,
        reserve_line_suffix,
        verbatim_with_comments,
    ) = (
        *items_verbatim,
        *preserve_trailing,
        *force_trailing,
        *independent_items,
        *reserve_line_suffix,
        *verbatim_with_comments,
    );
    if verbatim_with_comments && node.children.iter().any(|child| child.kind == "comment") {
        validate_subtree(node, source)?;
        return source_slice(source, node.start, node.end, &node.kind);
    }
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
            Doc::Align(inner, aligned) => stack.push((*aligned, mode, inner)),
            Doc::Group(inner, force, _) => stack.push((
                column,
                if *force || inner.breaks() {
                    Mode::Break
                } else {
                    Mode::Flat
                },
                inner,
            )),
            Doc::IfBreak(broken, flat) => {
                stack.push((column, mode, if mode == Mode::Flat { flat } else { broken }))
            }
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
            Doc::Align(inner, aligned) => stack.push((*aligned, mode, inner)),
            Doc::Group(inner, force, reserve) => {
                let remaining = width as isize - position as isize - *reserve as isize;
                let flat =
                    !force && !inner.breaks() && fits(remaining, column, inner, indent_width);
                stack.push((column, if flat { Mode::Flat } else { Mode::Break }, inner));
            }
            Doc::IfBreak(broken, flat) => {
                stack.push((column, mode, if mode == Mode::Flat { flat } else { broken }))
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
