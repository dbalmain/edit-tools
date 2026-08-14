"use strict";

// Layout-kind interpreter. The package names an algorithm per node type;
// this file *is* those algorithms plus a Wadler printer.
//
// Width is Unicode scalar values. Never use String.length — it counts
// UTF-16 code units and disagrees with Rust's chars().count() on astral
// input (gate 1).

const fs = require("fs");
const path = require("path");

const widthOf = (s) => [...s].length;

// ---------------------------------------------------------------- Doc IR

const text = (s) => ({ t: "text", s, brk: false });
const line = { t: "line", brk: false };
const softline = { t: "softline", brk: false };
const hardline = { t: "hardline", brk: true };

const concat = (ds) => ({ t: "concat", d: ds, brk: ds.some((x) => x.brk) });
const indent = (d) => ({ t: "indent", d, brk: d.brk });
const group = (d, opts) => ({
  t: "group",
  d,
  shouldBreak: !!(opts && opts.shouldBreak),
  brk: d.brk,
});
const ifBreak = (a, b) => ({ t: "ifBreak", a, b, brk: false });
const lineSuffix = (d) => ({ t: "lineSuffix", d, brk: false });

function join(sep, docs) {
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    if (i) out.push(sep);
    out.push(docs[i]);
  }
  return concat(out);
}

// ------------------------------------------------------------- printer

function fits(remaining, indentWidth, ind, doc) {
  const stack = [[ind, "flat", doc]];
  let rem = remaining;
  while (stack.length) {
    if (rem < 0) return false;
    const [i, mode, d] = stack.pop();
    switch (d.t) {
      case "text":
        rem -= widthOf(d.s);
        break;
      case "concat":
        for (let k = d.d.length - 1; k >= 0; k--) stack.push([i, mode, d.d[k]]);
        break;
      case "group":
        stack.push([i, d.shouldBreak || d.brk ? "break" : "flat", d.d]);
        break;
      case "indent":
        stack.push([i + indentWidth, mode, d.d]);
        break;
      case "line":
        if (mode === "flat") rem -= 1;
        else return true;
        break;
      case "softline":
        if (mode !== "flat") return true;
        break;
      case "hardline":
        return true;
      case "ifBreak":
        stack.push([i, mode, mode === "break" ? d.a : d.b]);
        break;
      case "lineSuffix":
        break;
      default:
        throw new Error(`unknown doc ${d.t}`);
    }
  }
  return rem >= 0;
}

function printDoc(doc, width, indentWidth) {
  const out = [];
  const suffixes = [];
  const stack = [[0, "break", doc]];
  let pos = 0;

  const newline = (i) => {
    while (suffixes.length) out.push(printFlat(suffixes.shift()));
    out.push("\n" + " ".repeat(i));
    pos = i;
  };

  while (stack.length) {
    const [i, mode, d] = stack.pop();
    switch (d.t) {
      case "text":
        out.push(d.s);
        pos += widthOf(d.s);
        break;
      case "concat":
        for (let k = d.d.length - 1; k >= 0; k--) stack.push([i, mode, d.d[k]]);
        break;
      case "indent":
        stack.push([i + indentWidth, mode, d.d]);
        break;
      case "group": {
        const must = d.shouldBreak || d.brk;
        const flat = !must && fits(width - pos, indentWidth, i, d.d);
        stack.push([i, flat ? "flat" : "break", d.d]);
        break;
      }
      case "line":
        if (mode === "flat") {
          out.push(" ");
          pos += 1;
        } else newline(i);
        break;
      case "softline":
        if (mode !== "flat") newline(i);
        break;
      case "hardline":
        newline(i);
        break;
      case "ifBreak":
        stack.push([i, mode, mode === "break" ? d.a : d.b]);
        break;
      case "lineSuffix":
        suffixes.push(d.d);
        break;
      default:
        throw new Error(`unknown doc ${d.t}`);
    }
  }
  while (suffixes.length) out.push(printFlat(suffixes.shift()));
  return out.join("");
}

// lineSuffix contents are comments: no groups, just text. Flatten without
// consulting width so a suffix never itself tries to break.
function printFlat(doc) {
  switch (doc.t) {
    case "text":
      return doc.s;
    case "concat":
      return doc.d.map(printFlat).join("");
    default:
      throw new Error(`lineSuffix must be text, got ${doc.t}`);
  }
}

// -------------------------------------------------------------- trees

