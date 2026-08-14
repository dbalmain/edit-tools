//! Kind dispatch: the package names an algorithm, this module runs it.

use crate::Refuse;
use crate::doc::{Doc, join};
use crate::node::{Cursor, Node, non_comments};
use crate::package::{Package, Rule};

pub struct Engine<'a> {
    pub pkg: &'a Package,
}

impl Engine<'_> {
    pub fn format_node(&self, node: &Node) -> Result<Doc, Refuse> {
        self.format_in(node, None)
    }

    fn format_in(&self, node: &Node, parent_kind: Option<&str>) -> Result<Doc, Refuse> {
        let rule = self.pkg.nodes.get(&node.kind);
        let kind = match rule {
            Some(r) => r.kind.as_str(),
            None => self.default_kind(node),
        };
        match kind {
            "leaf" => self.kind_leaf(node),
            "opaque" => Ok(self.kind_opaque(node)),
            "fwd" => self.kind_fwd(node, kind),
            "infix" => self.kind_infix(node, rule, kind),
            "seq" => self.kind_seq(node, rule, kind),
            "body" => self.kind_body(node, rule, kind),
            "pfx" => self.kind_pfx(node, rule, kind, parent_kind),
            "wrap" => self.kind_wrap(node, rule, kind),
            "chain" => self.kind_chain(node, rule, kind, parent_kind),
            "comp" => self.kind_comp(node, rule, kind),
            "dot" => self.kind_dot(node, kind),
            "template" => self.kind_template(node, rule, kind, parent_kind),
            "from_import" => self.kind_from_import(node, kind),
            "clause" => self.kind_clause(node, rule, kind),
            other => Err(Refuse(format!("unknown kind {other} for {}", node.kind))),
        }
    }

    fn default_kind(&self, node: &Node) -> &'static str {
        if self.pkg.is_opaque(&node.kind) {
            "opaque"
        } else if node.text.is_some() {
            "leaf"
        } else {
            "fwd"
        }
    }

    fn kids<'a>(&self, node: &'a Node) -> Vec<&'a Node> {
        non_comments(node, self.pkg.comment_type())
    }

    fn kind_leaf(&self, node: &Node) -> Result<Doc, Refuse> {
        let Some(t) = &node.text else {
            return Err(Refuse(format!("leaf {} has no text", node.kind)));
        };
        if !node.children.is_empty() {
            return Err(Refuse(format!("leaf {} has children", node.kind)));
        }
        Ok(Doc::text(t.clone()))
    }

    fn kind_opaque(&self, node: &Node) -> Doc {
        Doc::text(node.raw_text())
    }

    fn kind_fwd(&self, node: &Node, kind: &str) -> Result<Doc, Refuse> {
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let mut interesting = Vec::new();
        while !c.is_empty() {
            let n = c.take("child")?;
            if !n.is_punct() {
                interesting.push(n);
            }
        }
        c.finish(&node.kind)?;
        match interesting.as_slice() {
            [] => Ok(Doc::text("")),
            [only] => self.format_in(only, Some(kind)),
            _ => Err(Refuse(format!(
                "fwd {} has {} significant children",
                node.kind,
                interesting.len()
            ))),
        }
    }

    fn kind_infix(&self, node: &Node, rule: Option<&Rule>, kind: &str) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("infix {} missing rule", node.kind)));
        };
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let needle = rule.op.as_deref().unwrap_or("").trim();
        let mut parts = Vec::new();
        while !c.is_empty() {
            let n = c.take("operand or op")?;
            let is_op = rule
                .op_field
                .as_deref()
                .is_some_and(|f| n.field.as_deref() == Some(f))
                || (!needle.is_empty() && n.is_token(needle));
            if !is_op {
                parts.push(self.format_in(n, Some(kind))?);
            }
        }
        c.finish(&node.kind)?;
        if parts.is_empty() {
            return Err(Refuse(format!("infix {} has no operands", node.kind)));
        }
        let sep = Doc::text(rule.op.clone().unwrap_or_default());
        Ok(join(&sep, parts))
    }

    fn kind_seq(&self, node: &Node, rule: Option<&Rule>, kind: &str) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("seq {} missing rule", node.kind)));
        };
        let open = rule
            .open
            .as_deref()
            .ok_or_else(|| Refuse(format!("seq {} missing open", node.kind)))?;
        let close = rule
            .close
            .as_deref()
            .ok_or_else(|| Refuse(format!("seq {} missing close", node.kind)))?;
        let sep = rule.sep.as_deref().unwrap_or(",");

        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let open_tok = c.take("open")?;
        if !open_tok.is_token(open) {
            return Err(Refuse(format!(
                "seq {}: expected {open}, got {}",
                node.kind, open_tok.kind
            )));
        }
        if c.is_empty() {
            return Err(Refuse(format!("seq {}: missing {close}", node.kind)));
        }
        if c.peek().is_some_and(|n| n.is_token(close)) {
            c.take("close")?;
            c.finish(&node.kind)?;
            return Ok(Doc::text(format!("{open}{close}")));
        }

        let mut items = Vec::new();
        let mut trailing_comma = false;
        while c.peek().is_some_and(|n| !n.is_token(close)) {
            if c.peek().is_some_and(|n| n.is_token(sep)) {
                return Err(Refuse(format!("seq {}: unexpected {sep}", node.kind)));
            }
            items.push(c.take("item")?);
            if c.is_empty() {
                return Err(Refuse(format!("seq {}: missing {close}", node.kind)));
            }
            if c.peek().is_some_and(|n| n.is_token(sep)) {
                c.take("sep")?;
                if c.peek().is_some_and(|n| n.is_token(close)) {
                    trailing_comma = true;
                    break;
                }
            } else if !c.peek().is_some_and(|n| n.is_token(close)) {
                return Err(Refuse(format!(
                    "seq {}: expected {sep} or {close}",
                    node.kind
                )));
            }
        }
        if !c.peek().is_some_and(|n| n.is_token(close)) {
            return Err(Refuse(format!("seq {}: missing {close}", node.kind)));
        }
        c.take("close")?;
        c.finish(&node.kind)?;

        if trailing_comma && rule.trailing.as_deref() == Some("none") {
            return Err(Refuse(format!(
                "seq {}: trailing {sep} is forbidden",
                node.kind
            )));
        }

        let pad = if rule.flat_pad {
            Doc::Line
        } else {
            Doc::Softline
        };
        let sep_doc = Doc::Concat(vec![Doc::text(sep), Doc::Line]);
        let mut item_docs = Vec::new();
        for item in items.iter() {
            item_docs.push(self.format_in(item, Some(kind))?);
        }
        let mut inner = vec![pad.clone()];
        for (i, d) in item_docs.into_iter().enumerate() {
            if i > 0 {
                inner.push(sep_doc.clone());
            }
            inner.push(d);
        }
        let singleton = rule.singleton_comma && items.len() == 1;
        if singleton {
            // The comma is syntactic (`(lonely,)`), not a magic-break hint.
            inner.push(Doc::text(sep));
        } else if matches!(
            rule.trailing.as_deref(),
            Some("magic") | Some("always-on-break")
        ) {
            inner.push(Doc::if_break(Doc::text(sep), Doc::text("")));
        }

        let should_break =
            rule.trailing.as_deref() == Some("magic") && trailing_comma && !singleton;
        let grouped = Doc::Concat(vec![
            Doc::text(open),
            Doc::indent(Doc::Concat(inner)),
            pad,
            Doc::text(close),
        ]);
        Ok(if should_break {
            Doc::group_break(grouped, true)
        } else {
            Doc::group(grouped)
        })
    }

    fn kind_body(&self, node: &Node, rule: Option<&Rule>, kind: &str) -> Result<Doc, Refuse> {
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let mut stmts = Vec::new();
        while !c.is_empty() {
            stmts.push(c.take("stmt")?);
        }
        c.finish(&node.kind)?;
        if stmts.is_empty() {
            return Ok(Doc::text(""));
        }
        let tight = rule.is_some_and(|r| r.tight);
        let mut docs = Vec::new();
        for (i, stmt) in stmts.iter().enumerate() {
            if i > 0 {
                docs.push(Doc::Hardline);
                if !tight && self.pkg.blank.before_top.iter().any(|t| t == &stmt.kind) {
                    docs.push(Doc::Hardline);
                    docs.push(Doc::Hardline);
                }
            }
            docs.push(self.format_in(stmt, Some(kind))?);
        }
        Ok(Doc::Concat(docs))
    }

    fn kind_pfx(
        &self,
        node: &Node,
        rule: Option<&Rule>,
        kind: &str,
        parent_kind: Option<&str>,
    ) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("pfx {} missing rule", node.kind)));
        };
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);

        if !rule.fields.is_empty() {
            let mut by_field = std::collections::BTreeMap::new();
            while !c.is_empty() {
                let n = c.take("child")?;
                if n.field
                    .as_deref()
                    .is_some_and(|f| rule.fields.iter().any(|w| w == f))
                {
                    by_field.insert(n.field.clone().unwrap_or_default(), n);
                } else if !n.is_punct() {
                    return Err(Refuse(format!("pfx {}: unexpected {}", node.kind, n.kind)));
                }
            }
            c.finish(&node.kind)?;
            let mut docs = Vec::new();
            for f in &rule.fields {
                if let Some(n) = by_field.get(f) {
                    docs.push(self.format_in(n, Some(kind))?);
                }
            }
            return Ok(Doc::Concat(docs));
        }

        let op_text = if let Some(kw) = &rule.kw {
            let tok = c.take("kw")?;
            if !tok.is_token(kw) {
                return Err(Refuse(format!(
                    "pfx {}: expected {kw}, got {}",
                    node.kind, tok.kind
                )));
            }
            kw.clone()
        } else if rule.op_field.is_some() {
            let op = c.take("op")?;
            op.raw_text()
        } else {
            return Err(Refuse(format!(
                "pfx {}: need kw, op_field, or fields",
                node.kind
            )));
        };
        let mut rest = Vec::new();
        while !c.is_empty() {
            rest.push(c.take("operand")?);
        }
        c.finish(&node.kind)?;
        let mut docs = vec![Doc::text(format!(
            "{op_text}{}",
            if rule.sp && !rest.is_empty() { " " } else { "" }
        ))];
        for n in rest {
            docs.push(self.format_in(n, Some(kind))?);
        }
        let mut doc = Doc::Concat(docs);
        if rule.paren {
            doc = paren_insert(doc, parent_kind);
        }
        Ok(doc)
    }

    fn kind_wrap(&self, node: &Node, rule: Option<&Rule>, kind: &str) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("wrap {} missing rule", node.kind)));
        };
        let open = rule
            .open
            .as_deref()
            .ok_or_else(|| Refuse(format!("wrap {} missing open", node.kind)))?;
        let close = rule
            .close
            .as_deref()
            .ok_or_else(|| Refuse(format!("wrap {} missing close", node.kind)))?;
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let open_tok = c.take("open")?;
        if !open_tok.is_token(open) {
            return Err(Refuse(format!(
                "wrap {}: expected {open}, got {}",
                node.kind, open_tok.kind
            )));
        }
        let inner = c.take("inner")?;
        let close_tok = c.take("close")?;
        if !close_tok.is_token(close) {
            return Err(Refuse(format!(
                "wrap {}: expected {close}, got {}",
                node.kind, close_tok.kind
            )));
        }
        c.finish(&node.kind)?;
        Ok(Doc::group(Doc::Concat(vec![
            Doc::text(open),
            Doc::indent(Doc::Concat(vec![
                Doc::Softline,
                self.format_in(inner, Some(kind))?,
            ])),
            Doc::Softline,
            Doc::text(close),
        ])))
    }

    fn kind_chain(
        &self,
        node: &Node,
        rule: Option<&Rule>,
        kind: &str,
        parent_kind: Option<&str>,
    ) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("chain {} missing rule", node.kind)));
        };
        let parts = if rule.already_flat {
            let kids = self.kids(node);
            let mut c = Cursor::new(&kids);
            let mut parts = vec![ChainPart {
                op: None,
                doc: self.format_in(c.take("operand")?, Some(kind))?,
            }];
            while !c.is_empty() {
                let op = c.take("op")?;
                let operand = c.take("operand")?;
                parts.push(ChainPart {
                    op: Some(format_op(op)),
                    doc: self.format_in(operand, Some(kind))?,
                });
            }
            c.finish(&node.kind)?;
            parts
        } else {
            let kids = self.kids(node);
            let mut c = Cursor::new(&kids);
            while !c.is_empty() {
                c.take("child")?;
            }
            c.finish(&node.kind)?;
            let op_node = field_child(node, "operator");
            let cls = prec_class(&format_op_opt(op_node));
            self.flatten_chain(node, cls, kind)?
        };
        finish_chain(parts, rule, parent_kind)
    }

    fn kind_comp(&self, node: &Node, rule: Option<&Rule>, kind: &str) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("comp {} missing rule", node.kind)));
        };
        let open = rule
            .open
            .as_deref()
            .ok_or_else(|| Refuse(format!("comp {} missing open", node.kind)))?;
        let close = rule
            .close
            .as_deref()
            .ok_or_else(|| Refuse(format!("comp {} missing close", node.kind)))?;
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let open_tok = c.take("open")?;
        if !open_tok.is_token(open) {
            return Err(Refuse(format!(
                "comp {}: expected {open}, got {}",
                node.kind, open_tok.kind
            )));
        }
        let mut parts = Vec::new();
        while c.peek().is_some_and(|n| !n.is_token(close)) {
            parts.push(c.take("part")?);
        }
        if !c.peek().is_some_and(|n| n.is_token(close)) {
            return Err(Refuse(format!("comp {}: missing {close}", node.kind)));
        }
        c.take("close")?;
        c.finish(&node.kind)?;
        let mut docs = vec![Doc::Softline];
        for (i, p) in parts.iter().enumerate() {
            if i > 0 {
                docs.push(Doc::Line);
            }
            docs.push(self.format_in(p, Some(kind))?);
        }
        Ok(Doc::group(Doc::Concat(vec![
            Doc::text(open),
            Doc::indent(Doc::Concat(docs)),
            Doc::Softline,
            Doc::text(close),
        ])))
    }

    fn kind_dot(&self, node: &Node, kind: &str) -> Result<Doc, Refuse> {
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let mut docs = Vec::new();
        while !c.is_empty() {
            let n = c.take("part")?;
            if n.is_token(".") {
                docs.push(Doc::text("."));
            } else {
                docs.push(self.format_in(n, Some(kind))?);
            }
        }
        c.finish(&node.kind)?;
        Ok(Doc::Concat(docs))
    }

    fn kind_template(
        &self,
        node: &Node,
        rule: Option<&Rule>,
        kind: &str,
        parent_kind: Option<&str>,
    ) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("template {} missing rule", node.kind)));
        };
        let spec = rule
            .doc
            .as_ref()
            .ok_or_else(|| Refuse(format!("template {} missing doc", node.kind)))?;
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let mut all = Vec::new();
        while !c.is_empty() {
            all.push(c.take("child")?);
        }
        c.finish(&node.kind)?;
        let mut by_field = std::collections::BTreeMap::new();
        for n in &all {
            if let Some(f) = &n.field {
                by_field.insert(f.as_str(), *n);
            }
        }
        let mut doc = self.eval_template(spec, &all, &by_field, kind)?;
        if rule.paren {
            doc = paren_insert(doc, parent_kind);
        }
        Ok(doc)
    }

    fn eval_template(
        &self,
        spec: &serde_json::Value,
        all: &[&Node],
        by_field: &std::collections::BTreeMap<&str, &Node>,
        kind: &str,
    ) -> Result<Doc, Refuse> {
        if let Some(s) = spec.as_str() {
            if let Some(nodes) = hole_nodes(s, all, by_field) {
                let mut docs = Vec::new();
                for n in nodes {
                    docs.push(self.format_in(n, Some(kind))?);
                }
                return Ok(Doc::Concat(docs));
            }
            return Ok(Doc::text(s));
        }
        if let Some(arr) = spec.as_array() {
            let mut docs = Vec::new();
            for item in arr {
                docs.push(self.eval_template(item, all, by_field, kind)?);
            }
            return Ok(Doc::Concat(docs));
        }
        if let Some(join) = spec.get("join") {
            let sep = join.get("sep").and_then(|v| v.as_str()).unwrap_or("");
            let items_spec = join
                .get("items")
                .and_then(|v| v.as_str())
                .unwrap_or("$children");
            let items = hole_nodes(items_spec, all, by_field).unwrap_or_default();
            let mut docs = Vec::new();
            for n in items {
                docs.push(self.format_in(n, Some(kind))?);
            }
            return Ok(crate::doc::join(&Doc::text(sep), docs));
        }
        Err(Refuse("bad template".into()))
    }

    fn kind_from_import(&self, node: &Node, kind: &str) -> Result<Doc, Refuse> {
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let from_tok = c.take("from")?;
        if !from_tok.is_token("from") {
            return Err(Refuse("from_import: expected from".into()));
        }
        let module = c.take("module")?;
        let import_tok = c.take("import")?;
        if !import_tok.is_token("import") {
            return Err(Refuse("from_import: expected import".into()));
        }
        let mut rest = Vec::new();
        while !c.is_empty() {
            rest.push(c.take("name")?);
        }
        c.finish(&node.kind)?;

        let names: Vec<&Node> = rest
            .iter()
            .copied()
            .filter(|n| {
                n.field.as_deref() == Some("name")
                    || (!n.is_punct() && n.kind != "(" && n.kind != ")")
            })
            .collect();
        let mut trailing_comma = false;
        for n in rest.iter().rev() {
            if n.is_token(")") {
                continue;
            }
            trailing_comma = n.is_token(",");
            break;
        }
        let has_parens = rest.iter().any(|n| n.is_token("("));
        let mut name_docs = Vec::new();
        for n in names {
            name_docs.push(self.format_in(n, Some(kind))?);
        }
        let sep_doc = Doc::Concat(vec![Doc::text(","), Doc::Line]);
        let mut inner = vec![Doc::Softline];
        for (i, d) in name_docs.into_iter().enumerate() {
            if i > 0 {
                inner.push(sep_doc.clone());
            }
            inner.push(d);
        }
        inner.push(Doc::if_break(Doc::text(","), Doc::text("")));
        let open = if has_parens {
            Doc::text("(")
        } else {
            Doc::if_break(Doc::text("("), Doc::text(""))
        };
        let close = if has_parens {
            Doc::text(")")
        } else {
            Doc::if_break(Doc::text(")"), Doc::text(""))
        };
        let list = Doc::group_break(
            Doc::Concat(vec![
                open,
                Doc::indent(Doc::Concat(inner)),
                Doc::Softline,
                close,
            ]),
            trailing_comma,
        );
        Ok(Doc::Concat(vec![
            Doc::text("from "),
            self.format_in(module, Some(kind))?,
            Doc::text(" import "),
            list,
        ]))
    }

    fn kind_clause(&self, node: &Node, rule: Option<&Rule>, kind: &str) -> Result<Doc, Refuse> {
        let Some(rule) = rule else {
            return Err(Refuse(format!("clause {} missing rule", node.kind)));
        };
        let kids = self.kids(node);
        let mut c = Cursor::new(&kids);
        let mut all = Vec::new();
        while !c.is_empty() {
            all.push(c.take("child")?);
        }
        c.finish(&node.kind)?;
        let mut by_field = std::collections::BTreeMap::new();
        for n in &all {
            if let Some(f) = &n.field {
                by_field.insert(f.as_str(), *n);
            }
        }
        let kw = rule.keyword.as_deref().unwrap_or("");
        let mut docs = vec![Doc::text(format!(
            "{kw}{}",
            if rule.header.is_empty() { "" } else { " " }
        ))];
        for h in &rule.header {
            if let Some(n) = all.iter().find(|n| n.field.as_deref() == Some(h.as_str())) {
                docs.push(self.format_in(n, Some(kind))?);
            } else if let Some(n) = all.iter().find(|n| n.kind == *h && n.text.is_none()) {
                docs.push(self.format_in(n, Some(kind))?);
            } else if all.iter().any(|n| n.is_token(h)) {
                docs.push(Doc::text(format!(" {h} ")));
            }
        }
        if let Some(arrow) = &rule.arrow
            && let Some(n) = by_field.get(arrow.as_str())
        {
            docs.push(Doc::text(" -> "));
            docs.push(self.format_in(n, Some(kind))?);
        }
        if rule.colon {
            docs.push(Doc::text(":"));
        }
        let body = rule
            .body
            .as_deref()
            .and_then(|b| by_field.get(b).copied())
            .or_else(|| all.iter().copied().find(|n| n.kind == "block"));
        if let Some(body) = body {
            docs.push(Doc::indent(Doc::Concat(vec![
                Doc::Hardline,
                self.format_in(body, Some(kind))?,
            ])));
        }
        for t in &rule.tails {
            for n in all.iter().filter(|n| n.kind == *t) {
                docs.push(Doc::Hardline);
                docs.push(self.format_in(n, Some(kind))?);
            }
        }
        Ok(Doc::Concat(docs))
    }

    fn flatten_chain(&self, node: &Node, cls: u8, kind: &str) -> Result<Vec<ChainPart>, Refuse> {
        if !is_bin_chain(node) {
            return Ok(vec![ChainPart {
                op: None,
                doc: self.format_in(node, Some(kind))?,
            }]);
        }
        let op_node = field_child(node, "operator");
        let op = format_op_opt(op_node);
        if prec_class(&op) != cls {
            return Ok(vec![ChainPart {
                op: None,
                doc: self.format_in(node, Some(kind))?,
            }]);
        }
        let left = field_child(node, "left")
            .ok_or_else(|| Refuse(format!("chain {} missing left", node.kind)))?;
        let right = field_child(node, "right")
            .ok_or_else(|| Refuse(format!("chain {} missing right", node.kind)))?;
        let mut head = self.flatten_chain(left, cls, kind)?;
        head.push(ChainPart {
            op: Some(op),
            doc: self.format_in(right, Some(kind))?,
        });
        Ok(head)
    }
}

