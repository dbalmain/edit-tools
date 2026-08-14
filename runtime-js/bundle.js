"use strict";

// Bytecode interpreter plus a Wadler printer. Width is Unicode scalar
// values. Never use String.length — it counts UTF-16 code units and
// disagrees with Rust's chars().count() on astral input (gate 1).

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

function i32(n) {
  return n | 0;
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
  verify(pkg);
  packageCache.set(language, pkg);
  return pkg;
}

// Opcode numbers — lockstep with tools/opcodes.js and rust/src/package.rs.
const OP = {
  HALT: 0,
  TAKE: 1,
  SKIP: 2,
  FINISH: 3,
  EMPTY: 4,
  PEEK_PUNCT: 5,
  NODE_PUNCT: 6,
  DROP_N: 7,
  DUP_N: 8,
  DROP_D: 9,
  DUP_D: 10,
  DROP_I: 11,
  DUP_I: 12,
  NOT: 13,
  LEAF: 14,
  OPAQUE: 15,
  LINE: 16,
  SOFTLINE: 17,
  HARDLINE: 18,
  GROUP: 19,
  INDENT: 20,
  IF_BREAK: 21,
  FORMAT: 22,
  NODE_TEXT: 23,
  FORMAT_OP: 24,
  ITEMS_NEW: 25,
  ITEMS_PUSH: 26,
  ITEMS_LEN: 27,
  ITEMS_FORMAT: 28,
  CONCAT_DYN: 29,
  JOIN_DYN: 30,
  PAREN: 31,
  TAKE_ALL: 32,
  EQ: 33,
  LT: 34,
  ADD: 35,
  SUB: 36,
  APPEND_DANGLING: 37,
  SWAP_D: 38,
  GROUP_BREAK: 39,
  HOST_FROM_IMPORT: 40,
  NODE_RAW: 41,
  BAG_LEN: 42,
  BAG_GET: 43,
  JZ: 50,
  JMP: 51,
  JNZ: 52,
  PUSH_I: 53,
  TEXT: 54,
  REFUSE: 55,
  PEEK_TOKEN: 56,
  NODE_TOKEN: 57,
  NODE_FIELD: 58,
  NODE_KIND: 59,
  STORE: 60,
  LOAD: 61,
  CONCAT: 62,
  BAG_FIELD: 63,
  BAG_KIND: 64,
  BAG_TOKEN: 65,
  BAG_INDEX: 66,
  BAG_FMT_KIND: 67,
  HOST_CHAIN: 68,
  DSTORE: 69,
  DLOAD: 70,
  ITEMS_GET: 71,
  BLANK_EXTRA: 72,
  BAG_ONLY_FIELDS: 80,
  ARG: 81,
  ARGI: 82,
  CTEXT: 83,
  CPEEK: 84,
  CTOKEN: 85,
  CFIELD: 86,
  CBAG_FIELD: 87,
  CBAG_KIND: 88,
  CBAG_TOKEN: 89,
  CBAG_FMT: 90,
  CBAG_ONLY: 91,
};

const HAS_IMM = new Set([
  OP.JZ, OP.JMP, OP.JNZ, OP.PUSH_I, OP.TEXT, OP.REFUSE, OP.PEEK_TOKEN,
  OP.NODE_TOKEN, OP.NODE_FIELD, OP.NODE_KIND, OP.STORE, OP.LOAD, OP.CONCAT,
  OP.BAG_FIELD, OP.BAG_KIND, OP.BAG_TOKEN, OP.BAG_INDEX, OP.BAG_FMT_KIND,
  OP.DSTORE, OP.DLOAD, OP.ARG, OP.CBAG_ONLY,
]);

const KNOWN = new Set(Object.values(OP));

function opLen(op, code, pc) {
  if (op === OP.BAG_ONLY_FIELDS) {
    const n = code[pc + 1];
    if (n == null || n < 0) refuse(`truncated BAG_ONLY_FIELDS at ${pc}`);
    return 2 + n;
  }
  return HAS_IMM.has(op) ? 2 : 1;
}

