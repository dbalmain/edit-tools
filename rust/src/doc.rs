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

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(parts: Vec<Doc>) -> Doc {
        Doc::Concat(parts)
    }

    #[test]
    fn a_group_stays_flat_while_it_fits_and_breaks_when_it_does_not() {
        let doc = || {
            Doc::group(seq(vec![
                Doc::text("["),
                Doc::indent(seq(vec![
                    Doc::Soft,
                    Doc::text("a"),
                    Doc::text(","),
                    Doc::Line,
                    Doc::text("b"),
                ])),
                Doc::Soft,
                Doc::text("]"),
            ]))
        };
        assert_eq!(print(&doc(), 80, 2), "[a, b]");
        assert_eq!(print(&doc(), 4, 2), "[\n  a,\n  b\n]");
    }

    #[test]
    fn width_counts_scalar_values_not_utf16_code_units() {
        // Three astral characters are three columns. Counting UTF-16 units
        // would make them six and break agreement with the other runtime.
        let doc = Doc::group(seq(vec![Doc::text("🙂🙂🙂"), Doc::Line, Doc::text("x")]));
        assert_eq!(print(&doc, 5, 2), "🙂🙂🙂 x");
        assert_eq!(print(&doc, 4, 2), "🙂🙂🙂\nx");
    }

    #[test]
    fn a_blank_line_carries_no_trailing_whitespace() {
        let doc = Doc::indent(seq(vec![
            Doc::text("a"),
            Doc::Hard,
            Doc::Hard,
            Doc::text("b"),
        ]));
        assert_eq!(print(&doc, 80, 4), "a\n\n    b");
    }

    #[test]
    fn a_line_suffix_waits_for_the_end_of_the_line() {
        let doc = seq(vec![
            Doc::text("x"),
            Doc::Suffix(Box::new(Doc::text("  # note"))),
            Doc::text(","),
            Doc::Hard,
            Doc::text("y"),
        ]);
        assert_eq!(print(&doc, 80, 2), "x,  # note\ny");
    }

    #[test]
    fn a_hardline_anywhere_inside_breaks_the_enclosing_group() {
        let doc = Doc::group(seq(vec![
            Doc::text("a"),
            Doc::Line,
            Doc::text("b"),
            Doc::Hard,
        ]));
        assert_eq!(print(&doc, 80, 2), "a\nb\n");
    }

    #[test]
    fn fits_measures_the_rest_of_the_line_not_just_the_group() {
        // The group holds "ab"; the trailing ")))" is on the printer's stack
        // and must still count, or the line silently overflows.
        let doc = seq(vec![
            Doc::group(seq(vec![Doc::text("a"), Doc::Line, Doc::text("b")])),
            Doc::text(")))"),
        ]);
        assert_eq!(print(&doc, 6, 2), "a b)))");
        assert_eq!(print(&doc, 5, 2), "a\nb)))");
    }
}
