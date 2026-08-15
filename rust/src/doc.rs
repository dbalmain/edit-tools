//! The Doc IR and a Wadler/Prettier-style printer.
//!
//! Width is counted in Unicode scalar values, one scalar one column. Indent is
//! written lazily so that a blank line is genuinely empty rather than a run of
//! spaces.

use std::collections::HashSet;

#[derive(Debug)]
pub enum Doc {
    Text(String),
    Concat(Vec<Doc>),
    Group(Box<Doc>),
    /// Relative indent of `n` columns for line breaks inside.
    Indent(usize, Box<Doc>),
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

    pub fn indent(n: usize, d: Doc) -> Doc {
        Doc::Indent(n, Box::new(d))
    }
}

type Forced = HashSet<*const Doc>;

/// Record each group body that forces its group to break. Propagation stops at
/// a line suffix and `IfBreak`, but their children still need visiting because
/// a group inside either boundary makes its own layout decision later.
fn collect_forced(doc: &Doc, forced: &mut Forced) -> bool {
    match doc {
        Doc::Hard | Doc::BreakParent => true,
        Doc::Concat(docs) => {
            let mut any = false;
            for doc in docs {
                any |= collect_forced(doc, forced);
            }
            any
        }
        Doc::Group(inner) => {
            let inner_forced = collect_forced(inner, forced);
            if inner_forced {
                forced.insert(std::ptr::from_ref(inner.as_ref()));
            }
            inner_forced
        }
        Doc::Indent(_, inner) => collect_forced(inner, forced),
        Doc::IfBreak(broken, flat) => {
            collect_forced(broken, forced);
            collect_forced(flat, forced);
            false
        }
        Doc::Suffix(inner) => {
            collect_forced(inner, forced);
            false
        }
        Doc::Text(_) | Doc::Line | Doc::Soft => false,
    }
}

fn forces_break(doc: &Doc, forced: &Forced) -> bool {
    forced.contains(&std::ptr::from_ref(doc))
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
fn fits(next: Cmd<'_>, rest: &[Cmd<'_>], mut rem: isize, forced: &Forced) -> bool {
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
                let m = if forces_break(inner, forced) {
                    Mode::Break
                } else {
                    mode
                };
                stack.push((ind, m, inner));
            }
            Doc::Indent(n, inner) => stack.push((ind + n, mode, inner)),
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

pub fn print(doc: &Doc, width: usize) -> String {
    let mut forced = Forced::new();
    collect_forced(doc, &mut forced);
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
                Doc::Indent(n, inner) => stack.push((ind + n, mode, inner)),
                Doc::Group(inner) => {
                    let rem = width as isize - pos as isize;
                    let flat = !forces_break(inner, &forced)
                        && fits((ind, Mode::Flat, inner), &stack, rem, &forced);
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
                Doc::indent(
                    2,
                    seq(vec![
                        Doc::Soft,
                        Doc::text("a"),
                        Doc::text(","),
                        Doc::Line,
                        Doc::text("b"),
                    ]),
                ),
                Doc::Soft,
                Doc::text("]"),
            ]))
        };
        assert_eq!(print(&doc(), 80), "[a, b]");
        assert_eq!(print(&doc(), 4), "[\n  a,\n  b\n]");
    }

    #[test]
    fn width_counts_scalar_values_not_utf16_code_units() {
        // Three astral characters are three columns. Counting UTF-16 units
        // would make them six and break agreement with the other runtime.
        let doc = Doc::group(seq(vec![Doc::text("🙂🙂🙂"), Doc::Line, Doc::text("x")]));
        assert_eq!(print(&doc, 5), "🙂🙂🙂 x");
        assert_eq!(print(&doc, 4), "🙂🙂🙂\nx");
    }

    #[test]
    fn a_blank_line_carries_no_trailing_whitespace() {
        let doc = Doc::indent(
            4,
            seq(vec![Doc::text("a"), Doc::Hard, Doc::Hard, Doc::text("b")]),
        );
        assert_eq!(print(&doc, 80), "a\n\n    b");
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
        assert_eq!(print(&doc, 80), "x,  # note\ny");
    }

    #[test]
    fn a_hardline_anywhere_inside_breaks_the_enclosing_group() {
        let doc = Doc::group(seq(vec![
            Doc::text("a"),
            Doc::Line,
            Doc::text("b"),
            Doc::Hard,
        ]));
        assert_eq!(print(&doc, 80), "a\nb\n");
    }

    #[test]
    fn a_group_inside_a_nonpropagating_branch_keeps_its_own_forced_state() {
        let inner = Doc::group(seq(vec![
            Doc::text("a"),
            Doc::Line,
            Doc::text("b"),
            Doc::BreakParent,
        ]));
        let doc = Doc::IfBreak(Box::new(inner), Box::new(Doc::nil()));
        assert_eq!(print(&doc, 80), "a\nb");
    }

    #[test]
    fn fits_measures_the_rest_of_the_line_not_just_the_group() {
        // The group holds "ab"; the trailing ")))" is on the printer's stack
        // and must still count, or the line silently overflows.
        let doc = seq(vec![
            Doc::group(seq(vec![Doc::text("a"), Doc::Line, Doc::text("b")])),
            Doc::text(")))"),
        ]);
        assert_eq!(print(&doc, 6), "a b)))");
        assert_eq!(print(&doc, 5), "a\nb)))");
    }

    #[test]
    fn nested_indents_add_their_own_amounts() {
        // Relative: a break inside a 2-column indent that sits inside a
        // 4-column one lands at column 6. The inner Hard has to live under
        // the inner Indent — wrapping already-emitted text is a no-op.
        let doc = Doc::indent(
            4,
            seq(vec![
                Doc::text("a"),
                Doc::indent(2, seq(vec![Doc::Hard, Doc::text("b")])),
            ]),
        );
        assert_eq!(print(&doc, 80), "a\n      b");
    }
}
