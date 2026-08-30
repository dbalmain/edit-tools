// Unit tests for the lexer half of the table interpreter.
//
//     node --test harness/ts_lr.test.mjs
//
// `harness/test_ts_transcode.py` shells out to this, so `python3 -m unittest
// discover -s harness` -- and therefore `./test.sh` -- runs it too.
//
// These exercise cases the frozen corpus cannot reach. The corpus is 3 JSON
// files and 16 Go files against a blob with tens of thousands of entries, so
// "byte-identical on the corpus" is not coverage; see
// `docs/parse-tables-spike.md`.

import test from "node:test";
import assert from "node:assert/strict";
import { makeLexer } from "./ts_lr.mjs";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const ALL = [INT32_MIN, INT32_MAX];

test("op 2 with an empty interval set is a false guard, not an absent one", () => {
  // `lookahead < 0 && lookahead >= 0` -- unsatisfiable, so the transcoder
  // collapses it to an empty set. Short-circuiting on `ranges.length` would
  // take the branch unconditionally and invert the predicate.
  const states = [
    { o: [[2, 0, [], 0, 1]] }, // if (false) ADVANCE(1)
    { o: [[0, 1]] }, // ACCEPT_TOKEN(tok)
  ];
  const lexer = makeLexer(Buffer.from("a", "utf8"));
  lexer.start();
  const found = lexer.run(states, 0);
  lexer.finish();
  assert.equal(found, false, "a guard that is false everywhere must not fire");
});

test("op 2 with the full interval set does fire", () => {
  const states = [{ o: [[2, 0, ALL, 0, 1]] }, { o: [[0, 1]] }];
  const lexer = makeLexer(Buffer.from("a", "utf8"));
  lexer.start();
  assert.equal(lexer.run(states, 0), true);
  lexer.finish();
  assert.equal(lexer.resultSymbol, 1);
});

test("op 4 splits on eof: (!eof && lookahead == 0) || lookahead == '\\n'", () => {
  // What tree-sitter-python 0.25.0 emits. not-eof: {0, '\n'}; at eof: {'\n'}.
  const states = [
    { o: [[4, [0, 0, 10, 10], [10, 10], 0, 1]] },
    { o: [[0, 1]] },
  ];
  // A real NUL byte is not EOF: the branch fires.
  let lexer = makeLexer(Buffer.from([0]));
  lexer.start();
  assert.equal(lexer.run(states, 0), true, "NUL byte must take the branch");

  // At EOF lookahead is also 0, but the eof set excludes it.
  lexer = makeLexer(Buffer.from([]));
  lexer.start();
  assert.equal(lexer.run(states, 0), false, "EOF must not take the branch");
});

test("the decode-error value -1 is inside the complement of {0}", () => {
  // `lookahead != 0`, as the transcoder emits it: two intervals straddling 0.
  const notZero = [INT32_MIN, -1, 1, INT32_MAX];
  const states = [{ o: [[2, 0, notZero, 0, 1]] }, { o: [[0, 1]] }];
  // 0x80 alone is invalid UTF-8 -> lookahead becomes -1, which `!= 0` accepts.
  const lexer = makeLexer(Buffer.from([0x80]));
  lexer.start();
  assert.equal(lexer.run(states, 0), true, "invalid UTF-8 must satisfy != 0");
});

test("ACCEPT_TOKEN marks the end, and a later failed advance keeps it", () => {
  // state 0: consume 'a' -> state 1. state 1: accept, then consume 'b' only.
  const states = [
    { o: [[2, 0, [97, 97], 0, 1]] },
    { o: [[0, 1], [2, 0, [98, 98], 0, 1]] },
  ];
  const lexer = makeLexer(Buffer.from("abz", "utf8"));
  lexer.start();
  assert.equal(lexer.run(states, 0), true);
  lexer.finish();
  assert.equal(lexer.tokenStart, 0);
  assert.equal(lexer.tokenEnd, 2, "longest match ends after 'ab', not at 'z'");
});

test("SKIP moves the token start, so leading trivia is padding", () => {
  const states = [
    { o: [[2, 0, [32, 32], 1, 0], [2, 0, [97, 97], 0, 1]] },
    { o: [[0, 1]] },
  ];
  const lexer = makeLexer(Buffer.from("   a", "utf8"));
  lexer.start();
  assert.equal(lexer.run(states, 0), true);
  lexer.finish();
  assert.equal(lexer.tokenStart, 3, "the three spaces are padding");
  assert.equal(lexer.tokenEnd, 4);
});
