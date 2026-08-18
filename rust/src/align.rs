//! Experimental rendered-text alignment.
//!
//! A second pass over rendered text that reproduces gofmt: `go/printer` splits
//! a declaration into vtab-terminated cells, and `text/tabwriter` aligns column
//! `c` over each *contiguous* run of rows that still have a cell after it,
//! discarding a column whose cells are all empty. Both halves matter -- padding
//! a whole block uniformly is what the first cut of this spike got wrong.
//!
//! This mirrors `runtime-js/bundle.js` line for line on purpose; gate 1 checks
//! the two byte for byte.

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Field,
    Value,
    Stmt,
}

#[derive(Default)]
struct Scan {
    indent: String,
    body: String,
    comment: String,
    opaque: bool,
}

#[derive(Default)]
struct State {
    raw: bool,
    block: bool,
}

#[derive(Default)]
struct Parts {
    name: String,
    ty: String,
    value: String,
    tag: String,
}

fn width(s: &str) -> usize {
    s.chars().count()
}

fn scan(line: &str, state: &mut State) -> Scan {
    let began = state.raw || state.block;
    let bytes = line.as_bytes();
    let mut quote = if state.raw { b'`' } else { 0 };
    let mut escaped = false;
    let mut comment = None;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if state.block {
            if byte == b'*' && bytes.get(i + 1) == Some(&b'/') {
                state.block = false;
                // A block comment that closes mid-line is part of the code, not
                // a trailing comment: only a run to end of line starts one.
                if !line[i + 2..].trim().is_empty() {
                    comment = None;
                }
                i += 1;
            }
        } else if quote == b'`' {
            if byte == b'`' {
                quote = 0;
                state.raw = false;
            }
        } else if quote != 0 {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                quote = 0;
            }
        } else if byte == b'`' {
            quote = b'`';
            state.raw = true;
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b'/' && bytes.get(i + 1) == Some(&b'/') {
            comment = Some(i);
            break;
        } else if byte == b'/' && bytes.get(i + 1) == Some(&b'*') {
            state.block = true;
            comment = comment.or(Some(i));
            i += 1;
        }
        i += 1;
    }
    let code = line[..comment.unwrap_or(line.len())].trim_end();
    let indent_len = code
        .as_bytes()
        .iter()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    Scan {
        indent: code[..indent_len].to_owned(),
        body: code[indent_len..].to_owned(),
        comment: comment.map(|at| &line[at..]).unwrap_or_default().to_owned(),
        opaque: began || state.raw || state.block,
    }
}

/// Quote-aware whitespace split with the leading comma-terminated tokens
/// merged: gofmt's `identList` makes `r, w int` two cells, not three.
fn tokens(value: &str) -> Vec<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut start = None;
    let mut quote = 0;
    let mut escaped = false;
    for (i, &byte) in bytes.iter().enumerate() {
        if quote == b'`' {
            if byte == b'`' {
                quote = 0;
            }
        } else if quote != 0 {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                quote = 0;
            }
        } else if byte == b'`' || byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b' ' || byte == b'\t' {
            if let Some(at) = start.take() {
                out.push(value[at..i].to_owned());
            }
            continue;
        }
        if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(at) = start {
        out.push(value[at..].to_owned());
    }
    let mut names = 1;
    while names < out.len() && out[names - 1].ends_with(',') {
        names += 1;
    }
    if names > 1 {
        let tail = out.split_off(names);
        let mut merged = vec![out.join(" ")];
        merged.extend(tail);
        merged
    } else {
        out
    }
}

/// Top-level `=` introducing a spec's values.
fn assign_at(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut quote = 0;
    let mut escaped = false;
    let mut depth: i32 = 0;
    for (i, &byte) in bytes.iter().enumerate() {
        if quote == b'`' {
            if byte == b'`' {
                quote = 0;
            }
        } else if quote != 0 {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                quote = 0;
            }
        } else if byte == b'`' || byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if matches!(byte, b'(' | b'[' | b'{') {
            depth += 1;
        } else if matches!(byte, b')' | b']' | b'}') {
            depth -= 1;
        } else if byte == b'='
            && depth == 0
            && bytes.get(i + 1) != Some(&b'=')
            && !matches!(
                i.checked_sub(1).map_or(b' ', |at| bytes[at]),
                b'=' | b'!' | b'<' | b'>' | b':'
            )
        {
            return Some(i);
        }
    }
    None
}