function cst(pkg, idx) {
  if (idx < 0 || idx >= pkg.consts.length) refuse(`const ${idx} oob`);
  return pkg.consts[idx];
}

function verify(pkg) {
  const code = pkg.code || [];
  if (!code.length) refuse("empty code section");
  const starts = new Set();
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc];
    if (!KNOWN.has(op)) refuse(`unknown opcode ${op} at ${pc}`);
    const len = opLen(op, code, pc);
    if (pc + len > code.length) refuse(`truncated op ${op} at ${pc}`);
    if (
      op === OP.TEXT || op === OP.REFUSE || op === OP.PEEK_TOKEN ||
      op === OP.NODE_TOKEN || op === OP.NODE_FIELD || op === OP.NODE_KIND ||
      op === OP.BAG_FIELD || op === OP.BAG_KIND || op === OP.BAG_TOKEN ||
      op === OP.BAG_FMT_KIND
    ) {
      cst(pkg, code[pc + 1]);
    }
    if (op === OP.STORE || op === OP.LOAD) {
      const s = code[pc + 1];
      if (s < 0 || s > 7) refuse(`int slot ${s} oob at ${pc}`);
    }
    if (op === OP.DSTORE || op === OP.DLOAD) {
      const s = code[pc + 1];
      if (s < 0 || s > 3) refuse(`doc slot ${s} oob at ${pc}`);
    }
    if (op === OP.CONCAT && code[pc + 1] < 0) refuse(`CONCAT n<0 at ${pc}`);
    if ((op === OP.ARG || op === OP.CBAG_ONLY) && code[pc + 1] < 0) {
      refuse(`negative arg index at ${pc}`);
    }
    if (op === OP.BAG_ONLY_FIELDS) {
      const n = code[pc + 1];
      for (let k = 0; k < n; k++) cst(pkg, code[pc + 2 + k]);
    }
    starts.add(pc);
    pc += len;
  }
  pc = 0;
  while (pc < code.length) {
    const op = code[pc];
    const len = opLen(op, code, pc);
    if (op === OP.JZ || op === OP.JMP || op === OP.JNZ) {
      const t = code[pc + 1];
      if (t < 0 || !starts.has(t)) refuse(`bad jump ${t} at ${pc}`);
    }
    pc += len;
  }
  const defaults = pkg.defaults || {};
  for (const [name, entry] of Object.entries(pkg.entry || {})) {
    if (!starts.has(entry)) refuse(`entry ${name} pc ${entry} not an op`);
  }
  for (const [label, p] of [
    ["defaults.leaf", defaults.leaf],
    ["defaults.opaque", defaults.opaque],
    ["defaults.fwd", defaults.fwd],
  ]) {
    if (!starts.has(p)) refuse(`${label} pc ${p} not an op`);
  }
  const roots = Object.values(pkg.entry || {});
  roots.push(defaults.leaf, defaults.opaque, defaults.fwd);
  for (const root of roots) checkHalts(code, starts, root);
}

function checkHalts(code, starts, root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const pc = stack.pop();
    if (seen.has(pc)) continue;
    seen.add(pc);
    if (pc >= code.length || !starts.has(pc)) refuse(`fall off code at ${pc}`);
    const op = code[pc];
    const len = opLen(op, code, pc);
    if (op === OP.HALT || op === OP.REFUSE) continue;
    if (op === OP.JMP) stack.push(code[pc + 1]);
    else if (op === OP.JZ || op === OP.JNZ) {
      stack.push(code[pc + 1]);
      stack.push(pc + len);
    } else stack.push(pc + len);
  }
}

// ---------------------------------------------------------------- VM

function popD(f) {
  if (!f.docs.length) refuse("doc stack empty");
  return f.docs.pop();
}
function popN(f) {
  if (!f.nodes.length) refuse("node stack empty");
  return f.nodes.pop();
}
function popI(f) {
  if (!f.ints.length) refuse("int stack empty");
  return f.ints.pop();
}
function peekN(f) {
  if (!f.nodes.length) refuse("node stack empty");
  return f.nodes[f.nodes.length - 1];
}
function popDocs(f, n) {
  if (n < 0 || f.docs.length < n) refuse("doc stack underflow");
  return f.docs.splice(f.docs.length - n, n);
}

