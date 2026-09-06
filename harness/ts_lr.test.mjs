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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { makeLexer, Language, forTests } from "./ts_lr.mjs";
import { encode, decode } from "./ts_scanner_pack.mjs";

// A Length is `{bytes, row, column}`; `column` counts bytes within the row.
const { len } = forTests;

// `toml.program.js` is the offline compiler's output and stays CommonJS with
// the rest of the spike's authoring tools; only the VM and the wire format
// moved into the harness.
const { build: buildToml } = createRequire(import.meta.url)("../harness/scanners/toml.program.js");

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
  const missing = forTests.newMissingLeaf(lang, 1, len(0, 0, 0), 0);
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
  // Five bytes spanning two newlines -- "a\nb\nc" -- so the size Length ends
  // one byte into row 2. The per-line term reads that row off the Length.
  const child = forTests.newLeaf(lang, 1, len(0, 0, 0), len(5, 2, 1), 0, 0, false);
  const error = forTests.newErrorNode(lang, [child], false);

  // 100 skipped visible child + 500 recovery + 5 chars + 2 newlines * 30.
  assert.equal(error.errorCost, 665);

  // The discriminating half: the same five bytes with no newlines in them --
  // "abcde" -- costs 60 less, so a row count stuck at zero is visible here.
  const flatChild = forTests.newLeaf(lang, 1, len(0, 0, 0), len(5, 0, 5), 0, 0, false);
  assert.equal(forTests.newErrorNode(lang, [flatChild], false).errorCost, 605);
});

test("a MISSING child does not make its parent fragile", () => {
  // ts_subtree_is_error is the symbol test alone. This branch read
  // `|| child.isMissing` while no missing leaf could exist, so it was dead --
  // and would have gone live, wrongly, the moment recovery could build one.
  const lang = new Language(TINY);
  const missing = forTests.newMissingLeaf(lang, 1, len(0, 0, 0), 0);
  const parent = forTests.newNode(lang, 2, [missing], 0);

  assert.equal(parent.fragileLeft, false);
  assert.equal(parent.fragileRight, false);
  assert.notEqual(parent.parseState, 0xffff, "TS_TREE_STATE_NONE is for ERROR children");
});

// ---------------------------------------------------------------------------
// Row/column tracking, mirroring lib/src/lexer.c.
//
// Nothing in the emitted trees reads these -- the frozen corpus carries byte
// offsets only -- so the corpus cannot catch a defect here at all. That makes
// these the whole of the evidence, and they drive the real `Lexer` rather than
// a paraphrase of it.
// ---------------------------------------------------------------------------

// Advance one codepoint at a time through the whole buffer, which is what a
// scanner does. Deliberately not a helper that re-implements do_advance: it
// calls the real one.
function walk(lexer, n) {
  lexer.start();
  for (let i = 0; i < n; i++) lexer.advance(false);
}

test("a newline increments the row and zeroes both columns", () => {
  const lexer = makeLexer(Buffer.from("ab\ncd", "utf8"));
  walk(lexer, 2);
  assert.equal(lexer.row, 0);
  assert.equal(lexer.column, 2, "two bytes into row 0");
  assert.equal(lexer.getColumn(), 2);

  lexer.advance(false); // over the '\n'
  assert.equal(lexer.row, 1, "the newline is charged to the row it ends");
  assert.equal(lexer.column, 0);
  assert.equal(lexer.getColumn(), 0);

  lexer.advance(false);
  assert.equal(lexer.row, 1);
  assert.equal(lexer.column, 1);
});

test("the extent column counts bytes and get_column counts codepoints", () => {
  // The discriminating case for the whole design: one number cannot be both.
  // "é" is 2 bytes, "€" is 3, "𝄞" is 4 -- 9 bytes and 3 codepoints. A port
  // that tracked a single column would agree with this test on ASCII and
  // disagree here, which is exactly the input no fixture contains.
  const lexer = makeLexer(Buffer.from("é€𝄞x", "utf8"));
  walk(lexer, 3);
  assert.equal(lexer.column, 9, "extent.column is a byte offset within the row");
  assert.equal(lexer.getColumn(), 3, "get_column is a codepoint count");
  assert.equal(lexer.pos, 9);
});

test("get_column recomputes the same value after a seek invalidates the cache", () => {
  // The cold-cache branch: seek away, come back, and the re-walk from the
  // start of the line must land on the number the running count had.
  const src = Buffer.from("xx\naé€b", "utf8");
  const warm = makeLexer(src);
  walk(warm, 6); // past "xx\n" then a, é, € -- three codepoints into row 1
  const running = warm.getColumn();
  assert.equal(running, 3);
  assert.equal(warm.row, 1);

  const cold = makeLexer(src);
  walk(cold, 6);
  // A seek to a different offset is what clears the cache upstream.
  const here = cold.position();
  cold.reset({ bytes: 0, row: 0, column: 0 });
  cold.reset(here);
  assert.equal(cold.columnValid, false, "the seek must have invalidated the cache");
  assert.equal(cold.getColumn(), running, "the recomputed column must match");
  assert.equal(cold.pos, here.bytes, "and get_column must leave the cursor where it was");
});

test("get_column sets didGetColumn, and lexer.start clears it", () => {
  const lexer = makeLexer(Buffer.from("ab", "utf8"));
  lexer.start();
  assert.equal(lexer.didGetColumn, false);
  lexer.getColumn();
  assert.equal(lexer.didGetColumn, true, "reading the column is what marks the token");
  lexer.start();
  assert.equal(lexer.didGetColumn, false, "each token starts unmarked");
});

