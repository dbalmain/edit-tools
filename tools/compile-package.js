"use strict";

// Compile an authored kinds package into a bytecode package.
// Authored form stays in packages/src/; shipped form is packages/<lang>.json.

const fs = require("fs");
const path = require("path");
const { OP, decode } = require("./opcodes");

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

  text(s) {
    this.emit(OP.TEXT, this.intern(s));
  }

  refuse(msg) {
    this.emit(OP.REFUSE, this.intern(msg));
  }

  peekToken(s) {
    this.emit(OP.PEEK_TOKEN, this.intern(s));
  }

  nodeToken(s) {
    this.emit(OP.NODE_TOKEN, this.intern(s));
  }

  nodeField(s) {
    this.emit(OP.NODE_FIELD, this.intern(s));
  }

  // Emit `op imm` and return the index of the immediate so a later patch can fill it.
  emitHole(op) {
    this.code.push(op);
    const i = this.code.length;
    this.code.push(0);
    return i;
  }

  patch(i, value) {
    this.code[i] = value | 0;
  }

  // JZ/JNZ/JMP to a pc that is known now.
  jzTo(pc) {
    this.emit(OP.JZ, pc);
  }
  jnzTo(pc) {
    this.emit(OP.JNZ, pc);
  }
  jmpTo(pc) {
    this.emit(OP.JMP, pc);
  }
}

function compileLeaf(e) {
  e.emit(OP.LEAF);
  e.emit(OP.HALT);
}

function compileOpaque(e) {
  // Opaque reads the source span and must still consume every child so
  // HALT's finish check holds. Skipping is a consume, not a leak.
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.SKIP);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.OPAQUE);
  e.emit(OP.HALT);
}

function compileFwd(e, type) {
  e.emit(OP.ITEMS_NEW);
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  e.emit(OP.NODE_PUNCT);
  const isPunct = e.emitHole(OP.JNZ);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(isPunct, e.here());
  e.emit(OP.DROP_N);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.FINISH);
  e.emit(OP.ITEMS_LEN);
  e.emit(OP.DUP_I);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const notZero = e.emitHole(OP.JZ);
  e.emit(OP.DROP_I);
  e.text("");
  e.emit(OP.HALT);
  e.patch(notZero, e.here());
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.EQ);
  const notOne = e.emitHole(OP.JZ);
  e.emit(OP.ITEMS_FORMAT);
  e.emit(OP.DROP_I);
  e.emit(OP.HALT);
  e.patch(notOne, e.here());
  e.refuse(`fwd ${type} has multiple significant children`);
}

function compileInfix(e, rule, type) {
  e.emit(OP.ITEMS_NEW);
  if (rule.op != null) {
    e.text(rule.op);
  } else {
    e.text("");
  }
  e.emit(OP.DSTORE, 0);

  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  if (rule.op_field) {
    e.nodeField(rule.op_field);
  } else {
    e.nodeToken((rule.op || "").trim());
  }
  const isOp = e.emitHole(OP.JNZ);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(isOp, e.here());
  if (rule.op == null) {
    e.emit(OP.FORMAT_OP);
    e.text(" ");
    e.emit(OP.SWAP_D);
    e.text(" ");
    e.emit(OP.CONCAT, 3);
    e.emit(OP.DSTORE, 0);
  } else {
    e.emit(OP.DROP_N);
  }
  e.jmpTo(loop);

  e.patch(after, e.here());
  e.emit(OP.FINISH);
  e.emit(OP.ITEMS_LEN);
  e.emit(OP.DUP_I);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const hasOps = e.emitHole(OP.JZ);
  e.refuse(`infix ${type} has no operands`);
  e.patch(hasOps, e.here());
  e.emit(OP.DLOAD, 0);
  e.emit(OP.ITEMS_FORMAT);
  e.emit(OP.JOIN_DYN);
  e.emit(OP.HALT);
}

