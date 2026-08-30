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
import { makeLexer, Language, forTests } from "./ts_lr.mjs";

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

// ---------------------------------------------------------------------------
// Error recovery. None of this is reachable from `corpus/trees/`, because
// `gen_trees.py` refuses to freeze a tree containing ERROR or MISSING -- so the
// clean corpus cannot exercise any of it by construction. The broken-input bar
// is `ts_check_trees.mjs --edited` against `corpus/trees-edited/`; these cover
// the four spots where upstream hides a special case behind something that
// reads like a plain field or a plain utility, each of which was wrong here.
// ---------------------------------------------------------------------------

// Enough of a language for the subtree layer: symbol 1 and 2 are visible and
// named, nothing is aliased, no fields. Only `visible`/`named` are reached.
const TINY = {
  symbolCount: 3,
  tokenCount: 2,
  largeStateCount: 0,
  maxAliasSequenceLength: 0,
  maxReservedWordSetSize: 0,
  fieldCount: 0,
  keywordCaptureToken: 0,
  symbolMetadata: [0, 3, 3],
  symbolNames: ["end", "tok", "node"],
};

test("a MISSING leaf costs 610 despite accumulating nothing", () => {
  // ts_subtree_error_cost is an accessor, not the field. Reading the field makes
  // an invented token look free, which makes its version always win
  // better_version_exists and suppresses recovery strategy 1.
  const lang = new Language(TINY);
  const missing = forTests.newMissingLeaf(lang, 1, 0, 0);
  assert.equal(missing.errorCost, 0, "the raw field really is zero");
  assert.equal(
    forTests.subtreeErrorCost(missing), 610,
    "ERROR_COST_PER_MISSING_TREE 110 + ERROR_COST_PER_RECOVERY 500",
  );

  // And the stack charges it, which is the path that actually ranks versions.
  const stack = new forTests.Stack();
  stack.push(0, missing, false, 1);
  assert.equal(stack.errorCost(0), 610);
});

test("renumbering a version keeps the summary it renumbers over", () => {
  // ts_stack_renumber_version moves the target's summary onto the source when
  // the source has none. A version created by popping never has one, and
  // recovery renumbers exactly such a version over one that does -- so dropping
  // it silently stops recovery strategy 1 for the rest of the parse.
  const stack = new forTests.Stack();
  stack.recordSummary(0, 16);
  const summary = stack.getSummary(0);
  assert.ok(summary, "precondition: version 0 has a summary");

  const popped = stack.addVersion(0, stack.heads[0].node);
  assert.equal(stack.getSummary(popped), null, "a popped version has none");

  stack.renumberVersion(popped, 0);
  assert.equal(
    stack.getSummary(0), summary,
    "the summary must survive the renumber, not go with the discarded head",
  );
});

test("an ERROR node charges per line it spans, not only per character", () => {
  const lang = new Language(TINY);
  const source = Buffer.from("a\nb\nc", "utf8");
  const child = forTests.newLeaf(lang, 1, 0, 5, 0, 0, false);
  const error = forTests.newErrorNode(lang, [child], false, source, 0);

  // 100 skipped visible child + 500 recovery + 5 chars + 2 newlines * 30.
  assert.equal(error.errorCost, 665);

  // The discriminating half: the same node over a span with no newlines costs
  // 60 less, so a row count stuck at zero would be visible here.
  const flat = Buffer.from("abcde", "utf8");
  const flatChild = forTests.newLeaf(lang, 1, 0, 5, 0, 0, false);
  assert.equal(forTests.newErrorNode(lang, [flatChild], false, flat, 0).errorCost, 605);
});

test("a MISSING child does not make its parent fragile", () => {
  // ts_subtree_is_error is the symbol test alone. This branch read
  // `|| child.isMissing` while no missing leaf could exist, so it was dead --
  // and would have gone live, wrongly, the moment recovery could build one.
  const lang = new Language(TINY);
  const missing = forTests.newMissingLeaf(lang, 1, 0, 0);
  const parent = forTests.newNode(lang, 2, [missing], 0);

  assert.equal(parent.fragileLeft, false);
  assert.equal(parent.fragileRight, false);
  assert.notEqual(parent.parseState, 0xffff, "TS_TREE_STATE_NONE is for ERROR children");
});
