//! The Doc IR and a Wadler/Prettier-style printer.
//!
//! Width is counted in Unicode scalar values, one scalar one column. Indent is
//! written lazily so that a blank line is genuinely empty rather than a run of
//! spaces.

#[derive(Debug)]
pub enum Doc {
    Text(String),
    Concat(Vec<Doc>),
    Group(Box<Doc>),
    Indent(Box<Doc>),
    /// Space when flat, newline when broken.
    Line,
    /// Nothing when flat, newline when broken.
    Soft,
    /// Always a newline; forces every enclosing group to break.
    Hard,
    IfBreak(Box<Doc>, Box<Doc>),
    /// Content deferred to just before the next newline (trailing comments).
    Suffix(Box<Doc>),
    /// Forces enclosing groups to break without emitting anything.
    BreakParent,
}

impl Doc {
    pub fn nil() -> Doc {
        Doc::Concat(Vec::new())
    }

    pub fn text(s: impl Into<String>) -> Doc {
        Doc::Text(s.into())
    }

    pub fn group(d: Doc) -> Doc {
        Doc::Group(Box::new(d))
    }

    pub fn indent(d: Doc) -> Doc {
        Doc::Indent(Box::new(d))
    }

    /// Does this doc force a break? Propagates out of nested groups, but not
    /// out of a line suffix -- a trailing comment breaks its parent through an
    /// explicit `BreakParent` instead, so the two can be reasoned about apart.
    fn forced(&self) -> bool {
        match self {
            Doc::Hard | Doc::BreakParent => true,
            Doc::Concat(ds) => ds.iter().any(Doc::forced),
            Doc::Group(d) | Doc::Indent(d) => d.forced(),
            _ => false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Flat,
    Break,
}

type Cmd<'a> = (usize, Mode, &'a Doc);

fn scalars(s: &str) -> isize {
    s.chars().count() as isize
}

/// Width of `s` up to its first newline, and whether it had one.
fn first_line(s: &str) -> (isize, bool) {
    match s.split_once('\n') {
        Some((head, _)) => (scalars(head), true),
        None => (scalars(s), false),
    }
}

/// Does `next` fit in `rem` columns, given the work still on the printer's
/// stack? Measuring the rest of the line -- not just the group -- is what
/// makes a trailing `)` or a trailing comment count against the budget.
fn fits(next: Cmd<'_>, rest: &[Cmd<'_>], mut rem: isize, tab: usize) -> bool {
    let mut stack = vec![next];
    let mut rest_at = rest.len();
    loop {
        if rem < 0 {
            return false;
        }
        let (ind, mode, doc) = match stack.pop() {
            Some(cmd) => cmd,
            None => match rest_at.checked_sub(1) {
                Some(i) => {
                    rest_at = i;
                    rest[i]
                }
                None => return true,
            },
        };
        match doc {
            Doc::Text(s) => {
                let (w, wrapped) = first_line(s);
                rem -= w;
                if wrapped {
                    return rem >= 0;
                }
            }
            Doc::Concat(ds) => stack.extend(ds.iter().rev().map(|d| (ind, mode, d))),
            Doc::Group(inner) => {
                let m = if inner.forced() { Mode::Break } else { mode };
                stack.push((ind, m, inner));
            }
            Doc::Indent(inner) => stack.push((ind + tab, mode, inner)),
            Doc::Line => {
                if mode == Mode::Break {
                    return true;
                }
                rem -= 1;
            }
            Doc::Soft => {
                if mode == Mode::Break {
                    return true;
                }
            }
            Doc::Hard => return true,
            Doc::IfBreak(brk, flat) => {
                stack.push((ind, mode, if mode == Mode::Break { brk } else { flat }));
            }
            // Black counts a trailing comment against the line budget, and so
            // do we: it is the difference between breaking a call and leaving
            // an over-long line behind a `# ...`.
            Doc::Suffix(inner) => stack.push((ind, Mode::Flat, inner)),
            Doc::BreakParent => {}
        }
    }
}

pub fn print(doc: &Doc, width: usize, tab: usize) -> String {
    let mut out = String::new();
    let mut pos = 0usize;
    let mut pending = 0usize;
    let mut suffixes: Vec<Cmd<'_>> = Vec::new();
    let mut stack: Vec<Cmd<'_>> = vec![(0, Mode::Break, doc)];

    loop {
        while let Some((ind, mode, doc)) = stack.pop() {
            match doc {
                Doc::Text(s) => {
                    if !s.is_empty() {
                        out.extend(std::iter::repeat_n(' ', pending));
                        pending = 0;
                        out.push_str(s);
                        pos = match s.rsplit_once('\n') {
                            Some((_, tail)) => scalars(tail) as usize,
                            None => pos + scalars(s) as usize,
                        };
                    }
                }
                Doc::Concat(ds) => stack.extend(ds.iter().rev().map(|d| (ind, mode, d))),
                Doc::Indent(inner) => stack.push((ind + tab, mode, inner)),
                Doc::Group(inner) => {
                    let rem = width as isize - pos as isize;
                    let flat = !inner.forced() && fits((ind, Mode::Flat, inner), &stack, rem, tab);
                    stack.push((ind, if flat { Mode::Flat } else { Mode::Break }, inner));
                }
                Doc::Line | Doc::Soft | Doc::Hard => {
                    let breaking = mode == Mode::Break || matches!(doc, Doc::Hard);
                    if breaking && !suffixes.is_empty() {
                        stack.push((ind, mode, doc));
                        stack.extend(suffixes.drain(..).rev());
                        continue;
                    }
                    if breaking {
                        out.push('\n');
                        pending = ind;
                        pos = ind;
                    } else if matches!(doc, Doc::Line) {
                        out.extend(std::iter::repeat_n(' ', pending));
                        pending = 0;
                        out.push(' ');
                        pos += 1;
                    }
                }
                Doc::IfBreak(brk, flat) => {
                    stack.push((ind, mode, if mode == Mode::Break { brk } else { flat }));
                }
                Doc::Suffix(inner) => suffixes.push((ind, Mode::Break, inner)),
                Doc::BreakParent => {}
            }
        }
        if suffixes.is_empty() {
            return out;
        }
        stack.extend(suffixes.drain(..).rev());
    }
}
