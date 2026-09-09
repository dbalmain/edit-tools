//! The evaluator: `Expr` + `Node` -> `Doc`.
//!
//! Every rule runs against a cursor over the node's direct children. A rule
//! may only ever consume the child under the cursor, so what it consumes is by
//! construction a disjoint, ordered partition of the children -- and a rule
//! that fails to consume all of them refuses the file instead of emitting.

use std::cell::Cell;
use std::collections::HashMap;

use crate::attach::{split, whitespace_node, Comment, Item};
use crate::doc::Doc;
use crate::pkg::{CommentCells, Expr, Package, Pred, Sel};
use crate::tree::{Node, TreeDoc};
use crate::Refusal;

pub type PackageMap = HashMap<String, Package>;

pub fn format(tree: &TreeDoc, packages: &PackageMap, width: usize) -> Result<String, Refusal> {
    let fmt = Fmt::for_language(&tree.language, packages, tree.source.as_bytes())?;
    let doc = fmt.node(&tree.root)?;
    let mut out = crate::doc::print(&doc, width, fmt.pkg.tab_stop);
    out = crate::align::cells(
        &out,
        fmt.pkg.comment_cells == crate::pkg::CommentCells::Block,
        &" ".repeat(fmt.pkg.comment_gap),
        width,
    );
    if fmt.semantic_eof.get() {
        while out.ends_with(['\r', '\n']) {
            out.pop();
        }
        let suffix = tree.source.trim_end_matches(['\r', '\n']).len();
        out.push_str(&tree.source[suffix..]);
        return Ok(out);
    }
    while out.ends_with('\n') {
        out.pop();
    }
    out.push('\n');
    Ok(out)
}

struct Fmt<'a> {
    pkg: &'a Package,
    packages: &'a PackageMap,
    src: &'a [u8],
    semantic_eof: Cell<bool>,
}

impl<'a> Fmt<'a> {
    fn for_language(
        language: &str,
        packages: &'a PackageMap,
        src: &'a [u8],
    ) -> Result<Self, Refusal> {
        let pkg = packages
            .get(language)
            .ok_or_else(|| Refusal(format!("no package for language `{language}`")))?;
        Ok(Self {
            pkg,
            packages,
            src,
            semantic_eof: Cell::new(false),
        })
    }

    fn node(&self, node: &'a Node) -> Result<Doc, Refusal> {
        if let Some(language) = node.language.as_deref() {
            // Structure without layout: the guest parse is spliced so readers
            // can see it, but the region's bytes are the host's to keep. The
            // same source check `verbatim` makes, for the same reason -- a
            // stale offset must refuse rather than emit the wrong bytes.
            if node.opaque {
                check_source(node, self.src, "opaque")?;
                return self.slice(node);
            }
            return Self::for_language(language, self.packages, self.src)?.node_current(node);
        }
        self.node_current(node)
    }

    fn node_current(&self, node: &'a Node) -> Result<Doc, Refusal> {
        if let Some(text) = &node.text {
            return Ok(Doc::text(text.as_str()));
        }
        let rule =
            self.pkg.rules.get(&node.kind).ok_or_else(|| {
                Refusal(format!("package has no rule for node type `{}`", node.kind))
            })?;
        let mut ctx = Ctx::new(node, self)?;
        let mut doc = ctx.eval(rule, self)?;
        doc = Doc::Concat(vec![doc, ctx.flush_after(self)]);
        if !ctx.dangling.is_empty() {
            doc = Doc::Concat(dangling(self.pkg, &ctx.dangling, doc));
        }
        if ctx.cursor != ctx.items.len() {
            let left = &ctx.items[ctx.cursor];
            return Err(Refusal(format!(
                "rule for `{}` left child `{}` unconsumed",
                node.kind, left.node.kind
            )));
        }
        Ok(doc)
    }

    fn text(&self, node: &Node) -> Result<&'a str, Refusal> {
        let bytes = self
            .src
            .get(node.start..node.end)
            .ok_or_else(|| Refusal(format!("`{}` runs past the source", node.kind)))?;
        std::str::from_utf8(bytes)
            .map_err(|e| Refusal(format!("`{}` is not valid UTF-8: {e}", node.kind)))
    }

    fn slice(&self, node: &Node) -> Result<Doc, Refusal> {
        self.text(node).map(Doc::text)
    }
}

/// Scalar count, the same measure the align pass uses.
fn width(s: &str) -> usize {
    s.chars().count()
}

/// A ruler cell: dashes, optionally anchored by a colon at either end.
fn is_ruler(cell: &str) -> bool {
    let body = cell.trim_start_matches(':').trim_end_matches(':');
    !body.is_empty() && body.bytes().all(|b| b == b'-')
}

/// The ruler's shape, as its own canonical spelling: `-`, `:-`, `-:` or `:-:`
/// for none, left, right and centre.
fn ruler_shape(cell: &str) -> &'static str {
    match (cell.starts_with(':'), cell.ends_with(':')) {
        (true, true) => ":-:",
        (true, false) => ":-",
        (false, true) => "-:",
        (false, false) => "-",
    }
}

/// Widen `cell` to `w` columns. Centre rounds the shorter half down to the
/// left, which is what prettier does with an odd remainder.
fn table_cell(cell: &str, w: usize, a: &str) -> String {
    let gap = w.saturating_sub(width(cell));
    match a {
        "-:" => format!("{}{cell}", " ".repeat(gap)),
        ":-:" => {
            let left = gap / 2;
            format!("{}{cell}{}", " ".repeat(left), " ".repeat(gap - left))
        }
        _ => format!("{cell}{}", " ".repeat(gap)),
    }
}

/// The ruler cell for a column of `w` columns, regenerated rather than padded:
/// the source's own dash count carries no information once the column width is
/// known, and `:-` has to grow to reach it.
fn table_rule(w: usize, a: &str) -> String {
    match a {
        ":-:" => format!(":{}:", "-".repeat(w - 2)),
        ":-" => format!(":{}", "-".repeat(w - 1)),
        "-:" => format!("{}:", "-".repeat(w - 1)),
        _ => "-".repeat(w),
    }
}

/// Leading and same-line comments attached to `item`, wrapped around its doc.
/// Own-line comments that trail the last sibling are held in `Ctx::pending_after`
/// so `trail` can emit a break-only comma *before* them — a comment before `]`
/// must not swallow that comma.
fn decorate(pkg: &Package, item: &Item<'_>, inner: Doc) -> Doc {
    if item.lead.is_empty() && item.suffix.is_empty() {
        return inner;
    }
    let mut parts = Vec::new();
    // A comment leading a suite belongs on the first line *inside* it.
    let sink = pkg.descend.contains(&item.node.kind);
    for (i, comment) in item.lead.iter().enumerate() {
        if sink {
            parts.push(Doc::Hard);
        }
        if i > 0 && comment.blanks > 0 {
            parts.push(Doc::Hard);
        }
        parts.push(Doc::text(comment.text.as_str()));
        if !sink {
            parts.push(Doc::Hard);
        }
    }
    if !sink {
        for _ in 0..item.gap.min(pkg.blank_cap) {
            parts.push(Doc::Hard);
        }
    }
    if sink && !parts.is_empty() {
        parts = vec![Doc::indent_unit(&pkg.indent_unit(), Doc::Concat(parts))];
    }
    parts.push(inner);
    let gap = " ".repeat(pkg.comment_gap);
    for text in &item.suffix {
        let body = if pkg.comment_cells != CommentCells::Off
            && !Package::is_cell_closer(&item.node.kind)
        {
            Doc::Concat(vec![Doc::Cell, Doc::text(text.as_str())])
        } else {
            Doc::text(format!("{gap}{text}"))
        };
        parts.push(Doc::Suffix(Box::new(body)));
    }
    parts.push(Doc::BreakParent);
    Doc::Concat(parts)
}

fn after_docs(pkg: &Package, comments: &[Comment]) -> Doc {
    if comments.is_empty() {
        return Doc::nil();
    }
    let mut parts = Vec::new();
    for comment in comments {
        parts.push(Doc::Hard);
        for _ in 0..comment.blanks.min(pkg.blank_cap) {
            parts.push(Doc::Hard);
        }
        parts.push(Doc::text(comment.text.as_str()));
    }
    parts.push(Doc::BreakParent);
    Doc::Concat(parts)
}

/// Comments held by a node with no child to attach them to.
fn dangling(pkg: &Package, comments: &[Comment], inner: Doc) -> Vec<Doc> {
    let mut parts = Vec::new();
    for (i, comment) in comments.iter().enumerate() {
        if i > 0 {
            for _ in 0..comment.blanks.min(pkg.blank_cap) {
                parts.push(Doc::Hard);
            }
        }
        parts.push(Doc::text(comment.text.as_str()));
        parts.push(Doc::Hard);
    }
    parts.push(inner);
    parts
}

struct Ctx<'a> {
    node: &'a Node,
    items: Vec<Item<'a>>,
    dangling: Vec<Comment>,
    cursor: usize,
    pending_after: Vec<Comment>,
    trailing_blanks: usize,
}

