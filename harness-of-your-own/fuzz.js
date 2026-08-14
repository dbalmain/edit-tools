#!/usr/bin/env node
"use strict";

// Differential fuzzer for the two bytecode interpreters.
// Generates well-typed instruction streams (the verifier accepts them),
// runs rust and js on a fixed tree, compares stdout byte-for-byte.
// Raw styles include an astral fit-probe (🙂 vs UTF-16 .length) and a
// HALT-without-drain leftover probe; see DESIGN.md mutation table.
//
//   node harness-of-your-own/fuzz.js [--seeds N] [--start S] [--tree PATH]
//                                    [--width W] [--stop-first]
//
// Exit 0 if no divergence. Prints a one-line summary (including
// seeds/s) and writes .ai/fuzz-last.json on a divergence.
// --stop-first exits after the first mismatch so a mutation test
// can report which seed caught it.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { compilePackage } = require("../tools/compile-package");
const { verify } = require("../runtime-js/bundle.js");
const { OP } = require("../tools/opcodes");

const ROOT = path.resolve(__dirname, "..");
const PKG_PATH = path.join(ROOT, "packages", "_fuzz.json");
const DEFAULT_TREE = path.join(ROOT, "corpus", "trees", "json__scalars.tree.json");

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.n = mulberry32(this.seed);
  }
  next() {
    return this.n();
  }
  int(max) {
    return Math.floor(this.next() * max);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  bool() {
    return this.next() < 0.5;
  }
}

function collectTypes(node, into) {
  into.add(node.type);
  for (const c of node.children || []) collectTypes(c, into);
}

function randomKind(rng) {
  const choice = rng.int(14);
  switch (choice) {
    case 0:
      return { kind: "leaf" };
    case 1:
      return { kind: "opaque" };
    case 2:
      return { kind: "fwd" };
    case 3:
      return {
        kind: "seq",
        open: rng.pick(["[", "{", "("]),
        close: rng.pick(["]", "}", ")"]),
        sep: rng.pick([",", ";"]),
        trailing: rng.pick(["none", "magic", "always-on-break"]),
        flat_pad: rng.bool(),
        singleton_comma: rng.bool(),
      };
    case 4:
      return { kind: "infix", op: rng.pick([": ", " = ", "=", ", "]) };
    case 5:
      return { kind: "infix", op_field: "operator" };
    case 6:
      return { kind: "wrap", open: rng.pick(["(", "[", "{"]), close: rng.pick([")", "]", "}"]) };
    case 7:
      return {
        kind: "pfx",
        kw: rng.pick(["not", "return", "-", "*"]),
        sp: rng.bool(),
        paren: rng.bool(),
      };
    case 8:
      return { kind: "body", tight: rng.bool() };
    case 9:
      return { kind: "dot", paren: rng.bool() };
    case 10:
      return { kind: "sub" };
    case 11:
      return { kind: "comp", open: rng.pick(["[", "(", "{"]), close: rng.pick(["]", ")", "}"]) };
    case 12:
      return {
        kind: "template",
        paren: rng.bool(),
        doc: rng.pick([
          ["$0"],
          ["$children"],
          ["$", "$0", " "],
          [{ join: { sep: ", ", items: "$children" } }],
          ["$0", " if ", "$2", " else ", "$4"],
        ]),
      };
    case 13:
      return { kind: "chain", already_flat: rng.bool(), break: rng.pick(["paren", "group"]) };
    default:
      return { kind: "fwd" };
  }
}

function authoredFromKinds(types, rng) {
  const nodes = {};
  for (const t of types) nodes[t] = randomKind(rng);
  return {
    language: "_fuzz",
    indent: rng.pick([2, 4]),
    opaque: rng.bool() ? ["string"] : [],
    nodes,
  };
}

class Emitter {
  constructor() {
    this.code = [];
    this.consts = [];
    this.constMap = new Map();
  }
  intern(s) {
    const key = String(s);
    if (this.constMap.has(key)) return this.constMap.get(key);
    const i = this.consts.length;
    this.consts.push(key);
    this.constMap.set(key, i);
    return i;
  }
  here() {
    return this.code.length;
  }
  emit(op, imm) {
    this.code.push(op);
    if (imm !== undefined) this.code.push(imm | 0);
  }
  emitHole(op) {
    this.code.push(op);
    const i = this.code.length;
    this.code.push(0);
    return i;
  }
  patch(i, v) {
    this.code[i] = v | 0;
  }
  text(s) {
    this.emit(OP.TEXT, this.intern(s));
  }
}

function drain(e) {
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.SKIP);
  e.emit(OP.JMP, loop);
  e.patch(after, e.here());
}

