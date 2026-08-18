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
    /// Like `Group`, and also breaks when the flat span exceeds `round(max * width)`.
    /// `max` is a fraction of the printer width, not a column count.
    GroupMax(f64, Box<Doc>),
    /// Alternating content and whitespace, packed independently per line.
    /// The tail is `(whitespace, next fill)`; this recursive shape lets the
    /// printer resume without allocating a shortened fill on every decision.
    Fill(Box<Doc>, Option<(Box<Doc>, Box<Doc>)>),
    /// Relative indent of one level for line breaks inside. The unit is the
    /// resolved string for that level -- spaces for most languages, a tab for
    /// gofmt -- so nested indents concatenate and a language region can nest a
    /// tab-indented body inside a space-indented one.
    Indent(String, Box<Doc>),
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

    pub fn group_max(d: Doc, max: f64) -> Doc {
        Doc::GroupMax(max, Box::new(d))
    }

    pub fn fill(parts: Vec<Doc>) -> Doc {
        let mut parts = parts.into_iter().rev();
        let Some(last) = parts.next() else {
            return Doc::nil();
        };
        let mut out = Doc::Fill(Box::new(last), None);
        while let Some(whitespace) = parts.next() {
            let content = parts
                .next()
                .expect("fill parts alternate content and whitespace");
            out = Doc::Fill(
                Box::new(content),
                Some((Box::new(whitespace), Box::new(out))),
            );
        }
        out
    }

    #[cfg(test)]
    pub fn indent(n: usize, d: Doc) -> Doc {
        Doc::Indent(" ".repeat(n), Box::new(d))
    }

    pub fn indent_unit(unit: &str, d: Doc) -> Doc {
        Doc::Indent(unit.to_owned(), Box::new(d))
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
        Doc::Group(inner) | Doc::GroupMax(_, inner) => {
            let inner_forced = collect_forced(inner, forced);
            if inner_forced {
                forced.insert(std::ptr::from_ref(inner.as_ref()));
            }
            inner_forced
        }
        Doc::Fill(content, tail) => {
            let mut any = collect_forced(content, forced);
            if let Some((whitespace, next)) = tail {
                any |= collect_forced(whitespace, forced);
                any |= collect_forced(next, forced);
            }
            any
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

type Cmd<'a> = (String, Mode, &'a Doc);

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
fn fits<'a>(
    mut stack: Vec<Cmd<'a>>,
    rest: &[Cmd<'a>],
    mut rem: isize,
    forced: &Forced,
    must_be_flat: bool,
) -> bool {
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
                    rest[i].clone()
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
            Doc::Concat(ds) => stack.extend(ds.iter().rev().map(|d| (ind.clone(), mode, d))),
            Doc::Group(inner) | Doc::GroupMax(_, inner) => {
                if must_be_flat && forces_break(inner, forced) {
                    return false;
                }
                let m = if forces_break(inner, forced) {
                    Mode::Break
                } else {
                    mode
                };
                stack.push((ind, m, inner));
            }
            Doc::Fill(content, tail) => {
                if let Some((whitespace, next)) = tail {
                    stack.push((ind.clone(), mode, next));
                    stack.push((ind.clone(), mode, whitespace));
                }
                stack.push((ind, mode, content));
            }
            Doc::Indent(unit, inner) => stack.push((ind + unit.as_str(), mode, inner)),
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
    let mut pending = String::new();
    let mut suffixes: Vec<Cmd<'_>> = Vec::new();
    let mut stack: Vec<Cmd<'_>> = vec![(String::new(), Mode::Break, doc)];

    loop {
        while let Some((ind, mode, doc)) = stack.pop() {
            match doc {
                Doc::Text(s) => {
                    if !s.is_empty() {
                        if !pending.is_empty() {
                            out.push_str(&pending);
                            pending.clear();
                        }
                        out.push_str(s);
                        pos = match s.rsplit_once('\n') {
                            Some((_, tail)) => scalars(tail) as usize,
                            None => pos + scalars(s) as usize,
                        };
                    }
                }
                Doc::Concat(ds) => stack.extend(ds.iter().rev().map(|d| (ind.clone(), mode, d))),
                Doc::Indent(unit, inner) => stack.push((ind + unit.as_str(), mode, inner)),
                Doc::Group(inner) | Doc::GroupMax(_, inner) => {
                    let rem = width as isize - pos as isize;
                    let mut flat = !forces_break(inner, &forced)
                        && fits(
                            vec![(ind.clone(), Mode::Flat, inner)],
                            &stack,
                            rem,
                            &forced,
                            false,
                        );
                    if flat {
                        if let Doc::GroupMax(max, _) = doc {
                            let cap = (max * width as f64).round() as isize;
                            flat = fits(
                                vec![(ind.clone(), Mode::Flat, inner)],
                                &[],
                                cap,
                                &forced,
                                false,
                            );
                        }
                    }
                    stack.push((ind, if flat { Mode::Flat } else { Mode::Break }, inner));
                }
                Doc::Fill(content, tail) => {
                    let rem = width as isize - pos as isize;
                    let content_fits = fits(
                        vec![(ind.clone(), Mode::Flat, content)],
                        &[],
                        rem,
                        &forced,
                        true,
                    );
                    let Some((whitespace, next)) = tail else {
                        stack.push((
                            ind,
                            if content_fits {
                                Mode::Flat
                            } else {
                                Mode::Break
                            },
                            content,
                        ));
                        continue;
                    };
                    let Doc::Fill(second, _) = next.as_ref() else {
                        unreachable!("a fill tail is another fill")
                    };
                    let both_fit = fits(
                        vec![
                            (ind.clone(), Mode::Flat, second),
                            (ind.clone(), Mode::Flat, whitespace),
                            (ind.clone(), Mode::Flat, content),
                        ],
                        &[],
                        rem,
                        &forced,
                        true,
                    );
                    stack.push((ind.clone(), mode, next));
                    stack.push((
                        ind.clone(),
                        if both_fit { Mode::Flat } else { Mode::Break },
                        whitespace,
                    ));
                    stack.push((
                        ind,
                        if content_fits {
                            Mode::Flat
                        } else {
                            Mode::Break
                        },
                        content,
                    ));
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
                        pos = scalars(&ind) as usize;
                        pending = ind;
                    } else if matches!(doc, Doc::Line) {
                        if !pending.is_empty() {
                            out.push_str(&pending);
                            pending.clear();
                        }
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

    #[test]
    fn fill_packs_each_line_independently() {
        let doc = Doc::indent(
            2,
            Doc::fill(vec![
                Doc::text("100"),
                Doc::Line,
                Doc::text("200"),
                Doc::Line,
                Doc::text("300"),
                Doc::Line,
                Doc::text("400"),
            ]),
        );
        assert_eq!(print(&doc, 10), "100 200\n  300 400");
    }

    #[test]
    fn fill_counts_astral_characters_as_single_columns() {
        let doc = Doc::fill(vec![
            Doc::text("🙂🙂"),
            Doc::Line,
            Doc::text("x"),
            Doc::Line,
            Doc::text("y"),
        ]);
        assert_eq!(print(&doc, 4), "🙂🙂 x\ny");
    }

    #[test]
    fn break_parent_reaches_a_group_without_disabling_fill() {
        let first = Doc::Concat(vec![Doc::text("a"), Doc::BreakParent]);
        let doc = Doc::group(Doc::fill(vec![
            first,
            Doc::Line,
            Doc::text("b"),
            Doc::Line,
            Doc::text("c"),
        ]));
        assert_eq!(print(&doc, 3), "a b\nc");
    }

    fn capped_pair(left: &str, right: &str, max: f64) -> Doc {
        Doc::group_max(seq(vec![Doc::text(left), Doc::Line, Doc::text(right)]), max)
    }

    #[test]
    fn a_capped_group_breaks_when_its_own_span_exceeds_the_fraction() {
        // Flat form is "leaves: [1, 2, 3, 4]" (20 columns). At width 80 the
        // line has room, but 0.18 * 80 = 14, so the cap opens the group.
        let doc = || capped_pair("leaves:", "[1, 2, 3, 4]", 0.18);
        assert_eq!(print(&doc(), 80), "leaves:\n[1, 2, 3, 4]");
        assert_eq!(
            print(
                &Doc::group(seq(vec![
                    Doc::text("leaves:"),
                    Doc::Line,
                    Doc::text("[1, 2, 3, 4]"),
                ])),
                80
            ),
            "leaves: [1, 2, 3, 4]"
        );
    }

    #[test]
    fn a_capped_group_stays_flat_when_its_span_is_under_the_fraction() {
        // "id: 1" is 5 columns; 0.18 * 80 = 14.
        assert_eq!(print(&capped_pair("id:", "1", 0.18), 80), "id: 1");
    }

    #[test]
    fn a_group_cap_measures_the_construct_not_the_rest_of_the_line() {
        // "id: 1" (5) is under the 14-column cap. The 70-column trailer would
        // trip the cap if we measured the whole line; rustfmt does not.
        let doc = seq(vec![
            capped_pair("id:", "1", 0.18),
            Doc::text("X".repeat(70)),
        ]);
        assert_eq!(print(&doc, 80), format!("id: 1{}", "X".repeat(70)));
    }

    #[test]
    fn a_capped_group_still_breaks_when_the_line_is_full() {
        // Own span is under the cap; remaining columns are not. The group
        // opens in place — Wadler does not insert a break before it — so
        // `id:` stays on the prefix line and `1` drops.
        let doc = seq(vec![
            Doc::text("X".repeat(78)),
            capped_pair("id:", "1", 0.18),
        ]);
        assert_eq!(print(&doc, 80), format!("{}id:\n1", "X".repeat(78)));
    }
}
