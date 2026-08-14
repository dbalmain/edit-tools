//! Bytecode interpreter. Comment attach and the Wadler printer stay in the host.

use crate::Refuse;
use crate::doc::{Doc, join};
use crate::node::{Node, non_comments};
use crate::package::{self, Bytecode};

pub struct Engine<'a> {
    pkg: &'a Bytecode,
    source: Option<&'a [u8]>,
}

impl Engine<'_> {
    pub fn format_node(&self, node: &Node) -> Result<Doc, Refuse> {
        self.run(node, None)
    }

    fn run(&self, node: &Node, parent_kind: Option<&str>) -> Result<Doc, Refuse> {
        let (pc, kind) = self.entry_for(node);
        let kids = non_comments(node, self.pkg.comment_type());
        let args = self.pkg.args.get(&node.kind).cloned().unwrap_or_default();
        let mut f = Frame {
            node,
            parent_kind,
            kind,
            kids,
            cursor: 0,
            items: Vec::new(),
            bag: Vec::new(),
            slots: [0; 8],
            dslots: [None, None, None, None],
            docs: Vec::new(),
            nodes: Vec::new(),
            ints: Vec::new(),
            args,
        };
        let mut doc = self.exec(&mut f, pc)?;
        if !node.leading.is_empty() {
            let mut parts = Vec::new();
            for c in &node.leading {
                parts.push(Doc::text(c.clone()));
                parts.push(Doc::Hardline);
            }
            parts.push(doc);
            doc = Doc::Concat(parts);
        }
        for c in &node.trailing {
            doc = Doc::Concat(vec![doc, Doc::line_suffix(Doc::text(format!("  {c}")))]);
        }
        Ok(doc)
    }

    fn entry_for(&self, node: &Node) -> (usize, &str) {
        if let Some(&pc) = self.pkg.entry.get(&node.kind) {
            let kind = self
                .pkg
                .kinds
                .get(&node.kind)
                .map(String::as_str)
                .unwrap_or("fwd");
            return (pc, kind);
        }
        if self.pkg.is_opaque(&node.kind) {
            (self.pkg.defaults.opaque, "opaque")
        } else if node.text.is_some() {
            (self.pkg.defaults.leaf, "leaf")
        } else {
            (self.pkg.defaults.fwd, "fwd")
        }
    }

    fn exec(&self, f: &mut Frame<'_>, mut pc: usize) -> Result<Doc, Refuse> {
        let code = &self.pkg.code;
        loop {
            let op = *code.get(pc).ok_or_else(|| Refuse(format!("pc {pc} oob")))?;
            let len = package::op_len(op, code, pc)?;
            let imm = if len >= 2 { code[pc + 1] } else { 0 };
            match op {
                package::HALT => {
                    self.finish(f)?;
                    return f.pop_d();
                }
                package::TAKE => {
                    let n = self.take(f, "child")?;
                    f.nodes.push(n);
                }
                package::SKIP => {
                    self.take(f, "child")?;
                }
                package::FINISH => self.finish(f)?,
                package::EMPTY => f.ints.push(i32::from(f.cursor >= f.kids.len())),
                package::PEEK_PUNCT => {
                    let v = f.kids.get(f.cursor).is_some_and(|n| n.is_punct());
                    f.ints.push(i32::from(v));
                }
                package::NODE_PUNCT => {
                    let n = f.peek_n()?;
                    f.ints.push(i32::from(n.is_punct()));
                }
                package::DROP_N => {
                    f.pop_n()?;
                }
                package::DUP_N => {
                    let n = f.peek_n()?;
                    f.nodes.push(n);
                }
                package::DROP_D => {
                    f.pop_d()?;
                }
                package::DUP_D => {
                    let d = f.peek_d()?.clone();
                    f.docs.push(d);
                }
                package::DROP_I => {
                    f.pop_i()?;
                }
                package::DUP_I => {
                    let v = f.peek_i()?;
                    f.ints.push(v);
                }
                package::NOT => {
                    let v = f.pop_i()?;
                    f.ints.push(i32::from(v == 0));
                }
                package::LEAF => f.docs.push(self.kind_leaf(f.node)?),
                package::OPAQUE => f.docs.push(self.kind_opaque(f.node)),
                package::LINE => f.docs.push(Doc::Line),
                package::SOFTLINE => f.docs.push(Doc::Softline),
                package::HARDLINE => f.docs.push(Doc::Hardline),
                package::GROUP => {
                    let d = f.pop_d()?;
                    f.docs.push(Doc::group(d));
                }
                package::INDENT => {
                    let d = f.pop_d()?;
                    f.docs.push(Doc::indent(d));
                }
                package::IF_BREAK => {
                    let flat = f.pop_d()?;
                    let broken = f.pop_d()?;
                    f.docs.push(Doc::if_break(broken, flat));
                }
                package::FORMAT => {
                    let n = f.pop_n()?;
                    let d = self.run(n, Some(f.kind))?;
                    f.docs.push(d);
                }
                package::NODE_TEXT => {
                    let n = f.pop_n()?;
                    f.docs.push(Doc::text(n.text.clone().unwrap_or_default()));
                }
                package::FORMAT_OP => {
                    let n = f.pop_n()?;
                    f.docs.push(Doc::text(format_op(n)));
                }
                package::NODE_RAW => {
                    let n = f.pop_n()?;
                    f.docs.push(Doc::text(n.raw_text()));
                }
                package::ITEMS_NEW => f.items.clear(),
                package::ITEMS_PUSH => {
                    let n = f.pop_n()?;
                    f.items.push(n);
                }
                package::ITEMS_LEN => f.ints.push(i32_len(f.items.len())),
                package::ITEMS_FORMAT => {
                    let items = f.items.clone();
                    for n in items {
                        let d = self.run(n, Some(f.kind))?;
                        f.docs.push(d);
                    }
                    f.ints.push(i32_len(f.items.len()));
                }
                package::CONCAT_DYN => {
                    let n = f.pop_i()?;
                    let d = pop_concat(f, n)?;
                    f.docs.push(d);
                }
                package::JOIN_DYN => {
                    let n = f.pop_i()?;
                    let docs = pop_n_docs(f, n)?;
                    let sep = f.pop_d()?;
                    f.docs.push(join(&sep, docs));
                }
                package::PAREN => {
                    let d = f.pop_d()?;
                    f.docs.push(paren_insert(d, f.parent_kind));
                }
                package::TAKE_ALL => {
                    while f.cursor < f.kids.len() {
                        f.bag.push(f.kids[f.cursor]);
                        f.cursor += 1;
                    }
                    self.finish(f)?;
                }
                package::EQ => {
                    let b = f.pop_i()?;
                    let a = f.pop_i()?;
                    f.ints.push(i32::from(a == b));
                }
                package::LT => {
                    let b = f.pop_i()?;
                    let a = f.pop_i()?;
                    f.ints.push(i32::from(a < b));
                }
                package::ADD => {
                    let b = f.pop_i()?;
                    let a = f.pop_i()?;
                    f.ints.push(a.wrapping_add(b));
                }
                package::SUB => {
                    let b = f.pop_i()?;
                    let a = f.pop_i()?;
                    f.ints.push(a.wrapping_sub(b));
                }
                package::APPEND_DANGLING => {
                    let d = f.pop_d()?;
                    f.docs.push(append_dangling(d, f.node));
                }
                package::SWAP_D => {
                    let a = f.pop_d()?;
                    let b = f.pop_d()?;
                    f.docs.push(a);
                    f.docs.push(b);
                }
                package::GROUP_BREAK => {
                    let should = f.pop_i()? != 0;
                    let d = f.pop_d()?;
                    f.docs.push(Doc::group_break(d, should));
                }
                package::HOST_FROM_IMPORT => {
                    let d = self.host_from_import(f)?;
                    f.docs.push(d);
                }
                package::BAG_LEN => f.ints.push(i32_len(f.bag.len())),
                package::BAG_GET => {
                    let i = idx(f.pop_i()?)?;
                    let n = *f
                        .bag
                        .get(i)
                        .ok_or_else(|| Refuse(format!("bag[{i}] oob")))?;
                    f.nodes.push(n);
                }
                package::JZ => {
                    if f.pop_i()? == 0 {
                        pc = idx(imm)?;
                        continue;
                    }
                }
                package::JMP => {
                    pc = idx(imm)?;
                    continue;
                }
                package::JNZ => {
                    if f.pop_i()? != 0 {
                        pc = idx(imm)?;
                        continue;
                    }
                }
                package::PUSH_I => f.ints.push(imm),
                package::TEXT => f.docs.push(Doc::text(self.pkg.const_at(imm)?)),
                package::REFUSE => return Err(Refuse(self.pkg.const_at(imm)?.to_string())),
                package::PEEK_TOKEN => {
                    let want = self.pkg.const_at(imm)?;
                    let v = f.kids.get(f.cursor).is_some_and(|n| n.is_token(want));
                    f.ints.push(i32::from(v));
                }
                package::NODE_TOKEN => {
                    let want = self.pkg.const_at(imm)?;
                    let n = f.peek_n()?;
                    f.ints.push(i32::from(n.is_token(want)));
                }
                package::NODE_FIELD => {
                    let want = self.pkg.const_at(imm)?;
                    let n = f.peek_n()?;
                    f.ints.push(i32::from(n.field.as_deref() == Some(want)));
                }
                package::NODE_KIND => {
                    let want = self.pkg.const_at(imm)?;
                    let n = f.peek_n()?;
                    f.ints.push(i32::from(n.kind == want));
                }
                package::STORE => {
                    let v = f.pop_i()?;
                    *f.slots
                        .get_mut(idx(imm)?)
                        .ok_or_else(|| Refuse(format!("int slot {imm} oob")))? = v;
                }
                package::LOAD => {
                    let v = *f
                        .slots
                        .get(idx(imm)?)
                        .ok_or_else(|| Refuse(format!("int slot {imm} oob")))?;
                    f.ints.push(v);
                }
                package::CONCAT => {
                    let d = pop_concat(f, imm)?;
                    f.docs.push(d);
                }
                package::BAG_FIELD => {
                    let want = self.pkg.const_at(imm)?;
                    if let Some(n) = f
                        .bag
                        .iter()
                        .copied()
                        .find(|n| n.field.as_deref() == Some(want))
                    {
                        f.nodes.push(n);
                        f.ints.push(1);
                    } else {
                        f.ints.push(0);
                    }
                }
                package::BAG_KIND => {
                    let want = self.pkg.const_at(imm)?;
                    if let Some(n) = f
                        .bag
                        .iter()
                        .copied()
                        .find(|n| n.kind == want && n.text.is_none())
                    {
                        f.nodes.push(n);
                        f.ints.push(1);
                    } else {
                        f.ints.push(0);
                    }
                }
                package::BAG_TOKEN => {
                    let want = self.pkg.const_at(imm)?;
                    let v = f.bag.iter().any(|n| n.is_token(want));
                    f.ints.push(i32::from(v));
                }
                package::BAG_INDEX => {
                    let i = idx(imm)?;
                    if let Some(n) = f.bag.get(i).copied() {
                        f.nodes.push(n);
                        f.ints.push(1);
                    } else {
                        f.ints.push(0);
                    }
                }
                package::BAG_FMT_KIND => {
                    let want = self.pkg.const_at(imm)?;
                    let mut parts = Vec::new();
                    let matches: Vec<&Node> =
                        f.bag.iter().copied().filter(|n| n.kind == want).collect();
                    for n in matches {
                        parts.push(Doc::Hardline);
                        parts.push(self.run(n, Some(f.kind))?);
                    }
                    f.docs.push(if parts.is_empty() {
                        Doc::Concat(vec![])
                    } else {
                        Doc::Concat(parts)
                    });
                }
                package::HOST_CHAIN => {
                    let flags = f.pop_i()?;
                    let d = self.host_chain(f, flags)?;
                    f.docs.push(d);
                }
                package::DSTORE => {
                    let d = f.pop_d()?;
                    *f.dslots
                        .get_mut(idx(imm)?)
                        .ok_or_else(|| Refuse(format!("doc slot {imm} oob")))? = Some(d);
                }
                package::DLOAD => {
                    let d = f
                        .dslots
                        .get(idx(imm)?)
                        .and_then(|s| s.clone())
                        .ok_or_else(|| Refuse(format!("empty doc slot {imm}")))?;
                    f.docs.push(d);
                }
                package::ITEMS_GET => {
                    let i = idx(f.pop_i()?)?;
                    let n = *f
                        .items
                        .get(i)
                        .ok_or_else(|| Refuse(format!("items[{i}] oob")))?;
                    f.nodes.push(n);
                }
                package::BLANK_EXTRA => {
                    let i = idx(f.pop_i()?)?;
                    f.ints.push(self.blank_extra(&f.items, i));
                }
                package::BAG_ONLY_FIELDS => {
                    let n = imm;
                    let mut wanted = Vec::new();
                    for k in 0..n {
                        wanted.push(self.pkg.const_at(code[pc + 2 + k as usize])?);
                    }
                    for node in &f.bag {
                        let field = node.field.as_deref();
                        let ok = field.is_some_and(|fld| wanted.contains(&fld));
                        if !ok && !node.is_punct() {
                            return Err(Refuse(format!(
                                "pfx {}: unexpected {}",
                                f.node.kind, node.kind
                            )));
                        }
                    }
                }
                package::ARG => f.ints.push(arg_at(f, imm)?),
                package::ARGI => {
                    let i = f.pop_i()?;
                    f.ints.push(arg_at(f, i)?);
                }
                package::CTEXT => {
                    let i = f.pop_i()?;
                    f.docs.push(Doc::text(self.pkg.const_at(i)?));
                }
                package::CPEEK => {
                    let i = f.pop_i()?;
                    let want = self.pkg.const_at(i)?;
                    let v = f.kids.get(f.cursor).is_some_and(|n| n.is_token(want));
                    f.ints.push(i32::from(v));
                }
                package::CTOKEN => {
                    let i = f.pop_i()?;
                    let want = self.pkg.const_at(i)?;
                    let n = f.peek_n()?;
                    f.ints.push(i32::from(n.is_token(want)));
                }
                package::CFIELD => {
                    let i = f.pop_i()?;
                    let want = self.pkg.const_at(i)?;
                    let n = f.peek_n()?;
                    f.ints.push(i32::from(n.field.as_deref() == Some(want)));
                }
                package::CBAG_FIELD => {
                    let i = f.pop_i()?;
                    let want = self.pkg.const_at(i)?;
                    if let Some(n) = f
                        .bag
                        .iter()
                        .copied()
                        .find(|n| n.field.as_deref() == Some(want))
                    {
                        f.nodes.push(n);
                        f.ints.push(1);
                    } else {
                        f.ints.push(0);
                    }
                }
                package::CBAG_KIND => {
                    let i = f.pop_i()?;
                    let want = self.pkg.const_at(i)?;
                    if let Some(n) = f
                        .bag
                        .iter()
                        .copied()
                        .find(|n| n.kind == want && n.text.is_none())
                    {
                        f.nodes.push(n);
                        f.ints.push(1);
                    } else {
                        f.ints.push(0);
                    }
                }
                package::CBAG_TOKEN => {
                    let i = f.pop_i()?;
                    let want = self.pkg.const_at(i)?;
                    let v = f.bag.iter().any(|n| n.is_token(want));
                    f.ints.push(i32::from(v));
                }
                package::CBAG_FMT => {
                    let i = f.pop_i()?;
                    let want = self.pkg.const_at(i)?.to_string();
                    let mut parts = Vec::new();
                    let matches: Vec<&Node> =
                        f.bag.iter().copied().filter(|n| n.kind == want).collect();
                    for n in matches {
                        parts.push(Doc::Hardline);
                        parts.push(self.run(n, Some(f.kind))?);
                    }
                    f.docs.push(if parts.is_empty() {
                        Doc::Concat(vec![])
                    } else {
                        Doc::Concat(parts)
                    });
                }
                package::CBAG_ONLY => {
                    let base = idx(imm)?;
                    let n = *f
                        .args
                        .get(base)
                        .ok_or_else(|| Refuse(format!("arg {base} oob")))?;
                    if n < 0 {
                        return Err(Refuse(format!("CBAG_ONLY n<{n}")));
                    }
                    let mut wanted = Vec::new();
                    for k in 0..n {
                        let ci = *f
                            .args
                            .get(base + 1 + k as usize)
                            .ok_or_else(|| Refuse(format!("arg {} oob", base + 1 + k as usize)))?;
                        wanted.push(self.pkg.const_at(ci)?);
                    }
                    for node in &f.bag {
                        let field = node.field.as_deref();
                        let ok = field.is_some_and(|fld| wanted.contains(&fld));
                        if !ok && !node.is_punct() {
                            return Err(Refuse(format!(
                                "pfx {}: unexpected {}",
                                f.node.kind, node.kind
                            )));
                        }
                    }
                }
                other => return Err(Refuse(format!("unknown opcode {other} at {pc}"))),
            }
            pc += len;
        }
    }

    fn take<'f>(&self, f: &mut Frame<'f>, what: &str) -> Result<&'f Node, Refuse> {
        match f.kids.get(f.cursor) {
            Some(n) => {
                f.cursor += 1;
                Ok(*n)
            }
            None => Err(Refuse(format!("expected {what}, found end"))),
        }
    }

    fn finish(&self, f: &Frame<'_>) -> Result<(), Refuse> {
        if let Some(n) = f.kids.get(f.cursor) {
            Err(Refuse(format!("unconsumed {} in {}", n.kind, f.node.kind)))
        } else {
            Ok(())
        }
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
        if let Some(src) = self.source {
            let start = node.start.min(src.len());
            let end = node.end.min(src.len()).max(start);
            if let Ok(s) = std::str::from_utf8(&src[start..end]) {
                return Doc::text(s);
            }
        }
        Doc::text(node.raw_text())
    }

    fn blank_extra(&self, items: &[&Node], i: usize) -> i32 {
        if i == 0 {
            return 0;
        }
        let Some(prev) = items.get(i - 1) else {
            return 0;
        };
        let Some(cur) = items.get(i) else {
            return 0;
        };
        let mut extra = 0usize;
        if let Some(src) = self.source {
            extra = count_blank_lines(src, prev.end, cur.start, self.pkg.blank.max);
        }
        if self.pkg.blank.before_top.iter().any(|t| t == &cur.kind) {
            extra = extra.max(2);
        }
        i32_len(extra)
    }

    fn host_chain(&self, f: &mut Frame<'_>, flags: i32) -> Result<Doc, Refuse> {
        let already_flat = flags & 1 != 0;
        let paren = flags & 2 != 0;
        let parts = if already_flat {
            let mut parts = vec![ChainPart {
                op: None,
                doc: self.run(self.take(f, "operand")?, Some(f.kind))?,
            }];
            while f.cursor < f.kids.len() {
                let op = self.take(f, "op")?;
                let operand = self.take(f, "operand")?;
                parts.push(ChainPart {
                    op: Some(format_op(op)),
                    doc: self.run(operand, Some(f.kind))?,
                });
            }
            self.finish(f)?;
            parts
        } else {
            let op_node = field_child(f.node, "operator");
            let cls = prec_class(&format_op_opt(op_node));
            self.flatten_chain(f.node, cls, f.kind)?
        };
        finish_chain(parts, paren, f.parent_kind)
    }

    fn flatten_chain(&self, node: &Node, cls: u8, kind: &str) -> Result<Vec<ChainPart>, Refuse> {
        if !is_bin_chain(node) {
            return Ok(vec![ChainPart {
                op: None,
                doc: self.run(node, Some(kind))?,
            }]);
        }
        let op_node = field_child(node, "operator");
        let op = format_op_opt(op_node);
        if prec_class(&op) != cls {
            return Ok(vec![ChainPart {
                op: None,
                doc: self.run(node, Some(kind))?,
            }]);
        }
        let left = field_child(node, "left")
            .ok_or_else(|| Refuse(format!("chain {} missing left", node.kind)))?;
        let right = field_child(node, "right")
            .ok_or_else(|| Refuse(format!("chain {} missing right", node.kind)))?;
        let mut head = self.flatten_chain(left, cls, kind)?;
        head.push(ChainPart {
            op: Some(op),
            doc: self.run(right, Some(kind))?,
        });
        Ok(head)
    }

    fn host_from_import(&self, f: &mut Frame<'_>) -> Result<Doc, Refuse> {
        let from_tok = self.take(f, "from")?;
        if !from_tok.is_token("from") {
            return Err(Refuse("from_import: expected from".into()));
        }
        let module = self.take(f, "module")?;
        let import_tok = self.take(f, "import")?;
        if !import_tok.is_token("import") {
            return Err(Refuse("from_import: expected import".into()));
        }
        let mut rest = Vec::new();
        while f.cursor < f.kids.len() {
            rest.push(self.take(f, "name")?);
        }
        self.finish(f)?;

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
            name_docs.push(self.run(n, Some(f.kind))?);
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
            self.run(module, Some(f.kind))?,
            Doc::text(" import "),
            list,
        ]))
    }
}

