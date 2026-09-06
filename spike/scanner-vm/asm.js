// Assembler for the scanner VM.  Offline tooling -- this never ships; only the
// bytecode it produces does.  Two passes so forward label references work.
const { OP } = require('./vm.js');

const ALU = { add: 0, sub: 1, and: 2, or: 3, xor: 4, shl: 5, sar: 6, mod: 7 };
const CMP = { eq: 0, ne: 1, lt: 2, le: 3, gt: 4, ge: 5 };

class Asm {
  constructor() { this.items = []; this.labels = new Map(); }

  label(name) {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.items.push({ kind: 'label', name });
    return this;
  }
  ins(op, ...ops) { this.items.push({ kind: 'ins', op, ops }); return this; }

  // -- lexer
  advance() { return this.ins(OP.ADVANCE); }
  skip() { return this.ins(OP.SKIP); }
  markEnd() { return this.ins(OP.MARK_END); }
  lookahead(r) { return this.ins(OP.LOOKAHEAD, ['r', r]); }
  eof(r) { return this.ins(OP.EOF, ['r', r]); }
  map(k, d, s) { return this.ins(OP.MAP, ['u', k], ['r', d], ['r', s]); }
  // -- termination
  emit(sym) { return this.ins(OP.EMIT, ['u', sym]); }
  emitR(r) { return this.ins(OP.EMIT_R, ['r', r]); }
  fail() { return this.ins(OP.FAIL); }
  emitIf(r, sym) { return this.ins(OP.EMIT_IF, ['r', r], ['u', sym]); }
  // -- lookahead tests
  ifChar(c, t) { return this.ins(OP.IF_CHAR, ['u', c], ['t', t]); }
  ifNChar(c, t) { return this.ins(OP.IF_NCHAR, ['u', c], ['t', t]); }
  ifClass(k, t) { return this.ins(OP.IF_CLASS, ['u', k], ['t', t]); }
  ifNClass(k, t) { return this.ins(OP.IF_NCLASS, ['u', k], ['t', t]); }
  ifEof(t) { return this.ins(OP.IF_EOF, ['t', t]); }
  ifNEof(t) { return this.ins(OP.IF_NEOF, ['t', t]); }
  // -- valid-symbol tests
  ifValid(s, t) { return this.ins(OP.IF_VALID, ['u', s], ['t', t]); }
  ifNValid(s, t) { return this.ins(OP.IF_NVALID, ['u', s], ['t', t]); }
  ifValidR(r, t) { return this.ins(OP.IF_VALID_R, ['r', r], ['t', t]); }
  ifNValidR(r, t) { return this.ins(OP.IF_NVALID_R, ['r', r], ['t', t]); }
  // -- registers
  const_(r, v) { return this.ins(OP.CONST, ['r', r], ['s', v]); }
  mov(d, s) { return this.ins(OP.MOV, ['r', d], ['r', s]); }
  alu(o, d, s) { return this.ins(OP.ALU, ['b', ALU[o]], ['r', d], ['r', s]); }
  alui(o, d, v) { return this.ins(OP.ALUI, ['b', ALU[o]], ['r', d], ['s', v]); }
  ifCmp(o, a, b, t) { return this.ins(OP.IF_CMP, ['b', CMP[o]], ['r', a], ['r', b], ['t', t]); }
  ifCmpI(o, a, v, t) { return this.ins(OP.IF_CMPI, ['b', CMP[o]], ['r', a], ['s', v], ['t', t]); }
  // -- stacks
  push(k, r) { return this.ins(OP.PUSH, ['b', k], ['r', r]); }
  pop(k, r) { return this.ins(OP.POP, ['b', k], ['r', r]); }
  peek(k, r, off) { return this.ins(OP.PEEK, ['b', k], ['r', r], ['u', off]); }
  settop(k, r) { return this.ins(OP.SETTOP, ['b', k], ['r', r]); }
  getidx(k, r, ri) { return this.ins(OP.GETIDX, ['b', k], ['r', r], ['r', ri]); }
  len(k, r) { return this.ins(OP.LEN, ['b', k], ['r', r]); }
  clear(k) { return this.ins(OP.CLEAR, ['b', k]); }
  // -- buffer
  bufClr() { return this.ins(OP.BUF_CLR); }
  bufPush(r) { return this.ins(OP.BUF_PUSH, ['r', r]); }
  bufLen(r) { return this.ins(OP.BUF_LEN, ['r', r]); }
  ifBufEq(s, t) { return this.ins(OP.IF_BUF_EQ, ['u', s], ['t', t]); }
  // -- control
  jmp(t) { return this.ins(OP.JMP, ['t', t]); }
  call(t) { return this.ins(OP.CALL, ['t', t]); }
  ret() { return this.ins(OP.RET); }
  callR(r) { return this.ins(OP.CALL_R, ['r', r]); }
  recurse(vs, r) { return this.ins(OP.RECURSE, ['u', vs], ['r', r]); }

  build() {
    // Pass 1: sizes with worst-case (2-byte) targets, which is also the real
    // size -- targets are always encoded as a fixed 2-byte LE word.
    let pos = 0;
    for (const it of this.items) {
      if (it.kind === 'label') { this.labels.set(it.name, pos); continue; }
      pos += 1;
      for (const [k, v] of it.ops) pos += operandSize(k, v);
    }
    // Pass 2: encode.
    const out = [];
    for (const it of this.items) {
      if (it.kind === 'label') continue;
      out.push(it.op);
      for (const [k, v] of it.ops) encodeOperand(out, k, v, this.labels);
    }
    if (out.length > 0xffff) throw new Error('program exceeds 64 KiB');
    return Uint8Array.from(out);
  }
}

function operandSize(kind, v) {
  switch (kind) {
    case 'r': case 'b': return 1;
    case 't': return 2;
    case 'u': return ulebSize(v);
    case 's': return slebSize(v);
    default: throw new Error(`bad operand kind ${kind}`);
  }
}
function encodeOperand(out, kind, v, labels) {
  switch (kind) {
    case 'r': case 'b': out.push(v & 0xff); return;
    case 't': {
      const t = labels.get(v);
      if (t === undefined) throw new Error(`undefined label ${v}`);
      out.push(t & 0xff, (t >> 8) & 0xff);
      return;
    }
    case 'u': { let x = v >>> 0; do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; out.push(b); } while (x); return; }
    case 's': {
      let x = v | 0;
      for (;;) {
        const b = x & 0x7f; x >>= 7;
        if ((x === 0 && !(b & 0x40)) || (x === -1 && (b & 0x40))) { out.push(b); return; }
        out.push(b | 0x80);
      }
    }
  }
}
function ulebSize(v) { let n = 0, x = v >>> 0; do { x >>>= 7; n++; } while (x); return n; }
function slebSize(v) {
  let n = 0, x = v | 0;
  for (;;) { const b = x & 0x7f; x >>= 7; n++; if ((x === 0 && !(b & 0x40)) || (x === -1 && (b & 0x40))) return n; }
}

module.exports = { Asm, ALU, CMP };
