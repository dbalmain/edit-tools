#!/usr/bin/env node
// The recovered-DFA side of the lexer equivalence check. Mirrors
// `harness/ts_probe_lex.c` exactly: same fake lexer, same fold, same inputs.
//
//     node harness/ts_probe_lex.mjs <blob.json> <which> < codepoints
//
// `which` is `lex` or `keywordLex`. Driven by `harness/ts_verify_lex.py`.
//
// The DFA interpretation here is `Lexer.run` itself -- the shipped code path --
// with only `advance` and `markEnd` replaced, so this compares the real
// interpreter against the real `ts_lex`, not two paraphrases of a table.

import { readFileSync } from "node:fs";
import { makeLexer } from "./ts_lr.mjs";

const MAX_STEPS = 64;

function fold(h, v) {
  h = Math.imul(h ^ (v & 0xff), 16777619);
  h = Math.imul(h ^ ((v >>> 8) & 0xff), 16777619);
  h = Math.imul(h ^ ((v >>> 16) & 0xff), 16777619);
  h = Math.imul(h ^ ((v >>> 24) & 0xff), 16777619);
  return h >>> 0;
}

function runOne(states, state, input) {
  const lx = makeLexer(Buffer.alloc(0));
  let pos = 0;
  let steps = 0;
  let hash = 2166136261;
  const len = input.length;
  lx.lookahead = len > 0 ? input[0] : 0;
  lx.atEof = len === 0;
  lx.resultSymbol = 0;
  lx.advance = (skip) => {
    hash = fold(hash, skip ? 2 : 1);
    if (steps++ > MAX_STEPS) return;
    if (pos < len) {
      pos++;
      lx.lookahead = pos < len ? input[pos] : 0;
      lx.atEof = pos >= len;
    }
  };
  lx.markEnd = () => {
    hash = fold(hash, 3);
    hash = fold(hash, pos);
  };
  const found = lx.run(states, state);
  hash = fold(hash, found ? 0x1111 : 0x2222);
  hash = fold(hash, found ? lx.resultSymbol : 0);
  hash = fold(hash, pos);
  hash = fold(hash, steps > MAX_STEPS ? 0xdead : 0);
  return hash;
}

const blob = JSON.parse(readFileSync(process.argv[2], "utf8"));
const states = blob[process.argv[3]];
if (!states) {
  console.error(`blob has no ${process.argv[3]}`);
  process.exitCode = 2;
} else {
  const cps = readFileSync(0, "utf8").split("\n").filter(Boolean).map(Number);
  const out = [];
  for (let s = 0; s < states.length; s++) {
    let h = 2166136261;
    h = (Math.imul(h ^ runOne(states, s, []), 16777619) >>> 0);
    for (const cp of cps) {
      h = (Math.imul(h ^ runOne(states, s, [cp]), 16777619) >>> 0);
      h = (Math.imul(h ^ runOne(states, s, [cp, 97]), 16777619) >>> 0);
      h = (Math.imul(h ^ runOne(states, s, [cp, 10]), 16777619) >>> 0);
    }
    out.push(`${s} ${h}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}