struct Frame<'a> {
    node: &'a Node,
    parent_kind: Option<&'a str>,
    kind: &'a str,
    kids: Vec<&'a Node>,
    cursor: usize,
    items: Vec<&'a Node>,
    bag: Vec<&'a Node>,
    slots: [i32; 8],
    dslots: [Option<Doc>; 4],
    docs: Vec<Doc>,
    nodes: Vec<&'a Node>,
    ints: Vec<i32>,
    args: Vec<i32>,
}

impl<'a> Frame<'a> {
    fn pop_d(&mut self) -> Result<Doc, Refuse> {
        self.docs
            .pop()
            .ok_or_else(|| Refuse("doc stack empty".into()))
    }
    fn peek_d(&self) -> Result<&Doc, Refuse> {
        self.docs
            .last()
            .ok_or_else(|| Refuse("doc stack empty".into()))
    }
    fn pop_n(&mut self) -> Result<&'a Node, Refuse> {
        self.nodes
            .pop()
            .ok_or_else(|| Refuse("node stack empty".into()))
    }
    fn peek_n(&self) -> Result<&'a Node, Refuse> {
        self.nodes
            .last()
            .copied()
            .ok_or_else(|| Refuse("node stack empty".into()))
    }
    fn pop_i(&mut self) -> Result<i32, Refuse> {
        self.ints
            .pop()
            .ok_or_else(|| Refuse("int stack empty".into()))
    }
    fn peek_i(&self) -> Result<i32, Refuse> {
        self.ints
            .last()
            .copied()
            .ok_or_else(|| Refuse("int stack empty".into()))
    }
}