function take(f, what) {
  if (f.cursor >= f.kids.length) refuse(`expected ${what}, found end`);
  return f.kids[f.cursor++];
}

function finish(f) {
  if (f.cursor < f.kids.length) {
    refuse(`unconsumed ${f.kids[f.cursor].type} in ${f.node.type}`);
  }
}

function kindLeaf(node) {
  if (node.text == null) refuse(`leaf ${node.type} has no text`);
  if (node.children && node.children.length) {
    refuse(`leaf ${node.type} has children`);
  }
  return text(node.text);
}

function kindOpaque(node, sourceBytes) {
  if (sourceBytes && node.start != null && node.end != null) {
    return text(sourceBytes.slice(node.start, node.end).toString("utf8"));
  }
  return text(rawText(node));
}

function isEmptyDoc(d) {
  return (d.t === "text" && d.s === "") || (d.t === "concat" && d.d.length === 0);
}

function appendDangling(doc, node) {
  const dangling = node.dangling || [];
  if (!dangling.length) return doc;
  const parts = isEmptyDoc(doc) ? [] : [doc];
  for (const d of dangling) {
    if (parts.length) parts.push(hardline);
    parts.push(text(d));
  }
  return parts.length ? concat(parts) : text("");
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
    case "or": return 1;
    case "and": return 2;
    case "|": return 4;
    case "^": return 5;
    case "&": return 6;
    case "<<":
    case ">>": return 7;
    case "+":
    case "-": return 8;
    case "*":
    case "/":
    case "//":
    case "%":
    case "@": return 9;
    case "**": return 10;
    default: return 3;
  }
}

function isBinChain(node) {
  return node.type === "binary_operator" || node.type === "boolean_operator";
}

function fieldChild(node, name) {
  return (node.children || []).find((c) => c.field === name) || null;
}

function parenInsert(inner, parentKind) {
  if (parentKind === "wrap") return inner;
  if (parentKind === "seq" || parentKind === "pfx") return group(inner);
  return group(
    concat([
      ifBreak(text("("), text("")),
      indent(concat([softline, inner])),
      softline,
      ifBreak(text(")"), text("")),
    ]),
  );
}

function finishChain(parts, paren, parentKind) {
  if (!parts.length) refuse("empty chain");
  const docs = [parts[0].doc];
  for (let i = 1; i < parts.length; i++) {
    docs.push(line);
    docs.push(text((parts[i].op || "") + " "));
    docs.push(parts[i].doc);
  }
  const inner = concat(docs);
  return paren ? parenInsert(inner, parentKind) : group(inner);
}

function entryFor(pkg, node) {
  if (pkg.entry && pkg.entry[node.type] != null) {
    return {
      pc: pkg.entry[node.type],
      kind: (pkg.kinds && pkg.kinds[node.type]) || "fwd",
      args: (pkg.args && pkg.args[node.type]) || [],
    };
  }
  const opaque = (pkg.opaque || []).indexOf(node.type) !== -1;
  if (opaque) return { pc: pkg.defaults.opaque, kind: "opaque", args: [] };
  if (node.text != null) return { pc: pkg.defaults.leaf, kind: "leaf", args: [] };
  return { pc: pkg.defaults.fwd, kind: "fwd", args: [] };
}

function argAt(f, i) {
  if (i < 0 || i >= f.args.length) refuse(`arg ${i} oob`);
  return f.args[i] | 0;
}

function run(node, ctx, parentKind) {
  const { pc: start, kind, args } = entryFor(ctx.pkg, node);
  const f = {
    node,
    parentKind,
    kind,
    kids: nonComments(node, ctx.commentType),
    cursor: 0,
    items: [],
    bag: [],
    slots: [0, 0, 0, 0, 0, 0, 0, 0],
    dslots: [null, null, null, null],
    docs: [],
    nodes: [],
    ints: [],
    args,
  };
  let doc = exec(f, start, ctx);
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

function countBlankLines(sourceBytes, from, to, max) {
  const gap = sourceBytes.slice(from, to).toString("utf8");
  const lines = gap.split("\n");
  let blanks = 0;
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i].trim() === "") blanks++;
  }
  return Math.min(max, blanks);
}