function compileSeq(e, rule, type) {
  const open = rule.open;
  const close = rule.close;
  const sep = rule.sep || ",";
  if (open == null || close == null) {
    e.refuse(`seq ${type} missing open/close`);
    return;
  }

  e.emit(OP.TAKE);
  e.nodeToken(open);
  const okOpen = e.emitHole(OP.JNZ);
  e.refuse(`seq ${type}: expected ${open}`);
  e.patch(okOpen, e.here());
  e.emit(OP.DROP_N);

  e.emit(OP.EMPTY);
  const hasClose0 = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(hasClose0, e.here());

  e.peekToken(close);
  const notEmpty = e.emitHole(OP.JZ);
  e.emit(OP.SKIP);
  e.emit(OP.FINISH);
  e.text(open + close);
  e.emit(OP.HALT);

  e.patch(notEmpty, e.here());
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 0); // trailing

  const itemLoop = e.here();
  e.peekToken(close);
  const afterItems = e.emitHole(OP.JNZ);
  e.emit(OP.EMPTY);
  const notEmpty2 = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(notEmpty2, e.here());

  e.peekToken(sep);
  const notSep = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: unexpected ${sep}`);
  e.patch(notSep, e.here());

  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);

  e.emit(OP.EMPTY);
  const hasAfterItem = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(hasAfterItem, e.here());

  e.peekToken(sep);
  const noSep = e.emitHole(OP.JZ);
  e.emit(OP.SKIP);
  e.peekToken(close);
  const notTrail = e.emitHole(OP.JZ);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.STORE, 0);
  e.jmpTo(0); // patch afterItems
  const trailJmp = e.code.length - 1;
  e.patch(notTrail, e.here());
  e.jmpTo(itemLoop);

  e.patch(noSep, e.here());
  e.peekToken(close);
  const goodClose = e.emitHole(OP.JNZ);
  e.refuse(`seq ${type}: expected ${sep} or ${close}`);
  e.patch(goodClose, e.here());
  e.jmpTo(itemLoop);

  const afterItemsPc = e.here();
  e.patch(afterItems, afterItemsPc);
  e.patch(trailJmp, afterItemsPc);

  e.peekToken(close);
  const gotClose = e.emitHole(OP.JNZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(gotClose, e.here());
  e.emit(OP.SKIP);
  e.emit(OP.FINISH);

  if (rule.trailing === "none") {
    e.emit(OP.LOAD, 0);
    const noTrail = e.emitHole(OP.JZ);
    e.refuse(`seq ${type}: trailing ${sep} is forbidden`);
    e.patch(noTrail, e.here());
  }

  // pad in D slot 0
  if (rule.flat_pad) e.emit(OP.LINE);
  else e.emit(OP.SOFTLINE);
  e.emit(OP.DUP_D);
  e.emit(OP.DSTORE, 0);

  // acc = pad; then for i in items: if i>0 concat sep; concat format(item)
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1); // i
  e.emit(OP.ITEMS_LEN);
  e.emit(OP.STORE, 2); // n

  const buildLoop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 2);
  e.emit(OP.LT);
  const buildDone = e.emitHole(OP.JZ);

  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const first = e.emitHole(OP.JNZ);
  e.text(sep);
  e.emit(OP.LINE);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.CONCAT, 2); // acc + sepDoc
  e.patch(first, e.here());
  e.emit(OP.LOAD, 1);
  e.emit(OP.ITEMS_GET);
  e.emit(OP.FORMAT);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(buildLoop);
  e.patch(buildDone, e.here());

  const singleton = !!rule.singleton_comma;
  if (singleton) {
    e.emit(OP.LOAD, 2);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.EQ);
    const notSing = e.emitHole(OP.JZ);
    e.text(sep);
    e.emit(OP.CONCAT, 2);
    const afterSing = e.emitHole(OP.JMP);
    e.patch(notSing, e.here());
    if (rule.trailing === "magic" || rule.trailing === "always-on-break") {
      e.text(sep);
      e.text("");
      e.emit(OP.IF_BREAK);
      e.emit(OP.CONCAT, 2);
    }
    e.patch(afterSing, e.here());
  } else if (rule.trailing === "magic" || rule.trailing === "always-on-break") {
    e.text(sep);
    e.text("");
    e.emit(OP.IF_BREAK);
    e.emit(OP.CONCAT, 2);
  }

  // group(concat([text(open), indent(inner), pad, text(close)]))
  e.text(open);
  e.emit(OP.SWAP_D);
  e.emit(OP.INDENT);
  e.emit(OP.DLOAD, 0);
  e.text(close);
  e.emit(OP.CONCAT, 4);

  const shouldBreakMagic = rule.trailing === "magic";
  if (shouldBreakMagic) {
    // should_break = trailing && !singleton
    e.emit(OP.LOAD, 0);
    if (singleton) {
      e.emit(OP.LOAD, 2);
      e.emit(OP.PUSH_I, 1);
      e.emit(OP.EQ);
      e.emit(OP.NOT);
      // I: trailing, !singleton — need AND
      // We don't have AND. a==1 && b==1: both on stack...
      // trailing is 0/1, !singleton is 0/1. Multiply via... no MUL.
      // AND: NOT a, NOT b, ... 
      // (a!=0) && (b!=0): 
      //   DUP path: if trailing==0, push 0; else push !singleton
      e.emit(OP.SWAP_I_MISSING);
    }
    // Simpler: compute should_break in the compiler with a small sequence:
    //   LOAD 0 (trailing)
    //   if singleton: if n==1 then push 0 else keep trailing
  }

  if (shouldBreakMagic && singleton) {
    // I currently empty. Compute: trailing && n!=1
    e.emit(OP.LOAD, 0);
    e.emit(OP.LOAD, 2);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.EQ);
    e.emit(OP.NOT);
    // I: [trailing, n!=1]. Want trailing!=0 && n!=1.
    // Use: if n==1 then 0 else trailing. We have n!=1 on TOS.
    const keep = e.emitHole(OP.JNZ);
    e.emit(OP.DROP_I); // drop trailing
    e.emit(OP.PUSH_I, 0);
    const done = e.emitHole(OP.JMP);
    e.patch(keep, e.here());
    // trailing stays
    e.emit(OP.GROUP_BREAK);
    const afterGb = e.emitHole(OP.JMP);
    e.patch(done, e.here());
    e.emit(OP.GROUP_BREAK);
    e.patch(afterGb, e.here());
  } else if (shouldBreakMagic) {
    e.emit(OP.LOAD, 0);
    e.emit(OP.GROUP_BREAK);
  } else {
    e.emit(OP.GROUP);
  }
  e.emit(OP.HALT);
}

// Fix: I referenced SWAP_I_MISSING. Remove that dead branch — the
// shouldBreakMagic && singleton / shouldBreakMagic / else handles it.
// compileSeq as written has a leftover `if (shouldBreakMagic) { ... SWAP_I }`
// block that I need to delete. I'll rewrite compileSeq more carefully.

function compileSeqFixed(e, rule, type) {
  const open = rule.open;
  const close = rule.close;
  const sep = rule.sep || ",";
  if (open == null || close == null) {
    e.refuse(`seq ${type} missing open/close`);
    return;
  }

  e.emit(OP.TAKE);
  e.nodeToken(open);
  const okOpen = e.emitHole(OP.JNZ);
  e.refuse(`seq ${type}: expected ${open}`);
  e.patch(okOpen, e.here());
  e.emit(OP.DROP_N);

  e.emit(OP.EMPTY);
  const hasClose0 = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(hasClose0, e.here());

  e.peekToken(close);
  const notEmpty = e.emitHole(OP.JZ);
  e.emit(OP.SKIP);
  e.emit(OP.FINISH);
  e.text(open + close);
  e.emit(OP.HALT);

  e.patch(notEmpty, e.here());
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 0);

  const itemLoop = e.here();
  e.peekToken(close);
  const afterHole = e.emitHole(OP.JNZ);
  e.emit(OP.EMPTY);
  const notEmpty2 = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(notEmpty2, e.here());

  e.peekToken(sep);
  const notSep = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: unexpected ${sep}`);
  e.patch(notSep, e.here());

  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);

  e.emit(OP.EMPTY);
  const hasAfterItem = e.emitHole(OP.JZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(hasAfterItem, e.here());

  e.peekToken(sep);
  const noSep = e.emitHole(OP.JZ);
  e.emit(OP.SKIP);
  e.peekToken(close);
  const notTrail = e.emitHole(OP.JZ);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.STORE, 0);
  const trailJmp = e.emitHole(OP.JMP);
  e.patch(notTrail, e.here());
  e.jmpTo(itemLoop);

  e.patch(noSep, e.here());
  e.peekToken(close);
  const goodClose = e.emitHole(OP.JNZ);
  e.refuse(`seq ${type}: expected ${sep} or ${close}`);
  e.patch(goodClose, e.here());
  e.jmpTo(itemLoop);

  const afterItemsPc = e.here();
  e.patch(afterHole, afterItemsPc);
  e.patch(trailJmp, afterItemsPc);

  e.peekToken(close);
  const gotClose = e.emitHole(OP.JNZ);
  e.refuse(`seq ${type}: missing ${close}`);
  e.patch(gotClose, e.here());
  e.emit(OP.SKIP);
  e.emit(OP.FINISH);

  if (rule.trailing === "none") {
    e.emit(OP.LOAD, 0);
    const noTrail = e.emitHole(OP.JZ);
    e.refuse(`seq ${type}: trailing ${sep} is forbidden`);
    e.patch(noTrail, e.here());
  }

  if (rule.flat_pad) e.emit(OP.LINE);
  else e.emit(OP.SOFTLINE);
  e.emit(OP.DUP_D);
  e.emit(OP.DSTORE, 0);

  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  e.emit(OP.ITEMS_LEN);
  e.emit(OP.STORE, 2);

  const buildLoop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 2);
  e.emit(OP.LT);
  const buildDone = e.emitHole(OP.JZ);

  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const first = e.emitHole(OP.JNZ);
  e.text(sep);
  e.emit(OP.LINE);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.CONCAT, 2);
  e.patch(first, e.here());
  e.emit(OP.LOAD, 1);
  e.emit(OP.ITEMS_GET);
  e.emit(OP.FORMAT);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(buildLoop);
  e.patch(buildDone, e.here());

  const singleton = !!rule.singleton_comma;
  const trailBreak = rule.trailing === "magic" || rule.trailing === "always-on-break";
  if (singleton) {
    e.emit(OP.LOAD, 2);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.EQ);
    const notSing = e.emitHole(OP.JZ);
    e.text(sep);
    e.emit(OP.CONCAT, 2);
    const afterSing = e.emitHole(OP.JMP);
    e.patch(notSing, e.here());
    if (trailBreak) {
      e.text(sep);
      e.text("");
      e.emit(OP.IF_BREAK);
      e.emit(OP.CONCAT, 2);
    }
    e.patch(afterSing, e.here());
  } else if (trailBreak) {
    e.text(sep);
    e.text("");
    e.emit(OP.IF_BREAK);
    e.emit(OP.CONCAT, 2);
  }

  e.text(open);
  e.emit(OP.SWAP_D);
  e.emit(OP.INDENT);
  e.emit(OP.DLOAD, 0);
  e.text(close);
  e.emit(OP.CONCAT, 4);

  if (rule.trailing === "magic") {
    e.emit(OP.LOAD, 0); // trailing
    if (singleton) {
      e.emit(OP.LOAD, 2);
      e.emit(OP.PUSH_I, 1);
      e.emit(OP.EQ);
      const isSing = e.emitHole(OP.JNZ);
      e.emit(OP.GROUP_BREAK);
      const done = e.emitHole(OP.JMP);
      e.patch(isSing, e.here());
      e.emit(OP.DROP_I); // drop trailing
      e.emit(OP.PUSH_I, 0);
      e.emit(OP.GROUP_BREAK);
      e.patch(done, e.here());
    } else {
      e.emit(OP.GROUP_BREAK);
    }
  } else {
    e.emit(OP.GROUP);
  }
  e.emit(OP.HALT);
}