fn arg_at(f: &Frame<'_>, i: i32) -> Result<i32, Refuse> {
    let i = idx(i)?;
    f.args
        .get(i)
        .copied()
        .ok_or_else(|| Refuse(format!("arg {i} oob")))
}

fn i32_len(n: usize) -> i32 {
    i32::try_from(n).unwrap_or(i32::MAX)
}

fn idx(v: i32) -> Result<usize, Refuse> {
    usize::try_from(v).map_err(|_| Refuse(format!("negative index {v}")))
}

fn pop_n_docs(f: &mut Frame<'_>, n: i32) -> Result<Vec<Doc>, Refuse> {
    let n = idx(n)?;
    if f.docs.len() < n {
        return Err(Refuse("doc stack underflow".into()));
    }
    Ok(f.docs.split_off(f.docs.len() - n))
}

fn pop_concat(f: &mut Frame<'_>, n: i32) -> Result<Doc, Refuse> {
    Ok(Doc::Concat(pop_n_docs(f, n)?))
}

fn append_dangling(doc: Doc, node: &Node) -> Doc {
    if node.dangling.is_empty() {
        return doc;
    }
    let empty = matches!(&doc, Doc::Text(s) if s.is_empty())
        || matches!(&doc, Doc::Concat(v) if v.is_empty());
    let mut parts = if empty { Vec::new() } else { vec![doc] };
    for d in &node.dangling {
        if !parts.is_empty() {
            parts.push(Doc::Hardline);
        }
        parts.push(Doc::text(d.clone()));
    }
    if parts.is_empty() {
        Doc::text("")
    } else {
        Doc::Concat(parts)
    }
}