impl<'a> Ctx<'a> {
    fn new(node: &'a Node, f: &Fmt<'a>) -> Result<Ctx<'a>, Refusal> {
        // A declaration cannot hide stale text or overlapping ranges. Only
        // check the subtree where whitespace trivia is actually consumed.
        if node.children.iter().any(|child| whitespace_node(child, f.pkg)) {
            check_source(node, f.src, "whitespace_nodes")?;
        }
        let parts = split(node, f.src, f.pkg);
        Ok(Ctx {
            node,
            items: parts.items,
            dangling: parts.dangling,
            cursor: 0,
            pending_after: Vec::new(),
            trailing_blanks: parts.trailing_blanks,
        })
    }

    fn flush_after(&mut self, f: &Fmt<'a>) -> Doc {
        after_docs(f.pkg, &std::mem::take(&mut self.pending_after))
    }

    fn flush_before_token(&mut self, f: &Fmt<'a>) -> Doc {
        if self.pending_after.is_empty() {
            return Doc::nil();
        }
        Doc::Concat(vec![self.flush_after(f), Doc::Hard])
    }

    fn matches(&self, at: usize, sel: &Sel, pkg: &Package) -> bool {
        let Some(item) = self.items.get(at) else {
            return false;
        };
        match sel {
            Sel::Field(name) => item.node.field.as_deref() == Some(name.as_str()),
            Sel::Type(kind) => item.node.kind == *kind,
            Sel::Named => !pkg.is_token(&item.node.kind),
            Sel::Any => true,
        }
    }

    fn refuse(&self, what: &str) -> Refusal {
        let at = self
            .items
            .get(self.cursor)
            .map_or("end of children".to_owned(), |i| {
                format!("`{}`", i.node.kind)
            });
        Refusal(format!(
            "rule for `{}` wants {what} but found {at}",
            self.node.kind
        ))
    }

    fn eval(&mut self, expr: &Expr, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        match expr {
            Expr::Seq(es) => Ok(Doc::Concat(self.eval_all(es, f)?)),
            Expr::Group(max, es) => {
                let inner = Doc::Concat(self.eval_all(es, f)?);
                Ok(match max {
                    Some(n) => Doc::group_max(inner, *n),
                    None => Doc::group(inner),
                })
            }
            Expr::Indent(es) => {
                let mut parts = self.eval_all(es, f)?;
                parts.push(self.flush_after(f));
                Ok(Doc::indent_unit(&f.pkg.indent_unit(), Doc::Concat(parts)))
            }
            Expr::Line => Ok(Doc::Line),
            Expr::Soft => Ok(Doc::Soft),
            Expr::Hard => Ok(Doc::Hard),
            Expr::Sp => Ok(Doc::text(" ")),
            Expr::SrcLine => Ok(self.src_break(Doc::text(" "))),
            Expr::SrcSoft => Ok(self.src_break(Doc::nil())),
            Expr::SrcGap => self.src_gap(f),
            Expr::SrcBreak => Ok(self.src_break(Doc::Line)),
            Expr::SrcTrail(sep) => self.srctrail(sep, f),
            Expr::Drop(want) => self.drop_token(want, f),
            Expr::Prefix(sel, es) => self.prefix(sel, es, f),
            Expr::Cell => Ok(Doc::Cell),
            Expr::CellBlock(es) => {
                let mut parts = vec![Doc::CellBreak];
                parts.extend(self.eval_all(es, f)?);
                parts.push(Doc::CellBreak);
                Ok(Doc::Concat(parts))
            }
            Expr::Child(sel) => self.child(sel, f),
            Expr::Each(sel, sep) => self.each(sel, sep, f),
            Expr::Fill(sel, sep) => self.fill(sel, sep, f),
            Expr::Tok(s) => self.tok(s, f),
            Expr::Verbatim => self.verbatim(f),
            Expr::Table => self.table(f),
            Expr::Opt(sel, body) => {
                if self.matches(self.cursor, sel, f.pkg) {
                    self.eval(body, f)
                } else {
                    Ok(Doc::nil())
                }
            }
            Expr::Trail(sep, sel) => self.trail(sep, sel, f),
            Expr::Paren(always, es) => self.paren(*always, es, f),
            Expr::AutoParen(sel) => self.autoparen(sel, f),
            Expr::When(pred, then, alt) => {
                let hit = self.test(pred, f);
                self.eval(if hit { then } else { alt }, f)
            }
            Expr::Flatten(kind, sep) => self.flatten(kind, sep, f),
            Expr::Blank(cap, around, keep_after) => {
                let keep = self.keeps_gap(keep_after);
                if self.cursor == self.items.len() {
                    if keep && self.node.end == f.src.len() {
                        f.semantic_eof.set(true);
                    }
                    let mut parts = vec![self.flush_after(f)];
                    let blanks = if keep {
                        self.trailing_blanks
                    } else {
                        self.trailing_blanks.min(*cap)
                    };
                    parts.extend(std::iter::repeat_with(|| Doc::Hard).take(blanks));
                    return Ok(Doc::Concat(parts));
                }
                let n = if keep {
                    self.blanks()
                } else if self.forces_blank(around) {
                    *cap
                } else {
                    self.blanks().min(*cap)
                };
                let spent = n.saturating_sub(self.blanks_already_spent(f));
                Ok(Doc::Concat(
                    std::iter::repeat_with(|| Doc::Hard).take(spent).collect(),
                ))
            }
        }
    }

    fn eval_all(&mut self, exprs: &[Expr], f: &Fmt<'a>) -> Result<Vec<Doc>, Refusal> {
        exprs.iter().map(|e| self.eval(e, f)).collect()
    }

    fn blanks(&self) -> usize {
        self.items.get(self.cursor).map_or(0, |i| i.blanks)
    }

    /// The separator in `each` runs *between* items and `blanks` reads the
    /// item at the cursor (the following one). A listed type on either side
    /// of the gap must open it — `def f` followed by `x = 1` needs the
    /// blanks too.
    fn forces_blank(&self, kinds: &[String]) -> bool {
        if kinds.is_empty() || self.cursor == 0 {
            return false;
        }
        let Some(next) = self.items.get(self.cursor) else {
            return false;
        };
        let prev = &self.items[self.cursor - 1];
        kinds
            .iter()
            .any(|k| k == &prev.node.kind || k == &next.node.kind)
    }

    /// Some grammars leave semantic line endings outside the node whose token
    /// declares them. YAML's `|+` is the motivating case: the exact newlines
    /// live in the gap after the block-scalar pair. A package may name the
    /// declaring leaf spelling; the gap bypasses the cap only when that leaf
    /// ends the preceding item, since only then is the gap the token's own.
    /// Blank lines the previous item's own output already carried.
    ///
    /// `blanks()` measures the gap *between* two nodes, so a node whose range
    /// ends after the blank line that follows it makes that gap read zero --
    /// and the separator then adds a blank the output already had. Markdown's
    /// `indented_code_block` is the case: every reformat added another line
    /// and the file grew without bound. Declared, never inferred, because a
    /// rule that reconstructs rather than slices never emitted those newlines.
    fn blanks_already_spent(&self, f: &Fmt<'a>) -> usize {
        if self.cursor == 0 || f.pkg.blank_owner.is_empty() {
            return 0;
        }
        let prev = self.items[self.cursor - 1].node;
        // The blank belongs to whichever node's range ends where this one does
        // -- a listed block deep inside a `list_item` ate it just as surely as
        // one at this level, and every node on that last-child spine shares
        // the byte.
        let mut node = Some(prev);
        let mut found = false;
        while let Some(current) = node {
            if f.pkg.blank_owner.contains(&current.kind) {
                found = true;
                break;
            }
            node = current
                .children
                .last()
                .filter(|last| last.end == prev.end);
        }
        if !found {
            return 0;
        }
        let mut newlines: usize = 0;
        for &byte in f.src[prev.start..prev.end].iter().rev() {
            match byte {
                b'\n' => newlines += 1,
                b'\r' => {}
                _ => break,
            }
        }
        newlines.saturating_sub(1)
    }

    fn keeps_gap(&self, spellings: &[String]) -> bool {
        if spellings.is_empty() || self.cursor == 0 {
            return false;
        }
        let prev = self.items[self.cursor - 1].node;
        ends_with_leaf_text(prev, spellings)
    }

    fn take(&mut self, sel: &Sel, f: &Fmt<'a>) -> Result<usize, Refusal> {
        if !self.matches(self.cursor, sel, f.pkg) {
            return Err(self.refuse(&format!("{sel:?}")));
        }
        self.cursor += 1;
        Ok(self.cursor - 1)
    }

    /// A break that mirrors the source's line structure rather than the group's
    /// fit: `flat` when the source put the next item on the same line, a hard
    /// break when it did not.
    fn src_break(&self, flat: Doc) -> Doc {
        let brk = self.items.get(self.cursor).is_some_and(|i| i.line_break);
        if brk {
            Doc::Hard
        } else {
            flat
        }
    }

    /// Whitespace between the children on either side of the cursor. Exact
    /// horizontal bytes are semantic in HTML, so they are the flat form; a
    /// broken group may replace them with a newline. Newline-bearing gaps stay
    /// broken, while a non-whitespace gap is a refusal rather than lost text.
    fn src_gap(&self, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let from = self
            .cursor
            .checked_sub(1)
            .and_then(|i| self.items.get(i))
            .map_or(self.node.start, |item| item.node.end);
        let to = self
            .items
            .get(self.cursor)
            .map_or(self.node.end, |item| item.node.start);
        let bytes = f
            .src
            .get(from..to)
            .ok_or_else(|| self.refuse("a valid source gap"))?;
        if !bytes.iter().all(u8::is_ascii_whitespace) {
            return Err(self.refuse("only whitespace in a `srcgap`"));
        }
        if bytes.is_empty() {
            return Ok(Doc::nil());
        }
        if bytes.iter().any(|b| matches!(b, b'\r' | b'\n')) {
            return Ok(Doc::Hard);
        }
        let flat = std::str::from_utf8(bytes)
            .map_err(|_| self.refuse("UTF-8 whitespace in a `srcgap`"))?;
        Ok(Doc::IfBreak(Box::new(Doc::Hard), Box::new(Doc::text(flat))))
    }

    /// The trailing-separator policy for a source-driven list: adopt a
    /// separator the source has, and emit it only when the following token sits
    /// on a fresh line. gofmt strips a single-line literal's trailing comma and
    /// keeps a broken literal's.
    fn srctrail(&mut self, sep: &str, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let at = self.cursor;
        let present = self.items.get(at).and_then(|i| i.node.text.as_deref()) == Some(sep);
        if present {
            self.cursor += 1;
        }
        let brk = self.items.get(self.cursor).is_some_and(|i| i.line_break);
        if !brk {
            if present && self.items[at].decorated() {
                return Err(self.refuse("no comment on a stripped trailing separator"));
            }
            return Ok(Doc::nil());
        }
        Ok(if present {
            decorate(f.pkg, &self.items[at], Doc::text(sep))
        } else {
            Doc::text(sep)
        })
    }

    /// Absent is fine: a package says "drop this if it is here", the way
    /// rustfmt drops a leading `|`. Two refusals guard it, because gate 3
    /// alone has been caught out. The token must be declared punctuation --
    /// dropping a named node would delete meaning, not spelling -- and it must
    /// carry no comment, since a dropped token takes its trivia with it.
    fn drop_token(&mut self, want: &str, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let at = self.cursor;
        if self.items.get(at).and_then(|i| i.node.text.as_deref()) != Some(want) {
            return Ok(Doc::nil());
        }
        if !f.pkg.is_token(&self.items[at].node.kind) {
            return Err(self.refuse(&format!(
                "`drop` of `{want}`, which is not declared punctuation"
            )));
        }
        if self.items[at].decorated() {
            return Err(self.refuse(&format!("no comment on a dropped `{want}`")));
        }
        self.cursor += 1;
        Ok(Doc::nil())
    }

    /// Indent the body by the selected child's own source text, consuming it.
    /// The prefix is a string rather than a column count, which is what lets a
    /// host continuation marker (`> `, or a list's spaces) survive onto lines
    /// the body invents -- including lines an injected guest reflows into
    /// existence after the host has stopped looking (FINDINGS 24).
    ///
    /// Zero matches is an empty prefix consuming nothing, so a fence at the top
    /// of a document and a fence four levels into a list take the same rule.
    fn prefix(&mut self, sel: &Sel, es: &[Expr], f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let unit = if self.matches(self.cursor, sel, f.pkg) {
            let at = self.cursor;
            if self.items[at].decorated() {
                return Err(self.refuse("no comment on the marker a `prefix` consumes"));
            }
            let node = self.items[at].node;
            if !node.children.is_empty() {
                return Err(self.refuse("a leaf as the marker a `prefix` consumes"));
            }
            let bytes = f
                .src
                .get(node.start..node.end)
                .ok_or_else(|| Refusal(format!("`{}` runs past the source", node.kind)))?;
            let unit = std::str::from_utf8(bytes)
                .map_err(|e| Refusal(format!("`{}` is not valid UTF-8: {e}", node.kind)))?
                .to_owned();
            if unit.contains('\n') || unit.contains('\r') {
                return Err(self.refuse("a single-line marker for `prefix`"));
            }
            self.cursor += 1;
            unit
        } else {
            String::new()
        };
        let mut parts = self.eval_all(es, f)?;
        parts.push(self.flush_after(f));
        Ok(Doc::indent_unit(&unit, Doc::Concat(parts)))
    }

    fn child(&mut self, sel: &Sel, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let flushed = self.flush_after(f);
        let at = self.take(sel, f)?;
        let after = std::mem::take(&mut self.items[at].after);
        let item = &self.items[at];
        let inner = f.node(item.node)?;
        let decorated = decorate(f.pkg, item, inner);
        self.pending_after = after;
        Ok(Doc::Concat(vec![flushed, decorated]))
    }

    fn tok(&mut self, want: &str, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let flushed = self.flush_before_token(f);
        let at = self.cursor;
        if self.items.get(at).and_then(|i| i.node.text.as_deref()) != Some(want) {
            return Err(self.refuse(&format!("the token `{want}`")));
        }
        self.cursor += 1;
        let after = std::mem::take(&mut self.items[at].after);
        self.pending_after = after;
        Ok(Doc::Concat(vec![
            flushed,
            decorate(f.pkg, &self.items[at], Doc::text(want)),
        ]))
    }

    fn verbatim(&mut self, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        if self.cursor != 0 {
            return Err(self.refuse("to be the whole rule (`verbatim` takes every child)"));
        }
        if self.items.iter().any(Item::decorated) {
            return Err(self.refuse("no comments inside an opaque node"));
        }
        check_source(self.node, f.src, "verbatim")?;
        self.cursor = self.items.len();
        f.slice(self.node)
    }

    /// The whole node as an aligned pipe table: rows are named children, cells
    /// are named grandchildren, and the ruler is the row whose cells are all
    /// dashes. Tokens between rows are a container's per-line marker and
    /// belong in front of the row that follows.
    ///
    /// `runtime-js/bundle.js` carries the full account of why a ruler has to
    /// be regenerated rather than padded; gate 1 checks the two byte for byte.
    fn table(&mut self, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        if self.cursor != 0 {
            return Err(self.refuse("to be the whole rule (`table` takes every child)"));
        }
        if self.items.iter().any(Item::decorated) {
            return Err(self.refuse("no comments inside a table"));
        }
        self.cursor = self.items.len();

        let mut rows: Vec<(String, Vec<String>)> = Vec::new();
        let mut lead = String::new();
        for item in &self.items {
            let node = item.node;
            if f.pkg.is_token(&node.kind) {
                lead.push_str(f.text(node)?);
                continue;
            }
            let mut cells = Vec::new();
            for child in &node.children {
                if f.pkg.is_token(&child.kind) {
                    continue;
                }
                // A cell is emitted as its own source, so an `ERROR` here would
                // be re-emitted as a cell: for `` `||` `` the grammar splits the
                // code span and leaves a bare `|` behind, which comes back as
                // another column and never settles.
                if child.kind == "ERROR" {
                    return Err(Refusal(format!(
                        "`{}` has an unparsed cell at byte {}, so its columns \
                         cannot be measured",
                        self.node.kind, child.start
                    )));
                }
                cells.push(f.text(child)?.trim().to_owned());
            }
            rows.push((std::mem::take(&mut lead), cells));
        }

        let ruler = rows
            .iter()
            .position(|(_, cells)| !cells.is_empty() && cells.iter().all(|c| is_ruler(c)));
        let align: Vec<&str> = match ruler {
            Some(r) => rows[r].1.iter().map(|c| ruler_shape(c)).collect(),
            None => Vec::new(),
        };
        let mut cols: Vec<usize> = Vec::new();
        for (r, (_, cells)) in rows.iter().enumerate() {
            if Some(r) == ruler {
                continue;
            }
            for (c, cell) in cells.iter().enumerate() {
                if c == cols.len() {
                    cols.push(3);
                }
                cols[c] = cols[c].max(width(cell));
            }
        }

        let mut parts = Vec::new();
        for (r, (row_lead, cells)) in rows.iter().enumerate() {
            if r > 0 {
                parts.push(Doc::Hard);
            }
            if !row_lead.is_empty() {
                parts.push(Doc::text(row_lead.as_str()));
            }
            let mut line = String::from("|");
            for (c, cell) in cells.iter().enumerate() {
                let w = cols.get(c).copied().unwrap_or_else(|| width(cell).max(3));
                let a = align.get(c).copied().unwrap_or("-");
                line.push(' ');
                line.push_str(&if Some(r) == ruler {
                    table_rule(w, a)
                } else {
                    table_cell(cell, w, a)
                });
                line.push_str(" |");
            }
            parts.push(Doc::text(line));
        }
        parts.push(Doc::Hard);
        if !lead.is_empty() {
            parts.push(Doc::text(lead));
        }
        Ok(Doc::Concat(parts))
    }

    /// The trailing-separator policy: adopt a separator the source already has
    /// -- which pins the layout open, black's magic trailing comma -- or add
    /// one when the enclosing group breaks and `sel` picks out a real list.
    fn trail(&mut self, sep: &str, sel: &Sel, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let optional = Doc::IfBreak(Box::new(Doc::text(sep)), Box::new(Doc::nil()));
        let at = self.cursor;
        if self.items.get(at).and_then(|i| i.node.text.as_deref()) != Some(sep) {
            // One item is not a list: black splits such a bracket without ever
            // reaching a comma, and so leaves none behind.
            let comma = if self.tally(sel, f.pkg) > 1 {
                optional
            } else {
                Doc::nil()
            };
            return Ok(comma);
        }
        self.cursor += 1;
        Ok(Doc::Concat(vec![
            decorate(f.pkg, &self.items[at], optional),
            Doc::BreakParent,
        ]))
    }

    /// The balanced-paren policy: adopt the pair the source already has, or
    /// add one when the region breaks.
    fn paren(&mut self, always: bool, body: &[Expr], f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let last = self.items.len().saturating_sub(1);
        let opener = self.cursor;
        let adopt = opener + 1 < self.items.len()
            && self.items[opener].node.text.as_deref() == Some("(")
            && self.items[last].node.text.as_deref() == Some(")");

        let open = if adopt {
            self.tok("(", f)?
        } else if always {
            Doc::text("(")
        } else {
            Doc::IfBreak(Box::new(Doc::text("(")), Box::new(Doc::nil()))
        };
        let mut inner = self.eval_all(body, f)?;
        if adopt {
            // Keep a comment before the adopted closer inside the region's
            // indent, then let `tok` enforce the ordinary token boundary.
            inner.push(self.flush_after(f));
        }
        let close = if adopt {
            if self.cursor != last {
                return Err(self.refuse("the closing `)` of the region it wraps"));
            }
            self.tok(")", f)?
        } else if always {
            Doc::text(")")
        } else {
            Doc::IfBreak(Box::new(Doc::text(")")), Box::new(Doc::nil()))
        };
        Ok(Doc::group(Doc::Concat(vec![
            open,
            Doc::indent_unit(
                &f.pkg.indent_unit(),
                Doc::Concat(vec![Doc::Soft, Doc::Concat(inner)]),
            ),
            Doc::Soft,
            close,
        ])))
    }

    /// Format a child, adding optional parentheses if its type is one the
    /// package lists as needing them to break.
    fn autoparen(&mut self, sel: &Sel, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        if !self.matches(self.cursor, sel, f.pkg) {
            return Err(self.refuse(&format!("{sel:?}")));
        }
        let wrap = f
            .pkg
            .optional_parens
            .contains(&self.items[self.cursor].node.kind);
        let inner = self.child(sel, f)?;
        if !wrap {
            return Ok(inner);
        }
        Ok(Doc::group(Doc::Concat(vec![
            Doc::IfBreak(Box::new(Doc::text("(")), Box::new(Doc::nil())),
            Doc::indent_unit(&f.pkg.indent_unit(), Doc::Concat(vec![Doc::Soft, inner])),
            Doc::Soft,
            Doc::IfBreak(Box::new(Doc::text(")")), Box::new(Doc::nil())),
        ])))
    }

    fn each(&mut self, sel: &Sel, sep: &Expr, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let mut parts = Vec::new();
        while self.matches(self.cursor, sel, f.pkg) {
            parts.push(self.child(sel, f)?);
            let next = (self.cursor..self.items.len()).find(|&i| self.matches(i, sel, f.pkg));
            let Some(next) = next else { break };
            parts.push(self.eval(sep, f)?);
            if self.cursor != next {
                return Err(self.refuse("its separator to take the children between items"));
            }
        }
        Ok(Doc::Concat(parts))
    }

    /// `each` with a per-line printer decision: every separator independently
    /// stays flat when the next content fits, or breaks when it does not.
    fn fill(&mut self, sel: &Sel, sep: &Expr, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let mut parts = Vec::new();
        while self.matches(self.cursor, sel, f.pkg) {
            parts.push(self.child(sel, f)?);
            let next = (self.cursor..self.items.len()).find(|&i| self.matches(i, sel, f.pkg));
            let Some(next) = next else { break };
            parts.push(self.eval(sep, f)?);
            if self.cursor != next {
                return Err(self.refuse("its separator to take the children between items"));
            }
        }
        Ok(Doc::fill(parts))
    }

    fn test(&self, pred: &Pred, f: &Fmt<'a>) -> bool {
        match pred {
            Pred::Count(sel, n) => self.tally(sel, f.pkg) == *n,
            Pred::ChildCount(parent, child, n) => self.child_tally(parent, child, f.pkg) == *n,
            Pred::All(sel, kinds) => self.all_kinds(sel, kinds, f.pkg),
            Pred::Text(path, spellings) => path_has_text(self.node, path, spellings, f.pkg),
            Pred::Multiline(path) => path_has_multiline(self.node, path, f.pkg),
            // Clamp the end rather than failing the lookup: `Uint8Array::subarray`
            // clamps, so a tree whose node range runs past the source would
            // otherwise answer `false` here and `true` in JavaScript.
            Pred::SourceMultiline => f
                .src
                .get(self.node.start..self.node.end.min(f.src.len()))
                .is_some_and(|source| source.contains(&b'\n') || source.contains(&b'\r')),
        }
    }

    /// Predicates describe the node, not the cursor: count over every child.
    fn tally(&self, sel: &Sel, pkg: &Package) -> usize {
        (0..self.items.len())
            .filter(|&i| self.matches(i, sel, pkg))
            .count()
    }

    /// Vacuous: no `sel` child means every one of them has a listed type.
    fn all_kinds(&self, sel: &Sel, kinds: &[String], pkg: &Package) -> bool {
        (0..self.items.len())
            .filter(|&i| self.matches(i, sel, pkg))
            .all(|i| kinds.iter().any(|k| self.items[i].node.kind == *k))
    }

    fn child_tally(&self, parent: &Sel, child: &Sel, pkg: &Package) -> usize {
        self.items
            .iter()
            .filter(|item| node_matches(item.node, parent, pkg))
            .flat_map(|item| &item.node.children)
            .filter(|node| node_matches(node, child, pkg))
            .count()
    }

    /// Collect a left-nested run of same-type, same-tightness operators into
    /// one flat list, so the whole chain breaks together instead of
    /// staircasing. This is the opcode a per-node fold cannot do without.
    ///
    /// Grammars that label the spine (`left` / `operator` / `right`) keep using
    /// those fields. Grammars that do not — tree-sitter-typescript's
    /// `union_type` / `intersection_type` are `[operand, token, operand]` with
    /// no fields — fall back to the first non-comment child as left and the
    /// remaining named child as right, and the separator expression consumes
    /// the operator token. The two shapes are the same walk.
    fn flatten(&mut self, kind: &str, sep: &Expr, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let fields = &f.pkg.flatten_fields;
        let fielded = self.node.children.iter().any(|c| c.field.is_some());
        let left = if fielded {
            Sel::Field(fields.left.clone())
        } else {
            Sel::Named
        };
        let right = if fielded {
            Sel::Field(fields.right.clone())
        } else {
            Sel::Named
        };

        let mut spine = Vec::new();
        let mut cur = self.node;
        loop {
            let next = if fielded {
                cur.child_with_field(&fields.left)
            } else {
                positional_left(cur, f.pkg)
            };
            let Some(next) = next else { break };
            if next.kind != kind || tightness(f.pkg, cur) != tightness(f.pkg, next) {
                break;
            }
            spine.push(next);
            cur = next;
        }
        let mut inner: Vec<Ctx<'a>> = spine
            .iter()
            .map(|n| Ctx::new(n, f))
            .collect::<Result<_, _>>()?;

        let mut parts = Vec::new();
        let mut outer_skipped = None;
        let mut skipped_comments: Vec<Option<Doc>> = (0..inner.len()).map(|_| None).collect();
        match inner.last_mut() {
            None => parts.push(self.child(&left, f)?),
            Some(deepest) => {
                parts.push(deepest.child(&left, f)?);
                // Comments attached to a skipped left (a nested same-type node)
                // belong after that nested chain, not at the skip site — which
                // is before the nested separators have been printed. TypeScript
                // unions park a mid-union comment on the nested left after the
                // first format; emitting it here would put it on the first
                // member.
                outer_skipped = Some(self.skip(&left, f)?);
                for i in 0..inner.len().saturating_sub(1) {
                    skipped_comments[i] = Some(inner[i].skip(&left, f)?);
                }
            }
        }
        for i in (0..inner.len()).rev() {
            if let Some(comments) = skipped_comments[i].take() {
                parts.push(comments);
            }
            parts.push(inner[i].eval(sep, f)?);
            parts.push(inner[i].child(&right, f)?);
        }
        if let Some(comments) = outer_skipped {
            parts.push(comments);
        }
        parts.push(self.eval(sep, f)?);
        parts.push(self.child(&right, f)?);

        for ctx in &mut inner {
            parts.push(ctx.flush_after(f));
            if ctx.cursor != ctx.items.len() {
                return Err(Refusal(format!(
                    "flattened `{}` left a child unconsumed",
                    ctx.node.kind
                )));
            }
        }
        Ok(Doc::Concat(parts))
    }

    /// Step over a child the chain emits elsewhere. Leading comments still
    /// refuse — those belong on the inner context — but a suffix or after
    /// comment on the skipped node is returned so the caller can emit it
    /// after the nested chain (the fieldless spine from FINDINGS 23).
    fn skip(&mut self, sel: &Sel, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let at = self.take(sel, f)?;
        if !self.items[at].lead.is_empty() {
            return Err(self.refuse("no leading comment on an operand of a flattened chain"));
        }
        let suffix = std::mem::take(&mut self.items[at].suffix);
        let after = std::mem::take(&mut self.items[at].after);
        let mut parts = Vec::new();
        let gap = " ".repeat(f.pkg.comment_gap);
        for text in &suffix {
            parts.push(Doc::Suffix(Box::new(Doc::text(format!("{gap}{text}")))));
        }
        if !suffix.is_empty() {
            parts.push(Doc::BreakParent);
        }
        parts.push(after_docs(f.pkg, &after));
        Ok(Doc::Concat(parts))
    }
}

