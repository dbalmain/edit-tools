// Scanner VM -- the shipped half.  Executes one language package's `scanner`
// program in place of a tree-sitter external scanner.  See docs/scanner-vm.md
// for the ISA and for why each instruction is shaped the way it is.
//
// This lived at `spike/scanner-vm/vm.js` while it was being priced.  It moved
// here when `harness/ts_lr.mjs` started driving it, because there must be
// exactly one copy: two runtimes disagreeing is the failure mode this whole
// route exists to make visible, and a second JS transcription would reintroduce
// it inside a single runtime.  `spike/scanner-vm/vm.js` is now a re-export, so
// the spike's replay and record harnesses still run against this file.
//
// The host supplies a lexer with six methods: lookahead(), advance(skip),
// markEnd(), atEof(), atRangeStart(), column().  Everything else is in here.
//
// The fifth arrived with javascript, whose automatic-semicolon scan calls
// `lexer->is_at_included_range_start`.  `docs/scanner-vm.md`'s host-interface
// table surveyed javascript and missed it: for a whole-document parse there is
// one included range and the answer is "position is zero", but that is a fact
// about the host, not about the VM, so the host answers it.
//
// Every value is a wrapping i32.  Every trap -- bad opcode, bad index, stack
// over/underflow, budget exhaustion -- halts the scan as `false`, identically
// in both runtimes.  There is no undefined behaviour and nothing throws.

// 32, not 16: markdown-block's parse_minus holds 11 locals live alongside the
// six scalars its Scanner struct carries, and a register operand is a whole
// byte either way, so the wider file costs nothing in encoded size.
const NREG = 32;
const NSTACK = 4;
const STACK_MAX = 256;
const BUF_MAX = 32;
const CALL_MAX = 32;
const RECURSE_MAX = 4;
// Instructions allowed between two consecutive lexer advances.  Bounds
// non-advancing loops without bounding total work on a large file.
const SPIN_BUDGET = 4096;

const OP = {
  NOP: 0x00,
  ADVANCE: 0x01, SKIP: 0x02, MARK_END: 0x03, LOOKAHEAD: 0x04, EOF: 0x05,
  GET_COLUMN: 0x06, MAP: 0x07,
  EMIT: 0x08, EMIT_R: 0x09, FAIL: 0x0a, EMIT_IF: 0x0b, EMIT_IF_R: 0x0c,
  IF_CHAR: 0x10, IF_NCHAR: 0x11, IF_CLASS: 0x12, IF_NCLASS: 0x13,
  IF_EOF: 0x14, IF_NEOF: 0x15, IF_RANGE_START: 0x16,
  IF_VALID: 0x18, IF_NVALID: 0x19, IF_VALID_R: 0x1a, IF_NVALID_R: 0x1b,
  CONST: 0x20, MOV: 0x21, ALU: 0x22, ALUI: 0x23,
  IF_CMP: 0x28, IF_CMPI: 0x29,
  PUSH: 0x30, POP: 0x31, PEEK: 0x32, SETTOP: 0x33, LEN: 0x34, CLEAR: 0x35,
  GETIDX: 0x36,
  BUF_CLR: 0x38, BUF_PUSH: 0x39, BUF_LEN: 0x3a, IF_BUF_EQ: 0x3b,
  JMP: 0x40, CALL: 0x41, RET: 0x42, CALL_R: 0x43, RECURSE: 0x44,
};

// Sentinel thrown internally to unwind out of a nested RECURSE.  Never escapes.
const HALT = Symbol('halt');

class ScannerVM {
  // `prog` is the decoded `scanner` section of a language package.
  constructor(prog) {
    this.code = prog.code;
    this.entry = prog.entry >>> 0;
    this.classes = prog.classes || [];
    this.maps = prog.maps || [];
    this.strings = prog.strings || [];
    this.validSets = prog.validSets || [];
    this.jumpTable = prog.jumpTable || [];
    this.regPersist = prog.regPersist >>> 0;
    this.stackSpec = prog.stacks || [];
    this.stackInit = prog.stackInit || [];

    this.reg = new Int32Array(NREG);
    this.stacks = [];
    for (let i = 0; i < NSTACK; i++) this.stacks.push([]);
    this.buf = new Uint8Array(BUF_MAX);
    this.buflen = 0;
    this.callStack = [];
    this.reset();
  }