function compileWrap(e, rule, type) {
  const open = rule.open;
  const close = rule.close;
  if (open == null || close == null) {
    e.refuse(`wrap ${type} missing open/close`);
    return;
  }
  e.emit(OP.TAKE);
  e.nodeToken(open);
  const okO = e.emitHole(OP.JNZ);
  e.refuse(`wrap ${type}: expected ${open}`);
  e.patch(okO, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.TAKE);
  e.emit(OP.FORMAT);
  e.emit(OP.TAKE);
  e.nodeToken(close);
  const okC = e.emitHole(OP.JNZ);
  e.refuse(`wrap ${type}: expected ${close}`);
  e.patch(okC, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.FINISH);
  e.emit(OP.SOFTLINE);
  e.emit(OP.SWAP_D);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.INDENT);
  e.text(open);
  e.emit(OP.SWAP_D);
  e.emit(OP.SOFTLINE);
  e.text(close);
  e.emit(OP.CONCAT, 4);
  e.emit(OP.GROUP);
  e.emit(OP.HALT);
}

function compilePfx(e, rule, type) {
  if (rule.fields && rule.fields.length) {
    e.emit(OP.TAKE_ALL);
    e.emit(OP.BAG_ONLY_FIELDS);
    e.code.push(rule.fields.length);
    for (const f of rule.fields) e.code.push(e.intern(f));
    e.emit(OP.PUSH_I, 0);
    e.emit(OP.STORE, 0);
    for (const f of rule.fields) {
      e.emit(OP.BAG_FIELD, e.intern(f));
      const miss = e.emitHole(OP.JZ);
      e.emit(OP.FORMAT);
      e.emit(OP.LOAD, 0);
      e.emit(OP.PUSH_I, 1);
      e.emit(OP.ADD);
      e.emit(OP.STORE, 0);
      e.patch(miss, e.here());
    }
    e.emit(OP.LOAD, 0);
    e.emit(OP.CONCAT_DYN);
    if (rule.paren) e.emit(OP.PAREN);
    e.emit(OP.HALT);
    return;
  }

  if (rule.kw != null) {
    e.emit(OP.TAKE);
    e.nodeToken(rule.kw);
    const ok = e.emitHole(OP.JNZ);
    e.refuse(`pfx ${type}: expected ${rule.kw}`);
    e.patch(ok, e.here());
    e.emit(OP.DROP_N);
    e.text(rule.kw);
  } else if (rule.op_field) {
    e.emit(OP.TAKE);
    e.emit(OP.NODE_RAW);
  } else {
    e.refuse(`pfx ${type}: need kw, op_field, or fields`);
    return;
  }
  e.emit(OP.ITEMS_NEW);
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.FINISH);

  if (rule.sp) {
    e.emit(OP.ITEMS_LEN);
    e.emit(OP.PUSH_I, 0);
    e.emit(OP.EQ);
    const noSp = e.emitHole(OP.JNZ);
    e.text(" ");
    e.emit(OP.CONCAT, 2);
    e.patch(noSp, e.here());
  }

  e.emit(OP.ITEMS_FORMAT);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.CONCAT_DYN);
  if (rule.paren) e.emit(OP.PAREN);
  e.emit(OP.HALT);
}

