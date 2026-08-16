//! The evaluator: `Expr` + `Node` -> `Doc`.
//!
//! Every rule runs against a cursor over the node's direct children. A rule
//! may only ever consume the child under the cursor, so what it consumes is by
//! construction a disjoint, ordered partition of the children -- and a rule
//! that fails to consume all of them refuses the file instead of emitting.

use std::collections::HashMap;

use crate::attach::{split, Comment, Item};
use crate::doc::Doc;
use crate::pkg::{Expr, Package, Pred, Sel};
use crate::tree::{Node, TreeDoc};
use crate::Refusal;

pub type PackageMap = HashMap<String, Package>;

pub fn format(tree: &TreeDoc, packages: &PackageMap, width: usize) -> Result<String, Refusal> {
    let fmt = Fmt::for_language(&tree.language, packages, tree.source.as_bytes())?;
    let doc = fmt.node(&tree.root)?;
    let mut out = crate::doc::print(&doc, width);
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
        Ok(Self { pkg, packages, src })
    }

    fn node(&self, node: &'a Node) -> Result<Doc, Refusal> {
        if let Some(language) = node.language.as_deref() {
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
        let mut ctx = Ctx::new(node, self);
        let mut doc = ctx.eval(rule, self)?;
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

    fn slice(&self, node: &Node) -> Result<Doc, Refusal> {
        let bytes = self
            .src
            .get(node.start..node.end)
            .ok_or_else(|| Refusal(format!("`{}` runs past the source", node.kind)))?;
        std::str::from_utf8(bytes)
            .map(Doc::text)
            .map_err(|e| Refusal(format!("`{}` is not valid UTF-8: {e}", node.kind)))
    }
}

/// Comments the runtime attached to `item`, wrapped around its doc.
fn decorate(pkg: &Package, item: &Item<'_>, inner: Doc) -> Doc {
    if !item.decorated() {
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
        parts = vec![Doc::indent(pkg.indent, Doc::Concat(parts))];
    }
    parts.push(inner);
    let gap = " ".repeat(pkg.comment_gap);
    for text in &item.suffix {
        parts.push(Doc::Suffix(Box::new(Doc::text(format!("{gap}{text}")))));
    }
    for comment in &item.after {
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
}

impl<'a> Ctx<'a> {
    fn new(node: &'a Node, f: &Fmt<'a>) -> Ctx<'a> {
        let parts = split(node, f.src, f.pkg);
        Ctx {
            node,
            items: parts.items,
            dangling: parts.dangling,
            cursor: 0,
        }
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
            Expr::Group(es) => Ok(Doc::group(Doc::Concat(self.eval_all(es, f)?))),
            Expr::Indent(es) => Ok(Doc::indent(
                f.pkg.indent,
                Doc::Concat(self.eval_all(es, f)?),
            )),
            Expr::Line => Ok(Doc::Line),
            Expr::Soft => Ok(Doc::Soft),
            Expr::Hard => Ok(Doc::Hard),
            Expr::Sp => Ok(Doc::text(" ")),
            Expr::Child(sel) => self.child(sel, f),
            Expr::Each(sel, sep) => self.each(sel, sep, f),
            Expr::Tok(s) => self.tok(s, f),
            Expr::Verbatim => self.verbatim(f),
            Expr::Opt(sel, body) => {
                if self.matches(self.cursor, sel, f.pkg) {
                    self.eval(body, f)
                } else {
                    Ok(Doc::nil())
                }
            }
            Expr::Trail(sep, sel) => self.trail(sep, sel, f),
            Expr::Paren(es) => self.paren(es, f),
            Expr::AutoParen(sel) => self.autoparen(sel, f),
            Expr::When(pred, then, alt) => {
                let hit = self.test(pred, f.pkg);
                self.eval(if hit { then } else { alt }, f)
            }
            Expr::Flatten(kind, sep) => self.flatten(kind, sep, f),
            Expr::Blank(cap, around) => {
                let n = if self.forces_blank(around) {
                    *cap
                } else {
                    self.blanks().min(*cap)
                };
                Ok(Doc::Concat(
                    std::iter::repeat_with(|| Doc::Hard).take(n).collect(),
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

    fn take(&mut self, sel: &Sel, f: &Fmt<'a>) -> Result<usize, Refusal> {
        if !self.matches(self.cursor, sel, f.pkg) {
            return Err(self.refuse(&format!("{sel:?}")));
        }
        self.cursor += 1;
        Ok(self.cursor - 1)
    }

    fn child(&mut self, sel: &Sel, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let at = self.take(sel, f)?;
        let item = &self.items[at];
        let inner = f.node(item.node)?;
        Ok(decorate(f.pkg, item, inner))
    }

    fn tok(&mut self, want: &str, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let at = self.cursor;
        if self.items.get(at).and_then(|i| i.node.text.as_deref()) != Some(want) {
            return Err(self.refuse(&format!("the token `{want}`")));
        }
        self.cursor += 1;
        Ok(decorate(f.pkg, &self.items[at], Doc::text(want)))
    }

    fn verbatim(&mut self, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        if self.cursor != 0 {
            return Err(self.refuse("to be the whole rule (`verbatim` takes every child)"));
        }
        if self.items.iter().any(Item::decorated) {
            return Err(self.refuse("no comments inside an opaque node"));
        }
        check_verbatim(self.node, f.src)?;
        self.cursor = self.items.len();
        f.slice(self.node)
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
            return Ok(if self.tally(sel, f.pkg) > 1 {
                optional
            } else {
                Doc::nil()
            });
        }
        self.cursor += 1;
        Ok(Doc::Concat(vec![
            decorate(f.pkg, &self.items[at], optional),
            Doc::BreakParent,
        ]))
    }

    /// The balanced-paren policy: adopt the pair the source already has, or
    /// add one when the region breaks.
    fn paren(&mut self, body: &[Expr], f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let last = self.items.len().saturating_sub(1);
        let opener = self.cursor;
        let adopt = opener + 1 < self.items.len()
            && self.items[opener].node.text.as_deref() == Some("(")
            && self.items[last].node.text.as_deref() == Some(")");

        let open = if adopt {
            self.cursor += 1;
            decorate(f.pkg, &self.items[opener], Doc::text("("))
        } else {
            Doc::IfBreak(Box::new(Doc::text("(")), Box::new(Doc::nil()))
        };
        let inner = Doc::Concat(self.eval_all(body, f)?);
        let close = if adopt {
            if self.cursor != last {
                return Err(self.refuse("the closing `)` of the region it wraps"));
            }
            self.cursor += 1;
            decorate(f.pkg, &self.items[last], Doc::text(")"))
        } else {
            Doc::IfBreak(Box::new(Doc::text(")")), Box::new(Doc::nil()))
        };
        Ok(Doc::group(Doc::Concat(vec![
            open,
            Doc::indent(f.pkg.indent, Doc::Concat(vec![Doc::Soft, inner])),
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
            Doc::indent(f.pkg.indent, Doc::Concat(vec![Doc::Soft, inner])),
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

    fn test(&self, pred: &Pred, pkg: &Package) -> bool {
        match pred {
            Pred::Count(sel, n) => self.tally(sel, pkg) == *n,
        }
    }

    /// Predicates describe the node, not the cursor: count over every child.
    fn tally(&self, sel: &Sel, pkg: &Package) -> usize {
        (0..self.items.len())
            .filter(|&i| self.matches(i, sel, pkg))
            .count()
    }

    /// Collect a left-nested run of same-type, same-tightness operators into
    /// one flat list, so the whole chain breaks together instead of
    /// staircasing. This is the opcode a per-node fold cannot do without.
    fn flatten(&mut self, kind: &str, sep: &Expr, f: &Fmt<'a>) -> Result<Doc, Refusal> {
        let fields = &f.pkg.flatten_fields;
        let left = Sel::Field(fields.left.clone());
        let right = Sel::Field(fields.right.clone());

        let mut spine = Vec::new();
        let mut cur = self.node;
        while let Some(next) = cur.child_with_field(&fields.left) {
            if next.kind != kind || tightness(f.pkg, cur) != tightness(f.pkg, next) {
                break;
            }
            spine.push(next);
            cur = next;
        }
        let mut inner: Vec<Ctx<'a>> = spine.iter().map(|n| Ctx::new(n, f)).collect();

        let mut parts = Vec::new();
        match inner.last_mut() {
            None => parts.push(self.child(&left, f)?),
            Some(deepest) => {
                parts.push(deepest.child(&left, f)?);
                self.skip(&left, f)?;
                for i in 0..inner.len().saturating_sub(1) {
                    inner[i].skip(&left, f)?;
                }
            }
        }
        for i in (0..inner.len()).rev() {
            parts.push(inner[i].eval(sep, f)?);
            parts.push(inner[i].child(&right, f)?);
        }
        parts.push(self.eval(sep, f)?);
        parts.push(self.child(&right, f)?);

        for ctx in &inner {
            if ctx.cursor != ctx.items.len() {
                return Err(Refusal(format!(
                    "flattened `{}` left a child unconsumed",
                    ctx.node.kind
                )));
            }
        }
        Ok(Doc::Concat(parts))
    }

    /// Step over a child the chain emits elsewhere. It is still consumed
    /// exactly once, so long as nothing was attached to it here.
    fn skip(&mut self, sel: &Sel, f: &Fmt<'a>) -> Result<(), Refusal> {
        let at = self.take(sel, f)?;
        if self.items[at].decorated() {
            return Err(self.refuse("no comment on an operand of a flattened chain"));
        }
        Ok(())
    }
}

fn tightness(pkg: &Package, node: &Node) -> i64 {
    node.child_with_field(&pkg.flatten_fields.operator)
        .and_then(|op| op.text.as_deref())
        .map_or(0, |op| pkg.tightness(op))
}

/// `verbatim` is the one opcode that emits source bytes nobody compared
/// against the tree. Every other path reaches text through a real child, so
/// the linearity invariant protects it; this walk is the equivalent for a
/// node whose offsets may be stale.
fn check_verbatim(node: &Node, src: &[u8]) -> Result<(), Refusal> {
    check_verbatim_node(node, src, None, &node.kind)
}

fn check_verbatim_node(
    node: &Node,
    src: &[u8],
    parent: Option<&Node>,
    root_kind: &str,
) -> Result<(), Refusal> {
    let fail = |why: &str| Refusal(format!("verbatim `{root_kind}` {why}"));

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
        check_verbatim_node(child, src, Some(node), root_kind)?;
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
    fn a_token_that_is_not_where_the_rule_says_refuses() {
        let pkg = toy(json!({ "list": ["seq", ["tok", "["], ["each", "*", ["seq"]]] }));
        let err = run(&pkg, list(&["a"], false), 80).expect_err("must refuse");
        assert!(err.0.contains("the token `[`"), "{}", err.0);
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
        let (source, root) = quote(
            0,
            4,
            vec![
                span("open", 0, 1, "\""),
                span("body", 1, 10, "hi"),
                span("close", 3, 4, "\""),
            ],
        );
        let err = run_on(&quote_pkg(), &source, root, 80).expect_err("must refuse");
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
    fn verbatim_refuses_when_a_range_is_inverted() {
        let (source, root) = quote_ok();
        let mut root = root;
        root["start"] = json!(4);
        root["end"] = json!(0);
        let err = run_on(&quote_pkg(), &source, root, 80).expect_err("must refuse");
        assert!(
            err.0.contains("verbatim `quote`") && err.0.contains("inverted range"),
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
}