fn path_has_text(node: &Node, path: &[Sel], spellings: &[String], pkg: &Package) -> bool {
    let Some((head, tail)) = path.split_first() else {
        return node
            .text
            .as_ref()
            .is_some_and(|text| spellings.iter().any(|spelling| spelling == text));
    };
    node.children
        .iter()
        .filter(|child| node_matches(child, head, pkg))
        .any(|child| path_has_text(child, tail, spellings, pkg))
}

fn path_has_multiline(node: &Node, path: &[Sel], pkg: &Package) -> bool {
    let Some((head, tail)) = path.split_first() else {
        return node
            .text
            .as_ref()
            .is_some_and(|text| text.contains(['\r', '\n']));
    };
    node.children
        .iter()
        .filter(|child| node_matches(child, head, pkg))
        .any(|child| path_has_multiline(child, tail, pkg))
}

/// Walk the rightmost spine: the declaring token must be the last leaf of the
/// subtree, or the gap after the subtree belongs to a later sibling instead.
fn ends_with_leaf_text(node: &Node, spellings: &[String]) -> bool {
    match node.children.last() {
        Some(last) => ends_with_leaf_text(last, spellings),
        None => node
            .text
            .as_ref()
            .is_some_and(|text| spellings.iter().any(|spelling| spelling == text)),
    }
}

fn node_matches(node: &Node, sel: &Sel, pkg: &Package) -> bool {
    match sel {
        Sel::Field(name) => node.field.as_deref() == Some(name.as_str()),
        Sel::Type(kind) => node.kind == *kind,
        Sel::Named => !pkg.is_token(&node.kind),
        Sel::Any => true,
    }
}

fn tightness(pkg: &Package, node: &Node) -> i64 {
    if let Some(op) = node.child_with_field(&pkg.flatten_fields.operator) {
        return op.text.as_deref().map_or(0, |text| pkg.tightness(text));
    }
    node.children
        .iter()
        .find_map(|child| {
            pkg.is_token(&child.kind)
                .then_some(child.text.as_deref())
                .flatten()
        })
        .map_or(0, |op| pkg.tightness(op))
}

/// First non-comment child: the left operand of a fieldless binary node.
fn positional_left<'a>(node: &'a Node, pkg: &Package) -> Option<&'a Node> {
    node.children
        .iter()
        .find(|child| !pkg.comments.contains(&child.kind))
}

/// `verbatim` is the one opcode that emits source bytes nobody compared
/// against the tree. Every other path reaches text through a real child, so
/// the linearity invariant protects it; this walk is the equivalent for a
/// node whose offsets may be stale. Whitespace-trivia consumption needs the
/// same proof before removing a leaf from the item view.
fn check_source(node: &Node, src: &[u8], operation: &str) -> Result<(), Refusal> {
    check_source_node(node, src, None, &node.kind, operation)
}