function compileBody(e, rule) {
  e.emit(OP.ITEMS_NEW);
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.FINISH);

  e.emit(OP.ITEMS_LEN);
  e.emit(OP.STORE, 0); // n
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1); // i
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.STORE, 2); // acc_empty

  const loop2 = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 0);
  e.emit(OP.LT);
  const done = e.emitHole(OP.JZ);

  e.emit(OP.LOAD, 2);
  const first = e.emitHole(OP.JNZ);

  e.emit(OP.HARDLINE);
  e.emit(OP.CONCAT, 2);
  if (!rule.tight) {
    e.emit(OP.LOAD, 1);
    e.emit(OP.BLANK_EXTRA);
    e.emit(OP.STORE, 3);
    const bLoop = e.here();
    e.emit(OP.LOAD, 3);
    e.emit(OP.PUSH_I, 0);
    e.emit(OP.EQ);
    const bDone = e.emitHole(OP.JNZ);
    e.emit(OP.HARDLINE);
    e.emit(OP.CONCAT, 2);
    e.emit(OP.LOAD, 3);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.SUB);
    e.emit(OP.STORE, 3);
    e.jmpTo(bLoop);
    e.patch(bDone, e.here());
  }

  e.patch(first, e.here());
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 2);
  e.emit(OP.LOAD, 1);
  e.emit(OP.ITEMS_GET);
  e.emit(OP.FORMAT);
  // if this was first, acc was empty — FORMAT left the doc as acc.
  // if not first, we already concat'd hardlines onto acc, then FORMAT
  // pushed the stmt doc, so CONCAT 2.
  // Problem: we don't know if first anymore (we cleared STORE 2).
  // Fix: concat only when not first. Check a saved flag.
  // Re-do: keep was_empty in slot 4 before clearing.

  // I already cleared slot 2. Let me restructure.
  // Actually look at the first branch: if slot2 (acc_empty) JNZ first.
  // first: we fall through after patch to STORE 2=0, GET, FORMAT. D: [doc]. Good.
  // not-first: HARDLINE, CONCAT, blanks, then we hit the same STORE/GET/FORMAT.
  // After FORMAT, D: [acc, stmt]. Need CONCAT 2 only for not-first.
  //
  // I'll use slot 4 as "need_concat" set to 0 on first path and 1 on other.

  // This function is already emitted wrong. Rewrite compileBody cleanly below.
  e.emit(OP.HALT);
}