struct ChainPart {
    op: Option<String>,
    doc: Doc,
}

fn hole_nodes<'a>(
    spec: &str,
    all: &[&'a Node],
    by_field: &std::collections::BTreeMap<&str, &'a Node>,
) -> Option<Vec<&'a Node>> {
    if spec == "$children" {
        return Some(all.iter().copied().filter(|n| !n.is_punct()).collect());
    }
    let name = spec.strip_prefix('$')?;
    if name.chars().all(|c| c.is_ascii_digit()) {
        let i: usize = name.parse().ok()?;
        return Some(all.get(i).copied().into_iter().collect());
    }
    let matches: Vec<&Node> = all
        .iter()
        .copied()
        .filter(|n| n.field.as_deref() == Some(name))
        .collect();
    if !matches.is_empty() {
        return Some(matches);
    }
    Some(by_field.get(name).copied().into_iter().collect())
}

fn is_bin_chain(node: &Node) -> bool {
    node.kind == "binary_operator" || node.kind == "boolean_operator"
}

fn field_child<'a>(node: &'a Node, name: &str) -> Option<&'a Node> {
    node.children
        .iter()
        .find(|c| c.field.as_deref() == Some(name))
}

fn format_op(node: &Node) -> String {
    if let Some(t) = &node.text {
        return t.clone();
    }
    let mut leaves = Vec::new();
    fn walk(n: &Node, leaves: &mut Vec<String>) {
        if let Some(t) = &n.text {
            leaves.push(t.clone());
        } else {
            for c in &n.children {
                walk(c, leaves);
            }
        }
    }
    walk(node, &mut leaves);
    leaves.join(" ")
}