function rawProgram(rng, width) {
  const e = new Emitter();
  const style = rng.int(8);
  // Style 7: HALT without draining. The leftover-child refuse is the
  // structural-linearity check; drain-then-emit never reaches it.
  if (style === 7) {
    e.text(rng.pick(["x", ""]));
    e.emit(OP.HALT);
    return e;
  }
  drain(e);
  if (style === 0) {
    e.text(rng.pick(["", "x", " ", "[]", "hello"]));
  } else if (style === 1) {
    e.emit(OP.SOFTLINE);
    e.text(rng.pick(["a", "b"]));
    e.emit(OP.CONCAT, 2);
    e.emit(OP.GROUP);
  } else if (style === 2) {
    e.text("(");
    e.emit(OP.LINE);
    e.text(")");
    e.emit(OP.CONCAT, 3);
    e.emit(OP.GROUP);
  } else if (style === 3) {
    e.text(",");
    e.text("");
    e.emit(OP.IF_BREAK);
  } else if (style === 4) {
    e.emit(OP.HARDLINE);
    e.text("x");
    e.emit(OP.CONCAT, 2);
  } else if (style === 6) {
    // Astral fit probe. group(text(pad+🙂) + line + "z") is `width`
    // scalar columns (fits) and `width+1` UTF-16 units (breaks).
    // ASCII-only TEXT at a generous width cannot see .length vs [...s].
    const n = Math.max(0, width - 3);
    e.text("a".repeat(n) + "🙂");
    e.emit(OP.LINE);
    e.text("z");
    e.emit(OP.CONCAT, 3);
    e.emit(OP.GROUP);
  } else {
    e.text("[");
    e.emit(OP.SOFTLINE);
    e.text("1");
    e.emit(OP.CONCAT, 2);
    e.emit(OP.INDENT);
    e.text("]");
    e.emit(OP.CONCAT, 2);
    e.emit(OP.GROUP);
  }
  e.emit(OP.HALT);
  return e;
}

function bytecodeFromRaw(types, rng, width) {
  const e = rawProgram(rng, width);
  const entry = {};
  for (const t of types) entry[t] = 0;
  return {
    language: "_fuzz",
    indent: 2,
    opaque: [],
    steal_into_body: [],
    blank: { max: 0, before_top: [] },
    consts: e.consts,
    entry,
    kinds: Object.fromEntries(types.map((t) => [t, "fwd"])),
    defaults: { leaf: 0, opaque: 0, fwd: 0 },
    code: e.code,
  };
}

// Shared program, distinct operand vectors. FORMAT is the call:
// every type enters the same pc with its own args.
function bytecodeFromArgs(types, rng) {
  const e = new Emitter();
  drain(e);
  const style = rng.int(4);
  if (style === 0) {
    e.emit(OP.ARG, 0);
    e.emit(OP.CTEXT);
  } else if (style === 1) {
    e.emit(OP.PUSH_I, 0);
    e.emit(OP.ARGI);
    e.emit(OP.CTEXT);
    e.emit(OP.GROUP);
  } else if (style === 2) {
    e.emit(OP.ARG, 0);
    e.emit(OP.CPEEK);
    const miss = e.emitHole(OP.JZ);
    e.emit(OP.SKIP);
    e.patch(miss, e.here());
    e.emit(OP.ARG, 1);
    e.emit(OP.CTEXT);
  } else {
    e.emit(OP.ARG, 0);
    e.emit(OP.PUSH_I, 0);
    e.emit(OP.EQ);
    const z = e.emitHole(OP.JNZ);
    e.emit(OP.ARG, 1);
    e.emit(OP.CTEXT);
    const done = e.emitHole(OP.JMP);
    e.patch(z, e.here());
    e.text("");
    e.patch(done, e.here());
  }
  e.emit(OP.HALT);
  const words = ["", "x", "[", "]", ",", "()", "hi"];
  const args = {};
  const entry = {};
  for (const t of types) {
    entry[t] = 0;
    args[t] = [e.intern(rng.pick(words)), e.intern(rng.pick(words))];
  }
  return {
    language: "_fuzz",
    indent: 2,
    opaque: [],
    steal_into_body: [],
    blank: { max: 0, before_top: [] },
    consts: e.consts,
    entry,
    args,
    kinds: Object.fromEntries(types.map((t) => [t, "fwd"])),
    defaults: { leaf: 0, opaque: 0, fwd: 0 },
    code: e.code,
  };
}