function compileBodyFixed(e, rule) {
  e.emit(OP.ITEMS_NEW);
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.FINISH);

  e.emit(OP.ITEMS_LEN);
  e.emit(OP.STORE, 0);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);

  // if n==0: empty text, dangling, halt
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const hasStmts = e.emitHole(OP.JZ);
  e.text("");
  e.emit(OP.APPEND_DANGLING);
  e.emit(OP.HALT);
  e.patch(hasStmts, e.here());

  // first stmt
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.ITEMS_GET);
  e.emit(OP.FORMAT);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.STORE, 1);

  const loop2 = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 0);
  e.emit(OP.LT);
  const done = e.emitHole(OP.JZ);

  e.emit(OP.HARDLINE);
  e.emit(OP.CONCAT, 2);
  if (!rule.tight) {
    e.emit(OP.LOAD, 1);
    e.emit(OP.BLANK_EXTRA);
    e.emit(OP.STORE, 3);
    const bLoop = e.here();
    e.emit(OP.LOAD, 3);
    e.emit(OP.PUSH_I, 0);
    e.emit(OP.EQ);
    const bDone = e.emitHole(OP.JNZ);
    e.emit(OP.HARDLINE);
    e.emit(OP.CONCAT, 2);
    e.emit(OP.LOAD, 3);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.SUB);
    e.emit(OP.STORE, 3);
    e.jmpTo(bLoop);
    e.patch(bDone, e.here());
  }
  e.emit(OP.LOAD, 1);
  e.emit(OP.ITEMS_GET);
  e.emit(OP.FORMAT);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(loop2);

  e.patch(done, e.here());
  e.emit(OP.APPEND_DANGLING);
  e.emit(OP.HALT);
}

function compileComp(e, rule, type) {
  const open = rule.open;
  const close = rule.close;
  if (open == null || close == null) {
    e.refuse(`comp ${type} missing open/close`);
    return;
  }
  e.emit(OP.TAKE);
  e.nodeToken(open);
  const okO = e.emitHole(OP.JNZ);
  e.refuse(`comp ${type}: expected ${open}`);
  e.patch(okO, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.ITEMS_NEW);
  const loop = e.here();
  e.peekToken(close);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.EMPTY);
  const notEmpty = e.emitHole(OP.JZ);
  e.refuse(`comp ${type}: missing ${close}`);
  e.patch(notEmpty, e.here());
  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.peekToken(close);
  const okC = e.emitHole(OP.JNZ);
  e.refuse(`comp ${type}: missing ${close}`);
  e.patch(okC, e.here());
  e.emit(OP.SKIP);
  e.emit(OP.FINISH);

  e.emit(OP.SOFTLINE);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  e.emit(OP.ITEMS_LEN);
  e.emit(OP.STORE, 2);
  const bLoop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 2);
  e.emit(OP.LT);
  const bDone = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const first = e.emitHole(OP.JNZ);
  e.emit(OP.LINE);
  e.emit(OP.CONCAT, 2);
  e.patch(first, e.here());
  e.emit(OP.LOAD, 1);
  e.emit(OP.ITEMS_GET);
  e.emit(OP.FORMAT);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(bLoop);
  e.patch(bDone, e.here());

  e.text(open);
  e.emit(OP.SWAP_D);
  e.emit(OP.INDENT);
  e.emit(OP.SOFTLINE);
  e.text(close);
  e.emit(OP.CONCAT, 4);
  e.emit(OP.GROUP);
  e.emit(OP.HALT);
}

function compileDot(e, rule) {
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 0);
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  e.emit(OP.NODE_PUNCT);
  const punct = e.emitHole(OP.JNZ);
  e.emit(OP.FORMAT);
  const pushed = e.emitHole(OP.JMP);
  e.patch(punct, e.here());
  e.emit(OP.NODE_TEXT);
  e.patch(pushed, e.here());
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.FINISH);
  e.emit(OP.LOAD, 0);
  e.emit(OP.CONCAT_DYN);
  if (rule.paren) e.emit(OP.PAREN);
  e.emit(OP.HALT);
}

function compileSub(e, type) {
  e.emit(OP.TAKE);
  e.emit(OP.FORMAT);
  e.emit(OP.TAKE);
  e.nodeToken("[");
  const okO = e.emitHole(OP.JNZ);
  e.refuse(`sub ${type}: expected [`);
  e.patch(okO, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.TAKE);
  e.emit(OP.FORMAT);
  e.emit(OP.TAKE);
  e.nodeToken("]");
  const okC = e.emitHole(OP.JNZ);
  e.refuse(`sub ${type}: expected ]`);
  e.patch(okC, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.FINISH);
  // D: [obj, index]
  e.emit(OP.SOFTLINE);
  e.emit(OP.SWAP_D);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.INDENT);
  e.text("[");
  e.emit(OP.SWAP_D);
  e.emit(OP.SOFTLINE);
  e.text("]");
  e.emit(OP.CONCAT, 4);
  e.emit(OP.GROUP);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.HALT);
}