function rawText(node) {
  if (node.text != null) return node.text;
  return (node.children || []).map(rawText).join("");
}

function isPunct(node) {
  if (node.text == null) return false;
  const ch = node.type.charAt(0);
  return !(
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z") ||
    ch === "_"
  );
}

function isToken(node, want) {
  return node.type === want || node.text === want;
}

function nonComments(node, commentType) {
  return (node.children || []).filter((c) => c.type !== commentType);
}

function refuse(msg) {
  const err = new Error(msg);
  err.refuse = true;
  throw err;
}

// Ordered cursor over a node's direct children. Taking past the end, or
// leaving anything behind, is a linearity violation.
function cursor(kids) {
  let i = 0;
  return {
    peek() {
      return i < kids.length ? kids[i] : null;
    },
    done() {
      return i >= kids.length;
    },
    take(what) {
      if (i >= kids.length) refuse(`expected ${what || "child"}, found end`);
      return kids[i++];
    },
    takeIf(pred) {
      if (i < kids.length && pred(kids[i])) return kids[i++];
      return null;
    },
    finish(where) {
      if (i !== kids.length) {
        refuse(`unconsumed ${kids[i].type} in ${where}`);
      }
    },
  };
}

// -------------------------------------------------------------- package

function findPackages() {
  let dir = __dirname;
  for (;;) {
    const cand = path.join(dir, "packages");
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  refuse("packages/ directory not found");
}

const packageCache = new Map();

function loadPackage(language) {
  if (packageCache.has(language)) return packageCache.get(language);
  const file = path.join(findPackages(), `${language}.json`);
  if (!fs.existsSync(file)) refuse(`no package for language ${language}`);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!pkg.nodes) pkg.nodes = {};
  if (!pkg.opaque) pkg.opaque = [];
  if (!pkg.indent) pkg.indent = 2;
  if (!pkg.blank) pkg.blank = {};
  packageCache.set(language, pkg);
  return pkg;
}

// --------------------------------------------------------------- kinds

function kindLeaf(node) {
  if (node.text == null) refuse(`leaf ${node.type} has no text`);
  if (node.children && node.children.length) {
    refuse(`leaf ${node.type} has children`);
  }
  return text(node.text);
}

function kindOpaque(node, _rule, ctx) {
  if (ctx.sourceBytes && node.start != null && node.end != null) {
    return text(ctx.sourceBytes.slice(node.start, node.end).toString("utf8"));
  }
  return text(rawText(node));
}

function kindFwd(node, _rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const interesting = [];
  while (!c.done()) {
    const n = c.take("child");
    if (!isPunct(n)) interesting.push(n);
  }
  c.finish(node.type);
  if (interesting.length > 1) {
    refuse(`fwd ${node.type} has ${interesting.length} significant children`);
  }
  if (interesting.length === 0) return text("");
  return ctx.format(interesting[0]);
}

function kindInfix(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const needle = (rule.op || "").trim();
  const parts = [];
  let opEmit = rule.op || "";
  while (!c.done()) {
    const n = c.take("operand or op");
    const isOp =
      (rule.op_field && n.field === rule.op_field) ||
      (needle && isToken(n, needle));
    if (isOp) {
      if (!rule.op) opEmit = ` ${formatOp(n)} `;
      continue;
    }
    parts.push(ctx.format(n));
  }
  c.finish(node.type);
  if (!parts.length) refuse(`infix ${node.type} has no operands`);
  return join(text(opEmit), parts);
}