/// Recover the printer's slots from rendered text: names, type, values, tag.
fn parts(info: &Scan, kind: Kind) -> Parts {
    if kind == Kind::Stmt {
        return Parts {
            name: info.body.clone(),
            ..Parts::default()
        };
    }
    let equal = if kind == Kind::Value {
        assign_at(&info.body)
    } else {
        None
    };
    let head = equal.map_or(info.body.as_str(), |at| info.body[..at].trim_end());
    let all = tokens(head);
    let mut rest: Vec<String> = all.iter().skip(1).cloned().collect();
    let mut tag = String::new();
    if kind == Kind::Field && rest.len() > 1 {
        let last = rest[rest.len() - 1].clone();
        if last.starts_with('`') || last.starts_with('"') {
            tag = last;
            rest.pop();
        }
    }
    Parts {
        name: all.first().cloned().unwrap_or_default(),
        ty: rest.join(" "),
        value: equal.map_or(String::new(), |at| {
            format!("= {}", info.body[at + 1..].trim_start())
        }),
        tag,
    }
}

/// `go/printer`'s `valueSpec` and `fieldList`, cell for cell. `keep` is
/// `keepTypeColumn`'s answer for this row.
fn row(part: &Parts, comment: &str, kind: Kind, keep: bool) -> Vec<String> {
    if kind == Kind::Stmt {
        return if comment.is_empty() {
            vec![part.name.clone()]
        } else {
            vec![part.name.clone(), comment.to_owned()]
        };
    }
    let mut cells = vec![part.name.clone()];
    let mut extra;
    if kind == Kind::Value {
        extra = 3;
        if !part.ty.is_empty() || keep {
            cells.push(part.ty.clone());
            extra -= 1;
        }
        if !part.value.is_empty() {
            cells.push(part.value.clone());
            extra -= 1;
        }
    } else if !part.ty.is_empty() {
        cells.push(part.ty.clone());
        extra = 1;
    } else {
        extra = 2;
    }
    if !part.tag.is_empty() {
        if !part.ty.is_empty() {
            cells.push(String::new());
        }
        cells.push(part.tag.clone());
        extra = 1;
    }
    if !comment.is_empty() {
        for _ in 1..extra {
            cells.push(String::new());
        }
        cells.push(comment.to_owned());
    }
    cells
}

/// `keepTypeColumn`: within a run of specs that all have values, the type
/// column survives if any of them declares a type.
fn keep_type(rows: &[Parts]) -> Vec<bool> {
    let mut keep = vec![false; rows.len()];
    let mut from: Option<usize> = None;
    let mut seen = false;
    for i in 0..=rows.len() {
        if i < rows.len() && !rows[i].value.is_empty() {
            if from.is_none() {
                from = Some(i);
                seen = false;
            }
        } else if let Some(start) = from.take() {
            if seen {
                keep[start..i].fill(true);
            }
        }
        if i < rows.len() && !rows[i].ty.is_empty() {
            seen = true;
        }
    }
    keep
}

