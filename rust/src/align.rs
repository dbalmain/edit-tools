//! Experimental rendered-text alignment.
//!
//! This is intentionally Go-shaped rather than a proposed general IR. The
//! package opts in, the ordinary printer finishes first, and this pass aligns
//! blank-line-delimited runs in struct and const/var bodies. A final suffix
//! pass covers adjacent declarations such as top-level `var` lines.

#[derive(Clone, Copy)]
enum Block {
    Fields,
    Assignments,
}

#[derive(Default)]
struct LineInfo {
    indent: String,
    body: String,
    comment: Option<String>,
    multiline_raw: bool,
}

fn width(s: &str) -> usize {
    s.chars().count()
}

fn line_info(line: &str, raw: &mut bool) -> LineInfo {
    let began_raw = *raw;
    let bytes = line.as_bytes();
    let mut quote = if *raw { b'`' } else { 0 };
    let mut escaped = false;
    let mut comment = None;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if quote == b'`' {
            if byte == b'`' {
                quote = 0;
                *raw = false;
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
            *raw = true;
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b'/' && bytes.get(i + 1) == Some(&b'/') {
            comment = Some(i);
            break;
        }
        i += 1;
    }
    let code = line[..comment.unwrap_or(line.len())].trim_end();
    let indent_len = code
        .as_bytes()
        .iter()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    LineInfo {
        indent: code[..indent_len].to_owned(),
        body: code[indent_len..].to_owned(),
        comment: comment.map(|at| line[at..].to_owned()),
        multiline_raw: began_raw || *raw,
    }
}

fn cells(s: &str) -> Vec<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
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
        } else if byte.is_ascii_whitespace() {
            if let Some(at) = start.take() {
                out.push(s[at..i].to_owned());
            }
            continue;
        }
        if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(at) = start {
        out.push(s[at..].to_owned());
    }
    out
}

fn assignment_at(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
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
        } else if byte == b'=' {
            return Some(i);
        }
    }
    None
}

fn render(indent: &str, body: &str, comment: Option<&str>, target: usize) -> String {
    let mut out = format!("{indent}{body}");
    if let Some(comment) = comment {
        out.push_str(&" ".repeat(target.saturating_sub(width(body)) + 1));
        out.push_str(comment);
    }
    out
}

fn align_fields(lines: &mut [String], infos: &[LineInfo], run: &[usize]) {
    let rows: Vec<_> = run
        .iter()
        .filter_map(|&at| {
            let parts = cells(&infos[at].body);
            (parts.len() >= 2).then_some((at, parts))
        })
        .collect();
    if rows.len() < 2 {
        return;
    }
    let columns = rows.iter().map(|(_, parts)| parts.len()).max().unwrap_or(0);
    let mut maxima = vec![0; columns.saturating_sub(1)];
    for (_, parts) in &rows {
        for (column, part) in parts.iter().take(parts.len() - 1).enumerate() {
            maxima[column] = maxima[column].max(width(part));
        }
    }
    let bodies: Vec<_> = rows
        .iter()
        .map(|(_, parts)| {
            let mut body = String::new();
            for (column, part) in parts.iter().enumerate() {
                body.push_str(part);
                if column + 1 < parts.len() {
                    body.push_str(&" ".repeat(maxima[column] - width(part) + 1));
                }
            }
            body
        })
        .collect();
    let target = bodies.iter().map(|body| width(body)).max().unwrap_or(0);
    for ((at, _), body) in rows.into_iter().zip(bodies) {
        lines[at] = render(
            &infos[at].indent,
            &body,
            infos[at].comment.as_deref(),
            target,
        );
    }
}

fn align_assignments(lines: &mut [String], infos: &[LineInfo], run: &[usize]) {
    let rows: Vec<_> = run
        .iter()
        .filter_map(|&at| {
            assignment_at(&infos[at].body).map(|equal| {
                let lhs = infos[at].body[..equal].trim_end().to_owned();
                let rhs = infos[at].body[equal + 1..].trim_start().to_owned();
                (at, lhs, rhs)
            })
        })
        .collect();
    if rows.len() < 2 {
        return;
    }
    let lhs_width = rows.iter().map(|(_, lhs, _)| width(lhs)).max().unwrap_or(0);
    let bodies: Vec<_> = rows
        .iter()
        .map(|(_, lhs, rhs)| format!("{lhs}{}= {rhs}", " ".repeat(lhs_width - width(lhs) + 1)))
        .collect();
    let target = bodies.iter().map(|body| width(body)).max().unwrap_or(0);
    for ((at, _, _), body) in rows.into_iter().zip(bodies) {
        lines[at] = render(
            &infos[at].indent,
            &body,
            infos[at].comment.as_deref(),
            target,
        );
    }
}

