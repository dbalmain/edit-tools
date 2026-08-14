"use strict";

// Compile an authored kinds package into a bytecode package.
// Each kind's program is emitted once. Node types point at that
// program and carry their own operand vector (brackets, flags, field
// names). Templates stay unrolled: the spec is the program.

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

  emitHole(op) {
    this.code.push(op);
    const i = this.code.length;
    this.code.push(0);
    return i;
  }

  patch(i, value) {
    this.code[i] = value | 0;
  }

  jzTo(pc) {
    this.emit(OP.JZ, pc);
  }
  jnzTo(pc) {
    this.emit(OP.JNZ, pc);
  }
  jmpTo(pc) {
    this.emit(OP.JMP, pc);
  }

  atext(n) {
    this.emit(OP.ARG, n);
    this.emit(OP.CTEXT);
  }
  apeek(n) {
    this.emit(OP.ARG, n);
    this.emit(OP.CPEEK);
  }
  atoken(n) {
    this.emit(OP.ARG, n);
    this.emit(OP.CTOKEN);
  }
  afield(n) {
    this.emit(OP.ARG, n);
    this.emit(OP.CFIELD);
  }
}

function compileLeaf(e) {
  e.emit(OP.LEAF);
  e.emit(OP.HALT);
}

function compileOpaque(e) {
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.SKIP);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.OPAQUE);
  e.emit(OP.HALT);
}

function compileFwd(e) {
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
  e.refuse("fwd has multiple significant children");
}

function compileInfix(e) {
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.ARG, 0);
  const hasOp = e.emitHole(OP.JNZ);
  e.text("");
  e.emit(OP.DSTORE, 0);
  const afterInit = e.emitHole(OP.JMP);
  e.patch(hasOp, e.here());
  e.atext(1);
  e.emit(OP.DSTORE, 0);
  e.patch(afterInit, e.here());

  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  e.emit(OP.ARG, 0);
  const useToken = e.emitHole(OP.JNZ);

  e.afield(2);
  const isOpField = e.emitHole(OP.JNZ);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(isOpField, e.here());
  e.emit(OP.FORMAT_OP);
  e.text(" ");
  e.emit(OP.SWAP_D);
  e.text(" ");
  e.emit(OP.CONCAT, 3);
  e.emit(OP.DSTORE, 0);
  e.jmpTo(loop);

  e.patch(useToken, e.here());
  e.atoken(3);
  const isOp = e.emitHole(OP.JNZ);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(isOp, e.here());
  e.emit(OP.DROP_N);
  e.jmpTo(loop);

  e.patch(after, e.here());
  e.emit(OP.FINISH);
  e.emit(OP.ITEMS_LEN);
  e.emit(OP.DUP_I);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const hasOps = e.emitHole(OP.JZ);
  e.refuse("infix has no operands");
  e.patch(hasOps, e.here());
  e.emit(OP.DLOAD, 0);
  e.emit(OP.ITEMS_FORMAT);
  e.emit(OP.JOIN_DYN);
  e.emit(OP.HALT);
}