  // Full reset: what `create` does upstream.
  reset() {
    this.reg.fill(0);
    for (let i = 0; i < NSTACK; i++) this.stacks[i].length = 0;
    for (const { stack, values } of this.stackInit) {
      for (const v of values) this.stacks[stack].push(v | 0);
    }
    this.buflen = 0;
  }

  // Clear only the transient half, at the start of each scan.
  enterScan() {
    for (let i = 0; i < NREG; i++) {
      if (!((this.regPersist >>> i) & 1)) this.reg[i] = 0;
    }
    for (let i = 0; i < NSTACK; i++) {
      const spec = this.stackSpec[i];
      if (!spec || !spec.persist) this.stacks[i].length = 0;
    }
    this.buflen = 0;
    this.callStack.length = 0;
  }

  // ---- serialize / deserialize -------------------------------------------
  // VM-defined and canonical, so no per-scanner code can get it wrong.  Order
  // is fixed: persistent registers by index, then persistent stacks by index.
  // Over-long state drops elements from the *top* of the deepest stack, which
  // is what python's and yaml's own truncation does.
  serialize(limit = 1024) {
    const out = [];
    for (let i = 0; i < NREG; i++) {
      if ((this.regPersist >>> i) & 1) writeSleb(out, this.reg[i]);
    }
    const bodies = [];
    for (let i = 0; i < NSTACK; i++) {
      const spec = this.stackSpec[i];
      if (!spec || !spec.persist) continue;
      bodies.push({ index: i, values: this.stacks[i].slice() });
    }
    for (;;) {
      const buf = out.slice();
      for (const b of bodies) {
        writeUleb(buf, b.values.length);
        for (const v of b.values) writeSleb(buf, v);
      }
      if (buf.length <= limit) return Uint8Array.from(buf);
      // Drop the top element of the deepest stack and try again.
      let deepest = -1;
      for (let i = 0; i < bodies.length; i++) {
        if (bodies[i].values.length > (deepest < 0 ? 0 : bodies[deepest].values.length)) deepest = i;
      }
      if (deepest < 0 || bodies[deepest].values.length === 0) return Uint8Array.from(buf.slice(0, limit));
      bodies[deepest].values.pop();
    }
  }

  deserialize(bytes) {
    this.reset();
    if (!bytes || bytes.length === 0) return;
    const r = { buf: bytes, pos: 0 };
    for (let i = 0; i < NREG; i++) {
      if ((this.regPersist >>> i) & 1) {
        if (r.pos >= bytes.length) return;
        this.reg[i] = readSleb(r) | 0;
      }
    }
    for (let i = 0; i < NSTACK; i++) {
      const spec = this.stackSpec[i];
      if (!spec || !spec.persist) continue;
      if (r.pos >= bytes.length) return;
      const n = readUleb(r);
      const s = this.stacks[i];
      s.length = 0;
      for (let k = 0; k < n && r.pos < bytes.length; k++) s.push(readSleb(r) | 0);
    }
  }

  // ---- execution ----------------------------------------------------------
  // Returns { ok, symbol }.  `ok` false means "no external token here".
  scan(lexer, valid) {
    this.enterScan();
    this.lexer = lexer;
    this.symbol = -1;
    this.depth = 0;
    try {
      return { ok: this.run(this.entry, valid), symbol: this.symbol };
    } catch (e) {
      if (e === HALT) return { ok: this.halted, symbol: this.symbol };
      throw e;
    }
  }

  trap() { this.halted = false; this.symbol = -1; throw HALT; }
  halt(ok) { this.halted = ok; throw HALT; }