function kindSeq(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const open = c.take("open");
  if (!isToken(open, rule.open)) {
    refuse(`seq ${node.type}: expected ${rule.open}, got ${open.type}`);
  }
  if (c.done()) refuse(`seq ${node.type}: missing ${rule.close}`);
  if (isToken(c.peek(), rule.close)) {
    c.take("close");
    c.finish(node.type);
    return text(rule.open + rule.close);
  }

  const items = [];
  let trailingComma = false;
  while (!c.done() && !isToken(c.peek(), rule.close)) {
    if (isToken(c.peek(), rule.sep)) {
      refuse(`seq ${node.type}: unexpected ${rule.sep}`);
    }
    items.push(c.take("item"));
    if (c.done()) refuse(`seq ${node.type}: missing ${rule.close}`);
    if (isToken(c.peek(), rule.sep)) {
      c.take("sep");
      if (!c.done() && isToken(c.peek(), rule.close)) {
        trailingComma = true;
        break;
      }
    } else if (!isToken(c.peek(), rule.close)) {
      refuse(`seq ${node.type}: expected ${rule.sep} or ${rule.close}`);
    }
  }
  if (c.done() || !isToken(c.peek(), rule.close)) {
    refuse(`seq ${node.type}: missing ${rule.close}`);
  }
  c.take("close");
  c.finish(node.type);

  if (trailingComma && rule.trailing === "none") {
    refuse(`seq ${node.type}: trailing ${rule.sep} is forbidden`);
  }

  const pad = rule.flat_pad ? line : softline;
  const sepDoc = concat([text(rule.sep), line]);
  const itemDocs = items.map((n) => ctx.format(n));
  const inner = [pad];
  for (let i = 0; i < itemDocs.length; i++) {
    if (i) inner.push(sepDoc);
    inner.push(itemDocs[i]);
  }
  const singleton = !!(rule.singleton_comma && items.length === 1);
  if (singleton) {
    // The comma is syntactic (`(lonely,)`), not a magic-break hint.
    inner.push(text(rule.sep));
  } else if (rule.trailing === "magic" || rule.trailing === "always-on-break") {
    inner.push(ifBreak(text(rule.sep), text("")));
  }

  return group(
    concat([text(rule.open), indent(concat(inner)), pad, text(rule.close)]),
    { shouldBreak: rule.trailing === "magic" && trailingComma && !singleton },
  );
}

function kindPfx(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  if (rule.fields && rule.fields.length) {
    const wanted = rule.fields;
    const byField = Object.create(null);
    while (!c.done()) {
      const n = c.take("child");
      if (n.field && wanted.indexOf(n.field) !== -1) {
        byField[n.field] = n;
      } else if (!isPunct(n)) {
        refuse(`pfx ${node.type}: unexpected ${n.type}`);
      }
    }
    c.finish(node.type);
    return concat(
      wanted.filter((f) => byField[f]).map((f) => ctx.format(byField[f])),
    );
  }

  let opText;
  if (rule.kw != null) {
    const kw = c.take("kw");
    if (!isToken(kw, rule.kw)) {
      refuse(`pfx ${node.type}: expected ${rule.kw}, got ${kw.type}`);
    }
    opText = rule.kw;
  } else if (rule.op_field) {
    const op = c.take("op");
    opText = rawText(op);
  } else {
    refuse(`pfx ${node.type}: need kw, op_field, or fields`);
  }
  const rest = [];
  while (!c.done()) rest.push(c.take("operand"));
  c.finish(node.type);
  const sp = rule.sp && rest.length ? " " : "";
  let doc = concat([text(opText + sp), ...rest.map((n) => ctx.format(n))]);
  if (rule.paren) doc = parenInsert(doc, ctx);
  return doc;
}

function kindWrap(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const open = c.take("open");
  if (!isToken(open, rule.open)) {
    refuse(`wrap ${node.type}: expected ${rule.open}`);
  }
  const inner = c.take("inner");
  const close = c.take("close");
  if (!isToken(close, rule.close)) {
    refuse(`wrap ${node.type}: expected ${rule.close}`);
  }
  c.finish(node.type);
  return group(
    concat([
      text(rule.open),
      indent(concat([softline, ctx.format(inner)])),
      softline,
      text(rule.close),
    ]),
  );
}

function formatOp(node) {
  if (!node) return "";
  if (node.text != null) return node.text;
  const leaves = [];
  (function walk(n) {
    if (n.text != null) leaves.push(n.text);
    else (n.children || []).forEach(walk);
  })(node);
  return leaves.join(" ");
}

function precClass(op) {
  switch (op) {
    case "or":
      return 1;
    case "and":
      return 2;
    case "|":
      return 4;
    case "^":
      return 5;
    case "&":
      return 6;
    case "<<":
    case ">>":
      return 7;
    case "+":
    case "-":
      return 8;
    case "*":
    case "/":
    case "//":
    case "%":
    case "@":
      return 9;
    case "**":
      return 10;
    default:
      return 3;
  }
}

function isBinChain(node) {
  return node.type === "binary_operator" || node.type === "boolean_operator";
}

function fieldChild(node, name) {
  return (node.children || []).find((c) => c.field === name) || null;
}