fn format_op_opt(node: Option<&Node>) -> String {
    node.map(format_op).unwrap_or_default()
}

fn prec_class(op: &str) -> u8 {
    match op {
        "or" => 1,
        "and" => 2,
        "|" => 4,
        "^" => 5,
        "&" => 6,
        "<<" | ">>" => 7,
        "+" | "-" => 8,
        "*" | "/" | "//" | "%" | "@" => 9,
        "**" => 10,
        _ => 3,
    }
}

fn paren_insert(inner: Doc, parent_kind: Option<&str>) -> Doc {
    if matches!(parent_kind, Some("wrap") | Some("seq")) {
        return Doc::group(inner);
    }
    Doc::group(Doc::Concat(vec![
        Doc::if_break(Doc::text("("), Doc::text("")),
        Doc::indent(Doc::Concat(vec![Doc::Softline, inner])),
        Doc::Softline,
        Doc::if_break(Doc::text(")"), Doc::text("")),
    ]))
}

fn finish_chain(
    parts: Vec<ChainPart>,
    rule: &Rule,
    parent_kind: Option<&str>,
) -> Result<Doc, Refuse> {
    let mut iter = parts.into_iter();
    let Some(first) = iter.next() else {
        return Err(Refuse("empty chain".into()));
    };
    let mut docs = vec![first.doc];
    for part in iter {
        docs.push(Doc::Line);
        docs.push(Doc::text(format!("{} ", part.op.unwrap_or_default())));
        docs.push(part.doc);
    }
    let inner = Doc::Concat(docs);
    if rule.break_style.as_deref() == Some("paren") {
        Ok(paren_insert(inner, parent_kind))
    } else {
        Ok(Doc::group(inner))
    }
}

pub fn format_tree(tree: &crate::node::TreeDoc, width: usize) -> Result<String, Refuse> {
    let pkg = crate::package::load(&tree.language)?;
    let engine = Engine { pkg: &pkg };
    let body = engine.format_node(&tree.root)?;
    Ok(crate::doc::print(
        &Doc::Concat(vec![body, Doc::Hardline]),
        width,
        pkg.indent,
    ))
}
