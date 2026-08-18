//! Language-independent tabwriter over `print()`'s vertical-tab markers.
//!
//! A package writes `["cell"]` where a column may break; `print` emits a
//! vertical tab. A run is contiguous marked rows at the same indent. A blank
//! line, an unmarked line, an indent change, or a group closer (`}` / `)` as
//! the first cell) ends the run. A row with fewer cells terminates that
//! column so the rows below start a fresh one. An all-empty column is
//! discarded.
//!
//! Formfeed (`["cellblock"]`) sections get the full tabwriter. Outside them,
//! interior markers collapse to spaces and only a trailing comment cell
//! participates — the same spec rule can serve a grouped `const (` and a
//! standalone `const x = 1`.
//!
//! This mirrors `runtime-js/bundle.js` line for line on purpose; gate 1 checks
//! the two byte for byte.

fn width(s: &str) -> usize {
    s.chars().count()
}

const MARK: char = '\u{000B}';
const FORMFEED: char = '\u{000C}';

pub fn cells(input: &str) -> String {
    if !input.contains(MARK) && !input.contains(FORMFEED) {
        return input.to_owned();
    }
    input
        .split(FORMFEED)
        .enumerate()
        .map(|(i, chunk)| align_chunk(chunk, i % 2 == 0))
        .collect()
}

fn align_chunk(chunk: &str, comment_only: bool) -> String {
    if !chunk.contains(MARK) {
        return chunk.to_owned();
    }
    let mut lines: Vec<String> = chunk.split('\n').map(str::to_owned).collect();
    if comment_only {
        collapse_to_comment_cells(&mut lines);
    }
    align_cells(&mut lines);
    lines.join("\n")
}

fn collapse_to_comment_cells(lines: &mut [String]) {
    for line in lines.iter_mut() {
        if !line.contains(MARK) {
            continue;
        }
        let indent_len = line
            .as_bytes()
            .iter()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count();
        let cells: Vec<&str> = line[indent_len..].split(MARK).collect();
        let last = *cells.last().unwrap_or(&"");
        let comment = last.starts_with("//") || last.starts_with("/*");
        let body = if comment {
            join_nonempty(&cells[..cells.len().saturating_sub(1)])
        } else {
            join_nonempty(&cells)
        };
        let indent = line[..indent_len].to_owned();
        *line = if comment {
            format!("{indent}{body}{MARK}{last}")
        } else {
            format!("{indent}{body}")
        };
    }
}

fn join_nonempty(cells: &[&str]) -> String {
    cells
        .iter()
        .copied()
        .filter(|cell| !cell.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

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

    fn cell_fixpoint(input: &str) -> String {
        let once = cells(input);
        assert_eq!(cells(&once), once, "cell alignment must be idempotent");
        once
    }

    /// Grouped declarations sit inside a `cellblock` pair of formfeeds.
    fn blocked(inner: &str) -> String {
        format!("\u{000C}{inner}\u{000C}")
    }

    #[test]
    fn cells_pad_marked_runs_and_a_blank_line_resets() {
        let got = cell_fixpoint(&blocked(concat!(
            "type T struct {\n",
            "\tA\u{000B}int\n",
            "\tLong\u{000B}string\n",
            "\n",
            "\tTag\u{000B}bool\u{000B}`json:\"tag\"`\n",
            "\tX\u{000B}string\u{000B}`json:\"x\"`\n",
            "}",
        )));
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
        let got = cell_fixpoint(&blocked(concat!(
            "type T struct {\n",
            "\tA\u{000B}int\n",
            "\tEmbedded\n",
            "\tBcd\u{000B}int\n",
            "\tr, w\u{000B}int\u{000B}// rw\n",
            "\terr\u{000B}error\n",
            "\tlast\u{000B}int\u{000B}// last\n",
            "\tmore\u{000B}int\u{000B}// more\n",
            "}",
        )));
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
        let got = cell_fixpoint(&blocked(concat!(
            "const (\n",
            "\ta\u{000B}\u{000B}= 1\n",
            "\tbcd\u{000B}int\u{000B}= 2\n",
            "\tef\u{000B}\u{000B}= 3\u{000B}// c\n",
            ")",
        )));
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
        let got = cell_fixpoint(&blocked(concat!(
            "const (\n",
            "\tA\u{000B}\u{000B}= iota\u{000B}// a\n",
            "\tBcdefg\u{000B}\u{000B}\u{000B}// b\n",
            ")",
        )));
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
        let got = cell_fixpoint(&blocked(concat!(
            "const (\n",
            "\tflags\u{000B}\u{000B}= a |\n",
            "\t\tbb | // second\n",
            "\t\tcccccc | // third\n",
            "\t\td\n",
            ")",
        )));
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
        let got = cell_fixpoint(&blocked(concat!(
            "type T struct {\n",
            "\tA\u{000B}int\u{000B}// a\n",
            "\tLongName\u{000B}string\u{000B}// b\n",
            "}\u{000B}// end\n",
            "func init() {\u{000B}// f\n",
        )));
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

    #[test]
    fn cells_outside_a_block_align_comments_only() {
        let got = cell_fixpoint(concat!(
            "var first\u{000B}\u{000B}= 1\u{000B}// first comment\n",
            "var secondLonger\u{000B}\u{000B}= 2\u{000B}// second comment\n",
            "var third\u{000B}\u{000B}= 3\n",
        ));
        assert_eq!(
            got,
            concat!(
                "var first = 1        // first comment\n",
                "var secondLonger = 2 // second comment\n",
                "var third = 3\n",
            )
        );
    }
}
