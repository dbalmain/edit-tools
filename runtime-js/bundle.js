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

function kindOpaque(node) {
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
  while (!c.done()) {
    const n = c.take("operand or op");
    const isOp =
      (rule.op_field && n.field === rule.op_field) ||
      (needle && isToken(n, needle));
    if (isOp) continue;
    parts.push(ctx.format(n));
  }
  c.finish(node.type);
  if (!parts.length) refuse(`infix ${node.type} has no operands`);
  return join(text(rule.op), parts);
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

function kindBody(node, rule, ctx) {
  const c = cursor(nonComments(node, ctx.commentType));
  const stmts = [];
  while (!c.done()) stmts.push(c.take("stmt"));
  c.finish(node.type);
  if (!stmts.length) return text("");
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
  return concat(docs);
}

const KINDS = {
  leaf: kindLeaf,
  opaque: kindOpaque,
  fwd: kindFwd,
  infix: kindInfix,
  seq: kindSeq,
  body: kindBody,
};

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
  return impl(node, rule || {}, ctx);
}

// ---------------------------------------------------------------- public

function format(tree, width) {
  if (!tree || !tree.language) refuse("tree is missing language");
  const pkg = loadPackage(tree.language);
  const ctx = {
    pkg,
    commentType: pkg.comment_type || "\0",
    format(n) {
      return formatNode(n, ctx);
    },
  };
  const body = formatNode(tree.root, ctx);
  return printDoc(concat([body, hardline]), width, pkg.indent);
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
