"use strict";

// Integer ISA. Immediates follow the opcode in the code array.
// Stacks are typed: D docs, N nodes, I i32 (wrapping).
// A single forward-only child cursor per frame. HALT always finishes
// it, so an unconsumed child is a refuse and a child cannot be taken
// twice. That is the structural linearity claim.

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
};

const HAS_IMM = new Set([
  OP.JZ,
  OP.JMP,
  OP.JNZ,
  OP.PUSH_I,
  OP.TEXT,
  OP.REFUSE,
  OP.PEEK_TOKEN,
  OP.NODE_TOKEN,
  OP.NODE_FIELD,
  OP.NODE_KIND,
  OP.STORE,
  OP.LOAD,
  OP.CONCAT,
  OP.BAG_FIELD,
  OP.BAG_KIND,
  OP.BAG_TOKEN,
  OP.BAG_INDEX,
  OP.BAG_FMT_KIND,
  OP.HOST_CHAIN,
  OP.DSTORE,
  OP.DLOAD,
]);

const OP_NAMES = {};
for (const [k, v] of Object.entries(OP)) OP_NAMES[v] = k;

function opLen(op, code, pc) {
  if (op === OP.BAG_ONLY_FIELDS) {
    const n = code[pc + 1];
    if (n == null || n < 0) return 2;
    return 2 + n;
  }
  return HAS_IMM.has(op) ? 2 : 1;
}

function decode(code) {
  const starts = new Set();
  const ops = [];
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc];
    if (typeof op !== "number" || (op | 0) !== op) {
      throw new Error(`code[${pc}] is not an i32`);
    }
    if (OP_NAMES[op] == null) throw new Error(`unknown opcode ${op} at ${pc}`);
    const len = opLen(op, code, pc);
    if (pc + len > code.length) throw new Error(`truncated op ${OP_NAMES[op]} at ${pc}`);
    starts.add(pc);
    ops.push({ pc, op, len, imm: len >= 2 ? code[pc + 1] : null });
    pc += len;
  }
  return { starts, ops };
}

module.exports = { OP, HAS_IMM, OP_NAMES, opLen, decode };
