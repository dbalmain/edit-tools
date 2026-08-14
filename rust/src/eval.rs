//! The evaluator: `Expr` + `Node` -> `Doc`.
//!
//! Every rule runs against a cursor over the node's direct children. A rule
//! may only ever consume the child under the cursor, so what it consumes is by
//! construction a disjoint, ordered partition of the children -- and a rule
//! that fails to consume all of them refuses the file instead of emitting.

use crate::attach::{items, Item};
use crate::doc::Doc;
use crate::pkg::{Expr, Package, Pred, Sel};
use crate::tree::{Node, TreeDoc};
use crate::Refusal;

pub fn format(tree: &TreeDoc, pkg: &Package, width: usize) -> Result<String, Refusal> {
    let fmt = Fmt {
        pkg,
        src: tree.source.as_bytes(),
    };
    let doc = fmt.node(&tree.root)?;
    let mut out = crate::doc::print(&doc, width, pkg.indent);
    while out.ends_with('\n') {
        out.pop();
    }
    out.push('\n');
    Ok(out)
}

struct Fmt<'a> {
    pkg: &'a Package,
    src: &'a [u8],
}

impl<'a> Fmt<'a> {
    fn node(&self, node: &'a Node) -> Result<Doc, Refusal> {
        if let Some(text) = &node.text {
            return Ok(Doc::text(text.as_str()));
        }
        let rule =
            self.pkg.rules.get(&node.kind).ok_or_else(|| {
                Refusal(format!("package has no rule for node type `{}`", node.kind))
            })?;
        let mut ctx = Ctx::new(node, self)?;
        let doc = ctx.eval(rule, self)?;
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
        for _ in 0..item.gap.min(2) {
            parts.push(Doc::Hard);
        }
    }
    if sink && !parts.is_empty() {
        parts = vec![Doc::indent(Doc::Concat(parts))];
    }
    parts.push(inner);
    for text in &item.suffix {
        parts.push(Doc::Suffix(Box::new(Doc::text(format!("  {text}")))));
    }
    for comment in &item.after {
        parts.push(Doc::Hard);
        for _ in 0..comment.blanks.min(2) {
            parts.push(Doc::Hard);
        }
        parts.push(Doc::text(comment.text.as_str()));
    }
    parts.push(Doc::BreakParent);
    Doc::Concat(parts)
}

struct Ctx<'a> {
    node: &'a Node,
    items: Vec<Item<'a>>,
    cursor: usize,
}

impl<'a> Ctx<'a> {
    fn new(node: &'a Node, f: &Fmt<'a>) -> Result<Ctx<'a>, Refusal> {
        Ok(Ctx {
            node,
            items: items(node, f.src, f.pkg)?,
            cursor: 0,
        })
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
            Expr::Indent(es) => Ok(Doc::indent(Doc::Concat(self.eval_all(es, f)?))),
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
            Expr::Blank(cap) => Ok(Doc::Concat(
                std::iter::repeat_with(|| Doc::Hard)
                    .take(self.blanks().min(*cap))
                    .collect(),
            )),
        }
    }

    fn eval_all(&mut self, exprs: &[Expr], f: &Fmt<'a>) -> Result<Vec<Doc>, Refusal> {
        exprs.iter().map(|e| self.eval(e, f)).collect()
    }

    fn blanks(&self) -> usize {
        self.items.get(self.cursor).map_or(0, |i| i.blanks)
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
            Doc::indent(Doc::Concat(vec![Doc::Soft, inner])),
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
            Doc::indent(Doc::Concat(vec![Doc::Soft, inner])),
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
            Pred::CountOver(sel, n) => self.tally(sel, pkg) > *n,
            Pred::Has(sel) => self.tally(sel, pkg) > 0,
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
        let left = Sel::Field("left".to_owned());
        let right = Sel::Field("right".to_owned());

        let mut spine = Vec::new();
        let mut cur = self.node;
        while let Some(next) = cur.child_with_field("left") {
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
    node.child_with_field("operator")
        .and_then(|op| op.text.as_deref())
        .map_or(0, |op| pkg.tightness(op))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A toy language, so the machinery is exercised without Python's bulk.
    fn toy(rules: serde_json::Value) -> Package {
        serde_json::from_value(json!({
            "indent": 2,
            "tokens": ["(", ")", ",", "+"],
            "precedence": { "+": 5, "*": 4 },
            "rules": rules,
        }))
        .expect("toy package parses")
    }

    fn leaf(kind: &str, text: &str) -> serde_json::Value {
        json!({ "type": kind, "start": 0, "end": 0, "text": text })
    }

    fn run(pkg: &Package, root: serde_json::Value, width: usize) -> Result<String, Refusal> {
        let tree: TreeDoc = serde_json::from_value(json!({
            "language": "toy",
            "source": "",
            "root": root,
        }))
        .expect("toy tree parses");
        format(&tree, pkg, width)
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
    fn a_token_that_is_not_where_the_rule_says_refuses() {
        let pkg = toy(json!({ "list": ["seq", ["tok", "["], ["each", "*", ["seq"]]] }));
        let err = run(&pkg, list(&["a"], false), 80).expect_err("must refuse");
        assert!(err.0.contains("the token `[`"), "{}", err.0);
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
        let mut node = leaf("name", base);
        for (op, rhs) in ops {
            let mut left = node;
            left["field"] = json!("left");
            let mut right = leaf("name", rhs);
            right["field"] = json!("right");
            let mut operator = leaf(op, op);
            operator["field"] = json!("operator");
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
}