function flattenChain(node, cls, ctx) {
  if (!isBinChain(node)) return [{ op: null, doc: ctx.format(node) }];
  const opNode = fieldChild(node, "operator");
  const op = formatOp(opNode);
  if (precClass(op) !== cls) return [{ op: null, doc: ctx.format(node) }];
  const left = fieldChild(node, "left");
  const right = fieldChild(node, "right");
  if (!left || !right) refuse(`chain ${node.type} missing operands`);
  const head = flattenChain(left, cls, ctx);
  head.push({ op, doc: ctx.format(right) });
  return head;
}

function parenInsert(inner, ctx) {
  const pk = ctx.parentKind;
  // wrap already supplies the group+parens. A nested group would stay
  // flat inside a broken wrap (pass 2 hugs; pass 1 exploded). Share mode.
  if (pk === "wrap") return inner;
  if (pk === "seq" || pk === "pfx") return group(inner);
  return group(
    concat([
      ifBreak(text("("), text("")),
      indent(concat([softline, inner])),
      softline,
      ifBreak(text(")"), text("")),
    ]),
  );
}

function finishChain(parts, rule, ctx) {
  const docs = [parts[0].doc];
  for (let i = 1; i < parts.length; i++) {
    docs.push(line);
    docs.push(text(parts[i].op + " "));
    docs.push(parts[i].doc);
  }
  const inner = concat(docs);
  if (rule.break === "paren") return parenInsert(inner, ctx);
  return group(inner);
}

function kindChain(node, rule, ctx) {
  if (rule.already_flat) {
    const c = cursor(nonComments(node, ctx.commentType));
    const parts = [{ op: null, doc: ctx.format(c.take("operand")) }];
    while (!c.done()) {
      const op = c.take("op");
      const operand = c.take("operand");
      parts.push({ op: formatOp(op), doc: ctx.format(operand) });
    }
    c.finish(node.type);
    return finishChain(parts, rule, ctx);
  }
  const c = cursor(nonComments(node, ctx.commentType));
  while (!c.done()) c.take("child");
  c.finish(node.type);
  const opNode = fieldChild(node, "operator");
  const cls = precClass(formatOp(opNode));
  return finishChain(flattenChain(node, cls, ctx), rule, ctx);
}

function kindBody(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const stmts = [];
  while (!c.done()) stmts.push(c.take("stmt"));
  c.finish(node.type);
  const dangling = node.dangling || [];
  if (!stmts.length && !dangling.length) return text("");
  const beforeTop = new Set((ctx.pkg.blank && ctx.pkg.blank.before_top) || []);
  const docs = [];
  for (let i = 0; i < stmts.length; i++) {
    if (i) {
      docs.push(hardline);
      if (!(rule && rule.tight) && beforeTop.has(stmts[i].type)) {
        docs.push(hardline);
        docs.push(hardline);
      }
    }
    docs.push(ctx.format(stmts[i]));
  }
  for (const d of dangling) {
    if (docs.length) docs.push(hardline);
    docs.push(text(d));
  }
  return concat(docs);
}

const KINDS = {
  leaf: kindLeaf,
  opaque: kindOpaque,
  fwd: kindFwd,
  infix: kindInfix,
  seq: kindSeq,
  body: kindBody,
  pfx: kindPfx,
  wrap: kindWrap,
  chain: kindChain,
  comp: kindComp,
  template: kindTemplate,
  dot: kindDot,
  sub: kindSub,
  from_import: kindFromImport,
  clause: kindClause,
};

function kindClause(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const all = [];
  while (!c.done()) all.push(c.take("child"));
  c.finish(node.type);
  const byField = Object.create(null);
  for (const n of all) {
    if (n.field) byField[n.field] = n;
  }
  const kw = rule.keyword || "";
  const header = rule.header || [];
  const docs = [text(kw + (header.length ? " " : ""))];
  for (const h of header) {
    const fieldNode = all.find((n) => n.field === h);
    const typeNode = all.find((n) => n.type === h);
    if (fieldNode) {
      docs.push(ctx.format(fieldNode));
    } else if (typeNode && typeNode.text == null) {
      docs.push(ctx.format(typeNode));
    } else {
      const tok = all.find((n) => isToken(n, h));
      if (tok) docs.push(text(" " + h + " "));
    }
  }
  if (rule.arrow && byField[rule.arrow]) {
    docs.push(text(" -> "));
    docs.push(ctx.format(byField[rule.arrow]));
  }
  if (rule.colon) docs.push(text(":"));
  let body = rule.body ? byField[rule.body] : null;
  if (!body) body = all.find((n) => n.type === "block");
  if (body) {
    docs.push(indent(concat([hardline, ctx.format(body)])));
  }
  for (const t of rule.tails || []) {
    for (const n of all.filter((n) => n.type === t)) {
      docs.push(hardline);
      docs.push(ctx.format(n));
    }
  }
  return concat(docs);
}