fn check_source_node(
    node: &Node,
    src: &[u8],
    parent: Option<&Node>,
    root_kind: &str,
    operation: &str,
) -> Result<(), Refusal> {
    let fail = |why: &str| Refusal(format!("{operation} `{root_kind}` {why}"));

    if node.start > node.end {
        return Err(fail("has inverted range"));
    }
    match parent {
        None if node.end > src.len() => return Err(fail("runs past the source")),
        Some(p) if node.start < p.start || node.end > p.end => {
            return Err(fail("has a descendant outside its parent"));
        }
        _ => {}
    }
    if let Some(text) = &node.text {
        let bytes = src
            .get(node.start..node.end)
            .ok_or_else(|| fail("runs past the source"))?;
        if text.as_bytes() != bytes {
            return Err(fail("has a leaf whose text does not match the source"));
        }
    }
    let mut prev_end = None;
    for child in &node.children {
        if let Some(end) = prev_end {
            if end > child.start {
                return Err(fail("has overlapping siblings"));
            }
        }
        prev_end = Some(child.end);
        check_source_node(child, src, Some(node), root_kind, operation)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A toy language, so the machinery is exercised without Python's bulk.
    fn one(package: Package) -> PackageMap {
        PackageMap::from([("toy".to_owned(), package)])
    }

    fn toy(rules: serde_json::Value) -> PackageMap {
        one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["(", ")", ",", "+"],
            "precedence": { "+": 5, "*": 4 },
            "rules": rules,
        }))
        .expect("toy package parses"))
    }

    fn leaf(kind: &str, text: &str) -> serde_json::Value {
        json!({ "type": kind, "start": 0, "end": 0, "text": text })
    }

    fn run(
        packages: &PackageMap,
        root: serde_json::Value,
        width: usize,
    ) -> Result<String, Refusal> {
        run_on(packages, "", root, width)
    }

    fn run_on(
        packages: &PackageMap,
        source: &str,
        root: serde_json::Value,
        width: usize,
    ) -> Result<String, Refusal> {
        format_tree(packages, "toy", source, root, width)
    }

    fn format_tree(
        packages: &PackageMap,
        language: &str,
        source: &str,
        root: serde_json::Value,
        width: usize,
    ) -> Result<String, Refusal> {
        let tree: TreeDoc = serde_json::from_value(json!({
            "language": language,
            "source": source,
            "root": root,
        }))
        .expect("toy tree parses");
        tree.validate()
            .map_err(|error| Refusal(format!("malformed tree: {error}")))?;
        format(&tree, packages, width)
    }

    fn comments_pkg(comment_gap: Option<usize>, blank_cap: Option<usize>) -> PackageMap {
        let mut raw = json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comments": ["comment"],
            "rules": { "file": ["each", "named", ["seq"]] },
        });
        if let Some(value) = comment_gap {
            raw["comment_gap"] = json!(value);
        }
        if let Some(value) = blank_cap {
            raw["blank_cap"] = json!(value);
        }
        one(serde_json::from_value(raw).expect("comments package parses"))
    }

    fn commented_file(children: serde_json::Value, end: usize) -> serde_json::Value {
        json!({ "type": "file", "start": 0, "end": end, "children": children })
    }

    fn span(kind: &str, start: usize, end: usize, text: &str) -> serde_json::Value {
        json!({ "type": kind, "start": start, "end": end, "text": text })
    }

    /// `"hi"` as a three-child `quote` node — the shape `verbatim` actually sees.
    fn quote(
        start: usize,
        end: usize,
        children: Vec<serde_json::Value>,
    ) -> (String, serde_json::Value) {
        (
            "\"hi\"".to_owned(),
            json!({ "type": "quote", "start": start, "end": end, "children": children }),
        )
    }

    fn quote_ok() -> (String, serde_json::Value) {
        quote(
            0,
            4,
            vec![
                span("open", 0, 1, "\""),
                span("body", 1, 3, "hi"),
                span("close", 3, 4, "\""),
            ],
        )
    }

    fn list(items: &[&str], trailing: bool) -> serde_json::Value {
        let mut children = vec![leaf("(", "(")];
        for (i, item) in items.iter().enumerate() {
            if i > 0 {
                children.push(leaf(",", ","));
            }
            children.push(leaf("name", item));
        }
        if trailing {
            children.push(leaf(",", ","));
        }
        children.push(leaf(")", ")"));
        json!({ "type": "list", "start": 0, "end": 0, "children": children })
    }

    fn list_rule() -> serde_json::Value {
        json!([
            "group",
            ["tok", "("],
            [
                "indent",
                ["soft"],
                ["each", "named", ["seq", ["tok", ","], ["line"]]],
                ["trail", ",", "named"]
            ],
            ["soft"],
            ["tok", ")"]
        ])
    }

    fn fill_rule() -> serde_json::Value {
        json!([
            "group",
            ["tok", "("],
            [
                "indent",
                ["soft"],
                ["fill", "named", ["seq", ["tok", ","], ["line"]]]
            ],
            ["soft"],
            ["tok", ")"]
        ])
    }

    #[test]
    fn a_rule_that_ignores_a_child_refuses_rather_than_dropping_it() {
        let pkg = toy(json!({ "list": ["seq", ["tok", "("]] }));
        let err = run(&pkg, list(&["a"], false), 80).expect_err("must refuse");
        assert!(err.0.contains("left child"), "{}", err.0);
    }

    #[test]
    fn an_unknown_node_type_refuses_rather_than_guessing() {
        let pkg = toy(json!({}));
        let err = run(&pkg, list(&["a"], false), 80).expect_err("must refuse");
        assert!(err.0.contains("no rule for node type `list`"), "{}", err.0);
    }

    fn prefix_pkg(rules: serde_json::Value) -> PackageMap {
        one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": [],
            "rules": rules,
        }))
        .expect("prefix package parses"))
    }

    /// The whole point of entry 24: a marker the host owns lands on every line
    /// the body emits, not just the first one the source already had.
    #[test]
    fn prefix_puts_the_markers_text_on_every_line_the_body_emits() {
        let packages = prefix_pkg(json!({
            "block": [
                "seq",
                ["child", "t:word"],
                ["prefix", "t:marker", ["hard"], ["each", "t:word", ["hard"]]]
            ]
        }));
        let root = json!({
            "type": "block", "start": 0, "end": 2,
            "children": [
                leaf("word", "head"),
                { "type": "marker", "start": 0, "end": 2 },
                leaf("word", "a"),
                leaf("word", "b"),
            ]
        });
        assert_eq!(
            run_on(&packages, "> x", root, 80).expect("formats"),
            "head\n> a\n> b\n"
        );
    }

    /// Zero matches is an empty prefix that consumes nothing, so one rule
    /// serves a fence at the top of a document and one four lists deep.
    #[test]
    fn prefix_without_its_marker_is_an_empty_prefix_and_consumes_nothing() {
        let packages = prefix_pkg(json!({
            "block": ["prefix", "t:marker", ["each", "t:word", ["hard"]]]
        }));
        let root = json!({
            "type": "block", "start": 0, "end": 0,
            "children": [leaf("word", "a"), leaf("word", "b")]
        });
        assert_eq!(
            run_on(&packages, "> x", root, 80).expect("formats"),
            "a\nb\n"
        );
    }

    /// Prefixes concatenate the way indent levels do, so a fence inside a
    /// quoted list carries both markers.
    #[test]
    fn prefixes_nest_and_concatenate() {
        let packages = prefix_pkg(json!({
            "block": [
                "prefix", "t:outer",
                ["prefix", "t:inner", ["each", "t:word", ["hard"]]]
            ]
        }));
        let root = json!({
            "type": "block", "start": 0, "end": 0,
            "children": [
                { "type": "outer", "start": 0, "end": 2 },
                { "type": "inner", "start": 2, "end": 4 },
                leaf("word", "a"),
                leaf("word", "b"),
            ]
        });
        assert_eq!(
            run_on(&packages, "> ..", root, 80).expect("formats"),
            "a\n> ..b\n"
        );
    }

    /// A marker spanning a line ending would write a newline the printer never
    /// accounted for, so it is refused rather than silently mis-measured.
    #[test]
    fn prefix_refuses_a_multiline_marker() {
        let packages = prefix_pkg(json!({
            "block": ["prefix", "t:marker", ["each", "t:word", ["hard"]]]
        }));
        let root = json!({
            "type": "block", "start": 0, "end": 2,
            "children": [
                { "type": "marker", "start": 0, "end": 2 },
                leaf("word", "a"),
            ]
        });
        let error = run_on(&packages, "\n ", root, 80).expect_err("refuses");
        assert!(
            error.0.contains("a single-line marker for `prefix`"),
            "{}",
            error.0
        );
    }

    /// The marker is consumed without being emitted, so a comment riding on it
    /// would be lost -- the same guard `drop` carries.
    #[test]
    fn prefix_refuses_a_marker_carrying_a_comment() {
        let mut raw = json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comments": ["comment"],
            "tokens": [],
            "rules": { "block": ["prefix", "t:marker", ["each", "t:word", ["hard"]]] },
        });
        raw["rules"]["block"] = json!(["prefix", "t:marker", ["each", "t:word", ["hard"]]]);
        let packages = one(serde_json::from_value(raw).expect("package parses"));
        let root = json!({
            "type": "block", "start": 0, "end": 3,
            "children": [
                { "type": "comment", "start": 0, "end": 1, "text": "#" },
                { "type": "marker", "start": 1, "end": 3 },
                leaf("word", "a"),
            ]
        });
        let error = run_on(&packages, "#> ", root, 80).expect_err("refuses");
        assert!(
            error.0.contains("no comment on the marker a `prefix` consumes"),
            "{}",
            error.0
        );
    }

    #[test]
    fn language_regions_use_their_rules_and_indent_then_restore_the_enclosing_package() {
        let block = json!([
            "seq",
            ["tok", "outer"],
            ["indent", ["hard"], ["each", "named", ["hard"]]]
        ]);
        let outer: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["outer"],
            "rules": {
                "outer_block": block,
                "outer_again": block,
                "region": ["verbatim"]
            }
        }))
        .expect("outer package parses");
        let inner_block = json!([
            "seq",
            ["tok", "inner"],
            ["indent", ["hard"], ["each", "named", ["hard"]]]
        ]);
        let inner: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 4,
            "tokens": ["inner"],
            "rules": {
                "region": inner_block,
                "inner_again": inner_block
            }
        }))
        .expect("inner package parses");
        let packages = PackageMap::from([("outer".to_owned(), outer), ("inner".to_owned(), inner)]);
        let root = json!({
            "type": "outer_block", "start": 0, "end": 0,
            "children": [
                leaf("outer", "outer"),
                leaf("word", "before"),
                {
                    "type": "region", "language": "inner", "start": 0, "end": 0,
                    "children": [
                        leaf("inner", "inner"),
                        leaf("word", "inside"),
                        {
                            "type": "outer_again", "language": "outer", "start": 0, "end": 0,
                            "children": [leaf("outer", "outer"), leaf("word", "back")]
                        },
                        {
                            "type": "inner_again", "start": 0, "end": 0,
                            "children": [leaf("inner", "inner"), leaf("word", "restored-inner")]
                        }
                    ]
                },
                {
                    "type": "outer_again", "start": 0, "end": 0,
                    "children": [leaf("outer", "outer"), leaf("word", "after")]
                }
            ]
        });

        assert_eq!(
            format_tree(&packages, "outer", "", root, 80).expect("ok"),
            "outer\n  before\n  inner\n      inside\n      outer\n        back\n      inner\n          restored-inner\n  outer\n    after\n"
        );
    }

    #[test]
    fn language_regions_use_their_comment_policy() {
        let outer: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "blank_cap": 0,
            "rules": { "file": ["child", "named"] }
        }))
        .expect("outer package parses");
        let inner: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 4,
            "comments": ["comment"],
            "comment_gap": 3,
            "blank_cap": 2,
            "rules": { "region": ["child", "named"] }
        }))
        .expect("inner package parses");
        let packages = PackageMap::from([("outer".to_owned(), outer), ("inner".to_owned(), inner)]);
        let source = "x# one\n\n\n\n# two";
        let root = json!({
            "type": "file", "start": 0, "end": 15,
            "children": [{
                "type": "region", "language": "inner", "start": 0, "end": 15,
                "children": [
                    { "type": "word", "start": 0, "end": 1, "text": "x" },
                    { "type": "comment", "start": 1, "end": 6, "text": "# one" },
                    { "type": "comment", "start": 10, "end": 15, "text": "# two" }
                ]
            }]
        });

        assert_eq!(
            format_tree(&packages, "outer", source, root, 80).expect("ok"),
            "x   # one\n\n\n# two\n"
        );
    }

    #[test]
    fn a_missing_nested_language_package_refuses_and_names_the_language() {
        let outer: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": { "file": ["child", "named"] }
        }))
        .expect("outer package parses");
        let packages = PackageMap::from([("outer".to_owned(), outer)]);
        let root = json!({
            "type": "file", "start": 0, "end": 0,
            "children": [{
                "type": "word", "language": "missing-toy", "start": 0, "end": 0,
                "text": "x"
            }]
        });

        let error = format_tree(&packages, "outer", "", root, 80).expect_err("must refuse");
        assert_eq!(error.0, "no package for language `missing-toy`");
    }

    #[test]
    fn drop_consumes_a_redundant_token_without_emitting_it() {
        let pkg = toy(json!({
            "list": ["seq", ["tok", "("], ["drop", "+"], ["child", "*"], ["tok", ")"]]
        }));
        let root = json!({
            "type": "list", "start": 0, "end": 0,
            "children": [leaf("(", "("), leaf("+", "+"), leaf("a", "a"), leaf(")", ")")]
        });
        assert_eq!(run(&pkg, root, 80).expect("drop succeeds"), "(a)\n");
    }

    #[test]
    fn drop_is_a_no_op_when_the_token_is_absent() {
        let pkg = toy(json!({
            "list": ["seq", ["tok", "("], ["drop", "+"], ["child", "*"], ["tok", ")"]]
        }));
        let root = json!({
            "type": "list", "start": 0, "end": 0,
            "children": [leaf("(", "("), leaf("a", "a"), leaf(")", ")")]
        });
        assert_eq!(run(&pkg, root, 80).expect("absent is fine"), "(a)\n");
    }

    #[test]
    fn drop_refuses_a_token_the_package_has_not_declared_punctuation() {
        let pkg = toy(json!({
            "list": ["seq", ["tok", "("], ["drop", "a"], ["tok", ")"]]
        }));
        let root = json!({
            "type": "list", "start": 0, "end": 0,
            "children": [leaf("(", "("), leaf("a", "a"), leaf(")", ")")]
        });
        let err = run(&pkg, root, 80).expect_err("must refuse");
        assert!(err.0.contains("not declared punctuation"), "{}", err.0);
    }

    #[test]
    fn paren_true_adds_a_balanced_pair_in_flat_layout() {
        let pkg = toy(json!({ "list": ["paren", true, ["child", "*"]] }));
        let root = json!({
            "type": "list", "start": 0, "end": 0,
            "children": [leaf("a", "a")]
        });
        assert_eq!(run(&pkg, root, 80).expect("always parens"), "(a)\n");
    }

    #[test]
    fn a_token_that_is_not_where_the_rule_says_refuses() {
        let pkg = toy(json!({ "list": ["seq", ["tok", "["], ["each", "*", ["seq"]]] }));
        let err = run(&pkg, list(&["a"], false), 80).expect_err("must refuse");
        assert!(err.0.contains("the token `[`"), "{}", err.0);
    }

    #[test]
    fn fill_is_a_fixed_point_for_already_packed_input() {
        let pkg = toy(json!({ "list": fill_rule() }));
        let tree = list(&["100", "200", "300", "400"], false);
        let once = run_on(&pkg, "(\n  100, 200,\n  300, 400\n)", tree.clone(), 12)
            .expect("first fill succeeds");
        let twice = run_on(&pkg, &once, tree, 12).expect("second fill succeeds");
        assert_eq!(once, "(\n  100, 200,\n  300, 400\n)\n");
        assert_eq!(twice, once);
    }

    #[test]
    fn comment_fields_default_to_one() {
        let source = "x# one\n\n\n# two";
        let root = commented_file(
            json!([
                { "type": "name", "start": 0, "end": 1, "text": "x" },
                { "type": "comment", "start": 1, "end": 6, "text": "# one" },
                { "type": "comment", "start": 9, "end": 14, "text": "# two" },
            ]),
            14,
        );
        assert_eq!(
            run_on(&comments_pkg(None, None), source, root, 80).expect("ok"),
            "x # one\n\n# two\n"
        );
    }

    #[test]
    fn comment_gap_controls_trailing_comment_spacing() {
        let source = "x# c";
        let root = commented_file(
            json!([
                { "type": "name", "start": 0, "end": 1, "text": "x" },
                { "type": "comment", "start": 1, "end": 4, "text": "# c" },
            ]),
            4,
        );
        assert_eq!(
            run_on(&comments_pkg(Some(4), None), source, root, 80).expect("ok"),
            "x    # c\n"
        );
    }

    #[test]
    fn blank_cap_limits_blank_lines_next_to_a_comment() {
        let source = "x\n\n\n\n\n# c";
        let root = commented_file(
            json!([
                { "type": "name", "start": 0, "end": 1, "text": "x" },
                { "type": "comment", "start": 6, "end": 9, "text": "# c" },
            ]),
            9,
        );
        assert_eq!(
            run_on(&comments_pkg(None, Some(3)), source, root, 80).expect("ok"),
            "x\n\n\n\n# c\n"
        );
    }

    #[test]
    fn interior_comment_without_text_slices_source() {
        // tree-sitter-rust's line_comment is an interior node: the `//` token
        // is a child and there is no `text` on the parent. The body lives
        // only in the source range.
        let source = "x // c\n/// doc\n";
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comments": ["line_comment"],
            "rules": { "file": ["each", "named", ["hard"]] },
        }))
        .expect("interior-comment package parses"));
        let root = commented_file(
            json!([
                { "type": "name", "start": 0, "end": 1, "text": "x" },
                {
                    "type": "line_comment",
                    "start": 2,
                    "end": 6,
                    "children": [
                        { "type": "//", "start": 2, "end": 4, "text": "//" }
                    ]
                },
                {
                    "type": "line_comment",
                    "start": 7,
                    "end": 15,
                    "children": [
                        { "type": "//", "start": 7, "end": 9, "text": "//" },
                        { "type": "doc_comment", "start": 9, "end": 15, "text": "/ doc\n" }
                    ]
                },
            ]),
            15,
        );
        assert_eq!(
            run_on(&pkg, source, root, 80).expect("ok"),
            "x // c\n/// doc\n"
        );
    }

    #[test]
    fn doc_comment_range_newline_does_not_eat_the_following_blank() {
        // tree-sitter-rust includes the line ending in a `///` / `//!`
        // node's range. That newline is not a consumed gap; a blank line
        // after the doc comment must still survive.
        let source = "//! inner\n\n// own-line\nfn";
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comments": ["line_comment"],
            "rules": { "file": ["each", "named", ["hard"]] },
        }))
        .expect("doc-comment-gap package parses"));
        let root = commented_file(
            json!([
                {
                    "type": "line_comment",
                    "start": 0,
                    "end": 10,
                    "children": [
                        { "type": "//", "start": 0, "end": 2, "text": "//" },
                        { "type": "doc_comment", "start": 2, "end": 10, "text": "! inner\n" }
                    ]
                },
                {
                    "type": "line_comment",
                    "start": 11,
                    "end": 22,
                    "children": [
                        { "type": "//", "start": 11, "end": 13, "text": "//" }
                    ]
                },
                { "type": "name", "start": 23, "end": 25, "text": "fn" },
            ]),
            25,
        );
        assert_eq!(
            run_on(&pkg, source, root, 80).expect("ok"),
            "//! inner\n\n// own-line\nfn\n"
        );
    }

    #[test]
    fn both_runtimes_refuse_the_same_out_of_range_comment_gap() {
        let pkg_json = json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comment_gap": 9,
            "rules": { "file": ["each", "*", ["seq"]] },
        });
        let rust_err = serde_json::from_value::<Package>(pkg_json.clone())
            .err()
            .expect("rust must refuse")
            .to_string();
        assert!(
            rust_err.contains("`comment_gap` is 9; the most allowed is 8"),
            "rust: {rust_err}"
        );

        let bundle = concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime-js/bundle.js");
        let script = format!(
            r#"
const {{ format }} = require({bundle:?});
const tree = {{ language: "toy", source: "", root: {{ type: "file", start: 0, end: 0 }} }};
try {{
  format(tree, new Map([["toy", {pkg}]]), 80);
  console.error("js accepted an out-of-range comment gap");
  process.exit(2);
}} catch (e) {{
  if (!/`comment_gap` is 9; the most allowed is 8/.test(e.message)) {{
    console.error(e.message);
    process.exit(3);
  }}
}}
"#,
            bundle = bundle,
            pkg = pkg_json,
        );
        let status = std::process::Command::new("node")
            .arg("-e")
            .arg(script)
            .status()
            .expect("spawn node");
        assert!(status.success(), "js runtime disagreed (exit {status})");
    }

    #[test]
    fn a_group_fraction_breaks_a_construct_that_still_fits_the_line() {
        let pkg = toy(json!({
            "list": [
                "group",
                0.18,
                ["tok", "("],
                [
                    "indent",
                    ["soft"],
                    ["each", "named", ["seq", ["tok", ","], ["line"]]],
                    ["trail", ",", "named"]
                ],
                ["soft"],
                ["tok", ")"]
            ]
        }));
        // "(aaaa, bbbb)" is 12 columns; 0.18 * 80 = 14, so this stays flat.
        assert_eq!(
            run(&pkg, list(&["aaaa", "bbbb"], false), 80).expect("ok"),
            "(aaaa, bbbb)\n"
        );
        // "(aaaaaa, bbbbbb)" is 16 columns — under 80, over 14.
        assert_eq!(
            run(&pkg, list(&["aaaaaa", "bbbbbb"], false), 80).expect("ok"),
            "(\n  aaaaaa,\n  bbbbbb,\n)\n"
        );
    }

    #[test]
    fn a_trailing_separator_is_added_only_when_the_bracket_holds_a_list() {
        let pkg = toy(json!({ "list": list_rule() }));
        // Two items, broken: the separator is added.
        assert_eq!(
            run(&pkg, list(&["aaa", "bbb"], false), 4).expect("ok"),
            "(\n  aaa,\n  bbb,\n)\n"
        );
        // One item: black never reaches a comma splitting such a bracket.
        assert_eq!(
            run(&pkg, list(&["aaaaaa"], false), 4).expect("ok"),
            "(\n  aaaaaa\n)\n"
        );
        // Flat: no separator at all.
        assert_eq!(
            run(&pkg, list(&["a", "b"], false), 80).expect("ok"),
            "(a, b)\n"
        );
    }

    #[test]
    fn a_separator_already_in_the_source_pins_the_layout_open() {
        let pkg = toy(json!({ "list": list_rule() }));
        assert_eq!(
            run(&pkg, list(&["a", "b"], true).clone(), 80).expect("ok"),
            "(\n  a,\n  b,\n)\n"
        );
    }

    #[test]
    fn srcbreak_stays_expanded_when_the_source_broke_but_still_obeys_width() {
        // A bracketed literal whose open break is `srcbreak`: a source line break
        // after the opener forces it open (prettier's `objectWrap: preserve`),
        // while a source-flat literal still collapses or breaks by width.
        let obj_rule = json!([
            "group",
            ["tok", "("],
            [
                "indent",
                ["srcbreak"],
                ["each", "named", ["seq", ["tok", ","], ["line"]]],
                ["trail", ",", "named"]
            ],
            ["line"],
            ["tok", ")"]
        ]);
        let pkg = toy(json!({ "obj": obj_rule }));

        let source = "(\n  a,\n  b\n)";
        let root = json!({ "type": "obj", "start": 0, "end": source.len(), "children": [
            span("(", 0, 1, "("),
            span("a", 4, 5, "a"),
            span(",", 5, 6, ","),
            span("b", 8, 9, "b"),
            span(")", 10, 11, ")"),
        ]});
        assert_eq!(
            run_on(&pkg, source, root, 80).expect("ok"),
            "(\n  a,\n  b,\n)\n"
        );

        let source = "(a, b)";
        let root = json!({ "type": "obj", "start": 0, "end": source.len(), "children": [
            span("(", 0, 1, "("),
            span("a", 1, 2, "a"),
            span(",", 2, 3, ","),
            span("b", 4, 5, "b"),
            span(")", 5, 6, ")"),
        ]});
        assert_eq!(run_on(&pkg, source, root, 80).expect("ok"), "( a, b )\n");

        let source = "(aaaaa, bbbbb)";
        let root = json!({ "type": "obj", "start": 0, "end": source.len(), "children": [
            span("(", 0, 1, "("),
            span("aaaaa", 1, 6, "aaaaa"),
            span(",", 6, 7, ","),
            span("bbbbb", 8, 13, "bbbbb"),
            span(")", 13, 14, ")"),
        ]});
        assert_eq!(
            run_on(&pkg, source, root, 6).expect("ok"),
            "(\n  aaaaa,\n  bbbbb,\n)\n"
        );
    }

    fn chain(ops: &[(&str, &str)], base: &str) -> serde_json::Value {
        chain_fields(ops, base, "left", "operator", "right")
    }

    /// The probe's renamed spine: same shape as `chain`, different field names.
    fn chain_fields(
        ops: &[(&str, &str)],
        base: &str,
        left_field: &str,
        operator_field: &str,
        right_field: &str,
    ) -> serde_json::Value {
        let mut node = leaf("name", base);
        for (op, rhs) in ops {
            let mut left = node;
            left["field"] = json!(left_field);
            let mut right = leaf("name", rhs);
            right["field"] = json!(right_field);
            let mut operator = leaf(op, op);
            operator["field"] = json!(operator_field);
            node = json!({
                "type": "sum", "start": 0, "end": 0,
                "children": [left, operator, right],
            });
        }
        node
    }

    #[test]
    fn flatten_breaks_a_whole_chain_together_instead_of_staircasing() {
        let pkg = toy(json!({
            "sum": ["group", ["flatten", "sum", ["seq", ["line"], ["child", "f:operator"], ["sp"]]]]
        }));
        let tree = chain(&[("+", "bbb"), ("+", "ccc")], "aaa");
        assert_eq!(
            run(&pkg, tree.clone(), 80).expect("ok"),
            "aaa + bbb + ccc\n"
        );
        assert_eq!(run(&pkg, tree, 4).expect("ok"), "aaa\n+ bbb\n+ ccc\n");
    }

    #[test]
    fn flatten_stops_where_the_operator_binds_tighter() {
        let pkg = toy(json!({
            "sum": ["group", ["flatten", "sum", ["seq", ["line"], ["child", "f:operator"], ["sp"]]]]
        }));
        // (aaa * bbb) + ccc: only the `+` is a break point at this width.
        // Narrower still and the inner chain breaks too, which is right --
        // that recursion is how a chain of mixed precedence splits.
        let tree = chain(&[("*", "bbb"), ("+", "ccc")], "aaa");
        assert_eq!(run(&pkg, tree, 9).expect("ok"), "aaa * bbb\n+ ccc\n");
    }

    #[test]
    fn flatten_uses_the_packages_field_names() {
        // The defect: these three strings used to live in both evaluators, so
        // a grammar that called them lhs/op/rhs was refused and no package
        // rewrite could save it. The probe built exactly this tree.
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["+", "*"],
            "precedence": { "+": 5, "*": 4 },
            "flatten_fields": { "left": "lhs", "operator": "op", "right": "rhs" },
            "rules": {
                "sum": ["group", ["flatten", "sum",
                    ["seq", ["line"], ["child", "f:op"], ["sp"]]]]
            },
        }))
        .expect("renamed package parses");
        let packages = one(pkg);
        let tree = chain_fields(&[("+", "bbb"), ("+", "ccc")], "aaa", "lhs", "op", "rhs");
        assert_eq!(
            run(&packages, tree.clone(), 80).expect("ok"),
            "aaa + bbb + ccc\n"
        );
        assert_eq!(run(&packages, tree, 4).expect("ok"), "aaa\n+ bbb\n+ ccc\n");
        // Tightness must read `op` too, or mixed precedence would not split.
        let mixed = chain_fields(&[("*", "bbb"), ("+", "ccc")], "aaa", "lhs", "op", "rhs");
        assert_eq!(run(&packages, mixed, 9).expect("ok"), "aaa * bbb\n+ ccc\n");
    }

    fn fieldless_chain(ops: &[(&str, &str)], base: &str) -> serde_json::Value {
        let mut node = leaf("name", base);
        for (op, rhs) in ops {
            node = json!({
                "type": "sum", "start": 0, "end": 0,
                "children": [node, leaf(op, op), leaf("name", rhs)],
            });
        }
        node
    }

    #[test]
    fn flatten_walks_a_fieldless_binary_spine() {
        // TypeScript unions are `[operand, "|", operand]` with no left/operator/
        // right fields. The same opcode has to flatten that shape, or every
        // nested union staircases.
        let pkg = toy(json!({
            "sum": ["group", ["flatten", "sum",
                ["seq", ["line"], ["tok", "|"], ["sp"]]]]
        }));
        let tree = fieldless_chain(&[("|", "bbb"), ("|", "ccc")], "aaa");
        assert_eq!(
            run(&pkg, tree.clone(), 80).expect("ok"),
            "aaa | bbb | ccc\n"
        );
        assert_eq!(run(&pkg, tree, 4).expect("ok"), "aaa\n| bbb\n| ccc\n");
    }

    #[test]
    fn flatten_keeps_a_suffix_comment_on_a_skipped_left() {
        // After one format, a mid-union comment re-parses as a sibling of the
        // nested left rather than of the `|`. skip used to refuse that shape.
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["|"],
            "comments": ["comment"],
            "rules": {
                "sum": ["group", ["flatten", "sum",
                    ["seq", ["line"], ["tok", "|"], ["sp"]]]]
            },
        }))
        .expect("package");
        let source = "aaa | bbb /* c */ | ccc";
        let tree = json!({
            "type": "sum", "start": 0, "end": source.len(),
            "children": [
                {
                    "type": "sum", "start": 0, "end": 9,
                    "children": [
                        {"type": "name", "start": 0, "end": 3, "text": "aaa"},
                        {"type": "|", "start": 4, "end": 5, "text": "|"},
                        {"type": "name", "start": 6, "end": 9, "text": "bbb"},
                    ],
                },
                {"type": "comment", "start": 10, "end": 17, "text": "/* c */"},
                {"type": "|", "start": 18, "end": 19, "text": "|"},
                {"type": "name", "start": 20, "end": 23, "text": "ccc"},
            ],
        });
        let got = run_on(&one(pkg), source, tree, 80).expect("ok");
        assert!(got.contains("/* c */"), "comment was dropped: {got:?}");
        assert!(got.contains("ccc"), "{got:?}");
    }

    #[test]
    fn flatten_emits_skipped_suffix_comments_at_their_own_spine_levels() {
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["|"],
            "comments": ["comment"],
            "rules": {
                "sum": ["group", ["flatten", "sum",
                    ["seq", ["line"], ["tok", "|"], ["sp"]]]]
            },
        }))
        .expect("package");
        let source = "aaa | bbb /* one */ | ccc /* two */ | ddd";
        let first = json!({
            "type": "sum", "start": 0, "end": 9,
            "children": [
                span("name", 0, 3, "aaa"),
                span("|", 4, 5, "|"),
                span("name", 6, 9, "bbb"),
            ],
        });
        let second = json!({
            "type": "sum", "start": 0, "end": 25,
            "children": [
                first,
                span("comment", 10, 19, "/* one */"),
                span("|", 20, 21, "|"),
                span("name", 22, 25, "ccc"),
            ],
        });
        let root = json!({
            "type": "sum", "start": 0, "end": source.len(),
            "children": [
                second,
                span("comment", 26, 35, "/* two */"),
                span("|", 36, 37, "|"),
                span("name", 38, 41, "ddd"),
            ],
        });
        assert_eq!(
            run_on(&one(pkg), source, root, 80).expect("ok"),
            "aaa\n| bbb /* one */\n| ccc /* two */\n| ddd\n"
        );
    }

    #[test]
    fn flatten_fieldless_fallback_keeps_the_leading_comment_refusal() {
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["|"],
            "comments": ["comment"],
            "rules": {
                "sum": ["group", ["flatten", "sum",
                    ["seq", ["line"], ["tok", "|"], ["sp"]]]]
            },
        }))
        .expect("package");
        let left = fieldless_chain(&[("|", "bbb")], "aaa");
        let root = json!({
            "type": "sum", "start": 0, "end": 0,
            "children": [leaf("comment", "/* lead */"), left, leaf("|", "|"), leaf("name", "ccc")],
        });
        let err = run(&one(pkg), root, 80).expect_err("must refuse");
        assert!(
            err.0.contains("no leading comment on an operand"),
            "{}",
            err.0
        );
    }

    #[test]
    fn flatten_emits_an_after_comment_from_a_skipped_fielded_operand() {
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["|", "rhs"],
            "comments": ["comment"],
            "precedence": { "|": 1 },
            "rules": {
                "sum": ["group", ["flatten", "sum",
                    ["seq", ["line"], ["child", "f:operator"], ["sp"]]]]
            },
        }))
        .expect("package");
        let source = "aaa | bbb\n/* after */\n| rhs";
        let mut left = chain(&[("|", "bbb")], "aaa");
        left["field"] = json!("left");
        let root = json!({
            "type": "sum", "start": 0, "end": source.len(),
            "children": [
                left,
                span("comment", 10, 21, "/* after */"),
                {"type": "|", "start": 22, "end": 23, "text": "|", "field": "operator"},
                {"type": "rhs", "start": 24, "end": 27, "text": "rhs", "field": "right"},
            ],
        });
        assert_eq!(
            run_on(&one(pkg), source, root, 80).expect("ok"),
            "aaa\n| bbb\n/* after */\n| rhs\n"
        );
    }

    #[test]
    fn flatten_does_not_infer_tightness_past_a_fielded_operator_without_text() {
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["+", "*"],
            "precedence": { "+": 5, "*": 4 },
            "rules": {
                "sum": ["group", ["flatten", "sum",
                    ["seq", ["line"], ["child", "f:operator"], ["child", "*"], ["sp"]]]],
                "marker": []
            },
        }))
        .expect("package");
        let marked = |mut left: serde_json::Value, op: &str, rhs: &str| {
            left["field"] = json!("left");
            let mut right = leaf("name", rhs);
            right["field"] = json!("right");
            json!({
                "type": "sum", "start": 0, "end": 0,
                "children": [
                    left,
                    {"type": "marker", "start": 0, "end": 0, "field": "operator", "children": []},
                    leaf(op, op),
                    right,
                ],
            })
        };
        let tree = marked(marked(leaf("name", "aaa"), "*", "bbb"), "+", "ccc");
        assert_eq!(run(&one(pkg), tree, 9).expect("ok"), "aaa\n* bbb\n+ ccc\n");
    }

    #[test]
    fn both_runtimes_refuse_the_same_bad_flatten_header() {
        let cases = [
            (
                json!(["left", "operator", "right"]),
                "`flatten_fields` must be an object, got [\"left\",\"operator\",\"right\"]",
            ),
            (
                json!({"left": "lhs", "operator": "op"}),
                "`flatten_fields` is missing `right`",
            ),
            (
                json!({"left": "lhs", "operator": "op", "right": "rhs", "mid": "x"}),
                "`flatten_fields` has unknown field `mid`",
            ),
            (
                json!({"left": "", "operator": "op", "right": "rhs"}),
                "`flatten_fields.left` must be a non-empty string, got \"\"",
            ),
            (
                json!({"left": 1, "operator": "op", "right": "rhs"}),
                "`flatten_fields.left` must be a non-empty string, got 1",
            ),
            (
                json!({"left": "lhs", "operator": "lhs", "right": "rhs"}),
                "`flatten_fields` field names must be distinct",
            ),
        ];
        let bundle = concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime-js/bundle.js");
        for (value, want) in cases {
            let pkg_json = json!({
                "format": "et-doc-rules/1",
                "indent": 2,
                "flatten_fields": value,
                "rules": { "file": ["each", "*", ["seq"]] },
            });
            let rust_err = serde_json::from_value::<Package>(pkg_json.clone())
                .err()
                .expect("rust must refuse")
                .to_string();
            assert!(
                rust_err.contains(want),
                "rust wanted {want:?} in {rust_err}"
            );

            let script = format!(
                r#"
const {{ format }} = require({bundle:?});
const tree = {{ language: "toy", source: "", root: {{ type: "file", start: 0, end: 0 }} }};
try {{
  format(tree, new Map([["toy", {pkg}]]), 80);
  console.error("js accepted a bad flatten_fields header");
  process.exit(2);
}} catch (e) {{
  if (!e.message.includes({want})) {{
    console.error(e.message);
    process.exit(3);
  }}
}}
"#,
                bundle = bundle,
                pkg = pkg_json,
                want = serde_json::to_string(want).expect("want json"),
            );
            let status = std::process::Command::new("node")
                .arg("-e")
                .arg(script)
                .status()
                .expect("spawn node");
            assert!(
                status.success(),
                "js runtime disagreed on {want} (exit {status})"
            );
        }
    }

    fn quote_pkg() -> PackageMap {
        toy(json!({ "quote": ["verbatim"] }))
    }

    #[test]
    fn verbatim_emits_the_source_slice_when_the_subtree_checks_out() {
        let (source, root) = quote_ok();
        assert_eq!(
            run_on(&quote_pkg(), &source, root, 80).expect("ok"),
            "\"hi\"\n"
        );
    }

    #[test]
    fn verbatim_refuses_when_a_leafs_text_does_not_match_the_source() {
        let (source, root) = quote(
            0,
            4,
            vec![
                span("open", 0, 1, "\""),
                span("body", 1, 3, "HI"),
                span("close", 3, 4, "\""),
            ],
        );
        let err = run_on(&quote_pkg(), &source, root, 80).expect_err("must refuse");
        assert!(
            err.0.contains("verbatim `quote`")
                && err.0.contains("leaf whose text does not match the source"),
            "{}",
            err.0
        );
    }

    #[test]
    fn verbatim_refuses_when_a_descendant_is_outside_its_parent() {
        let (_, root) = quote(
            0,
            4,
            vec![
                span("open", 0, 1, "\""),
                span("body", 1, 5, "hi"),
                span("close", 3, 4, "\""),
            ],
        );
        let source = "\"hi\"x";
        let err = run_on(&quote_pkg(), source, root, 80).expect_err("must refuse");
        assert!(
            err.0.contains("verbatim `quote`") && err.0.contains("outside its parent"),
            "{}",
            err.0
        );
    }

    #[test]
    fn verbatim_refuses_when_siblings_overlap() {
        // Each leaf matches its own slice; the ranges themselves overlap.
        let (source, root) = quote(
            0,
            4,
            vec![
                span("open", 0, 2, "\"h"),
                span("body", 1, 3, "hi"),
                span("close", 3, 4, "\""),
            ],
        );
        let err = run_on(&quote_pkg(), &source, root, 80).expect_err("must refuse");
        assert!(
            err.0.contains("verbatim `quote`") && err.0.contains("overlapping siblings"),
            "{}",
            err.0
        );
    }

    #[test]
    fn tree_loader_refuses_before_verbatim_when_a_range_is_reversed() {
        let (source, root) = quote_ok();
        let mut root = root;
        root["start"] = json!(4);
        root["end"] = json!(0);
        let err = run_on(&quote_pkg(), &source, root, 80).expect_err("must refuse");
        assert!(
            err.0.contains("malformed tree: node `quote`") && err.0.contains("reversed range"),
            "{}",
            err.0
        );
    }

    #[test]
    fn both_runtimes_refuse_the_same_corrupt_verbatim_tree() {
        let pkg_json = json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["(", ")", ",", "+"],
            "precedence": { "+": 5, "*": 4 },
            "rules": { "quote": ["verbatim"] },
        });
        let pkg: Package = serde_json::from_value(pkg_json.clone()).expect("toy package parses");
        let (source, root) = quote(
            0,
            4,
            vec![
                span("open", 0, 1, "\""),
                span("body", 1, 3, "HI"),
                span("close", 3, 4, "\""),
            ],
        );

        let rust_err = run_on(&one(pkg), &source, root.clone(), 80).expect_err("rust must refuse");
        assert!(
            rust_err
                .0
                .contains("leaf whose text does not match the source"),
            "rust: {}",
            rust_err.0
        );

        let bundle = concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime-js/bundle.js");
        let script = format!(
            r#"
const {{ format }} = require({bundle:?});
const tree = {{ language: "toy", source: {source}, root: {root} }};
const pkg = {pkg};
try {{
  format(tree, new Map([["toy", pkg]]), 80);
  console.error("js accepted a corrupt verbatim tree");
  process.exit(2);
}} catch (e) {{
  if (!/verbatim `quote`/.test(e.message) ||
      !/leaf whose text does not match the source/.test(e.message)) {{
    console.error(e.message);
    process.exit(3);
  }}
}}
"#,
            bundle = bundle,
            source = serde_json::to_string(&source).expect("source json"),
            root = root,
            pkg = pkg_json,
        );
        let status = std::process::Command::new("node")
            .arg("-e")
            .arg(script)
            .status()
            .expect("spawn node");
        assert!(status.success(), "js runtime disagreed (exit {status})");
    }

    fn stmts_pkg(around: serde_json::Value) -> PackageMap {
        one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["(", ")", ",", "+", "def", "="],
            "comments": ["comment"],
            "rules": {
                "file": ["each", "named", ["seq", ["hard"], ["blank", 2, around]]],
                "fn": ["seq", ["tok", "def"], ["sp"], ["child", "t:name"],
                       ["opt", "t:body", ["child", "t:body"]]],
                "body": ["indent", ["hard"],
                         ["each", "named", ["seq", ["hard"], ["blank", 1, around]]]],
                "assign": ["seq", ["child", "t:name"], ["sp"], ["tok", "="], ["sp"],
                           ["child", "t:num"]],
            },
        }))
        .expect("stmts package parses"))
    }

    /// `x = 1` starting at `at`.
    fn assign_at(at: usize, name: &str, num: &str) -> serde_json::Value {
        let n1 = at + name.len();
        let eq = n1 + 1;
        let v0 = eq + 2;
        let v1 = v0 + num.len();
        json!({
            "type": "assign", "start": at, "end": v1,
            "children": [
                { "type": "name", "start": at, "end": n1, "text": name },
                { "type": "=", "start": eq, "end": eq + 1, "text": "=" },
                { "type": "num", "start": v0, "end": v1, "text": num },
            ]
        })
    }

    /// `def f` starting at `at`, optionally followed by a `body` child.
    fn fn_at(at: usize, name: &str, body: Option<serde_json::Value>) -> serde_json::Value {
        let n0 = at + 4;
        let n1 = n0 + name.len();
        let mut children = vec![
            json!({ "type": "def", "start": at, "end": at + 3, "text": "def" }),
            json!({ "type": "name", "start": n0, "end": n1, "text": name }),
        ];
        let end = match body {
            Some(b) => {
                let end = b["end"].as_u64().expect("body end") as usize;
                children.push(b);
                end
            }
            None => n1,
        };
        json!({ "type": "fn", "start": at, "end": end, "children": children })
    }

    #[test]
    fn blank_opens_to_the_cap_on_either_side_of_a_listed_type() {
        // x = 1\ndef f\ny = 2\n  — packed in the source; the def must open
        // the gap *after* itself as well as before, or we have grok's bug.
        let source = "x = 1\ndef f\ny = 2\n";
        let root = json!({
            "type": "file", "start": 0, "end": 18,
            "children": [
                assign_at(0, "x", "1"),
                fn_at(6, "f", None),
                assign_at(12, "y", "2"),
            ]
        });
        assert_eq!(
            run_on(&stmts_pkg(json!(["fn"])), source, root, 80).expect("ok"),
            "x = 1\n\n\ndef f\n\n\ny = 2\n"
        );
    }

    #[test]
    fn blank_inside_a_block_uses_the_block_cap_as_the_floor() {
        // Nested defs must open to 1, not 2: the cap is the floor, so depth
        // comes free and we do not hardcode 2 the way the sibling did.
        let source = "def f\n  x = 1\n  def g\n  y = 2\n";
        let root = json!({
            "type": "file", "start": 0, "end": 30,
            "children": [fn_at(0, "f", Some(json!({
                "type": "body", "start": 8, "end": 29,
                "children": [
                    assign_at(8, "x", "1"),
                    fn_at(16, "g", None),
                    assign_at(24, "y", "2"),
                ]
            })))]
        });
        assert_eq!(
            run_on(&stmts_pkg(json!(["fn"])), source, root, 80).expect("ok"),
            "def f\n  x = 1\n\n  def g\n\n  y = 2\n"
        );
    }

    #[test]
    fn blank_does_not_open_a_gap_between_unlisted_types() {
        let source = "x = 1\ny = 2\n";
        let root = json!({
            "type": "file", "start": 0, "end": 12,
            "children": [assign_at(0, "x", "1"), assign_at(6, "y", "2")]
        });
        assert_eq!(
            run_on(&stmts_pkg(json!(["fn"])), source, root, 80).expect("ok"),
            "x = 1\ny = 2\n"
        );
    }

    #[test]
    fn blank_still_caps_a_run_longer_than_n() {
        let source = "x = 1\n\n\n\ndef f\n";
        let root = json!({
            "type": "file", "start": 0, "end": 15,
            "children": [assign_at(0, "x", "1"), fn_at(9, "f", None)]
        });
        assert_eq!(
            run_on(&stmts_pkg(json!(["fn"])), source, root, 80).expect("ok"),
            "x = 1\n\n\ndef f\n"
        );
    }

    #[test]
    fn blank_keeps_the_exact_gap_after_a_declared_leaf_spelling() {
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": {
                "file": [
                    "seq",
                    ["each", "named",
                     ["seq", ["hard"], ["blank", 1, [], ["|+"]]]],
                    ["blank", 1, [], ["|+"]]
                ],
                "pair": ["verbatim"]
            }
        }))
        .expect("semantic-gap package parses"));
        let source = "|+\n  keep\n\n\nnext";
        let root = json!({
            "type": "file", "start": 0, "end": 16,
            "children": [
                {
                    "type": "pair", "start": 0, "end": 9,
                    "children": [{
                        "type": "block_scalar", "start": 0, "end": 9,
                        "children": [
                            { "type": "|", "start": 0, "end": 2, "text": "|+" }
                        ]
                    }]
                },
                {
                    "type": "pair", "start": 12, "end": 16,
                    "children": [
                        { "type": "word", "start": 12, "end": 16, "text": "next" }
                    ]
                }
            ]
        });
        assert_eq!(
            run_on(&pkg, source, root, 80).expect("ok"),
            "|+\n  keep\n\n\nnext\n"
        );

        let source = "|+\n  keep\n\n\n";
        let root = json!({
            "type": "file", "start": 0, "end": 12,
            "children": [{
                "type": "pair", "start": 0, "end": 12,
                "children": [{
                    "type": "block_scalar", "start": 0, "end": 12,
                    "children": [
                        { "type": "|", "start": 0, "end": 2, "text": "|+" }
                    ]
                }]
            }]
        });
        assert_eq!(run_on(&pkg, source, root, 80).expect("ok"), source);
    }

    #[test]
    fn blank_still_caps_after_a_subtree_that_merely_contains_the_spelling() {
        // The `|+` is buried mid-subtree, so the gap that follows the subtree
        // is ordinary trivia belonging to the next item, not scalar content.
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": {
                "file": [
                    "seq",
                    ["each", "named",
                     ["seq", ["hard"], ["blank", 1, [], ["|+"]]]],
                    ["blank", 1, [], ["|+"]]
                ],
                "pair": ["verbatim"]
            }
        }))
        .expect("semantic-gap package parses"));
        let source = "|+ tail\n\n\nnext";
        let root = json!({
            "type": "file", "start": 0, "end": 14,
            "children": [
                {
                    "type": "pair", "start": 0, "end": 7,
                    "children": [
                        { "type": "|", "start": 0, "end": 2, "text": "|+" },
                        { "type": "word", "start": 3, "end": 7, "text": "tail" }
                    ]
                },
                {
                    "type": "pair", "start": 10, "end": 14,
                    "children": [
                        { "type": "word", "start": 10, "end": 14, "text": "next" }
                    ]
                }
            ]
        });
        assert_eq!(
            run_on(&pkg, source, root, 80).expect("ok"),
            "|+ tail\n\nnext\n"
        );
    }

    #[test]
    fn child_count_can_dispatch_on_a_fields_wrapped_construct() {
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": {
                "file": [
                    "when", ["child-count", "f:value", "t:block_scalar", 1],
                    ["child", "named"], []
                ],
                "wrapper": ["verbatim"]
            }
        }))
        .expect("descendant predicate parses"));
        let root = json!({
            "type": "file", "start": 0, "end": 1,
            "children": [{
                "type": "wrapper", "field": "value", "start": 0, "end": 1,
                "children": [{
                    "type": "block_scalar", "start": 0, "end": 1,
                    "children": [
                        { "type": "|", "start": 0, "end": 1, "text": "|" }
                    ]
                }]
            }]
        });
        assert_eq!(run_on(&pkg, "|", root, 80).expect("ok"), "|\n");
    }

    #[test]
    fn text_predicate_follows_an_exact_child_path() {
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": {
                "file": [
                    "when", ["text", ["t:wrapper", "t:name"], ["block"]],
                    ["each", "named", ["sp"]],
                    ["each", "named", ["seq"]]
                ],
                "wrapper": ["each", "named", ["seq"]]
            }
        }))
        .expect("text-path package parses"));
        let direct = json!({
            "type": "file", "start": 0, "end": 0,
            "children": [
                { "type": "wrapper", "start": 0, "end": 0, "children": [
                    { "type": "name", "start": 0, "end": 0, "text": "block" }
                ]},
                { "type": "word", "start": 0, "end": 0, "text": "x" }
            ]
        });
        assert_eq!(
            run(&pkg, direct, 80).expect("direct path matches"),
            "block x\n"
        );

        let nested = json!({
            "type": "file", "start": 0, "end": 0,
            "children": [
                { "type": "wrapper", "start": 0, "end": 0, "children": [
                    { "type": "name", "start": 0, "end": 0, "text": "inline" },
                    { "type": "wrapper", "start": 0, "end": 0, "children": [
                        { "type": "name", "start": 0, "end": 0, "text": "block" }
                    ]}
                ]},
                { "type": "word", "start": 0, "end": 0, "text": "x" }
            ]
        });
        assert_eq!(
            run(&pkg, nested, 80).expect("deeper text does not match"),
            "inlineblockx\n"
        );
    }

    #[test]
    fn multiline_predicate_follows_an_exact_child_path() {
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": {
                "file": [
                    "when", ["multiline", ["t:wrapper", "t:name"]],
                    ["each", "named", ["sp"]],
                    ["each", "named", ["seq"]]
                ],
                "wrapper": ["each", "named", ["seq"]]
            }
        }))
        .expect("multiline-path package parses"));
        let root = json!({
            "type": "file", "start": 0, "end": 0,
            "children": [
                { "type": "wrapper", "start": 0, "end": 0, "children": [
                    { "type": "name", "start": 0, "end": 0, "text": "a\nb" }
                ]},
                { "type": "word", "start": 0, "end": 0, "text": "x" }
            ]
        });
        assert_eq!(
            run(&pkg, root, 80).expect("multiline path matches"),
            "a\nb x\n"
        );
    }

    #[test]
    fn source_multiline_predicate_inspects_the_node_range() {
        let pkg = toy(json!({
            "file": [
                "when", ["source-multiline"],
                ["seq", ["child", "named"], ["hard"], ["child", "named"]],
                ["each", "named", ["sp"]]
            ]
        }));
        let root = json!({
            "type": "file", "start": 0, "end": 3,
            "children": [
                { "type": "name", "start": 0, "end": 1, "text": "a" },
                { "type": "name", "start": 2, "end": 3, "text": "b" }
            ]
        });
        assert_eq!(
            run_on(&pkg, "a\nb", root.clone(), 80).expect("broken"),
            "a\nb\n"
        );
        assert_eq!(run_on(&pkg, "a b", root, 80).expect("flat"), "a b\n");

        // Range validity belongs to loading now; the predicate never sees a
        // tree whose source slice would need cross-runtime clamp semantics.
        let past = json!({
            "type": "file", "start": 0, "end": 99,
            "children": [
                { "type": "name", "start": 0, "end": 1, "text": "a" },
                { "type": "name", "start": 2, "end": 3, "text": "b" }
            ]
        });
        let error = run_on(&pkg, "a\nb", past, 80).expect_err("must refuse at load");
        assert!(error.0.contains("node `file`") && error.0.contains("past the source"));
    }

    #[test]
    fn srcgap_preserves_horizontal_space_and_breaks_without_trailing_space() {
        let pkg = toy(json!({
            "file": ["group", ["child", "named"], ["srcgap"], ["child", "named"]]
        }));
        let root = json!({
            "type": "file", "start": 0, "end": 4,
            "children": [
                { "type": "name", "start": 0, "end": 1, "text": "a" },
                { "type": "name", "start": 3, "end": 4, "text": "b" }
            ]
        });
        assert_eq!(
            run_on(&pkg, "a  b", root.clone(), 80).expect("flat"),
            "a  b\n"
        );
        assert_eq!(run_on(&pkg, "a  b", root, 1).expect("broken"), "a\nb\n");

        let omitted = json!({
            "type": "file", "start": 0, "end": 3,
            "children": [
                { "type": "name", "start": 0, "end": 1, "text": "a" },
                { "type": "name", "start": 2, "end": 3, "text": "b" }
            ]
        });
        assert!(run_on(&pkg, "a+b", omitted, 80)
            .expect_err("non-whitespace gap refuses")
            .0
            .contains("only whitespace in a `srcgap`"));

        // Node-local load checks cannot prove a range derived from two
        // overlapping siblings. Refuse that relation where `srcgap` forms it.
        let reversed = json!({
            "type": "file", "start": 0, "end": 4,
            "children": [
                { "type": "name", "start": 0, "end": 3, "text": "a" },
                { "type": "name", "start": 1, "end": 4, "text": "b" }
            ]
        });
        assert!(run_on(&pkg, "a  b", reversed, 80)
            .expect_err("reversed derived gap refuses")
            .0
            .contains("a valid source gap"));
    }

    fn all_pkg() -> PackageMap {
        one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": {
                "file": [
                    "when", ["all", "named", ["num", "word"]],
                    ["each", "named", ["seq"]],
                    []
                ],
                "num": ["verbatim"],
                "word": ["verbatim"]
            }
        }))
        .expect("all predicate parses"))
    }

    #[test]
    fn all_holds_vacuously_when_no_child_matches_the_selector() {
        // Else is `[]` and would refuse leftover children, so a successful
        // empty format is the empty-case pin: both runtimes must agree.
        let root = json!({ "type": "file", "start": 0, "end": 0, "children": [] });
        assert_eq!(run_on(&all_pkg(), "", root, 80).expect("ok"), "\n");
    }

    #[test]
    fn all_holds_when_every_selected_child_has_a_listed_type() {
        let root = json!({
            "type": "file", "start": 0, "end": 3,
            "children": [
                { "type": "num", "start": 0, "end": 1, "text": "1" },
                { "type": "word", "start": 2, "end": 3, "text": "a" }
            ]
        });
        assert_eq!(run_on(&all_pkg(), "1 a", root, 80).expect("ok"), "1a\n");
    }

    #[test]
    fn all_fails_when_one_selected_child_has_an_unlisted_type() {
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "rules": {
                "file": [
                    "when", ["all", "named", ["num"]],
                    [],
                    ["each", "named", ["seq"]]
                ],
                "num": ["verbatim"],
                "word": ["verbatim"]
            }
        }))
        .expect("all predicate parses"));
        let root = json!({
            "type": "file", "start": 0, "end": 3,
            "children": [
                { "type": "num", "start": 0, "end": 1, "text": "1" },
                { "type": "word", "start": 2, "end": 3, "text": "a" }
            ]
        });
        assert_eq!(run_on(&pkg, "1 a", root, 80).expect("ok"), "1a\n");
    }

    #[test]
    fn blank_opens_before_a_comment_that_leads_a_listed_type() {
        // The gap lives on the item, counted from its first leading comment,
        // so forcing it open puts the blanks *before* the comment.
        let source = "x = 1\n# c\ndef f\n";
        let root = json!({
            "type": "file", "start": 0, "end": 16,
            "children": [
                assign_at(0, "x", "1"),
                { "type": "comment", "start": 6, "end": 9, "text": "# c" },
                fn_at(10, "f", None),
            ]
        });
        assert_eq!(
            run_on(&stmts_pkg(json!(["fn"])), source, root, 80).expect("ok"),
            "x = 1\n\n\n# c\ndef f\n"
        );
    }

    #[test]
    fn blank_does_not_move_a_gap_that_sits_between_a_comment_and_a_def() {
        // The floor opens before the comment. A blank the source put
        // between the comment and the def is still just capped by decorate.
        let source = "x = 1\n# c\n\ndef f\n";
        let root = json!({
            "type": "file", "start": 0, "end": 17,
            "children": [
                assign_at(0, "x", "1"),
                { "type": "comment", "start": 6, "end": 9, "text": "# c" },
                fn_at(11, "f", None),
            ]
        });
        assert_eq!(
            run_on(&stmts_pkg(json!(["fn"])), source, root, 80).expect("ok"),
            "x = 1\n\n\n# c\n\ndef f\n"
        );
    }

    #[test]
    fn blank_without_a_type_list_is_still_only_a_cap() {
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["def", "="],
            "rules": {
                "file": ["each", "named", ["seq", ["hard"], ["blank", 2]]],
                "fn": ["seq", ["tok", "def"], ["sp"], ["child", "t:name"]],
                "assign": ["seq", ["child", "t:name"], ["sp"], ["tok", "="], ["sp"],
                           ["child", "t:num"]],
            },
        }))
        .expect("cap-only package parses");
        let source = "x = 1\ndef f\n";
        let root = json!({
            "type": "file", "start": 0, "end": 12,
            "children": [assign_at(0, "x", "1"), fn_at(6, "f", None)]
        });
        assert_eq!(
            run_on(&one(pkg), source, root, 80).expect("ok"),
            "x = 1\ndef f\n"
        );
    }

    #[test]
    fn after_comments_inside_indent_keep_the_indent() {
        // Flushing pending after-comments at the end of the *node* would drop
        // a block-trailing comment to column 0. They have to flush inside
        // the indent that holds the last sibling.
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comments": ["comment"],
            "rules": {
                "file": ["seq", ["tok", "def"], ["child", "t:body"]],
                "body": ["indent", ["hard"], ["each", "named", ["hard"]]]
            },
            "tokens": ["def"]
        }))
        .expect("indented-after package parses");
        let source = "def\n  x\n  # c\n";
        let root = json!({
            "type": "file", "start": 0, "end": 13,
            "children": [
                { "type": "def", "start": 0, "end": 3, "text": "def" },
                {
                    "type": "body", "start": 4, "end": 13,
                    "children": [
                        { "type": "name", "start": 6, "end": 7, "text": "x" },
                        { "type": "comment", "start": 10, "end": 13, "text": "# c" },
                    ]
                }
            ]
        });
        assert_eq!(
            run_on(&one(pkg), source, root, 80).expect("ok"),
            "def\n  x\n  # c\n"
        );
    }

    #[test]
    fn a_comment_only_descend_block_keeps_the_comment_inside() {
        // CSS `{ /* only comment */ }`: no named host, so the comment
        // used to dangle in front of `{` and leave the block. Parking it
        // on the opener lets indent flush it inside.
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comments": ["comment"],
            "descend": ["block"],
            "tokens": ["{", "}"],
            "rules": {
                "file": ["child", "t:block"],
                "block": [
                    "seq",
                    ["tok", "{"],
                    ["indent", ["opt", "named", ["seq", ["hard"], ["each", "named", ["hard"]]]]],
                    ["hard"],
                    ["tok", "}"]
                ]
            }
        }))
        .expect("comment-only block package parses");
        let source = "{\n  /* c */\n}";
        let root = json!({
            "type": "file", "start": 0, "end": 13,
            "children": [{
                "type": "block", "start": 0, "end": 13,
                "children": [
                    { "type": "{", "start": 0, "end": 1, "text": "{" },
                    { "type": "comment", "start": 4, "end": 11, "text": "/* c */" },
                    { "type": "}", "start": 12, "end": 13, "text": "}" }
                ]
            }]
        });
        assert_eq!(
            run_on(&one(pkg), source, root, 80).expect("ok"),
            "{\n  /* c */\n}\n"
        );
    }

    #[test]
    fn a_swallowed_terminator_is_peeled_once_and_only_once() {
        // FINDINGS 30. Same source, same rules; the two items differ only in
        // where the first node *ends*, which is the whole of what separates the
        // two grammar shapes:
        //   markdown `atx_heading`      swallows its line ending
        //   toml `table_array_element`  swallows that ending AND the blank run,
        //                               which its own rule already accounts for
        // Peeling one terminator recovers the blank for the first and leaves
        // the second alone. Peeling every trailing byte would double-count the
        // second, which is what FINDINGS 30's proposed repair did.
        let raw = json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": [],
            "rules": {
                "file": ["each", "named", ["seq", ["hard"], ["blank", 1]]],
                "item": ["child", "t:name"],
                "name": ["verbatim"]
            }
        });
        let pkg = || -> Package {
            serde_json::from_value(raw.clone()).expect("swallow package parses")
        };
        let source = "a\n\nb";
        let tree = |first_end: usize, file_end: usize| {
            json!({
                "type": "file", "start": 0, "end": file_end,
                "children": [
                    { "type": "item", "start": 0, "end": first_end, "children": [
                        { "type": "name", "start": 0, "end": 1, "text": "a" }
                    ]},
                    { "type": "item", "start": 3, "end": 4, "children": [
                        { "type": "name", "start": 3, "end": 4, "text": "b" }
                    ]}
                ]
            })
        };
        // Swallows only its line ending: the source blank is real and recovered.
        assert_eq!(
            run_on(&one(pkg()), source, tree(2, 4), 80).expect("ok"),
            "a\n\nb\n"
        );
        // Swallows the line ending and the blank: the blank belongs to the node,
        // and the gap must not claim it a second time.
        assert_eq!(
            run_on(&one(pkg()), source, tree(3, 4), 80).expect("ok"),
            "a\nb\n"
        );
        let error = run_on(&one(pkg()), source, tree(2, 50), 80)
            .expect_err("past-end root must refuse at load");
        assert!(error.0.contains("node `file`") && error.0.contains("past the source"));
    }

    #[test]
    fn a_declared_gap_owner_measures_past_the_childs_own_subtree() {
        // FINDINGS 30's remaining half. The source blank sits *inside* the
        // first item, one level below where peeling one terminator reaches --
        // markdown's loose list, where the blank that makes the list loose
        // lives in the preceding `list_item`. Only the parent the package names
        // measures past the subtree; every other consumer keeps the shallow
        // bound, because one blank is visible to several rules at once and each
        // of them would render it.
        let raw = |owner: serde_json::Value| {
            json!({
                "format": "et-doc-rules/1",
                "indent": 2,
                "tokens": [],
                "gap_owner": owner,
                "rules": {
                    "file": ["each", "named", ["seq", ["hard"], ["blank", 1]]],
                    "item": ["child", "t:name"],
                    "name": ["verbatim"]
                }
            })
        };
        let pkg = |owner: serde_json::Value| -> PackageMap {
            one(serde_json::from_value(raw(owner)).expect("gap_owner package parses"))
        };
        let source = "a\n\nb";
        let root = || {
            json!({
                "type": "file", "start": 0, "end": 4,
                "children": [
                    { "type": "item", "start": 0, "end": 3, "children": [
                        { "type": "name", "start": 0, "end": 1, "text": "a" }
                    ]},
                    { "type": "item", "start": 3, "end": 4, "children": [
                        { "type": "name", "start": 3, "end": 4, "text": "b" }
                    ]}
                ]
            })
        };
        // Undeclared: one terminator comes off `a\n\n`, the gap reads a single
        // newline, and the blank is invisible.
        assert_eq!(
            run_on(&pkg(json!({})), source, root(), 80).expect("ok"),
            "a\nb\n"
        );
        // Declared: the gap is measured from the deepest non-empty descendant,
        // so the blank the grammar buried is reachable.
        assert_eq!(
            run_on(&pkg(json!({ "file": ["item"] })), source, root(), 80).expect("ok"),
            "a\n\nb\n"
        );
        // A different child type is not the declared pair.
        assert_eq!(
            run_on(&pkg(json!({ "file": ["other"] })), source, root(), 80).expect("ok"),
            "a\nb\n"
        );
    }

    #[test]
    fn a_gap_owner_does_not_move_the_trailing_blank() {
        // The double-count that made every global depth worse than no depth at
        // all: the enclosing separator and the node's own trailing `blank` both
        // see one source blank. Ownership settles the sibling gap only -- the
        // trailing measure keeps the shallow bound, so the two never claim the
        // same newline.
        let pkg: PackageMap = one(
            serde_json::from_value(json!({
                "format": "et-doc-rules/1",
                "indent": 2,
                "tokens": [],
                "gap_owner": { "file": ["item"] },
                "rules": {
                    "file": ["seq", ["each", "named", ["seq", ["hard"], ["blank", 1]]], ["blank", 1]],
                    "item": ["child", "t:name"],
                    "name": ["verbatim"]
                }
            }))
            .expect("package parses"),
        );
        // `b\n\n` swallows its ending and the blank after it. Shallow peels one
        // terminator and stops; deep would reach `b` and count the blank twice.
        let root = json!({
            "type": "file", "start": 0, "end": 6,
            "children": [
                { "type": "item", "start": 0, "end": 3, "children": [
                    { "type": "name", "start": 0, "end": 1, "text": "a" }
                ]},
                { "type": "item", "start": 3, "end": 6, "children": [
                    { "type": "name", "start": 3, "end": 4, "text": "b" }
                ]}
            ]
        });
        assert_eq!(
            run_on(&pkg, "a\n\nb\n\n", root, 80).expect("ok"),
            "a\n\nb\n"
        );
    }

    #[test]
    fn gap_owner_accepts_the_same_shapes_as_the_js_loader() {
        // Acceptance domains must match: a package that loads in one runtime
        // and refuses in the other is a parity break no corpus can see, which
        // is the lesson `tab_stop` left behind (FINDINGS 29b).
        let with_owner = |owner: serde_json::Value| {
            serde_json::from_value::<Package>(json!({
                "format": "et-doc-rules/1",
                "indent": 2,
                "gap_owner": owner,
                "rules": { "file": ["each", "named", ["hard"]] }
            }))
        };
        assert!(with_owner(json!({ "list": ["list_item"] })).is_ok());
        assert!(with_owner(json!({})).is_ok());
        assert!(with_owner(json!(["list"])).is_err());
        assert!(with_owner(json!({ "list": "list_item" })).is_err());
        assert!(with_owner(json!({ "list": [7] })).is_err());
    }

    #[test]
    fn trailing_trivia_does_not_make_an_own_line_comment_a_suffix() {
        // tree-sitter-go's statement_list range includes the newline after
        // the last statement, so an own-line comment before `}` looks
        // adjacent if suffix detection uses node.end. Content end (last
        // child) is the right line.
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "comments": ["comment"],
            "descend": ["statements"],
            "tokens": ["{", "}"],
            "rules": {
                "file": ["child", "t:block"],
                "block": [
                    "seq",
                    ["tok", "{"],
                    ["child", "t:statements"],
                    ["indent"],
                    ["hard"],
                    ["tok", "}"]
                ],
                "statements": ["indent", ["hard"], ["each", "named", ["hard"]]],
                "name": ["verbatim"]
            }
        }))
        .expect("trivia-suffix package parses");
        let source = "{\n  x\n  // c\n}";
        let root = json!({
            "type": "file", "start": 0, "end": 14,
            "children": [{
                "type": "block", "start": 0, "end": 14,
                "children": [
                    { "type": "{", "start": 0, "end": 1, "text": "{" },
                    {
                        "type": "statements", "start": 4, "end": 6,
                        "children": [
                            { "type": "name", "start": 4, "end": 5, "text": "x" }
                        ]
                    },
                    { "type": "comment", "start": 8, "end": 12, "text": "// c" },
                    { "type": "}", "start": 13, "end": 14, "text": "}" }
                ]
            }]
        });
        assert_eq!(
            run_on(&one(pkg), source, root, 80).expect("ok"),
            "{\n  x\n  // c\n}\n"
        );
    }

    #[test]
    fn trail_comma_precedes_an_own_line_comment_before_the_closer() {
        // TOML (and any language whose last list item carries an own-line
        // comment before `]`) must not let that comment swallow the
        // break-only trailing comma.
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["(", ")", ","],
            "comments": ["comment"],
            "rules": {
                "list": [
                    "group", ["tok", "("],
                    ["indent", ["soft"],
                        ["each", "named", ["seq", ["tok", ","], ["line"]]],
                        ["trail", ",", "*"]],
                    ["soft"], ["tok", ")"]
                ]
            }
        }))
        .expect("list-with-comments package parses"));
        let source = "(a\n# c\n)";
        let root = json!({
            "type": "list", "start": 0, "end": 8,
            "children": [
                { "type": "(", "start": 0, "end": 1, "text": "(" },
                { "type": "name", "start": 1, "end": 2, "text": "a" },
                { "type": "comment", "start": 3, "end": 6, "text": "# c" },
                { "type": ")", "start": 7, "end": 8, "text": ")" },
            ]
        });
        assert_eq!(
            run_on(&pkg, source, root, 4).expect("ok"),
            "(\n  a,\n  # c\n)\n"
        );
    }

    #[test]
    fn a_flat_rule_keeps_an_own_line_comment_before_the_closer() {
        let pkg = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["[", "]", ","],
            "comments": ["comment"],
            "rules": {
                "array": [
                    "seq", ["tok", "["],
                    ["each", "named", ["seq", ["tok", ","], ["sp"]]],
                    ["trail", ",", "*"], ["tok", "]"]
                ]
            }
        }))
        .expect("flat-array package parses"));
        let source = "a = [\n  1,\n  # a comment before the closer\n]\n";
        let root = json!({
            "type": "array", "start": 4, "end": 44,
            "children": [
                { "type": "[", "start": 4, "end": 5, "text": "[" },
                { "type": "integer", "start": 8, "end": 9, "text": "1" },
                { "type": ",", "start": 9, "end": 10, "text": "," },
                {
                    "type": "comment", "start": 13, "end": 42,
                    "text": "# a comment before the closer"
                },
                { "type": "]", "start": 43, "end": 44, "text": "]" },
            ]
        });
        assert_eq!(
            run_on(&pkg, source, root, 80).expect("ok"),
            "[1,\n# a comment before the closer\n]\n"
        );
    }

    #[test]
    fn blank_at_end_of_a_rule_preserves_trailing_trivia() {
        // tree-sitter-toml's table range includes the blank line before the
        // next header. A `blank` after the last child is the only way a
        // package can see that gap.
        let pkg: Package = serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["["],
            "rules": {
                "file": ["each", "named", ["seq", ["hard"], ["blank", 2]]],
                "table": [
                    "seq",
                    ["tok", "["],
                    ["child", "named"],
                    ["blank", 2]
                ]
            }
        }))
        .expect("trailing-trivia package parses");
        let source = "[a\n\n[b\n";
        let root = json!({
            "type": "file", "start": 0, "end": 7,
            "children": [
                {
                    "type": "table", "start": 0, "end": 4,
                    "children": [
                        { "type": "[", "start": 0, "end": 1, "text": "[" },
                        { "type": "name", "start": 1, "end": 2, "text": "a" },
                    ]
                },
                {
                    "type": "table", "start": 4, "end": 7,
                    "children": [
                        { "type": "[", "start": 4, "end": 5, "text": "[" },
                        { "type": "name", "start": 5, "end": 6, "text": "b" },
                    ]
                },
            ]
        });
        assert_eq!(
            run_on(&one(pkg), source, root, 80).expect("ok"),
            "[a\n\n[b\n"
        );
    }

    // --- table ------------------------------------------------------------

    fn table_pkg() -> PackageMap {
        one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["|", "cont"],
            "rules": { "table": ["table"] },
        }))
        .expect("table package parses"))
    }

    fn tcell(kind: &str, start: usize, end: usize) -> serde_json::Value {
        json!({ "type": kind, "start": start, "end": end, "children": [] })
    }

    fn trow(
        kind: &str,
        start: usize,
        end: usize,
        cells: Vec<serde_json::Value>,
    ) -> serde_json::Value {
        let mut kids = vec![span("|", start, start + 1, "|")];
        kids.extend(cells);
        kids.push(span("|", end - 1, end, "|"));
        json!({ "type": kind, "start": start, "end": end, "children": kids })
    }

    /// `| a | bb |` / `|:-|-:|` / `| longer | 2 |`, with the grammar's own cell
    /// spans: it strips a cell's leading space and keeps its trailing one.
    const WONKY: &str = "| a | bb |\n|:-|-:|\n| longer | 2 |\n";

    fn wonky_table() -> serde_json::Value {
        json!({
            "type": "table", "start": 0, "end": 34,
            "children": [
                trow("head", 0, 10, vec![tcell("cell", 2, 4), tcell("cell", 6, 9)]),
                trow("ruler", 11, 18, vec![tcell("rule", 12, 14), tcell("rule", 15, 17)]),
                trow("body", 19, 33, vec![tcell("cell", 21, 28), tcell("cell", 30, 32)]),
            ],
        })
    }

    #[test]
    fn table_pads_to_the_widest_cell_and_redraws_the_ruler_to_match() {
        let out = run_on(&table_pkg(), WONKY, wonky_table(), 80).expect("formats");
        assert_eq!(out, "| a      |  bb |\n| :----- | --: |\n| longer |   2 |\n");
    }

    #[test]
    fn table_floors_a_column_at_three_and_never_measures_the_ruler() {
        // Both columns hold one character; the ruler in the source is seven
        // wide and carries no alignment, so every column comes out at the floor.
        let source = "| a | b |\n|-------|-|\n";
        let root = json!({
            "type": "table", "start": 0, "end": 22,
            "children": [
                trow("head", 0, 9, vec![tcell("cell", 2, 4), tcell("cell", 6, 8)]),
                trow("ruler", 10, 21, vec![tcell("rule", 11, 18), tcell("rule", 19, 20)]),
            ],
        });
        let out = run_on(&table_pkg(), source, root, 80).expect("formats");
        assert_eq!(out, "| a   | b   |\n| --- | --- |\n");
    }

    #[test]
    fn table_keeps_a_containers_per_line_marker_in_front_of_its_row() {
        // What a table inside a block quote looks like: the host's `> ` arrives
        // as a token child of the table, between the rows it prefixes.
        let source = "| a |\n> |-|\n> | bb |\n";
        let root = json!({
            "type": "table", "start": 0, "end": 21,
            "children": [
                trow("head", 0, 5, vec![tcell("cell", 2, 4)]),
                span("cont", 6, 8, "> "),
                trow("ruler", 8, 11, vec![tcell("rule", 9, 10)]),
                span("cont", 12, 14, "> "),
                trow("body", 14, 20, vec![tcell("cell", 16, 19)]),
            ],
        });
        let out = run_on(&table_pkg(), source, root, 80).expect("formats");
        assert_eq!(out, "| a   |\n> | --- |\n> | bb  |\n");
    }

    #[test]
    fn table_leaves_a_ragged_row_ragged_rather_than_squaring_it_off() {
        let source = "| a | b |\n| - | - |\n| 1 |\n";
        let root = json!({
            "type": "table", "start": 0, "end": 26,
            "children": [
                trow("head", 0, 9, vec![tcell("cell", 2, 4), tcell("cell", 6, 8)]),
                trow("ruler", 10, 19, vec![tcell("rule", 12, 13), tcell("rule", 16, 17)]),
                trow("body", 20, 25, vec![tcell("cell", 22, 24)]),
            ],
        });
        let out = run_on(&table_pkg(), source, root, 80).expect("formats");
        assert_eq!(out, "| a   | b   |\n| --- | --- |\n| 1   |\n");
    }

    #[test]
    fn table_refuses_to_share_its_node_with_another_expression() {
        let pkg: PackageMap = one(serde_json::from_value(json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "tokens": ["|", "cont"],
            "rules": { "table": ["seq", ["child", "t:cont"], ["table"]] },
        }))
        .expect("package"));
        let mut root = wonky_table();
        let kids = root["children"].as_array_mut().expect("children");
        kids.insert(0, span("cont", 0, 0, ""));
        let err = run_on(&pkg, WONKY, root, 80).expect_err("must refuse");
        assert!(err.0.contains("`table` takes every child"), "{}", err.0);
    }


    // --- blank_owner ------------------------------------------------------

    /// `block` is a leaf whose source range runs past the blank line that ends
    /// it, which is markdown's `indented_code_block`. `p` is a paragraph.
    fn spent_pkg(owner: Option<&[&str]>) -> PackageMap {
        let mut raw = json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "blank_cap": 1,
            "rules": {
                "file": ["each", "named", ["blank", 1, ["list", "p", "block"]]],
                "p": ["verbatim"],
            },
        });
        if let Some(kinds) = owner {
            raw["blank_owner"] = json!(kinds);
        }
        one(serde_json::from_value(raw).expect("package parses"))
    }

    const SPENT_SRC: &str = "one line\n\n    code\n\nlast line\n";

    fn spent_tree() -> serde_json::Value {
        json!({
            "type": "file", "start": 0, "end": 30,
            "children": [
                {"type": "p", "start": 0, "end": 9, "children": []},
                {"type": "block", "start": 10, "end": 20, "text": "    code\n\n"},
                {"type": "p", "start": 20, "end": 30, "children": []},
            ],
        })
    }

    #[test]
    fn a_listed_nodes_own_trailing_blank_is_not_emitted_twice() {
        let pkg = spent_pkg(Some(&["block"]));
        let out = run_on(&pkg, SPENT_SRC, spent_tree(), 80).expect("formats");
        assert_eq!(out, "one line\n\n    code\n\nlast line\n");
    }

    #[test]
    fn without_the_declaration_the_same_tree_grows_a_blank_line() {
        let pkg = spent_pkg(None);
        let out = run_on(&pkg, SPENT_SRC, spent_tree(), 80).expect("formats");
        assert_eq!(out, "one line\n\n    code\n\n\nlast line\n");
    }

    #[test]
    fn blank_owner_reaches_through_the_spine_that_ends_where_the_item_does() {
        // The blank is eaten by a `block` nested inside the item, and the
        // separator that has to know is the one *after the item*.
        let src = "- a\n\n      code\n\n- b\n";
        let root = json!({
            "type": "file", "start": 0, "end": 21,
            "children": [
                {"type": "p", "start": 0, "end": 17, "children": [
                    {"type": "lead", "start": 0, "end": 4, "text": "- a\n"},
                    {"type": "block", "start": 4, "end": 17, "text": "\n      code\n\n"},
                ]},
                {"type": "p", "start": 17, "end": 21, "children": []},
            ],
        });
        let pkg = spent_pkg(Some(&["block"]));
        let out = run_on(&pkg, src, root, 80).expect("formats");
        assert_eq!(out, "- a\n\n      code\n\n- b\n");
    }

    #[test]
    fn blank_owner_refuses_anything_but_an_array_of_node_types() {
        let raw = json!({
            "format": "et-doc-rules/1",
            "indent": 2,
            "blank_owner": "block",
            "rules": { "file": ["each", "named", ["blank", 1]] },
        });
        assert!(serde_json::from_value::<Package>(raw).is_err(), "must refuse a bare string");
    }


    #[test]
    fn table_refuses_an_error_where_a_cell_goes_rather_than_re_emitting_it() {
        // What `` `||` `` in a cell produces: the grammar splits the code span
        // and leaves a bare `|` behind as an ERROR, which would come back as a
        // column and never settle.
        let source = "| a |\n| - |\n| ` | | ` |\n";
        let root = json!({
            "type": "table", "start": 0, "end": 24,
            "children": [
                trow("head", 0, 5, vec![tcell("cell", 2, 4)]),
                trow("ruler", 6, 11, vec![tcell("rule", 8, 9)]),
                {"type": "body", "start": 12, "end": 23, "children": [
                    span("|", 12, 13, "|"),
                    tcell("cell", 14, 16),
                    span("|", 16, 17, "|"),
                    {"type": "ERROR", "start": 17, "end": 18, "children": []},
                    span("|", 18, 19, "|"),
                    tcell("cell", 20, 22),
                    span("|", 22, 23, "|"),
                ]},
            ],
        });
        let err = run_on(&table_pkg(), source, root, 80).expect_err("must refuse");
        assert!(
            err.0.contains("unparsed cell at byte 17"),
            "{}",
            err.0
        );
    }

    // Toy kinds exercise whitespace attachment independently of Markdown.
    fn whitespace_pkg(fields: serde_json::Value) -> PackageMap {
        let mut raw = json!({
            "format": "et-doc-rules/2", "indent": 2, "whitespace_nodes": ["gap"],
            "comments": ["comment"],
            "rules": {"file": ["each", "named", ["blank", 1]], "gap": ["verbatim"]},
        });
        raw.as_object_mut()
            .expect("formats")
            .extend(fields.as_object().expect("object").clone());
        one(serde_json::from_value(raw).expect("package"))
    }

    fn trivia_file(chunks: &[(&str, &str)]) -> (String, serde_json::Value) {
        let mut source = String::new();
        let children: Vec<_> = chunks
            .iter()
            .map(|(kind, text)| {
                let start = source.len();
                source.push_str(text);
                span(kind, start, source.len(), text)
            })
            .collect();
        let root = json!({"type": "file", "start": 0, "end": source.len(), "children": children});
        (source, root)
    }

    #[test]
    fn declared_whitespace_leaves_form_one_capped_gap_and_no_edge_items() {
        let (source, root) = trivia_file(&[
            ("gap", "\n\n"),
            ("a", "a\n"),
            ("gap", "\n"),
            ("gap", "\n\n"),
            ("b", "b\n"),
            ("gap", "\n\n"),
        ]);
        let pkg = whitespace_pkg(json!({}));
        assert_eq!(run_on(&pkg, &source, root, 80).expect("formats"), "a\n\nb\n");
        let (source, root) = trivia_file(&[("gap", "\n\n")]);
        assert_eq!(run_on(&pkg, &source, root, 80).expect("formats"), "\n");
    }

    #[test]
    fn whitespace_trivia_is_opt_in_and_separators_see_the_real_neighbours() {
        let (source, root) = trivia_file(&[("a", "a\n"), ("gap", "\n"), ("b", "b\n")]);
        let rules = json!({"file": ["each", "named", ["hard"]]});
        let pkg = whitespace_pkg(json!({"rules": rules}));
        assert_eq!(run_on(&pkg, &source, root.clone(), 80).expect("formats"), "a\n\nb\n");
        let pkg = whitespace_pkg(json!({"rules": rules, "whitespace_nodes": []}));
        assert_eq!(run_on(&pkg, &source, root, 80).expect("formats"), "a\n\n\n\nb\n");
        let (source, root) = trivia_file(&[("a", "a\n"), ("gap", ""), ("b", "b\n")]);
        let pkg = whitespace_pkg(json!({"rules": {"file": ["each", "named", ["blank", 1, ["a"]]]}}));
        assert_eq!(run_on(&pkg, &source, root, 80).expect("formats"), "a\n\nb\n");
    }

    #[test]
    fn non_whitespace_interior_nodes_and_injection_boundaries_remain_items() {
        let pkg = whitespace_pkg(json!({}));
        let (source, root) = trivia_file(&[("gap", "# Keep\n"), ("gap", "\u{a0}\n")]);
        assert_eq!(run_on(&pkg, &source, root, 80).expect("formats"), source);
        let (source, mut root) = trivia_file(&[("gap", " \n")]);
        root["children"][0]["children"] = json!([span("content", 0, 2, " \n")]);
        root["children"][0].as_object_mut().expect("object").remove("text");
        assert_eq!(run_on(&pkg, &source, root, 80).expect("formats"), " \n");
        let (source, mut root) = trivia_file(&[("a", "a\n"), ("gap", "\n"), ("b", "b\n")]);
        root["children"][1]["language"] = json!("toy");
        let pkg = whitespace_pkg(json!({"rules": {"file": ["each", "named", ["hard"]]}}));
        assert_eq!(run_on(&pkg, &source, root, 80).expect("formats"), "a\n\n\n\nb\n");
    }

    #[test]
    fn comments_attach_across_whitespace_trivia_without_being_swallowed() {
        let (source, root) = trivia_file(&[
            ("a", "a\n"),
            ("gap", "\n"),
            ("comment", "# keep"),
            ("gap", "\n\n"),
            ("b", "b\n"),
        ]);
        assert_eq!(
            run_on(&whitespace_pkg(json!({})), &source, root, 80).expect("formats"),
            "a\n\n# keep\n\nb\n"
        );
    }

    #[test]
    fn whitespace_trivia_cannot_hide_stale_text_or_overlapping_ranges() {
        let pkg = whitespace_pkg(json!({}));
        let (source, mut root) = trivia_file(&[("gap", "x")]);
        root["children"][0]["text"] = json!(" ");
        let err = run_on(&pkg, &source, root, 80).expect_err("stale leaf");
        assert!(
            err.0.contains("text does not match the source"),
            "{}",
            err.0
        );
        let (source, mut root) = trivia_file(&[("a", "a\n"), ("gap", "\n"), ("b", "b\n")]);
        root["children"][0]["end"] = json!(3);
        root["children"][0]["text"] = json!("a\n\n");
        let err = run_on(&pkg, &source, root, 80).expect_err("overlap");
        assert!(err.0.contains("overlapping siblings"), "{}", err.0);
    }

    #[test]
    fn whitespace_declarations_require_v2_a_list_of_kinds_and_disjoint_comments() {
        let raw = json!({"format": "et-doc-rules/2", "indent": 2, "rules": {}});
        for value in [json!(null), json!("gap"), json!({}), json!([1])] {
            let mut raw = raw.clone();
            raw["whitespace_nodes"] = value;
            assert!(serde_json::from_value::<Package>(raw).is_err());
        }
        for value in [json!([]), json!(["gap"])] {
            let mut raw = raw.clone();
            raw["format"] = json!("et-doc-rules/1");
            raw["whitespace_nodes"] = value;
            let err = serde_json::from_value::<Package>(raw)
                .err()
                .expect("v1 refuses declaration");
            assert!(err.to_string().contains("requires package format"), "{err}");
        }
        let mut raw = raw;
        raw["whitespace_nodes"] = json!(["gap"]);
        raw["comments"] = json!(["gap"]);
        let err = serde_json::from_value::<Package>(raw)
            .err()
            .expect("conflicting declarations");
        assert!(err.to_string().contains("must not overlap"), "{err}");
    }

}
