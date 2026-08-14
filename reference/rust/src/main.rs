//! Reference submission: JSON only, rules hardcoded. See ../README.md.
//!
//! Mirrors runtime-js/bundle.js constructor for constructor. The two are
//! written idiomatically rather than transliterated, which is the whole point
//! of the exercise -- gate 1 is what keeps them honest.

use std::process::ExitCode;

use serde::Deserialize;

const INDENT_WIDTH: usize = 2;
const PUNCT: [&str; 6] = ["{", "}", "[", "]", ",", ":"];

#[derive(Deserialize)]
struct TreeDoc {
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

impl Node {
    fn raw(&self) -> String {
        match &self.text {
            Some(t) => t.clone(),
            None => self.children.iter().map(Node::raw).collect(),
        }
    }

    fn is_punct(&self) -> bool {
        PUNCT.contains(&self.kind.as_str())
    }
}

// ------------------------------------------------------------------ Doc IR

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
    /// Does this doc contain a hardline? Enclosing groups must then break.
    fn breaks(&self) -> bool {
        match self {
            Doc::Hardline => true,
            Doc::Concat(ds) => ds.iter().any(Doc::breaks),
            Doc::Group(d) | Doc::Indent(d) => d.breaks(),
            _ => false,
        }
    }

    fn group(d: Doc) -> Doc {
        Doc::Group(Box::new(d))
    }

    fn indent(d: Doc) -> Doc {
        Doc::Indent(Box::new(d))
    }
}

fn join(sep: impl Fn() -> Doc, docs: Vec<Doc>) -> Doc {
    let mut out = Vec::new();
    for (i, d) in docs.into_iter().enumerate() {
        if i > 0 {
            out.push(sep());
        }
        out.push(d);
    }
    Doc::Concat(out)
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Flat,
    Break,
}

// --------------------------------------------------------------- the printer

fn fits(remaining: isize, indent: usize, doc: &Doc) -> bool {
    let mut rem = remaining;
    let mut stack = vec![(indent, Mode::Flat, doc)];
    while let Some((ind, mode, d)) = stack.pop() {
        if rem < 0 {
            return false;
        }
        match d {
            Doc::Text(s) => rem -= s.chars().count() as isize,
            Doc::Concat(ds) => stack.extend(ds.iter().rev().map(|c| (ind, mode, c))),
            Doc::Group(inner) => {
                let m = if inner.breaks() { Mode::Break } else { Mode::Flat };
                stack.push((ind, m, inner));
            }
            Doc::Indent(inner) => stack.push((ind + INDENT_WIDTH, mode, inner)),
            Doc::Line => {
                if mode == Mode::Flat {
                    rem -= 1;
                } else {
                    return true;
                }
            }
            Doc::Softline => {
                if mode != Mode::Flat {
                    return true;
                }
            }
            Doc::Hardline => return true,
        }
    }
    rem >= 0
}

fn print(doc: &Doc, width: usize) -> String {
    let mut out = String::new();
    let mut pos = 0usize;
    let mut stack = vec![(0usize, Mode::Break, doc)];

    while let Some((ind, mode, d)) = stack.pop() {
        match d {
            Doc::Text(s) => {
                out.push_str(s);
                pos += s.chars().count();
            }
            Doc::Concat(ds) => stack.extend(ds.iter().rev().map(|c| (ind, mode, c))),
            Doc::Indent(inner) => stack.push((ind + INDENT_WIDTH, mode, inner)),
            Doc::Group(inner) => {
                let remaining = width as isize - pos as isize;
                let flat = !inner.breaks() && fits(remaining, ind, inner);
                stack.push((ind, if flat { Mode::Flat } else { Mode::Break }, inner));
            }
            Doc::Line => {
                if mode == Mode::Flat {
                    out.push(' ');
                    pos += 1;
                } else {
                    newline(&mut out, &mut pos, ind);
                }
            }
            Doc::Softline => {
                if mode != Mode::Flat {
                    newline(&mut out, &mut pos, ind);
                }
            }
            Doc::Hardline => newline(&mut out, &mut pos, ind),
        }
    }
    out
}

fn newline(out: &mut String, pos: &mut usize, indent: usize) {
    out.push('\n');
    out.extend(std::iter::repeat(' ').take(indent));
    *pos = indent;
}

// -------------------------------------------------------- JSON rules (dumb)

fn build(node: &Node) -> Doc {
    match node.kind.as_str() {
        "document" => match node.children.iter().find(|c| !c.is_punct()) {
            Some(value) => build(value),
            None => Doc::Text(String::new()),
        },
        "object" => {
            let pairs: Vec<&Node> = node.children.iter().filter(|c| c.kind == "pair").collect();
            if pairs.is_empty() {
                return Doc::Text("{}".into());
            }
            Doc::group(Doc::Concat(vec![
                Doc::Text("{".into()),
                Doc::indent(Doc::Concat(vec![
                    Doc::Line,
                    join(
                        || Doc::Concat(vec![Doc::Text(",".into()), Doc::Line]),
                        pairs.into_iter().map(build).collect(),
                    ),
                ])),
                Doc::Line,
                Doc::Text("}".into()),
            ]))
        }
        "array" => {
            let items: Vec<&Node> = node.children.iter().filter(|c| !c.is_punct()).collect();
            if items.is_empty() {
                return Doc::Text("[]".into());
            }
            Doc::group(Doc::Concat(vec![
                Doc::Text("[".into()),
                Doc::indent(Doc::Concat(vec![
                    Doc::Softline,
                    join(
                        || Doc::Concat(vec![Doc::Text(",".into()), Doc::Line]),
                        items.into_iter().map(build).collect(),
                    ),
                ])),
                Doc::Softline,
                Doc::Text("]".into()),
            ]))
        }
        "pair" => {
            let mut parts = node.children.iter().filter(|c| !c.is_punct());
            let key = parts.next().expect("pair has a key");
            let value = parts.next().expect("pair has a value");
            Doc::Concat(vec![
                Doc::Text(key.raw()),
                Doc::Text(": ".into()),
                build(value),
            ])
        }
        _ => Doc::Text(node.raw()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let [_, tree_path, width] = &args[..] else {
        eprintln!("usage: fmt-rust <tree.json> <width>");
        return ExitCode::FAILURE;
    };

    let Ok(raw) = std::fs::read_to_string(tree_path) else {
        eprintln!("cannot read {tree_path}");
        return ExitCode::FAILURE;
    };
    let doc: TreeDoc = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("malformed tree: {e}");
            return ExitCode::FAILURE;
        }
    };
    if doc.language != "json" {
        eprintln!("reference submission handles json only, got {}", doc.language);
        return ExitCode::FAILURE;
    }
    let width: usize = width.parse().unwrap_or(88);

    let out = print(&Doc::Concat(vec![build(&doc.root), Doc::Hardline]), width);
    print!("{out}");
    ExitCode::SUCCESS
}