function compileSeq(e) {
  e.emit(OP.TAKE);
  e.atoken(0);
  const okOpen = e.emitHole(OP.JNZ);
  e.refuse("seq: expected open");
  e.patch(okOpen, e.here());
  e.emit(OP.DROP_N);

  e.emit(OP.EMPTY);
  const hasClose0 = e.emitHole(OP.JZ);
  e.refuse("seq: missing close");
  e.patch(hasClose0, e.here());

  e.apeek(1);
  const notEmpty = e.emitHole(OP.JZ);
  e.emit(OP.SKIP);
  e.emit(OP.FINISH);
  e.atext(3);
  e.emit(OP.HALT);

  e.patch(notEmpty, e.here());
  e.emit(OP.ITEMS_NEW);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 0);

  const itemLoop = e.here();
  e.apeek(1);
  const afterHole = e.emitHole(OP.JNZ);
  e.emit(OP.EMPTY);
  const notEmpty2 = e.emitHole(OP.JZ);
  e.refuse("seq: missing close");
  e.patch(notEmpty2, e.here());

  e.apeek(2);
  const notSep = e.emitHole(OP.JZ);
  e.refuse("seq: unexpected sep");
  e.patch(notSep, e.here());

  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);

  e.emit(OP.EMPTY);
  const hasAfterItem = e.emitHole(OP.JZ);
  e.refuse("seq: missing close");
  e.patch(hasAfterItem, e.here());

  e.apeek(2);
  const noSep = e.emitHole(OP.JZ);
  e.emit(OP.SKIP);
  e.apeek(1);
  const notTrail = e.emitHole(OP.JZ);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.STORE, 0);
  const trailJmp = e.emitHole(OP.JMP);
  e.patch(notTrail, e.here());
  e.jmpTo(itemLoop);

  e.patch(noSep, e.here());
  e.apeek(1);
  const goodClose = e.emitHole(OP.JNZ);
  e.refuse("seq: expected sep or close");
  e.patch(goodClose, e.here());
  e.jmpTo(itemLoop);

  const afterItemsPc = e.here();
  e.patch(afterHole, afterItemsPc);
  e.patch(trailJmp, afterItemsPc);

  e.apeek(1);
  const gotClose = e.emitHole(OP.JNZ);
  e.refuse("seq: missing close");
  e.patch(gotClose, e.here());
  e.emit(OP.SKIP);
  e.emit(OP.FINISH);

  e.emit(OP.ARG, 6);
  const skipNone = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 0);
  const noTrail = e.emitHole(OP.JZ);
  e.refuse("seq: trailing sep is forbidden");
  e.patch(noTrail, e.here());
  e.patch(skipNone, e.here());

  e.emit(OP.ARG, 4);
  const useSoft = e.emitHole(OP.JZ);
  e.emit(OP.LINE);
  const afterPad = e.emitHole(OP.JMP);
  e.patch(useSoft, e.here());
  e.emit(OP.SOFTLINE);
  e.patch(afterPad, e.here());
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
  e.atext(2);
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

  e.emit(OP.ARG, 5);
  const notSingKind = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 2);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.EQ);
  const notSing = e.emitHole(OP.JZ);
  e.atext(2);
  e.emit(OP.CONCAT, 2);
  const afterSing = e.emitHole(OP.JMP);
  e.patch(notSing, e.here());
  e.emit(OP.ARG, 8);
  const noTrailBrk = e.emitHole(OP.JZ);
  e.atext(2);
  e.text("");
  e.emit(OP.IF_BREAK);
  e.emit(OP.CONCAT, 2);
  e.patch(noTrailBrk, e.here());
  e.patch(afterSing, e.here());
  const afterSingKind = e.emitHole(OP.JMP);

  e.patch(notSingKind, e.here());
  e.emit(OP.ARG, 8);
  const noTrailBrk2 = e.emitHole(OP.JZ);
  e.atext(2);
  e.text("");
  e.emit(OP.IF_BREAK);
  e.emit(OP.CONCAT, 2);
  e.patch(noTrailBrk2, e.here());
  e.patch(afterSingKind, e.here());

  e.atext(0);
  e.emit(OP.SWAP_D);
  e.emit(OP.INDENT);
  e.emit(OP.DLOAD, 0);
  e.atext(1);
  e.emit(OP.CONCAT, 4);

  e.emit(OP.ARG, 7);
  const noMagic = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 0);
  e.emit(OP.ARG, 5);
  const noSingMagic = e.emitHole(OP.JZ);
  e.emit(OP.LOAD, 2);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.EQ);
  const isSing = e.emitHole(OP.JNZ);
  e.emit(OP.GROUP_BREAK);
  const doneMagic = e.emitHole(OP.JMP);
  e.patch(isSing, e.here());
  e.emit(OP.DROP_I);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.GROUP_BREAK);
  e.patch(doneMagic, e.here());
  const afterMagic = e.emitHole(OP.JMP);
  e.patch(noSingMagic, e.here());
  e.emit(OP.GROUP_BREAK);
  e.patch(afterMagic, e.here());
  const afterGroup = e.emitHole(OP.JMP);
  e.patch(noMagic, e.here());
  e.emit(OP.GROUP);
  e.patch(afterGroup, e.here());
  e.emit(OP.HALT);
}