  run(pc, valid) {
    const code = this.code;
    const reg = this.reg;
    const base = this.callStack.length;
    let spin = 0;
    for (;;) {
      if (pc < 0 || pc >= code.length) this.trap();
      if (++spin > SPIN_BUDGET) this.trap();
      const op = code[pc++];
      switch (op) {
        case OP.NOP: break;

        case OP.ADVANCE: this.lexer.advance(false); spin = 0; break;
        case OP.SKIP: this.lexer.advance(true); spin = 0; break;
        case OP.MARK_END: this.lexer.markEnd(); break;
        case OP.LOOKAHEAD: { const r = code[pc++]; this.setReg(r, this.lexer.lookahead()); break; }
        case OP.EOF: { const r = code[pc++]; this.setReg(r, this.lexer.atEof() ? 1 : 0); break; }
        // Codepoint column of the current position, counting from the start of
        // the line. haskell is the first ported scanner that calls
        // lexer->get_column; 0x06 was reserved for it and trapped. The host
        // answers -- ByteLexer and ts_lr.mjs both re-walk the line -- and
        // the parser host also stamps didGetColumn, which is load-bearing
        // for leaf reuse.
        case OP.GET_COLUMN: { const r = code[pc++]; this.setReg(r, this.lexer.column()); break; }
        // Case mapping is a host property in exactly the way classification
        // is -- html stores `towupper(lookahead)` in every tag name, so which
        // characters are the same tag name depends on the process's locale.
        // Carrying it as a table is what stops a port inheriting that.
        case OP.MAP: {
          const c = readUlebAt(code, pc); pc = c.pos;
          const d = code[pc++], sr = code[pc++];
          this.setReg(d, this.mapped(c.v, this.getReg(sr)));
          break;
        }

        case OP.EMIT: { const s = readUlebAt(code, pc); this.symbol = s.v; this.halt(true); break; }
        case OP.EMIT_R: { const r = code[pc++]; this.symbol = this.getReg(r); this.halt(true); break; }
        case OP.FAIL: this.halt(false); break;
        case OP.EMIT_IF: {
          const r = code[pc++]; const s = readUlebAt(code, pc);
          this.symbol = s.v; this.halt(this.getReg(r) !== 0); break;
        }
        case OP.EMIT_IF_R: {
          const r = code[pc++]; const rs = code[pc++];
          this.symbol = this.getReg(rs); this.halt(this.getReg(r) !== 0); break;
        }

        case OP.IF_CHAR: case OP.IF_NCHAR: {
          const c = readUlebAt(code, pc); pc = c.pos;
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          const hit = this.lexer.lookahead() === c.v;
          if (hit === (op === OP.IF_CHAR)) pc = t;
          break;
        }
        case OP.IF_CLASS: case OP.IF_NCLASS: {
          const c = readUlebAt(code, pc); pc = c.pos;
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          const hit = this.inClass(c.v, this.lexer.lookahead());
          if (hit === (op === OP.IF_CLASS)) pc = t;
          break;
        }
        case OP.IF_EOF: case OP.IF_NEOF: {
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          if (this.lexer.atEof() === (op === OP.IF_EOF)) pc = t;
          break;
        }
        // ts_lexer__is_at_included_range_start. Only javascript asks, and only
        // inside its automatic-semicolon scan.
        case OP.IF_RANGE_START: {
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          if (this.lexer.atRangeStart()) pc = t;
          break;
        }
        case OP.IF_VALID: case OP.IF_NVALID: {
          const c = readUlebAt(code, pc); pc = c.pos;
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          if (!!valid[c.v] === (op === OP.IF_VALID)) pc = t;
          break;
        }
        case OP.IF_VALID_R: case OP.IF_NVALID_R: {
          const r = code[pc++];
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          const i = this.getReg(r);
          if (i < 0 || i >= valid.length) this.trap();
          if (!!valid[i] === (op === OP.IF_VALID_R)) pc = t;
          break;
        }

        case OP.CONST: { const r = code[pc++]; const s = readSlebAt(code, pc); pc = s.pos; this.setReg(r, s.v); break; }
        case OP.MOV: { const d = code[pc++], s = code[pc++]; this.setReg(d, this.getReg(s)); break; }
        case OP.ALU: {
          const o = code[pc++], d = code[pc++], s = code[pc++];
          this.setReg(d, alu(o, this.getReg(d), this.getReg(s), this));
          break;
        }
        case OP.ALUI: {
          const o = code[pc++], d = code[pc++]; const s = readSlebAt(code, pc); pc = s.pos;
          this.setReg(d, alu(o, this.getReg(d), s.v, this));
          break;
        }

        case OP.IF_CMP: {
          const o = code[pc++], a = code[pc++], b = code[pc++];
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          if (cmp(o, this.getReg(a), this.getReg(b), this)) pc = t;
          break;
        }
        case OP.IF_CMPI: {
          const o = code[pc++], a = code[pc++]; const s = readSlebAt(code, pc); pc = s.pos;
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          if (cmp(o, this.getReg(a), s.v, this)) pc = t;
          break;
        }

        case OP.PUSH: {
          const k = code[pc++], r = code[pc++]; const st = this.stack(k);
          if (st.length >= STACK_MAX) this.trap();
          st.push(this.getReg(r));
          break;
        }
        case OP.POP: {
          const k = code[pc++], r = code[pc++]; const st = this.stack(k);
          if (st.length === 0) this.trap();
          this.setReg(r, st.pop());
          break;
        }
        case OP.PEEK: {
          const k = code[pc++], r = code[pc++]; const o = readUlebAt(code, pc); pc = o.pos;
          const st = this.stack(k);
          const i = st.length - 1 - o.v;
          if (i < 0) this.trap();
          this.setReg(r, st[i]);
          break;
        }
        case OP.SETTOP: {
          const k = code[pc++], r = code[pc++]; const st = this.stack(k);
          if (st.length === 0) this.trap();
          st[st.length - 1] = this.getReg(r);
          break;
        }
        // Index from the *bottom*, held in a register.  PEEK is not enough:
        // markdown-block walks its open-block stack with `items[s->matched]`,
        // an absolute index, at three sites.
        case OP.GETIDX: {
          const k = code[pc++], r = code[pc++], ri = code[pc++];
          const st = this.stack(k); const i = this.getReg(ri);
          if (i < 0 || i >= st.length) this.trap();
          this.setReg(r, st[i]);
          break;
        }
        case OP.LEN: { const k = code[pc++], r = code[pc++]; this.setReg(r, this.stack(k).length); break; }
        case OP.CLEAR: { const k = code[pc++]; this.stack(k).length = 0; break; }

        case OP.BUF_CLR: this.buflen = 0; break;
        case OP.BUF_PUSH: {
          const r = code[pc++];
          if (this.buflen >= BUF_MAX) this.trap();
          this.buf[this.buflen++] = this.getReg(r) & 0xff;
          break;
        }
        case OP.BUF_LEN: { const r = code[pc++]; this.setReg(r, this.buflen); break; }
        case OP.IF_BUF_EQ: {
          const c = readUlebAt(code, pc); pc = c.pos;
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          const s = this.strings[c.v];
          if (s === undefined) this.trap();
          let eq = s.length === this.buflen;
          for (let i = 0; eq && i < s.length; i++) eq = s[i] === this.buf[i];
          if (eq) pc = t;
          break;
        }

        case OP.JMP: { pc = code[pc] | (code[pc + 1] << 8); break; }
        case OP.CALL: {
          const t = code[pc] | (code[pc + 1] << 8); pc += 2;
          if (this.callStack.length >= CALL_MAX) this.trap();
          this.callStack.push(pc); pc = t;
          break;
        }
        case OP.RET: {
          if (this.callStack.length <= base) this.trap();
          pc = this.callStack.pop();
          break;
        }
        case OP.CALL_R: {
          const r = code[pc++]; const i = this.getReg(r);
          if (i < 0 || i >= this.jumpTable.length) this.trap();
          if (this.callStack.length >= CALL_MAX) this.trap();
          this.callStack.push(pc); pc = this.jumpTable[i] >>> 0;
          break;
        }
        case OP.RECURSE: {
          const c = readUlebAt(code, pc); pc = c.pos;
          const r = code[pc++];
          const vs = this.validSets[c.v];
          if (vs === undefined || this.depth >= RECURSE_MAX) this.trap();
          this.depth++;
          const savedSym = this.symbol;
          let inner;
          try {
            inner = this.run(this.entry, vs);
          } catch (e) {
            if (e !== HALT) throw e;
            inner = this.halted;
          }
          this.depth--;
          this.symbol = savedSym;
          this.setReg(r, inner ? 1 : 0);
          break;
        }

        default: this.trap();
      }
    }
  }