function invoke(exe, treePath, width) {
  const r = spawnSync(exe, [treePath, String(width)], {
    encoding: "buffer",
    timeout: 15000,
    cwd: ROOT,
  });
  return {
    status: r.status,
    stdout: r.stdout || Buffer.alloc(0),
    stderr: (r.stderr || Buffer.alloc(0)).toString("utf8").trim(),
    error: r.error ? String(r.error) : "",
  };
}

function parseArgs(argv) {
  const out = { seeds: 400, start: 1, tree: DEFAULT_TREE, width: 88, stopFirst: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seeds") out.seeds = Number(argv[++i]);
    else if (a === "--start") out.start = Number(argv[++i]);
    else if (a === "--tree") out.tree = path.resolve(argv[++i]);
    else if (a === "--width") out.width = Number(argv[++i]);
    else if (a === "--stop-first") out.stopFirst = true;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rust = path.join(ROOT, "fmt-rust");
  const js = path.join(ROOT, "fmt-js");
  const baseTree = JSON.parse(fs.readFileSync(opts.tree, "utf8"));
  const typeSet = new Set();
  collectTypes(baseTree.root, typeSet);
  const types = [...typeSet].sort();

  const tmpTree = path.join(ROOT, ".ai", "fuzz-tree.json");
  fs.mkdirSync(path.dirname(tmpTree), { recursive: true });
  const fuzzTree = JSON.parse(JSON.stringify(baseTree));
  fuzzTree.language = "_fuzz";
  fs.writeFileSync(tmpTree, JSON.stringify(fuzzTree));

  let agreedOk = 0;
  let agreedRefuse = 0;
  let divergences = 0;
  const firstDiv = [];
  const t0 = process.hrtime.bigint();

  try {
    for (let i = 0; i < opts.seeds; i++) {
      const seed = (opts.start + i) >>> 0;
      const rng = new Rng(seed);
      let bc;
      const which = rng.int(3);
      if (which === 0) {
        bc = compilePackage(authoredFromKinds(types, rng));
        bc.language = "_fuzz";
      } else if (which === 1) {
        bc = bytecodeFromRaw(types, rng, opts.width);
      } else {
        bc = bytecodeFromArgs(types, rng);
      }
      try {
        verify(bc);
      } catch (e) {
        divergences++;
        firstDiv.push({ seed, kind: "verify-reject", err: String(e.message || e), after: i + 1 });
        if (opts.stopFirst || firstDiv.length >= 5) break;
        continue;
      }
      fs.writeFileSync(PKG_PATH, JSON.stringify(bc));

      const r = invoke(rust, tmpTree, opts.width);
      const j = invoke(js, tmpTree, opts.width);
      const rOk = r.status === 0 && !r.error;
      const jOk = j.status === 0 && !j.error;

      if (rOk && jOk) {
        if (Buffer.compare(r.stdout, j.stdout) === 0) {
          agreedOk++;
        } else {
          divergences++;
          firstDiv.push({
            seed,
            kind: "output",
            rustBytes: r.stdout.length,
            jsBytes: j.stdout.length,
            after: i + 1,
          });
          fs.writeFileSync(
            path.join(ROOT, ".ai", "fuzz-last.json"),
            JSON.stringify({ seed, bc, rust: r.stdout.toString("utf8"), js: j.stdout.toString("utf8") }, null, 2),
          );
          if (opts.stopFirst || firstDiv.length >= 5) break;
        }
      } else if (!rOk && !jOk) {
        agreedRefuse++;
      } else {
        divergences++;
        firstDiv.push({
          seed,
          kind: "refuse-mismatch",
          rust: { status: r.status, err: r.stderr || r.error },
          js: { status: j.status, err: j.stderr || j.error },
          after: i + 1,
        });
        fs.writeFileSync(
          path.join(ROOT, ".ai", "fuzz-last.json"),
          JSON.stringify({ seed, bc, rust: r, js: j }, null, 2),
        );
        if (opts.stopFirst || firstDiv.length >= 5) break;
      }
    }
  } finally {
    try {
      fs.unlinkSync(PKG_PATH);
    } catch (_) {
      /* keep going */
    }
  }

  const ran = agreedOk + agreedRefuse + divergences;
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;
  const perSec = elapsedSec > 0 ? ran / elapsedSec : 0;
  console.log(
    `fuzz seeds=${ran} agreed_ok=${agreedOk} agreed_refuse=${agreedRefuse} divergences=${divergences} tree=${path.basename(opts.tree)} width=${opts.width} ${elapsedSec.toFixed(2)}s ${perSec.toFixed(1)} seeds/s`,
  );
  if (firstDiv.length) {
    console.log("first divergences:");
    for (const d of firstDiv) console.log(" ", JSON.stringify(d));
    process.exit(1);
  }
}

main();