fn tabwrite(lines: &mut [String], infos: &[Scan], at: &[usize], rows: &[Vec<String>]) {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(1) - 1;
    let mut pad: Vec<Vec<usize>> = rows.iter().map(|cells| vec![0; cells.len()]).collect();
    for column in 0..columns {
        let mut block: Vec<usize> = Vec::new();
        let close = |block: &mut Vec<usize>, pad: &mut Vec<Vec<usize>>| {
            let wide = block
                .iter()
                .map(|&r| width(&rows[r][column]))
                .max()
                .unwrap_or(0);
            // DiscardEmptyColumns: gofmt separates cells with vertical tabs.
            if wide > 0 {
                for &r in block.iter() {
                    pad[r][column] = wide + 1;
                }
            }
            block.clear();
        };
        for (r, cells) in rows.iter().enumerate() {
            if cells.len() > column + 1 {
                block.push(r);
            } else {
                close(&mut block, &mut pad);
            }
        }
        close(&mut block, &mut pad);
    }
    for (r, cells) in rows.iter().enumerate() {
        let mut out = infos[at[r]].indent.clone();
        for (column, cell) in cells.iter().enumerate() {
            out.push_str(cell);
            if column + 1 < cells.len() {
                out.push_str(&" ".repeat(pad[r][column].saturating_sub(width(cell))));
            }
        }
        lines[at[r]] = out;
    }
}

/// Runs end at a blank line, an opaque line (raw string or block comment), an
/// indent change, or the brace closing a declaration group. Declarations and
/// statements are separate passes because their cell models differ.
fn align(lines: &mut [String], decl: bool) {
    let mut state = State::default();
    let infos: Vec<Scan> = lines.iter().map(|line| scan(line, &mut state)).collect();
    let mut at: Vec<usize> = Vec::new();
    let mut rows: Vec<Parts> = Vec::new();
    let mut kind = Kind::Stmt;
    let mut indent: Option<&str> = None;
    let mut group: Option<(Kind, String)> = None;

    macro_rules! flush {
        () => {
            if at.len() > 1 {
                let keep = if kind == Kind::Value {
                    keep_type(&rows)
                } else {
                    vec![false; rows.len()]
                };
                let cells: Vec<_> = rows
                    .iter()
                    .enumerate()
                    .map(|(i, part)| row(part, &infos[at[i]].comment, kind, keep[i]))
                    .collect();
                tabwrite(lines, &infos, &at, &cells);
            }
            at.clear();
            rows.clear();
            #[allow(unused_assignments)]
            {
                indent = None;
            }
        };
    }

    for (i, info) in infos.iter().enumerate() {
        if info.opaque || info.body.is_empty() {
            flush!();
            continue;
        }
        let closes = group.as_ref().is_some_and(|(_, opener)| {
            info.indent == *opener && (info.body.starts_with('}') || info.body.starts_with(')'))
        });
        if closes {
            flush!();
            group = None;
            continue;
        }
        let mut current = group.as_ref().map(|(kind, _)| *kind);
        if current.is_none() {
            let opened = if info.body.ends_with("struct {") {
                Some(Kind::Field)
            } else if info.body == "const (" || info.body == "var (" {
                Some(Kind::Value)
            } else {
                None
            };
            if let Some(opened) = opened {
                flush!();
                group = Some((opened, info.indent.clone()));
                continue;
            }
            current = Some(Kind::Stmt);
        }
        let current = current.unwrap_or(Kind::Stmt);
        // A line ending in a binary operator or a comma continues one
        // expression or name list across lines; go/printer emits a formfeed
        // there, which ends the tabwriter section rather than aligning the
        // pieces.
        let skip = if decl {
            current == Kind::Stmt
        } else {
            current != Kind::Stmt || info.comment.is_empty()
        } || info
            .body
            .ends_with(['+', '-', '*', '/', '%', '&', '|', '^', ',']);
        if skip {
            flush!();
            continue;
        }
        if indent.is_some_and(|seen| seen != info.indent) {
            flush!();
        }
        indent = Some(&info.indent);
        kind = current;
        at.push(i);
        rows.push(parts(info, current));
    }
    flush!();
}

pub fn go(input: &str) -> String {
    let mut lines: Vec<String> = input.split('\n').map(str::to_owned).collect();
    align(&mut lines, true);
    align(&mut lines, false);
    lines.join("\n")
}