function compileWrap(e) {
  e.emit(OP.TAKE);
  e.atoken(0);
  const okO = e.emitHole(OP.JNZ);
  e.refuse("wrap: expected open");
  e.patch(okO, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.TAKE);
  e.emit(OP.FORMAT);
  e.emit(OP.TAKE);
  e.atoken(1);
  const okC = e.emitHole(OP.JNZ);
  e.refuse("wrap: expected close");
  e.patch(okC, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.FINISH);
  e.emit(OP.SOFTLINE);
  e.emit(OP.SWAP_D);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.INDENT);
  e.atext(0);
  e.emit(OP.SWAP_D);
  e.emit(OP.SOFTLINE);
  e.atext(1);
  e.emit(OP.CONCAT, 4);
  e.emit(OP.GROUP);
  e.emit(OP.HALT);
}

function compilePfxTail(e) {
  e.emit(OP.ITEMS_NEW);
  const loop = e.here();
  e.emit(OP.EMPTY);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.emit(OP.FINISH);

  e.emit(OP.ARG, 2);
  const noSp = e.emitHole(OP.JZ);
  e.emit(OP.ITEMS_LEN);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const skipSp = e.emitHole(OP.JNZ);
  e.text(" ");
  e.emit(OP.CONCAT, 2);
  e.patch(skipSp, e.here());
  e.patch(noSp, e.here());

  e.emit(OP.ITEMS_FORMAT);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.CONCAT_DYN);
  e.emit(OP.ARG, 3);
  const noParen = e.emitHole(OP.JZ);
  e.emit(OP.PAREN);
  e.patch(noParen, e.here());
  e.emit(OP.HALT);
}

function compilePfx(e) {
  e.emit(OP.ARG, 0);
  e.emit(OP.DUP_I);
  e.emit(OP.PUSH_I, 2);
  e.emit(OP.EQ);
  const fields = e.emitHole(OP.JNZ);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.EQ);
  const opField = e.emitHole(OP.JNZ);

  e.emit(OP.TAKE);
  e.atoken(1);
  const ok = e.emitHole(OP.JNZ);
  e.refuse("pfx: expected keyword");
  e.patch(ok, e.here());
  e.emit(OP.DROP_N);
  e.atext(1);
  compilePfxTail(e);

  e.patch(opField, e.here());
  e.emit(OP.TAKE);
  e.emit(OP.NODE_RAW);
  compilePfxTail(e);

  e.patch(fields, e.here());
  e.emit(OP.DROP_I);
  e.emit(OP.TAKE_ALL);
  e.emit(OP.CBAG_ONLY, 4);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 0);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  const fLoop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.ARG, 4);
  e.emit(OP.LT);
  const fDone = e.emitHole(OP.JZ);
  e.emit(OP.PUSH_I, 5);
  e.emit(OP.LOAD, 1);
  e.emit(OP.ADD);
  e.emit(OP.ARGI);
  e.emit(OP.CBAG_FIELD);
  const miss = e.emitHole(OP.JZ);
  e.emit(OP.FORMAT);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  e.patch(miss, e.here());
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(fLoop);
  e.patch(fDone, e.here());
  e.emit(OP.LOAD, 0);
  e.emit(OP.CONCAT_DYN);
  e.emit(OP.ARG, 3);
  const noParenF = e.emitHole(OP.JZ);
  e.emit(OP.PAREN);
  e.patch(noParenF, e.here());
  e.emit(OP.HALT);
}

function compileBody(e) {
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

  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.EQ);
  const hasStmts = e.emitHole(OP.JZ);
  e.text("");
  e.emit(OP.APPEND_DANGLING);
  e.emit(OP.HALT);
  e.patch(hasStmts, e.here());

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
  e.emit(OP.ARG, 0);
  const skipBlank = e.emitHole(OP.JNZ);
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
  e.patch(skipBlank, e.here());

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