function compileTemplateSpec(e, spec, countsSlot) {
  // Pushes one doc. Increments slot countsSlot by 1 if we want the caller
  // to CONCAT_DYN — actually each call pushes exactly one doc.
  if (typeof spec === "string") {
    if (spec === "$children") {
      // all non-punct bag nodes, concat
      // Use BAG_FMT of... we don't have "all non-punct".
      // Walk bag by index.
      compileBagChildrenConcat(e, false);
      return;
    }
    if (spec.charAt(0) === "$") {
      const name = spec.slice(1);
      if (/^\d+$/.test(name)) {
        e.emit(OP.BAG_INDEX, Number(name));
        const miss = e.emitHole(OP.JZ);
        e.emit(OP.FORMAT);
        const done = e.emitHole(OP.JMP);
        e.patch(miss, e.here());
        e.text("");
        e.patch(done, e.here());
        return;
      }
      // all field matches, else by_field (same)
      compileBagFieldConcat(e, name);
      return;
    }
    e.text(spec);
    return;
  }
  if (Array.isArray(spec)) {
    if (spec.length === 0) {
      e.text("");
      return;
    }
    for (const item of spec) compileTemplateSpec(e, item);
    e.emit(OP.CONCAT, spec.length);
    return;
  }
  if (spec && spec.join) {
    const sep = (spec.join.sep != null ? spec.join.sep : "");
    const items = spec.join.items || "$children";
    e.text(sep);
    if (items === "$children") {
      compileBagChildrenToItems(e, false);
    } else if (typeof items === "string" && items.charAt(0) === "$") {
      const name = items.slice(1);
      if (/^\d+$/.test(name)) {
        e.emit(OP.ITEMS_NEW);
        e.emit(OP.BAG_INDEX, Number(name));
        const miss = e.emitHole(OP.JZ);
        e.emit(OP.ITEMS_PUSH);
        e.patch(miss, e.here());
      } else {
        compileBagFieldToItems(e, name);
      }
    } else {
      e.emit(OP.ITEMS_NEW);
    }
    e.emit(OP.ITEMS_FORMAT);
    e.emit(OP.JOIN_DYN);
    return;
  }
  e.refuse("bad template");
}

function compileBagChildrenToItems(e, includePunct) {
  // items = bag nodes that are (includePunct or !punct)
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.BAG_LEN_MISSING);
}

// I don't have BAG_LEN or bag iteration except BAG_INDEX / BAG_FIELD / BAG_FMT_KIND.
// Add BAG_LEN op? Or walk with BAG_INDEX 0,1,2,... we don't know length.
//
// Add OP.BAG_LEN = 42 (no imm) and OP.BAG_GET = 43 (pop i, push node; refuse oob)
// That's enough to iterate the bag.
//
// Actually I already have BAG_INDEX which pushes node+flag without refusing.
// But I need the length to loop. ADD BAG_LEN.

function compileTemplate(e, rule) {
  e.emit(OP.TAKE_ALL);
  if (rule.doc == null) {
    e.refuse("template missing doc");
    return;
  }
  compileTemplateSpec(e, rule.doc);
  if (rule.paren) e.emit(OP.PAREN);
  e.emit(OP.HALT);
}

function compileClause(e, rule) {
  e.emit(OP.TAKE_ALL);
  const kw = rule.keyword || "";
  const header = rule.header || [];
  e.text(kw + (header.length ? " " : ""));
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.STORE, 0);

  for (const h of header) {
    e.emit(OP.BAG_FIELD, e.intern(h));
    const notField = e.emitHole(OP.JZ);
    e.emit(OP.FORMAT);
    e.emit(OP.LOAD, 0);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 0);
    const next = e.emitHole(OP.JMP);

    e.patch(notField, e.here());
    e.emit(OP.BAG_KIND, e.intern(h));
    const notKind = e.emitHole(OP.JZ);
    e.emit(OP.FORMAT);
    e.emit(OP.LOAD, 0);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 0);
    const next2 = e.emitHole(OP.JMP);

    e.patch(notKind, e.here());
    e.emit(OP.BAG_TOKEN, e.intern(h));
    const notTok = e.emitHole(OP.JZ);
    e.text(" " + h + " ");
    e.emit(OP.LOAD, 0);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 0);
    e.patch(notTok, e.here());
    e.patch(next, e.here());
    e.patch(next2, e.here());
  }

  if (rule.arrow) {
    e.emit(OP.BAG_FIELD, e.intern(rule.arrow));
    const miss = e.emitHole(OP.JZ);
    e.text(" -> ");
    e.emit(OP.FORMAT);
    e.emit(OP.LOAD, 0);
    e.emit(OP.PUSH_I, 2);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 0);
    e.patch(miss, e.here());
  }
  if (rule.colon) {
    e.text(":");
    e.emit(OP.LOAD, 0);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 0);
  }

  // body: field or first "block"
  if (rule.body) {
    e.emit(OP.BAG_FIELD, e.intern(rule.body));
    const missF = e.emitHole(OP.JZ);
    emitIndentedBody(e);
    const after = e.emitHole(OP.JMP);
    e.patch(missF, e.here());
    e.emit(OP.BAG_KIND, e.intern("block"));
    const missB = e.emitHole(OP.JZ);
    emitIndentedBody(e);
    e.patch(missB, e.here());
    e.patch(after, e.here());
  } else {
    e.emit(OP.BAG_KIND, e.intern("block"));
    const missB = e.emitHole(OP.JZ);
    emitIndentedBody(e);
    e.patch(missB, e.here());
  }

  for (const t of rule.tails || []) {
    e.emit(OP.BAG_FMT_KIND, e.intern(t));
    // BAG_FMT_KIND pushes one doc (possibly empty concat) — always include
    e.emit(OP.LOAD, 0);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 0);
  }

  e.emit(OP.LOAD, 0);
  e.emit(OP.CONCAT_DYN);
  e.emit(OP.HALT);
}