/// Language-independent tabwriter over `print()`'s vertical-tab markers.
///
/// A run is contiguous marked rows at the same indent. A blank line, an
/// unmarked line, an indent change, or a group closer (`}` / `)` as the
/// first cell) ends the run. A row with fewer cells terminates that column
/// so the rows below start a fresh one. An all-empty column is discarded.
pub fn cells(input: &str) -> String {
    if !input.contains(MARK) {
        return input.to_owned();
    }
    let mut lines: Vec<String> = input.split('\n').map(str::to_owned).collect();
    align_cells(&mut lines);
    lines.join("\n")
}

const MARK: char = '\u{000B}';

struct Marked {
    indent: String,
    cells: Vec<String>,
    closer: bool,
}

fn marked(line: &str) -> Option<Marked> {
    if !line.contains(MARK) {
        return None;
    }
    let indent_len = line
        .as_bytes()
        .iter()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    let cells: Vec<String> = line[indent_len..].split(MARK).map(str::to_owned).collect();
    let first = cells.first().map_or("", String::as_str);
    let closer = first.starts_with('}') || first.starts_with(')');
    Some(Marked {
        indent: line[..indent_len].to_owned(),
        cells,
        closer,
    })
}

fn tabwrite_cells(lines: &mut [String], at: &[usize], rows: &[Vec<String>], indents: &[String]) {
    let columns = rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(1)
        .saturating_sub(1);
    let mut pad: Vec<Vec<usize>> = rows.iter().map(|cells| vec![0; cells.len()]).collect();
    for column in 0..columns {
        let mut block: Vec<usize> = Vec::new();
        let close = |block: &mut Vec<usize>, pad: &mut [Vec<usize>]| {
            let wide = block
                .iter()
                .map(|&r| width(&rows[r][column]))
                .max()
                .unwrap_or(0);
            if wide > 0 {
                for &r in block.iter() {
                    pad[r][column] = wide + 1;
                }
            }
            block.clear();
        };
        for (r, cells) in rows.iter().enumerate() {
            if cells.len() > column + 1 {
                block.push(r);
            } else {
                close(&mut block, &mut pad);
            }
        }
        close(&mut block, &mut pad);
    }
    for (r, cells) in rows.iter().enumerate() {
        let mut out = indents[r].clone();
        for (column, cell) in cells.iter().enumerate() {
            out.push_str(cell);
            if column + 1 < cells.len() {
                out.push_str(&" ".repeat(pad[r][column].saturating_sub(width(cell))));
            }
        }
        lines[at[r]] = out;
    }
}

fn flush_cells(
    lines: &mut [String],
    at: &mut Vec<usize>,
    rows: &mut Vec<Vec<String>>,
    indents: &mut Vec<String>,
) {
    if !at.is_empty() {
        tabwrite_cells(lines, at, rows, indents);
    }
    at.clear();
    rows.clear();
    indents.clear();
}