test("a leading BOM advances the byte column but not the codepoint column", () => {
  // ts_lexer__do_advance skips increment_column_data for a BOM at byte 0.
  //
  // Reaching that guard takes some care: after `start()` has skipped the BOM it
  // sets the column to 0 regardless, so the warm path cannot see the
  // difference. The guard only bites on get_column's *cold* re-walk, which
  // restarts at byte 0 and advances over the BOM with the cache already valid.
  // A test that only walked forward would pass with the guard deleted --
  // checked by deleting it.
  const src = Buffer.from("﻿ab", "utf8");
  const lexer = makeLexer(src);
  lexer.start();
  assert.equal(lexer.pos, 3, "the BOM is three UTF-8 bytes and start() skips it");
  assert.equal(lexer.getColumn(), 0, "a BOM is not a character");

  lexer.advance(false); // over 'a'
  assert.equal(lexer.column, 4, "the byte column counted all four bytes");
  assert.equal(lexer.getColumn(), 1, "warm cache: one real character so far");

  // Now force the re-walk across the BOM.
  const here = lexer.position();
  lexer.reset({ bytes: 0, row: 0, column: 0 });
  lexer.reset(here);
  assert.equal(lexer.columnValid, false);
  assert.equal(lexer.getColumn(), 1, "the re-walk must not count the BOM either");
});

test("markEnd and SKIP carry the extent, not just the offset", () => {
  const states = [
    { o: [[2, 0, [32, 32], 1, 0], [2, 0, [97, 97], 0, 1]] }, // SKIP ' ', ADVANCE 'a'
    { o: [[0, 1]] },
  ];
  const lexer = makeLexer(Buffer.from("\n  a", "utf8"));
  lexer.start();
  lexer.advance(false); // consume the newline so the token starts on row 1
  assert.equal(lexer.run(states, 0), true);
  lexer.finish();
  assert.equal(lexer.tokenStart, 3, "two spaces of padding on row 1");
  assert.equal(lexer.tokenStartRow, 1);
  assert.equal(lexer.tokenStartColumn, 2);
  assert.equal(lexer.tokenEnd, 4);
  assert.equal(lexer.tokenEndRow, 1);
  assert.equal(lexer.tokenEndColumn, 3);
});

// ---------------------------------------------------------------------------
// The scanner package wire format.
//
// `decode` did not exist until the parser needed it: the JS replay ran off the
// in-memory program object while only Rust read the packed bytes, so "one
// artifact, two runtimes" was untested in the runtime where it was easiest to
// check. These are that check.
// ---------------------------------------------------------------------------

test("the committed toml.svm still matches the program it was built from", () => {
  // Guards the drift that was previously unnoticeable: `pack.js::encode` had no
  // caller in the repo, so nothing said whether the checked-in artifact was
  // still the encoding of toml.program.js.
  const svm = readFileSync(new URL("./scanners/toml.svm", import.meta.url));
  const encoded = encode(buildToml());
  assert.deepEqual(
    Array.from(encoded), Array.from(new Uint8Array(svm)),
    "toml.svm is stale -- regenerate with node harness/ts_scanner_build.mjs",
  );
});

test("decode round-trips every section, including the ones TOML leaves empty", () => {
  // TOML has no stacks, no strings, no valid-sets and no jump table, so a
  // decoder that mis-walked any of those sections would round-trip TOML
  // perfectly and corrupt every other scanner. This program fills all of them.
  const prog = {
    entry: 7,
    regPersist: 0b1010_0000_0000_0000_0000_0000_0000_0101,
    stacks: [{ persist: true }, { persist: false }, { persist: true }, { persist: false }],
    stackInit: [{ stack: 2, values: [0, -1, 127, -128, 100000, -100000] }],
    classes: [[9, 9, 32, 32], [0x41, 0x5a, 0x61, 0x7a, 0x10000, 0x10ffff]],
    strings: [[104, 116, 109, 108], []],
    // 13 is deliberately not a multiple of 8: the bitset packs 8 flags per
    // byte, so a wrong tail length is only visible on a ragged final byte.
    validSets: [[true, false, true, true, false, false, false, false, true, false, false, false, true]],
    jumpTable: [0, 3, 65535],
    code: Uint8Array.from([0x01, 0x02, 0x40, 0x00, 0x00, 0x0a]),
  };
  const back = decode(encode(prog));
  assert.equal(back.entry, prog.entry);
  assert.equal(back.regPersist, prog.regPersist >>> 0);
  assert.deepEqual(back.stacks, prog.stacks);
  assert.deepEqual(back.stackInit, prog.stackInit, "SLEB128 must survive both signs");
  assert.deepEqual(back.classes, prog.classes, "class bounds run past the BMP");
  assert.deepEqual(back.strings, prog.strings);
  assert.deepEqual(back.validSets, prog.validSets, "ragged bitset tail");
  assert.deepEqual(back.jumpTable, prog.jumpTable);
  assert.deepEqual(Array.from(back.code), Array.from(prog.code));
});

test("decode rejects a package it cannot trust rather than guessing", () => {
  const good = encode(buildToml());
  assert.throws(() => decode(good.slice(0, good.length - 1)), /truncated/);
  assert.throws(() => decode(new Uint8Array([...good, 0])), /trailing/);
  const badMagic = Uint8Array.from(good);
  badMagic[1] ^= 0xff;
  assert.throws(() => decode(badMagic), /bad magic/);
});