function emitIndentedBody(e) {
  e.emit(OP.HARDLINE);
  e.emit(OP.SWAP_D);
  e.emit(OP.FORMAT);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.INDENT);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
}

function compileChain(e, rule) {
  const flags = (rule.already_flat ? 1 : 0) | (rule.break === "paren" ? 2 : 0);
  if (!rule.already_flat) {
    e.emit(OP.TAKE_ALL);
  }
  e.emit(OP.HOST_CHAIN, flags);
  e.emit(OP.HALT);
}

function compileFromImport(e) {
  e.emit(OP.HOST_FROM_IMPORT);
  e.emit(OP.HALT);
}

function compileKind(e, kind, rule, type) {
  switch (kind) {
    case "leaf":
      return compileLeaf(e);
    case "opaque":
      return compileOpaque(e);
    case "fwd":
      return compileFwd(e, type);
    case "infix":
      return compileInfix(e, rule, type);
    case "seq":
      return compileSeqFixed(e, rule, type);
    case "wrap":
      return compileWrap(e, rule, type);
    case "pfx":
      return compilePfx(e, rule, type);
    case "body":
      return compileBodyFixed(e, rule);
    case "comp":
      return compileComp(e, rule, type);
    case "dot":
      return compileDot(e, rule);
    case "sub":
      return compileSub(e, type);
    case "template":
      return compileTemplate(e, rule);
    case "clause":
      return compileClause(e, rule);
    case "chain":
      return compileChain(e, rule);
    case "from_import":
      return compileFromImport(e);
    default:
      e.refuse(`unknown kind ${kind} for ${type}`);
  }
}

// ---- bag helpers used by template: need BAG_LEN + BAG_GET ----
// I'll add these ops rather than rewrite template as a host op.

function compileBagChildrenConcat(e, includePunct) {
  // iterate bag, format non-punct (or all), concat
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1); // i
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 2); // count
  e.emit(OP.BAG_LEN);
  e.emit(OP.STORE, 3);
  const loop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 3);
  e.emit(OP.LT);
  const done = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 1);
  e.emit(OP.BAG_GET);
  if (!includePunct) {
    e.emit(OP.NODE_PUNCT);
    const skip = e.emitHole(OP.JNZ);
    e.emit(OP.FORMAT);
    e.emit(OP.LOAD, 2);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 2);
    const next = e.emitHole(OP.JMP);
    e.patch(skip, e.here());
    e.emit(OP.DROP_N);
    e.patch(next, e.here());
  } else {
    e.emit(OP.FORMAT);
    e.emit(OP.LOAD, 2);
    e.emit(OP.PUSH_I, 1);
    e.emit(OP.ADD);
    e.emit(OP.STORE, 2);
  }
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(loop);
  e.patch(done, e.here());
  e.emit(OP.LOAD, 2);
  e.emit(OP.CONCAT_DYN);
}

function compileBagFieldConcat(e, name) {
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  e.emit(OP.BAG_LEN);
  e.emit(OP.STORE, 3);
  const loop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 3);
  e.emit(OP.LT);
  const done = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 1);
  e.emit(OP.BAG_GET);
  e.nodeField(name);
  const no = e.emitHole(OP.JZ);
  e.emit(OP.ITEMS_PUSH);
  const next = e.emitHole(OP.JMP);
  e.patch(no, e.here());
  e.emit(OP.DROP_N);
  e.patch(next, e.here());
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(loop);
  e.patch(done, e.here());
  e.emit(OP.ITEMS_FORMAT);
  e.emit(OP.CONCAT_DYN);
}

function compileBagFieldToItems(e, name) {
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  e.emit(OP.BAG_LEN);
  e.emit(OP.STORE, 3);
  const loop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 3);
  e.emit(OP.LT);
  const done = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 1);
  e.emit(OP.BAG_GET);
  e.nodeField(name);
  const no = e.emitHole(OP.JZ);
  e.emit(OP.ITEMS_PUSH);
  const next = e.emitHole(OP.JMP);
  e.patch(no, e.here());
  e.emit(OP.DROP_N);
  e.patch(next, e.here());
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(loop);
  e.patch(done, e.here());
}

function compileBagChildrenToItemsFixed(e) {
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  e.emit(OP.BAG_LEN);
  e.emit(OP.STORE, 3);
  const loop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.LOAD, 3);
  e.emit(OP.LT);
  const done = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 1);
  e.emit(OP.BAG_GET);
  e.emit(OP.NODE_PUNCT);
  const skip = e.emitHole(OP.JNZ);
  e.emit(OP.ITEMS_PUSH);
  const next = e.emitHole(OP.JMP);
  e.patch(skip, e.here());
  e.emit(OP.DROP_N);
  e.patch(next, e.here());
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(loop);
  e.patch(done, e.here());
}