  getReg(i) { if (i < 0 || i >= NREG) this.trap(); return this.reg[i]; }
  setReg(i, v) { if (i < 0 || i >= NREG) this.trap(); this.reg[i] = v | 0; }
  stack(i) { if (i < 0 || i >= NSTACK) this.trap(); return this.stacks[i]; }

  // Triples are sorted, inclusive and non-overlapping: [lo0,hi0,d0, ...].
  // Anything not in a run maps to itself, which is what keeps the table to
  // hundreds of entries rather than thousands.
  mapped(k, cp) {
    const m = this.maps[k];
    if (m === undefined) this.trap();
    let lo = 0, hi = (m.length / 3) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < m[mid * 3]) hi = mid - 1;
      else if (cp > m[mid * 3 + 1]) lo = mid + 1;
      else return (cp + m[mid * 3 + 2]) | 0;
    }
    return cp | 0;
  }

  inClass(k, cp) {
    const r = this.classes[k];
    if (r === undefined) this.trap();
    // Ranges are sorted, inclusive, non-overlapping: [lo0,hi0, lo1,hi1, ...].
    let lo = 0, hi = (r.length >> 1) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < r[mid * 2]) hi = mid - 1;
      else if (cp > r[mid * 2 + 1]) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

// i32 wrapping throughout.  Shift counts are masked to 5 bits explicitly
// because Rust's `<<` panics at >= 32 while JS's masks silently.  There is no
// logical right shift and no division: neither is needed by any of the nine,
// and both are places the two languages differ.
function alu(o, a, b, vm) {
  switch (o) {
    case 0: return (a + b) | 0;
    case 1: return (a - b) | 0;
    case 2: return a & b;
    case 3: return a | b;
    case 4: return a ^ b;
    case 5: return (a << (b & 31)) | 0;
    case 6: return (a >> (b & 31)) | 0;
    case 7: if (b <= 0) vm.trap(); return (a % b) | 0;
    default: vm.trap();
  }
}

function cmp(o, a, b, vm) {
  switch (o) {
    case 0: return a === b;
    case 1: return a !== b;
    case 2: return a < b;
    case 3: return a <= b;
    case 4: return a > b;
    case 5: return a >= b;
    default: vm.trap();
  }
}

function writeUleb(out, v) {
  v >>>= 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
}
function writeSleb(out, v) {
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return; }
    out.push(b | 0x80);
  }
}
function readUleb(r) {
  let v = 0, s = 0, b;
  do { b = r.buf[r.pos++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
  return v >>> 0;
}
function readSleb(r) {
  let v = 0, s = 0, b;
  do { b = r.buf[r.pos++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
  if (s < 32 && (b & 0x40)) v |= -1 << s;
  return v | 0;
}
function readUlebAt(code, pos) {
  let v = 0, s = 0, b;
  do { b = code[pos++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
  return { v: v >>> 0, pos };
}
function readSlebAt(code, pos) {
  let v = 0, s = 0, b;
  do { b = code[pos++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
  if (s < 32 && (b & 0x40)) v |= -1 << s;
  return { v: v | 0, pos };
}

export { ScannerVM, OP, NREG, NSTACK, STACK_MAX, BUF_MAX };