function blankExtra(ctx, items, i) {
  if (i === 0 || !items[i] || !items[i - 1]) return 0;
  let extra = 0;
  if (ctx.sourceBytes) {
    extra = countBlankLines(
      ctx.sourceBytes,
      items[i - 1].end,
      items[i].start,
      (ctx.pkg.blank && ctx.pkg.blank.max) || 0,
    );
  }
  const before = (ctx.pkg.blank && ctx.pkg.blank.before_top) || [];
  if (before.indexOf(items[i].type) !== -1) extra = Math.max(extra, 2);
  return i32(extra);
}

function flattenChain(node, cls, ctx, kind) {
  if (!isBinChain(node)) return [{ op: null, doc: run(node, ctx, kind) }];
  const opNode = fieldChild(node, "operator");
  const op = formatOp(opNode);
  if (precClass(op) !== cls) return [{ op: null, doc: run(node, ctx, kind) }];
  const left = fieldChild(node, "left");
  const right = fieldChild(node, "right");
  if (!left || !right) refuse(`chain ${node.type} missing operands`);
  const head = flattenChain(left, cls, ctx, kind);
  head.push({ op, doc: run(right, ctx, kind) });
  return head;
}

function hostChain(f, flags, ctx) {
  const alreadyFlat = (flags & 1) !== 0;
  const paren = (flags & 2) !== 0;
  let parts;
  if (alreadyFlat) {
    parts = [{ op: null, doc: run(take(f, "operand"), ctx, f.kind) }];
    while (f.cursor < f.kids.length) {
      const op = take(f, "op");
      const operand = take(f, "operand");
      parts.push({ op: formatOp(op), doc: run(operand, ctx, f.kind) });
    }
    finish(f);
  } else {
    const opNode = fieldChild(f.node, "operator");
    const cls = precClass(formatOp(opNode));
    parts = flattenChain(f.node, cls, ctx, f.kind);
  }
  return finishChain(parts, paren, f.parentKind);
}

function hostFromImport(f, ctx) {
  const fromTok = take(f, "from");
  if (!isToken(fromTok, "from")) refuse("from_import: expected from");
  const mod = take(f, "module");
  const importTok = take(f, "import");
  if (!isToken(importTok, "import")) refuse("from_import: expected import");
  const rest = [];
  while (f.cursor < f.kids.length) rest.push(take(f, "name"));
  finish(f);

  const names = rest.filter(
    (n) => n.field === "name" || (!isPunct(n) && n.type !== "(" && n.type !== ")"),
  );
  let trailingComma = false;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (isToken(rest[i], ")")) continue;
    trailingComma = isToken(rest[i], ",");
    break;
  }
  const hasParens = rest.some((n) => isToken(n, "("));
  const nameDocs = names.map((n) => run(n, ctx, f.kind));
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
  return concat([text("from "), run(mod, ctx, f.kind), text(" import "), list]);
}

