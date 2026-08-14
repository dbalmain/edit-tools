//! Wadler/Lindig Doc IR and printer.
//!
//! Width is Unicode scalar values (`chars().count()`), never bytes.

#[derive(Clone, Debug)]
pub enum Doc {
    Text(String),
    Concat(Vec<Doc>),
    Group { inner: Box<Doc>, should_break: bool },
    Indent(Box<Doc>),
    Line,
    Softline,
    Hardline,
    IfBreak { broken: Box<Doc>, flat: Box<Doc> },
    LineSuffix(Box<Doc>),
}

impl Doc {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }

    pub fn group(inner: Doc) -> Self {
        Self::Group {
            inner: Box::new(inner),
            should_break: false,
        }
    }

    pub fn group_break(inner: Doc, should_break: bool) -> Self {
        Self::Group {
            inner: Box::new(inner),
            should_break,
        }
    }

    pub fn indent(inner: Doc) -> Self {
        Self::Indent(Box::new(inner))
    }

    pub fn if_break(broken: Doc, flat: Doc) -> Self {
        Self::IfBreak {
            broken: Box::new(broken),
            flat: Box::new(flat),
        }
    }

    pub fn line_suffix(inner: Doc) -> Self {
        Self::LineSuffix(Box::new(inner))
    }

    /// A hardline anywhere inside forces enclosing groups to break.
    /// `IfBreak` contents are not scanned — Prettier's documented limit.
    pub fn forces_break(&self) -> bool {
        match self {
            Self::Hardline => true,
            Self::Concat(docs) => docs.iter().any(Self::forces_break),
            Self::Group { inner, .. } | Self::Indent(inner) => inner.forces_break(),
            Self::IfBreak { .. }
            | Self::LineSuffix(_)
            | Self::Text(_)
            | Self::Line
            | Self::Softline => false,
        }
    }
}

pub fn join(sep: &Doc, docs: Vec<Doc>) -> Doc {
    let mut out = Vec::new();
    for (i, d) in docs.into_iter().enumerate() {
        if i > 0 {
            out.push(sep.clone());
        }
        out.push(d);
    }
    Doc::Concat(out)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Flat,
    Break,
}

fn fits(remaining: isize, indent_width: usize, indent: usize, doc: &Doc) -> bool {
    let mut rem = remaining;
    let mut stack = vec![(indent, Mode::Flat, doc)];
    while let Some((ind, mode, d)) = stack.pop() {
        if rem < 0 {
            return false;
        }
        match d {
            Doc::Text(s) => rem -= s.chars().count() as isize,
            Doc::Concat(docs) => {
                stack.extend(docs.iter().rev().map(|c| (ind, mode, c)));
            }
            Doc::Group {
                inner,
                should_break,
            } => {
                let m = if *should_break || inner.forces_break() {
                    Mode::Break
                } else {
                    Mode::Flat
                };
                stack.push((ind, m, inner));
            }
            Doc::Indent(inner) => stack.push((ind + indent_width, mode, inner)),
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
            Doc::IfBreak { broken, flat } => {
                stack.push((ind, mode, if mode == Mode::Break { broken } else { flat }));
            }
            Doc::LineSuffix(_) => {}
        }
    }
    rem >= 0
}

fn flush_suffixes(out: &mut String, suffixes: &mut Vec<Doc>) {
    for suffix in suffixes.drain(..) {
        write_flat(out, &suffix);
    }
}

fn write_flat(out: &mut String, doc: &Doc) {
    match doc {
        Doc::Text(s) => out.push_str(s),
        Doc::Concat(docs) => {
            for d in docs {
                write_flat(out, d);
            }
        }
        _ => {}
    }
}

fn newline(out: &mut String, pos: &mut usize, indent: usize, suffixes: &mut Vec<Doc>) {
    flush_suffixes(out, suffixes);
    out.push('\n');
    out.extend(std::iter::repeat_n(' ', indent));
    *pos = indent;
}

pub fn print(doc: &Doc, width: usize, indent_width: usize) -> String {
    let mut out = String::new();
    let mut pos = 0usize;
    let mut suffixes = Vec::new();
    let mut stack = vec![(0usize, Mode::Break, doc)];

    while let Some((ind, mode, d)) = stack.pop() {
        match d {
            Doc::Text(s) => {
                out.push_str(s);
                pos += s.chars().count();
            }
            Doc::Concat(docs) => {
                stack.extend(docs.iter().rev().map(|c| (ind, mode, c)));
            }
            Doc::Indent(inner) => stack.push((ind + indent_width, mode, inner)),
            Doc::Group {
                inner,
                should_break,
            } => {
                let must = *should_break || inner.forces_break();
                let remaining = width as isize - pos as isize;
                let flat = !must && fits(remaining, indent_width, ind, inner);
                stack.push((ind, if flat { Mode::Flat } else { Mode::Break }, inner));
            }
            Doc::Line => {
                if mode == Mode::Flat {
                    out.push(' ');
                    pos += 1;
                } else {
                    newline(&mut out, &mut pos, ind, &mut suffixes);
                }
            }
            Doc::Softline => {
                if mode != Mode::Flat {
                    newline(&mut out, &mut pos, ind, &mut suffixes);
                }
            }
            Doc::Hardline => newline(&mut out, &mut pos, ind, &mut suffixes),
            Doc::IfBreak { broken, flat } => {
                stack.push((ind, mode, if mode == Mode::Break { broken } else { flat }));
            }
            Doc::LineSuffix(inner) => suffixes.push((**inner).clone()),
        }
    }
    flush_suffixes(&mut out, &mut suffixes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_width_not_utf16() {
        assert_eq!("café".chars().count(), 4);
        assert_eq!("🙂".chars().count(), 1);
        assert_eq!("🙂🙂".chars().count(), 2);
    }

    #[test]
    fn flat_group_fits() {
        let doc = Doc::group(Doc::Concat(vec![
            Doc::text("["),
            Doc::indent(Doc::Concat(vec![
                Doc::Softline,
                Doc::text("1"),
                Doc::text(","),
                Doc::Line,
                Doc::text("2"),
            ])),
            Doc::Softline,
            Doc::text("]"),
        ]));
        assert_eq!(print(&doc, 80, 2), "[1, 2]");
        assert_eq!(print(&doc, 3, 2), "[\n  1,\n  2\n]");
    }

    #[test]
    fn if_break_trailing_comma() {
        let inner = Doc::Concat(vec![
            Doc::Softline,
            Doc::text("a"),
            Doc::if_break(Doc::text(","), Doc::text("")),
        ]);
        let doc = Doc::group(Doc::Concat(vec![
            Doc::text("("),
            Doc::indent(inner),
            Doc::Softline,
            Doc::text(")"),
        ]));
        assert_eq!(print(&doc, 80, 4), "(a)");
        assert_eq!(print(&doc, 1, 4), "(\n    a,\n)");
    }

    #[test]
    fn line_suffix_flushes_before_newline() {
        let doc = Doc::Concat(vec![
            Doc::text("x"),
            Doc::line_suffix(Doc::text("  # c")),
            Doc::Hardline,
            Doc::text("y"),
        ]);
        assert_eq!(print(&doc, 80, 4), "x  # c\ny");
    }

    #[test]
    fn should_break_skips_fits() {
        let doc = Doc::group_break(
            Doc::Concat(vec![
                Doc::text("["),
                Doc::indent(Doc::Concat(vec![Doc::Softline, Doc::text("1")])),
                Doc::Softline,
                Doc::text("]"),
            ]),
            true,
        );
        assert_eq!(print(&doc, 80, 2), "[\n  1\n]");
    }
}