struct ChainPart {
    op: Option<String>,
    doc: Doc,
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
    if parent_kind == Some("wrap") {
        return inner;
    }
    if matches!(parent_kind, Some("seq") | Some("pfx")) {
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
    paren: bool,
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
    if paren {
        Ok(paren_insert(inner, parent_kind))
    } else {
        Ok(Doc::group(inner))
    }
}

pub fn format_tree(tree: &crate::node::TreeDoc, width: usize) -> Result<String, Refuse> {
    let pkg = crate::package::load(&tree.language)?;
    let mut root = tree.root.clone();
    if pkg.comment_type.is_some() && !tree.source.is_empty() {
        attach_all(
            &mut root,
            tree.source.as_bytes(),
            pkg.comment_type(),
            &pkg.steal_into_body,
        );
    }
    let engine = Engine {
        pkg: &pkg,
        source: Some(tree.source.as_bytes()),
    };
    let body = engine.format_node(&root)?;
    Ok(crate::doc::print(
        &Doc::Concat(vec![body, Doc::Hardline]),
        width,
        pkg.indent,
    ))
}

fn gap_newlines(source: &[u8], from: usize, to: usize) -> usize {
    let from = from.min(source.len());
    let to = to.min(source.len()).max(from);
    source[from..to].iter().filter(|&&b| b == b'\n').count()
}

fn count_blank_lines(source: &[u8], from: usize, to: usize, max: usize) -> usize {
    let from = from.min(source.len());
    let to = to.min(source.len()).max(from);
    let Ok(gap) = std::str::from_utf8(&source[from..to]) else {
        return 0;
    };
    let lines: Vec<&str> = gap.split('\n').collect();
    let blanks = lines
        .iter()
        .skip(1)
        .take(lines.len().saturating_sub(2))
        .filter(|l| l.trim().is_empty())
        .count();
    blanks.min(max)
}

fn classify_comments(node: &mut Node, source: &[u8], comment_type: &str) {
    let n_kids = node.children.len();
    for i in 0..n_kids {
        if node.children[i].kind != comment_type {
            continue;
        }
        let prev = (0..i)
            .rev()
            .find(|&j| node.children[j].kind != comment_type);
        let next = (i + 1..n_kids).find(|&j| node.children[j].kind != comment_type);
        let from = prev.map_or(node.start, |j| node.children[j].end);
        let start = node.children[i].start;
        let nl = gap_newlines(source, from, start);
        let text = node.children[i]
            .text
            .clone()
            .unwrap_or_else(|| node.children[i].raw_text());
        if nl == 0
            && let Some(p) = prev
        {
            let mut owner = p;
            if node.children[p].is_punct()
                && let Some(item) = (0..i).rev().find(|&j| {
                    node.children[j].kind != comment_type && !node.children[j].is_punct()
                })
            {
                owner = item;
            }
            node.children[owner].trailing.push(text);
            continue;
        }
        if let Some(n) = next {
            node.children[n].leading.push(text);
        } else {
            node.dangling.push(text);
        }
    }
}

fn steal_into_body(node: &mut Node, steal: &[String]) {
    if !steal.iter().any(|t| t == &node.kind) {
        return;
    }
    let Some(block_i) = node.children.iter().position(|c| c.kind == "block") else {
        return;
    };
    if node.children[block_i].leading.is_empty() {
        return;
    }
    let stolen = std::mem::take(&mut node.children[block_i].leading);
    let stmt_i = node.children[block_i]
        .children
        .iter()
        .position(|c| c.text.is_none() && c.kind != "comment");
    if let Some(si) = stmt_i {
        let mut lead = stolen;
        lead.extend(std::mem::take(
            &mut node.children[block_i].children[si].leading,
        ));
        node.children[block_i].children[si].leading = lead;
    } else {
        node.children[block_i].dangling.extend(stolen);
    }
}

fn attach_all(node: &mut Node, source: &[u8], comment_type: &str, steal: &[String]) {
    classify_comments(node, source, comment_type);
    for ch in &mut node.children {
        attach_all(ch, source, comment_type, steal);
    }
    steal_into_body(node, steal);
}