function exec(f, start, ctx) {
  const code = ctx.pkg.code;
  let pc = start;
  for (;;) {
    const op = code[pc];
    if (op == null) refuse(`pc ${pc} oob`);
    const len = opLen(op, code, pc);
    const imm = len >= 2 ? code[pc + 1] : 0;
    switch (op) {
      case OP.HALT:
        finish(f);
        return popD(f);
      case OP.TAKE:
        f.nodes.push(take(f, "child"));
        break;
      case OP.SKIP:
        take(f, "child");
        break;
      case OP.FINISH:
        finish(f);
        break;
      case OP.EMPTY:
        f.ints.push(f.cursor >= f.kids.length ? 1 : 0);
        break;
      case OP.PEEK_PUNCT:
        f.ints.push(f.cursor < f.kids.length && isPunct(f.kids[f.cursor]) ? 1 : 0);
        break;
      case OP.NODE_PUNCT:
        f.ints.push(isPunct(peekN(f)) ? 1 : 0);
        break;
      case OP.DROP_N:
        popN(f);
        break;
      case OP.DUP_N:
        f.nodes.push(peekN(f));
        break;
      case OP.DROP_D:
        popD(f);
        break;
      case OP.DUP_D:
        if (!f.docs.length) refuse("doc stack empty");
        f.docs.push(f.docs[f.docs.length - 1]);
        break;
      case OP.DROP_I:
        popI(f);
        break;
      case OP.DUP_I:
        if (!f.ints.length) refuse("int stack empty");
        f.ints.push(f.ints[f.ints.length - 1]);
        break;
      case OP.NOT:
        f.ints.push(popI(f) === 0 ? 1 : 0);
        break;
      case OP.LEAF:
        f.docs.push(kindLeaf(f.node));
        break;
      case OP.OPAQUE:
        f.docs.push(kindOpaque(f.node, ctx.sourceBytes));
        break;
      case OP.LINE:
        f.docs.push(line);
        break;
      case OP.SOFTLINE:
        f.docs.push(softline);
        break;
      case OP.HARDLINE:
        f.docs.push(hardline);
        break;
      case OP.GROUP:
        f.docs.push(group(popD(f)));
        break;
      case OP.INDENT:
        f.docs.push(indent(popD(f)));
        break;
      case OP.IF_BREAK: {
        const flat = popD(f);
        const broken = popD(f);
        f.docs.push(ifBreak(broken, flat));
        break;
      }
      case OP.FORMAT:
        f.docs.push(run(popN(f), ctx, f.kind));
        break;
      case OP.NODE_TEXT:
        f.docs.push(text(popN(f).text || ""));
        break;
      case OP.FORMAT_OP:
        f.docs.push(text(formatOp(popN(f))));
        break;
      case OP.NODE_RAW:
        f.docs.push(text(rawText(popN(f))));
        break;
      case OP.ITEMS_NEW:
        f.items = [];
        break;
      case OP.ITEMS_PUSH:
        f.items.push(popN(f));
        break;
      case OP.ITEMS_LEN:
        f.ints.push(i32(f.items.length));
        break;
      case OP.ITEMS_FORMAT:
        for (const n of f.items) f.docs.push(run(n, ctx, f.kind));
        f.ints.push(i32(f.items.length));
        break;
      case OP.CONCAT_DYN:
        f.docs.push(concat(popDocs(f, popI(f))));
        break;
      case OP.JOIN_DYN: {
        const n = popI(f);
        const docs = popDocs(f, n);
        const sep = popD(f);
        f.docs.push(join(sep, docs));
        break;
      }
      case OP.PAREN:
        f.docs.push(parenInsert(popD(f), f.parentKind));
        break;
      case OP.TAKE_ALL:
        while (f.cursor < f.kids.length) f.bag.push(f.kids[f.cursor++]);
        finish(f);
        break;
      case OP.EQ: {
        const b = popI(f);
        const a = popI(f);
        f.ints.push(a === b ? 1 : 0);
        break;
      }
      case OP.LT: {
        const b = popI(f);
        const a = popI(f);
        f.ints.push(a < b ? 1 : 0);
        break;
      }
      case OP.ADD: {
        const b = popI(f);
        const a = popI(f);
        f.ints.push(i32(a + b));
        break;
      }
      case OP.SUB: {
        const b = popI(f);
        const a = popI(f);
        f.ints.push(i32(a - b));
        break;
      }
      case OP.APPEND_DANGLING:
        f.docs.push(appendDangling(popD(f), f.node));
        break;
      case OP.SWAP_D: {
        const a = popD(f);
        const b = popD(f);
        f.docs.push(a);
        f.docs.push(b);
        break;
      }
      case OP.GROUP_BREAK: {
        const should = popI(f) !== 0;
        f.docs.push(group(popD(f), { shouldBreak: should }));
        break;
      }
      case OP.HOST_FROM_IMPORT:
        f.docs.push(hostFromImport(f, ctx));
        break;
      case OP.BAG_LEN:
        f.ints.push(i32(f.bag.length));
        break;
      case OP.BAG_GET: {
        const i = popI(f);
        if (i < 0 || i >= f.bag.length) refuse(`bag[${i}] oob`);
        f.nodes.push(f.bag[i]);
        break;
      }
      case OP.JZ:
        if (popI(f) === 0) {
          pc = imm;
          continue;
        }
        break;
      case OP.JMP:
        pc = imm;
        continue;
      case OP.JNZ:
        if (popI(f) !== 0) {
          pc = imm;
          continue;
        }
        break;
      case OP.PUSH_I:
        f.ints.push(i32(imm));
        break;
      case OP.TEXT:
        f.docs.push(text(cst(ctx.pkg, imm)));
        break;
      case OP.REFUSE:
        refuse(cst(ctx.pkg, imm));
        break;
      case OP.PEEK_TOKEN: {
        const want = cst(ctx.pkg, imm);
        f.ints.push(
          f.cursor < f.kids.length && isToken(f.kids[f.cursor], want) ? 1 : 0,
        );
        break;
      }
      case OP.NODE_TOKEN:
        f.ints.push(isToken(peekN(f), cst(ctx.pkg, imm)) ? 1 : 0);
        break;
      case OP.NODE_FIELD:
        f.ints.push(peekN(f).field === cst(ctx.pkg, imm) ? 1 : 0);
        break;
      case OP.NODE_KIND:
        f.ints.push(peekN(f).type === cst(ctx.pkg, imm) ? 1 : 0);
        break;
      case OP.STORE: {
        if (imm < 0 || imm > 7) refuse(`int slot ${imm} oob`);
        f.slots[imm] = popI(f);
        break;
      }
      case OP.LOAD:
        if (imm < 0 || imm > 7) refuse(`int slot ${imm} oob`);
        f.ints.push(f.slots[imm]);
        break;
      case OP.CONCAT:
        f.docs.push(concat(popDocs(f, imm)));
        break;
      case OP.BAG_FIELD: {
        const want = cst(ctx.pkg, imm);
        const n = f.bag.find((x) => x.field === want);
        if (n) {
          f.nodes.push(n);
          f.ints.push(1);
        } else f.ints.push(0);
        break;
      }
      case OP.BAG_KIND: {
        const want = cst(ctx.pkg, imm);
        const n = f.bag.find((x) => x.type === want && x.text == null);
        if (n) {
          f.nodes.push(n);
          f.ints.push(1);
        } else f.ints.push(0);
        break;
      }
      case OP.BAG_TOKEN:
        f.ints.push(f.bag.some((x) => isToken(x, cst(ctx.pkg, imm))) ? 1 : 0);
        break;
      case OP.BAG_INDEX:
        if (imm >= 0 && imm < f.bag.length) {
          f.nodes.push(f.bag[imm]);
          f.ints.push(1);
        } else f.ints.push(0);
        break;
      case OP.BAG_FMT_KIND: {
        const want = cst(ctx.pkg, imm);
        const parts = [];
        for (const n of f.bag) {
          if (n.type === want) {
            parts.push(hardline);
            parts.push(run(n, ctx, f.kind));
          }
        }
        f.docs.push(parts.length ? concat(parts) : concat([]));
        break;
      }
      case OP.HOST_CHAIN:
        f.docs.push(hostChain(f, popI(f), ctx));
        break;
      case OP.DSTORE:
        if (imm < 0 || imm > 3) refuse(`doc slot ${imm} oob`);
        f.dslots[imm] = popD(f);
        break;
      case OP.DLOAD:
        if (imm < 0 || imm > 3 || f.dslots[imm] == null) {
          refuse(`empty doc slot ${imm}`);
        }
        f.docs.push(f.dslots[imm]);
        break;
      case OP.ITEMS_GET: {
        const i = popI(f);
        if (i < 0 || i >= f.items.length) refuse(`items[${i}] oob`);
        f.nodes.push(f.items[i]);
        break;
      }
      case OP.BLANK_EXTRA:
        f.ints.push(blankExtra(ctx, f.items, popI(f)));
        break;
      case OP.BAG_ONLY_FIELDS: {
        const n = imm;
        const wanted = [];
        for (let k = 0; k < n; k++) wanted.push(cst(ctx.pkg, code[pc + 2 + k]));
        for (const node of f.bag) {
          const ok = node.field && wanted.indexOf(node.field) !== -1;
          if (!ok && !isPunct(node)) {
            refuse(`pfx ${f.node.type}: unexpected ${node.type}`);
          }
        }
        break;
      }
      case OP.ARG:
        f.ints.push(argAt(f, imm));
        break;
      case OP.ARGI:
        f.ints.push(argAt(f, popI(f)));
        break;
      case OP.CTEXT:
        f.docs.push(text(cst(ctx.pkg, popI(f))));
        break;
      case OP.CPEEK: {
        const want = cst(ctx.pkg, popI(f));
        f.ints.push(
          f.cursor < f.kids.length && isToken(f.kids[f.cursor], want) ? 1 : 0,
        );
        break;
      }
      case OP.CTOKEN:
        f.ints.push(isToken(peekN(f), cst(ctx.pkg, popI(f))) ? 1 : 0);
        break;
      case OP.CFIELD:
        f.ints.push(peekN(f).field === cst(ctx.pkg, popI(f)) ? 1 : 0);
        break;
      case OP.CBAG_FIELD: {
        const want = cst(ctx.pkg, popI(f));
        const n = f.bag.find((x) => x.field === want);
        if (n) {
          f.nodes.push(n);
          f.ints.push(1);
        } else f.ints.push(0);
        break;
      }
      case OP.CBAG_KIND: {
        const want = cst(ctx.pkg, popI(f));
        const n = f.bag.find((x) => x.type === want && x.text == null);
        if (n) {
          f.nodes.push(n);
          f.ints.push(1);
        } else f.ints.push(0);
        break;
      }
      case OP.CBAG_TOKEN: {
        const want = cst(ctx.pkg, popI(f));
        f.ints.push(f.bag.some((x) => isToken(x, want)) ? 1 : 0);
        break;
      }
      case OP.CBAG_FMT: {
        const want = cst(ctx.pkg, popI(f));
        const parts = [];
        for (const n of f.bag) {
          if (n.type === want) {
            parts.push(hardline);
            parts.push(run(n, ctx, f.kind));
          }
        }
        f.docs.push(parts.length ? concat(parts) : concat([]));
        break;
      }
      case OP.CBAG_ONLY: {
        const base = imm;
        const n = argAt(f, base);
        if (n < 0) refuse(`CBAG_ONLY n<${n}`);
        const wanted = [];
        for (let k = 0; k < n; k++) wanted.push(cst(ctx.pkg, argAt(f, base + 1 + k)));
        for (const node of f.bag) {
          const ok = node.field && wanted.indexOf(node.field) !== -1;
          if (!ok && !isPunct(node)) {
            refuse(`pfx ${f.node.type}: unexpected ${node.type}`);
          }
        }
        break;
      }
      default:
        refuse(`unknown opcode ${op} at ${pc}`);
    }
    pc += len;
  }
}

// ---------------------------------------------------------------- comments

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
  const stmts = (block.children || []).filter(
    (c) => c.text == null && c.type !== "comment",
  );
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

// ---------------------------------------------------------------- public

function format(tree, width) {
  if (!tree || !tree.language) refuse("tree is missing language");
  const pkg = loadPackage(tree.language);
  const commentType = pkg.comment_type || "\0";
  if (pkg.comment_type && tree.source != null) {
    attachAll(
      tree.root,
      Buffer.from(tree.source, "utf8"),
      commentType,
      new Set(pkg.steal_into_body || []),
    );
  }
  const ctx = {
    pkg,
    commentType,
    sourceBytes: tree.source != null ? Buffer.from(tree.source, "utf8") : null,
  };
  const body = run(tree.root, ctx, null);
  return printDoc(concat([body, hardline]), width, pkg.indent || 2);
}

module.exports = {
  format,
  verify,
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