function compilePackage(src) {
  const e = new Emitter();
  const entry = {};
  const kinds = {};

  const defaults = {};
  defaults.leaf = e.here();
  compileLeaf(e);
  defaults.opaque = e.here();
  compileOpaque(e);
  defaults.fwd = e.here();
  compileFwd(e, "<fwd>");

  const nodes = src.nodes || {};
  for (const type of Object.keys(nodes)) {
    const rule = nodes[type];
    const kind = rule.kind;
    kinds[type] = kind;
    entry[type] = e.here();
    compileKind(e, kind, rule, type);
  }

  // Patch template helpers that used missing ops: rewrite compileTemplate
  // to use the fixed bag walkers. The functions compileBagChildrenConcat
  // and compileBagFieldConcat emit BAG_LEN / BAG_GET.

  return {
    language: src.language,
    indent: src.indent || 2,
    comment_type: src.comment_type || null,
    opaque: src.opaque || [],
    steal_into_body: src.steal_into_body || [],
    blank: src.blank || { max: 0, before_top: [] },
    consts: e.consts,
    entry,
    kinds,
    defaults,
    code: e.code,
  };
}

// Fix template compilation to use the real bag walkers.
// Re-bind the helper names used inside compileTemplateSpec.
function installTemplateFixes() {
  // compileTemplateSpec calls compileBagChildrenConcat / compileBagFieldConcat
  // / compileBagChildrenToItems. Replace compileBagChildrenToItems body.
}

// I referenced compileBagChildrenToItems (missing BAG_LEN) from compileTemplateSpec.
// Patch that function's call site by rewriting compileTemplateSpec's $children
// and join $children to use the Fixed versions. Easiest: replace the function
// after the fact.

function compileTemplateSpecFixed(e, spec) {
  if (typeof spec === "string") {
    if (spec === "$children") {
      compileBagChildrenConcat(e, false);
      return;
    }
    if (spec.charAt(0) === "$") {
      const name = spec.slice(1);
      if (/^\d+$/.test(name)) {
        e.emit(OP.BAG_INDEX, Number(name));
        const miss = e.emitHole(OP.JZ);
        e.emit(OP.FORMAT);
        const done = e.emitHole(OP.JMP);
        e.patch(miss, e.here());
        e.text("");
        e.patch(done, e.here());
        return;
      }
      compileBagFieldConcat(e, name);
      return;
    }
    e.text(spec);
    return;
  }
  if (Array.isArray(spec)) {
    if (spec.length === 0) {
      e.text("");
      return;
    }
    for (const item of spec) compileTemplateSpecFixed(e, item);
    e.emit(OP.CONCAT, spec.length);
    return;
  }
  if (spec && spec.join) {
    const sep = spec.join.sep != null ? spec.join.sep : "";
    const items = spec.join.items || "$children";
    e.text(sep);
    if (items === "$children") {
      compileBagChildrenToItemsFixed(e);
    } else if (typeof items === "string" && items.charAt(0) === "$") {
      const name = items.slice(1);
      if (/^\d+$/.test(name)) {
        e.emit(OP.ITEMS_NEW);
        e.emit(OP.BAG_INDEX, Number(name));
        const miss = e.emitHole(OP.JZ);
        e.emit(OP.ITEMS_PUSH);
        e.patch(miss, e.here());
      } else {
        compileBagFieldToItems(e, name);
      }
    } else {
      e.emit(OP.ITEMS_NEW);
    }
    e.emit(OP.ITEMS_FORMAT);
    e.emit(OP.JOIN_DYN);
    return;
  }
  e.refuse("bad template");
}

function compileTemplateFixed(e, rule) {
  e.emit(OP.TAKE_ALL);
  if (rule.doc == null) {
    e.refuse("template missing doc");
    return;
  }
  compileTemplateSpecFixed(e, rule.doc);
  if (rule.paren) e.emit(OP.PAREN);
  e.emit(OP.HALT);
}

function compileKindFixed(e, kind, rule, type) {
  if (kind === "template") return compileTemplateFixed(e, rule);
  if (kind === "seq") return compileSeqFixed(e, rule, type);
  if (kind === "body") return compileBodyFixed(e, rule);
  return compileKind(e, kind, rule, type);
}

function compilePackageFixed(src) {
  const e = new Emitter();
  const entry = {};
  const kinds = {};

  const defaults = {};
  defaults.leaf = e.here();
  compileLeaf(e);
  defaults.opaque = e.here();
  compileOpaque(e);
  defaults.fwd = e.here();
  compileFwd(e, "<fwd>");

  const nodes = src.nodes || {};
  for (const type of Object.keys(nodes)) {
    const rule = nodes[type];
    kinds[type] = rule.kind;
    entry[type] = e.here();
    compileKindFixed(e, rule.kind, rule, type);
  }

  return {
    language: src.language,
    indent: src.indent || 2,
    comment_type: src.comment_type || null,
    opaque: src.opaque || [],
    steal_into_body: src.steal_into_body || [],
    blank: {
      max: (src.blank && src.blank.max) || 0,
      before_top: (src.blank && src.blank.before_top) || [],
    },
    consts: e.consts,
    entry,
    kinds,
    defaults,
    code: e.code,
  };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const srcDir = path.join(root, "packages", "src");
  const outDir = path.join(root, "packages");
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const src = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf8"));
    const bc = compilePackageFixed(src);
    decode(bc.code); // fail fast on bad encoding
    const out = path.join(outDir, f);
    fs.writeFileSync(out, JSON.stringify(bc));
    console.error(
      `compiled ${f}: ${bc.code.length} ints, ${bc.consts.length} consts, ${Object.keys(bc.entry).length} entries`,
    );
  }
}

if (require.main === module) main();

module.exports = { compilePackage: compilePackageFixed, Emitter, OP };