fn flush_block(lines: &mut [String], infos: &[LineInfo], block: Block, run: &mut Vec<usize>) {
    match block {
        Block::Fields => align_fields(lines, infos, run),
        Block::Assignments => align_assignments(lines, infos, run),
    }
    run.clear();
}

fn align_blocks(lines: &mut [String]) {
    let mut raw = false;
    let infos: Vec<_> = lines.iter().map(|line| line_info(line, &mut raw)).collect();
    let mut block: Option<(Block, String)> = None;
    let mut run = Vec::new();

    for (at, info) in infos.iter().enumerate() {
        if let Some((kind, opener_indent)) = &block {
            let close = match kind {
                Block::Fields => info.body == "}",
                Block::Assignments => info.body == ")",
            } && info.indent == *opener_indent;
            if close {
                flush_block(lines, &infos, *kind, &mut run);
                block = None;
            } else if info.multiline_raw || info.body.is_empty() {
                flush_block(lines, &infos, *kind, &mut run);
            } else {
                run.push(at);
            }
            continue;
        }

        if info.multiline_raw {
            continue;
        }
        if info.body.ends_with("struct {") {
            block = Some((Block::Fields, info.indent.clone()));
        } else if info.body == "const (" || info.body == "var (" {
            block = Some((Block::Assignments, info.indent.clone()));
        }
    }
    if let Some((kind, _)) = block {
        flush_block(lines, &infos, kind, &mut run);
    }
}

fn align_comments(lines: &mut [String]) {
    let mut raw = false;
    let infos: Vec<_> = lines.iter().map(|line| line_info(line, &mut raw)).collect();
    let mut run = Vec::new();
    let mut indent: Option<&str> = None;

    let flush = |run: &mut Vec<usize>, lines: &mut [String]| {
        let commented: Vec<_> = run
            .iter()
            .copied()
            .filter(|&at| infos[at].comment.is_some())
            .collect();
        if commented.len() >= 2 {
            let target = commented
                .iter()
                .map(|&at| width(&infos[at].body))
                .max()
                .unwrap_or(0);
            for at in commented {
                lines[at] = render(
                    &infos[at].indent,
                    &infos[at].body,
                    infos[at].comment.as_deref(),
                    target,
                );
            }
        }
        run.clear();
    };

    for (at, info) in infos.iter().enumerate() {
        let boundary = info.multiline_raw
            || info.body.is_empty()
            || indent.is_some_and(|current| current != info.indent);
        if boundary {
            flush(&mut run, lines);
            indent = None;
            if info.multiline_raw || info.body.is_empty() {
                continue;
            }
        }
        if indent.is_none() {
            indent = Some(&info.indent);
        }
        run.push(at);
    }
    flush(&mut run, lines);
}

pub fn go(input: &str) -> String {
    let mut lines: Vec<String> = input.split('\n').map(str::to_owned).collect();
    align_blocks(&mut lines);
    align_comments(&mut lines);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_alignment_has_blank_line_runs_and_independent_columns() {
        let input = concat!(
            "type T struct {\n",
            "\tA int\n",
            "\tLong string\n",
            "\n",
            "\tTag bool `json:\"tag\"`\n",
            "\tX string `json:\"x\"`\n",
            "}\n",
            "const (\n",
            "\tA = 1 // a\n",
            "\tLong = 2 // b\n",
            ")",
        );
        let want = concat!(
            "type T struct {\n",
            "\tA    int\n",
            "\tLong string\n",
            "\n",
            "\tTag bool   `json:\"tag\"`\n",
            "\tX   string `json:\"x\"`\n",
            "}\n",
            "const (\n",
            "\tA    = 1 // a\n",
            "\tLong = 2 // b\n",
            ")",
        );
        let once = go(input);
        assert_eq!(once, want);
        assert_eq!(go(&once), once);
    }
}