function kindFromImport(node, _rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const fromTok = c.take("from");
  if (!isToken(fromTok, "from")) refuse(`from_import: expected from`);
  const mod = c.take("module");
  const importTok = c.take("import");
  if (!isToken(importTok, "import")) refuse(`from_import: expected import`);
  const rest = [];
  while (!c.done()) rest.push(c.take("name"));
  c.finish(node.type);

  const names = rest.filter((n) => n.field === "name" || (!isPunct(n) && n.type !== "(" && n.type !== ")"));
  let trailingComma = false;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (isToken(rest[i], ")")) continue;
    trailingComma = isToken(rest[i], ",");
    break;
  }
  const hasParens = rest.some((n) => isToken(n, "("));
  const nameDocs = names.map((n) => ctx.format(n));
  const sepDoc = concat([text(","), line]);
  const inner = [softline];
  for (let i = 0; i < nameDocs.length; i++) {
    if (i) inner.push(sepDoc);
    inner.push(nameDocs[i]);
  }
  inner.push(ifBreak(text(","), text("")));
  const list = group(
    concat([
      hasParens ? text("(") : ifBreak(text("("), text("")),
      indent(concat(inner)),
      softline,
      hasParens ? text(")") : ifBreak(text(")"), text("")),
    ]),
    { shouldBreak: trailingComma },
  );
  return concat([text("from "), ctx.format(mod), text(" import "), list]);
}

function kindComp(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const open = c.take("open");
  if (!isToken(open, rule.open)) {
    refuse(`comp ${node.type}: expected ${rule.open}`);
  }
  const parts = [];
  while (!c.done() && !isToken(c.peek(), rule.close)) {
    parts.push(c.take("part"));
  }
  if (c.done() || !isToken(c.peek(), rule.close)) {
    refuse(`comp ${node.type}: missing ${rule.close}`);
  }
  c.take("close");
  c.finish(node.type);
  const docs = [softline];
  for (let i = 0; i < parts.length; i++) {
    if (i) docs.push(line);
    docs.push(ctx.format(parts[i]));
  }
  return group(
    concat([
      text(rule.open),
      indent(concat(docs)),
      softline,
      text(rule.close),
    ]),
  );
}

function kindDot(node, _rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const docs = [];
  while (!c.done()) {
    const n = c.take("part");
    if (n.text != null && isPunct(n)) docs.push(text(n.text));
    else docs.push(ctx.format(n));
  }
  c.finish(node.type);
  let doc = concat(docs);
  if (_rule && _rule.paren) doc = parenInsert(doc, ctx);
  return doc;
}

function kindSub(node, _rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const obj = c.take("obj");
  const open = c.take("[");
  if (!isToken(open, "[")) refuse(`sub ${node.type}: expected [`);
  const index = c.take("index");
  const close = c.take("]");
  if (!isToken(close, "]")) refuse(`sub ${node.type}: expected ]`);
  c.finish(node.type);
  return concat([
    ctx.format(obj),
    group(
      concat([
        text("["),
        indent(concat([softline, ctx.format(index)])),
        softline,
        text("]"),
      ]),
    ),
  ]);
}

function holeNodes(spec, all, byField) {
  if (spec === "$children") return all.filter((n) => !isPunct(n));
  if (typeof spec === "string" && spec.charAt(0) === "$") {
    const name = spec.slice(1);
    if (/^\d+$/.test(name)) {
      const n = all[Number(name)];
      return n ? [n] : [];
    }
    const matches = all.filter((n) => n.field === name);
    if (matches.length) return matches;
    return byField[name] ? [byField[name]] : [];
  }
  return null;
}

function kindTemplate(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const all = [];
  while (!c.done()) all.push(c.take("child"));
  c.finish(node.type);
  const byField = Object.create(null);
  for (const n of all) {
    if (n.field) byField[n.field] = n;
  }

  function evalDoc(spec) {
    if (typeof spec === "string") {
      const nodes = holeNodes(spec, all, byField);
      if (nodes) return concat(nodes.map((n) => ctx.format(n)));
      return text(spec);
    }
    if (Array.isArray(spec)) return concat(spec.map(evalDoc));
    if (spec && spec.join) {
      const items = holeNodes(spec.join.items, all, byField) || [];
      return join(
        text(spec.join.sep),
        items.map((n) => ctx.format(n)),
      );
    }
    refuse(`bad template in ${node.type}`);
  }

  let doc = evalDoc(rule.doc);
  if (rule.paren) doc = parenInsert(doc, ctx);
  return doc;
}