fn align_cells(lines: &mut [String]) {
    let parsed: Vec<Option<Marked>> = lines.iter().map(|line| marked(line)).collect();
    let mut at: Vec<usize> = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut indents: Vec<String> = Vec::new();
    let mut indent = String::new();

    for (i, row) in parsed.iter().enumerate() {
        let Some(row) = row else {
            flush_cells(lines, &mut at, &mut rows, &mut indents);
            continue;
        };
        if row.closer {
            flush_cells(lines, &mut at, &mut rows, &mut indents);
            tabwrite_cells(
                lines,
                &[i],
                std::slice::from_ref(&row.cells),
                std::slice::from_ref(&row.indent),
            );
            continue;
        }
        if !at.is_empty() && indent != row.indent {
            flush_cells(lines, &mut at, &mut rows, &mut indents);
        }
        indent.clone_from(&row.indent);
        at.push(i);
        rows.push(row.cells.clone());
        indents.push(row.indent.clone());
    }
    flush_cells(lines, &mut at, &mut rows, &mut indents);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixpoint(input: &str) -> String {
        let once = go(input);
        assert_eq!(go(&once), once, "alignment must be idempotent");
        once
    }

    #[test]
    fn blank_line_resets_a_run_and_columns_are_independent() {
        let got = fixpoint(concat!(
            "type T struct {\n",
            "\tA int\n",
            "\tLong string\n",
            "\n",
            "\tTag bool `json:\"tag\"`\n",
            "\tX string `json:\"x\"`\n",
            "}",
        ));
        assert_eq!(
            got,
            concat!(
                "type T struct {\n",
                "\tA    int\n",
                "\tLong string\n",
                "\n",
                "\tTag bool   `json:\"tag\"`\n",
                "\tX   string `json:\"x\"`\n",
                "}",
            )
        );
    }

    #[test]
    fn a_shorter_row_terminates_a_column_rather_than_widening_it() {
        // gofmt: the embedded field splits the type column in two, and the
        // comment-free `err error` splits the comment column in two.
        let got = fixpoint(concat!(
            "type T struct {\n",
            "\tA int\n",
            "\tEmbedded\n",
            "\tBcd int\n",
            "\tr, w int // rw\n",
            "\terr error\n",
            "\tlast int // last\n",
            "\tmore int // more\n",
            "}",
        ));
        assert_eq!(
            got,
            concat!(
                "type T struct {\n",
                "\tA int\n",
                "\tEmbedded\n",
                "\tBcd  int\n",
                "\tr, w int // rw\n",
                "\terr  error\n",
                "\tlast int // last\n",
                "\tmore int // more\n",
                "}",
            )
        );
    }

    #[test]
    fn value_specs_keep_the_type_column_only_inside_a_run_with_values() {
        let got = fixpoint(concat!(
            "const (\n",
            "\ta = 1\n",
            "\tbcd int = 2\n",
            "\tef = 3 // c\n",
            ")",
        ));
        assert_eq!(
            got,
            concat!(
                "const (\n",
                "\ta       = 1\n",
                "\tbcd int = 2\n",
                "\tef      = 3 // c\n",
                ")",
            )
        );
    }

    #[test]
    fn an_all_empty_column_is_discarded_rather_than_padded() {
        let got = fixpoint(concat!(
            "const (\n",
            "\tA = iota // a\n",
            "\tBcdefg // b\n",
            ")"
        ));
        assert_eq!(
            got,
            concat!(
                "const (\n",
                "\tA      = iota // a\n",
                "\tBcdefg        // b\n",
                ")"
            )
        );
    }

    #[test]
    fn a_continuation_line_is_not_a_sibling() {
        // gofmt gives each operand of a multi-line expression a single space:
        // the pieces are one node, not a column of siblings.
        let got = fixpoint(concat!(
            "const (\n",
            "\tflags = a |\n",
            "\t\tbb | // second\n",
            "\t\tcccccc | // third\n",
            "\t\td\n",
            ")",
        ));
        assert_eq!(
            got,
            concat!(
                "const (\n",
                "\tflags = a |\n",
                "\t\tbb | // second\n",
                "\t\tcccccc | // third\n",
                "\t\td\n",
                ")",
            )
        );
    }

    #[test]
    fn a_block_comment_closing_mid_line_is_code_not_a_trailing_comment() {
        let got = fixpoint(concat!(
            "func f() {\n",
            "\tg(1000 /* 1ms */)\n",
            "\tlonger(2)\n",
            "}",
        ));
        assert_eq!(
            got,
            concat!(
                "func f() {\n",
                "\tg(1000 /* 1ms */)\n",
                "\tlonger(2)\n",
                "}"
            )
        );
    }

    #[test]
    fn a_multi_line_block_comment_is_opaque() {
        let got = fixpoint(concat!(
            "/*\n",
            "type T struct {\n",
            "\tint r;\n",
            "\tchar pad[4];\n",
            "*/\n",
            "import \"C\"",
        ));
        assert_eq!(
            got,
            concat!(
                "/*\n",
                "type T struct {\n",
                "\tint r;\n",
                "\tchar pad[4];\n",
                "*/\n",
                "import \"C\""
            )
        );
    }

    fn cell_fixpoint(input: &str) -> String {
        let once = cells(input);
        assert_eq!(cells(&once), once, "cell alignment must be idempotent");
        once
    }

    #[test]
    fn cells_pad_marked_runs_and_a_blank_line_resets() {
        let got = cell_fixpoint(concat!(
            "type T struct {\n",
            "\tA\u{000B}int\n",
            "\tLong\u{000B}string\n",
            "\n",
            "\tTag\u{000B}bool\u{000B}`json:\"tag\"`\n",
            "\tX\u{000B}string\u{000B}`json:\"x\"`\n",
            "}",
        ));
        assert_eq!(
            got,
            concat!(
                "type T struct {\n",
                "\tA    int\n",
                "\tLong string\n",
                "\n",
                "\tTag bool   `json:\"tag\"`\n",
                "\tX   string `json:\"x\"`\n",
                "}",
            )
        );
    }

    #[test]
    fn cells_a_shorter_row_terminates_a_column() {
        let got = cell_fixpoint(concat!(
            "type T struct {\n",
            "\tA\u{000B}int\n",
            "\tEmbedded\n",
            "\tBcd\u{000B}int\n",
            "\tr, w\u{000B}int\u{000B}// rw\n",
            "\terr\u{000B}error\n",
            "\tlast\u{000B}int\u{000B}// last\n",
            "\tmore\u{000B}int\u{000B}// more\n",
            "}",
        ));
        assert_eq!(
            got,
            concat!(
                "type T struct {\n",
                "\tA int\n",
                "\tEmbedded\n",
                "\tBcd  int\n",
                "\tr, w int // rw\n",
                "\terr  error\n",
                "\tlast int // last\n",
                "\tmore int // more\n",
                "}",
            )
        );
    }

    #[test]
    fn cells_empty_type_slots_keep_the_equals_column() {
        let got = cell_fixpoint(concat!(
            "const (\n",
            "\ta\u{000B}\u{000B}= 1\n",
            "\tbcd\u{000B}int\u{000B}= 2\n",
            "\tef\u{000B}\u{000B}= 3\u{000B}// c\n",
            ")",
        ));
        assert_eq!(
            got,
            concat!(
                "const (\n",
                "\ta       = 1\n",
                "\tbcd int = 2\n",
                "\tef      = 3 // c\n",
                ")",
            )
        );
    }

    #[test]
    fn cells_discard_an_all_empty_column() {
        let got = cell_fixpoint(concat!(
            "const (\n",
            "\tA\u{000B}\u{000B}= iota\u{000B}// a\n",
            "\tBcdefg\u{000B}\u{000B}\u{000B}// b\n",
            ")",
        ));
        assert_eq!(
            got,
            concat!(
                "const (\n",
                "\tA      = iota // a\n",
                "\tBcdefg        // b\n",
                ")"
            )
        );
    }

    #[test]
    fn cells_an_unmarked_continuation_is_not_a_sibling() {
        let got = cell_fixpoint(concat!(
            "const (\n",
            "\tflags\u{000B}\u{000B}= a |\n",
            "\t\tbb | // second\n",
            "\t\tcccccc | // third\n",
            "\t\td\n",
            ")",
        ));
        assert_eq!(
            got,
            concat!(
                "const (\n",
                "\tflags = a |\n",
                "\t\tbb | // second\n",
                "\t\tcccccc | // third\n",
                "\t\td\n",
                ")",
            )
        );
    }

    #[test]
    fn cells_a_closer_does_not_join_the_comment_column() {
        let got = cell_fixpoint(concat!(
            "type T struct {\n",
            "\tA\u{000B}int\u{000B}// a\n",
            "\tLongName\u{000B}string\u{000B}// b\n",
            "}\u{000B}// end\n",
            "func init() {\u{000B}// f\n",
        ));
        assert_eq!(
            got,
            concat!(
                "type T struct {\n",
                "\tA        int    // a\n",
                "\tLongName string // b\n",
                "} // end\n",
                "func init() { // f\n",
            )
        );
    }
}