function compileComp(e) {
  e.emit(OP.TAKE);
  e.atoken(0);
  const okO = e.emitHole(OP.JNZ);
  e.refuse("comp: expected open");
  e.patch(okO, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.ITEMS_NEW);
  const loop = e.here();
  e.apeek(1);
  const after = e.emitHole(OP.JNZ);
  e.emit(OP.EMPTY);
  const notEmpty = e.emitHole(OP.JZ);
  e.refuse("comp: missing close");
  e.patch(notEmpty, e.here());
  e.emit(OP.TAKE);
  e.emit(OP.ITEMS_PUSH);
  e.jmpTo(loop);
  e.patch(after, e.here());
  e.apeek(1);
  const okC = e.emitHole(OP.JNZ);
  e.refuse("comp: missing close");
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

  e.atext(0);
  e.emit(OP.SWAP_D);
  e.emit(OP.INDENT);
  e.emit(OP.SOFTLINE);
  e.atext(1);
  e.emit(OP.CONCAT, 4);
  e.emit(OP.GROUP);
  e.emit(OP.HALT);
}

function compileDot(e) {
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
  e.emit(OP.ARG, 0);
  const noParen = e.emitHole(OP.JZ);
  e.emit(OP.PAREN);
  e.patch(noParen, e.here());
  e.emit(OP.HALT);
}

function compileSub(e) {
  e.emit(OP.TAKE);
  e.emit(OP.FORMAT);
  e.emit(OP.TAKE);
  e.emit(OP.NODE_TOKEN, e.intern("["));
  const okO = e.emitHole(OP.JNZ);
  e.refuse("sub: expected [");
  e.patch(okO, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.TAKE);
  e.emit(OP.FORMAT);
  e.emit(OP.TAKE);
  e.emit(OP.NODE_TOKEN, e.intern("]"));
  const okC = e.emitHole(OP.JNZ);
  e.refuse("sub: expected ]");
  e.patch(okC, e.here());
  e.emit(OP.DROP_N);
  e.emit(OP.FINISH);
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

function emitIndentedBody(e) {
  e.emit(OP.FORMAT);
  e.emit(OP.HARDLINE);
  e.emit(OP.SWAP_D);
  e.emit(OP.CONCAT, 2);
  e.emit(OP.INDENT);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
}

function compileClause(e) {
  e.emit(OP.TAKE_ALL);
  e.atext(0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.STORE, 0);

  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  const hLoop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.ARG, 1);
  e.emit(OP.LT);
  const hDone = e.emitHole(OP.JZ);

  e.emit(OP.PUSH_I, 8);
  e.emit(OP.LOAD, 1);
  e.emit(OP.ADD);
  e.emit(OP.ARGI);
  e.emit(OP.DUP_I);
  e.emit(OP.STORE, 2);

  e.emit(OP.CBAG_FIELD);
  const notField = e.emitHole(OP.JZ);
  e.emit(OP.FORMAT);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  const nextH = e.emitHole(OP.JMP);

  e.patch(notField, e.here());
  e.emit(OP.LOAD, 2);
  e.emit(OP.CBAG_KIND);
  const notKind = e.emitHole(OP.JZ);
  e.emit(OP.FORMAT);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  const nextH2 = e.emitHole(OP.JMP);

  e.patch(notKind, e.here());
  e.emit(OP.LOAD, 2);
  e.emit(OP.CBAG_TOKEN);
  const notTok = e.emitHole(OP.JZ);
  e.text(" ");
  e.emit(OP.LOAD, 2);
  e.emit(OP.CTEXT);
  e.text(" ");
  e.emit(OP.CONCAT, 3);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  e.patch(notTok, e.here());
  e.patch(nextH, e.here());
  e.patch(nextH2, e.here());

  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(hLoop);
  e.patch(hDone, e.here());

  e.emit(OP.ARG, 5);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.LT);
  const noArrow = e.emitHole(OP.JNZ);
  e.emit(OP.ARG, 5);
  e.emit(OP.CBAG_FIELD);
  const missArrow = e.emitHole(OP.JZ);
  e.text(" -> ");
  e.emit(OP.FORMAT);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 2);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  e.patch(missArrow, e.here());
  e.patch(noArrow, e.here());

  e.emit(OP.ARG, 2);
  const noColon = e.emitHole(OP.JZ);
  e.text(":");
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  e.patch(noColon, e.here());

  e.emit(OP.ARG, 3);
  const noBody = e.emitHole(OP.JZ);
  e.emit(OP.ARG, 3);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.EQ);
  const blockOnly = e.emitHole(OP.JZ);
  e.emit(OP.ARG, 4);
  e.emit(OP.CBAG_FIELD);
  const missF = e.emitHole(OP.JZ);
  emitIndentedBody(e);
  const afterBody = e.emitHole(OP.JMP);
  e.patch(missF, e.here());
  e.emit(OP.BAG_KIND, e.intern("block"));
  const missB = e.emitHole(OP.JZ);
  emitIndentedBody(e);
  e.patch(missB, e.here());
  e.patch(afterBody, e.here());
  const afterBodyMode = e.emitHole(OP.JMP);

  e.patch(blockOnly, e.here());
  e.emit(OP.BAG_KIND, e.intern("block"));
  const missB2 = e.emitHole(OP.JZ);
  emitIndentedBody(e);
  e.patch(missB2, e.here());
  e.patch(afterBodyMode, e.here());
  e.patch(noBody, e.here());

  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  const tLoop = e.here();
  e.emit(OP.LOAD, 1);
  e.emit(OP.ARG, 6);
  e.emit(OP.LT);
  const tDone = e.emitHole(OP.JZ);
  e.emit(OP.PUSH_I, 8);
  e.emit(OP.ARG, 1);
  e.emit(OP.ADD);
  e.emit(OP.LOAD, 1);
  e.emit(OP.ADD);
  e.emit(OP.ARGI);
  e.emit(OP.CBAG_FMT);
  e.emit(OP.LOAD, 0);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 0);
  e.emit(OP.LOAD, 1);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 1);
  e.jmpTo(tLoop);
  e.patch(tDone, e.here());

  e.emit(OP.LOAD, 0);
  e.emit(OP.CONCAT_DYN);
  e.emit(OP.HALT);
}