function defaultKind(node, pkg) {
  if (pkg.opaque.indexOf(node.type) !== -1) return "opaque";
  if (node.text != null) return "leaf";
  return "fwd";
}

function formatNode(node, ctx) {
  const rule = ctx.pkg.nodes[node.type];
  const kind = rule ? rule.kind : defaultKind(node, ctx.pkg);
  const impl = KINDS[kind];
  if (!impl) refuse(`unknown kind ${kind} for ${node.type}`);
  const selfCtx = Object.assign({}, ctx);
  selfCtx.format = (n) =>
    formatNode(n, Object.assign({}, ctx, { parentKind: kind }));
  let doc = impl(node, rule || {}, selfCtx);
  if (node.leading && node.leading.length) {
    const parts = [];
    for (const c of node.leading) {
      parts.push(text(c));
      parts.push(hardline);
    }
    parts.push(doc);
    doc = concat(parts);
  }
  if (node.trailing && node.trailing.length) {
    for (const c of node.trailing) {
      doc = concat([doc, lineSuffix(text("  " + c))]);
    }
  }
  return doc;
}

// ---------------------------------------------------------------- public

function format(tree, width) {
  if (!tree || !tree.language) refuse("tree is missing language");
  const pkg = loadPackage(tree.language);
  const commentType = pkg.comment_type || "\0";
  if (pkg.comment_type && tree.source != null) {
    attachAll(tree.root, Buffer.from(tree.source, "utf8"), commentType, new Set(pkg.steal_into_body || []));
  }
  const ctx = {
    pkg,
    commentType,
    sourceBytes: tree.source != null ? Buffer.from(tree.source, "utf8") : null,
    format(n) {
      return formatNode(n, ctx);
    },
  };
  const body = formatNode(tree.root, ctx);
  return printDoc(concat([body, hardline]), width, pkg.indent);
}

function gapNewlines(sourceBytes, from, to) {
  const gap = sourceBytes.slice(from, to).toString("utf8");
  return (gap.match(/\n/g) || []).length;
}

function classifyComments(node, sourceBytes, commentType) {
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.type !== commentType) continue;
    let prev = null;
    let next = null;
    for (let j = i - 1; j >= 0; j--) {
      if (kids[j].type !== commentType) {
        prev = kids[j];
        break;
      }
    }
    for (let j = i + 1; j < kids.length; j++) {
      if (kids[j].type !== commentType) {
        next = kids[j];
        break;
      }
    }
    const from = prev ? prev.end : node.start;
    const nl = gapNewlines(sourceBytes, from, c.start);
    const textC = c.text || rawText(c);
    if (nl === 0 && prev) {
      let owner = prev;
      if (isPunct(owner)) {
        for (let j = i - 1; j >= 0; j--) {
          if (kids[j].type !== commentType && !isPunct(kids[j])) {
            owner = kids[j];
            break;
          }
        }
      }
      (owner.trailing = owner.trailing || []).push(textC);
    } else if (next) {
      (next.leading = next.leading || []).push(textC);
    } else {
      (node.dangling = node.dangling || []).push(textC);
    }
  }
}

function stealIntoBody(node, stealSet) {
  if (!stealSet.has(node.type)) return;
  const block = (node.children || []).find((c) => c.type === "block");
  if (!block || !(block.leading && block.leading.length)) return;
  const stolen = block.leading;
  block.leading = [];
  const stmts = (block.children || []).filter((c) => c.text == null && c.type !== "comment");
  if (stmts.length) {
    stmts[0].leading = stolen.concat(stmts[0].leading || []);
  } else {
    block.dangling = stolen.concat(block.dangling || []);
  }
}

function attachAll(node, sourceBytes, commentType, stealSet) {
  classifyComments(node, sourceBytes, commentType);
  for (const ch of node.children || []) {
    attachAll(ch, sourceBytes, commentType, stealSet);
  }
  stealIntoBody(node, stealSet);
}

module.exports = {
  format,
  text,
  concat,
  group,
  indent,
  line,
  softline,
  hardline,
  ifBreak,
  lineSuffix,
  printDoc,
  widthOf,
};
