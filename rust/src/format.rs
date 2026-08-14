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
        let rule = self.pkg.nodes.get(&node.kind);
        let kind = match rule {
            Some(r) => r.kind.as_str(),
            None => self.default_kind(node),
        };
        match kind {
            "leaf" => self.kind_leaf(node),
            "opaque" => Ok(self.kind_opaque(node)),
            "fwd" => self.kind_fwd(node),
            "infix" => self.kind_infix(node, rule),
            "seq" => self.kind_seq(node, rule),
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

    fn kind_fwd(&self, node: &Node) -> Result<Doc, Refuse> {
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
            [only] => self.format_node(only),
            _ => Err(Refuse(format!(
                "fwd {} has {} significant children",
                node.kind,
                interesting.len()
            ))),
        }
    }

    fn kind_infix(&self, node: &Node, rule: Option<&Rule>) -> Result<Doc, Refuse> {
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
                parts.push(self.format_node(n)?);
            }
        }
        c.finish(&node.kind)?;
        if parts.is_empty() {
            return Err(Refuse(format!("infix {} has no operands", node.kind)));
        }
        let sep = Doc::text(rule.op.clone().unwrap_or_default());
        Ok(join(&sep, parts))
    }

    fn kind_seq(&self, node: &Node, rule: Option<&Rule>) -> Result<Doc, Refuse> {
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
            item_docs.push(self.format_node(item)?);
        }
        let mut inner = vec![pad.clone()];
        for (i, d) in item_docs.into_iter().enumerate() {
            if i > 0 {
                inner.push(sep_doc.clone());
            }
            inner.push(d);
        }
        match rule.trailing.as_deref() {
            _ if rule.singleton_comma && items.len() == 1 => inner.push(Doc::text(sep)),
            Some("magic") | Some("always-on-break") => {
                inner.push(Doc::if_break(Doc::text(sep), Doc::text("")));
            }
            _ => {}
        }

        let should_break = rule.trailing.as_deref() == Some("magic") && trailing_comma;
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