function compileChain(e) {
  e.emit(OP.ARG, 0);
  const skipTake = e.emitHole(OP.JNZ);
  e.emit(OP.TAKE_ALL);
  e.patch(skipTake, e.here());
  e.emit(OP.ARG, 1);
  e.emit(OP.HOST_CHAIN);
  e.emit(OP.HALT);
}

function compileFromImport(e) {
  e.emit(OP.HOST_FROM_IMPORT);
  e.emit(OP.HALT);
}

function compileBagChildrenConcat(e) {
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 1);
  e.emit(OP.PUSH_I, 0);
  e.emit(OP.STORE, 2);
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
  e.emit(OP.FORMAT);
  e.emit(OP.LOAD, 2);
  e.emit(OP.PUSH_I, 1);
  e.emit(OP.ADD);
  e.emit(OP.STORE, 2);
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
  e.emit(OP.NODE_FIELD, e.intern(name));
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
  e.emit(OP.NODE_FIELD, e.intern(name));
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

function compileBagChildrenToItems(e) {
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

function compileTemplateSpec(e, spec) {
  if (typeof spec === "string") {
    if (spec === "$children") {
      compileBagChildrenConcat(e);
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
    for (const item of spec) compileTemplateSpec(e, item);
    e.emit(OP.CONCAT, spec.length);
    return;
  }
  if (spec && spec.join) {
    const sep = spec.join.sep != null ? spec.join.sep : "";
    const items = spec.join.items || "$children";
    e.text(sep);
    if (items === "$children") {
      compileBagChildrenToItems(e);
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

function argsFor(kind, rule, intern) {
  switch (kind) {
    case "seq": {
      const open = rule.open == null ? "" : String(rule.open);
      const close = rule.close == null ? "" : String(rule.close);
      const sep = rule.sep == null ? "," : String(rule.sep);
      return [
        intern(open),
        intern(close),
        intern(sep),
        intern(open + close),
        rule.flat_pad ? 1 : 0,
        rule.singleton_comma ? 1 : 0,
        rule.trailing === "none" ? 1 : 0,
        rule.trailing === "magic" ? 1 : 0,
        rule.trailing === "magic" || rule.trailing === "always-on-break" ? 1 : 0,
      ];
    }
    case "infix":
      return [
        rule.op != null ? 1 : 0,
        intern(rule.op != null ? rule.op : ""),
        intern(rule.op_field || ""),
        intern((rule.op || "").trim()),
      ];
    case "wrap":
    case "comp":
      return [intern(rule.open || ""), intern(rule.close || "")];
    case "pfx": {
      let mode = 0;
      if (rule.fields && rule.fields.length) mode = 2;
      else if (rule.op_field) mode = 1;
      const fields = rule.fields || [];
      return [
        mode,
        intern(rule.kw || ""),
        rule.sp ? 1 : 0,
        rule.paren ? 1 : 0,
        fields.length,
        ...fields.map((f) => intern(f)),
      ];
    }
    case "body":
      return [rule.tight ? 1 : 0];
    case "dot":
      return [rule.paren ? 1 : 0];
    case "chain":
      return [
        rule.already_flat ? 1 : 0,
        (rule.already_flat ? 1 : 0) | (rule.break === "paren" ? 2 : 0),
      ];
    case "clause": {
      const header = rule.header || [];
      const tails = rule.tails || [];
      const kw = rule.keyword || "";
      const kwText = kw + (header.length ? " " : "");
      let bodyMode = 2;
      if (rule.body) bodyMode = 1;
      return [
        intern(kwText),
        header.length,
        rule.colon ? 1 : 0,
        bodyMode,
        intern(rule.body || ""),
        rule.arrow ? intern(rule.arrow) : -1,
        tails.length,
        0,
        ...header.map((h) => intern(h)),
        ...tails.map((t) => intern(t)),
      ];
    }
    default:
      return [];
  }
}

const KIND_COMPILE = {
  leaf: compileLeaf,
  opaque: compileOpaque,
  fwd: compileFwd,
  infix: compileInfix,
  seq: compileSeq,
  wrap: compileWrap,
  pfx: compilePfx,
  body: compileBody,
  comp: compileComp,
  dot: compileDot,
  sub: compileSub,
  clause: compileClause,
  chain: compileChain,
  from_import: compileFromImport,
};

function compileShared(e, needed) {
  const progs = {};
  for (const kind of Object.keys(KIND_COMPILE)) {
    if (!needed.has(kind)) continue;
    progs[kind] = e.here();
    KIND_COMPILE[kind](e);
  }
  return progs;
}

function compilePackage(src) {
  const nodes = src.nodes || {};
  const needed = new Set(["leaf", "opaque", "fwd"]);
  for (const rule of Object.values(nodes)) {
    if (rule.kind && rule.kind !== "template") needed.add(rule.kind);
  }
  const e = new Emitter();
  const progs = compileShared(e, needed);
  const entry = {};
  const kinds = {};
  const args = {};

  for (const type of Object.keys(nodes)) {
    const rule = nodes[type];
    const kind = rule.kind;
    kinds[type] = kind;
    if (kind === "template") {
      entry[type] = e.here();
      compileTemplate(e, rule);
    } else if (progs[kind] != null) {
      entry[type] = progs[kind];
      const vec = argsFor(kind, rule, (s) => e.intern(s));
      if (vec.length) args[type] = vec;
    } else {
      entry[type] = e.here();
      e.refuse(`unknown kind ${kind} for ${type}`);
    }
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
    args,
    kinds,
    defaults: {
      leaf: progs.leaf,
      opaque: progs.opaque,
      fwd: progs.fwd,
    },
    code: e.code,
  };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const srcDir = path.join(root, "authored");
  const outDir = path.join(root, "packages");
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const src = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf8"));
    const bc = compilePackage(src);
    decode(bc.code);
    fs.writeFileSync(path.join(outDir, f), JSON.stringify(bc));
    const nTmpl = Object.values(bc.kinds).filter((k) => k === "template").length;
    console.error(
      `compiled ${f}: ${bc.code.length} ints, ${bc.consts.length} consts, ${Object.keys(bc.entry).length} entries, ${nTmpl} unrolled templates`,
    );
  }
}

if (require.main === module) main();

module.exports = { compilePackage, Emitter, OP };
