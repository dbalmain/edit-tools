// The host-side behaviours, tested where they are pure.
//
// `VimEditor` needs a DOM and is exercised in a browser; `continuation` and
// `keyOf` are the two pieces that decide behaviour rather than draw it, and
// both are reachable from node. Autoindent is the one worth a suite: it runs on
// every `<CR>` and it is the only place this component guesses.

import test from "node:test";
import assert from "node:assert/strict";
import { continuation, keyOf } from "./host.js";

const rust = { indent: 4, lineComment: "//" };
const python = { indent: 4, lineComment: "#" };
const none = { indent: 2, lineComment: null };

test("carries the previous line's indentation", () => {
  assert.equal(continuation("    let x = 1;", rust), "    ");
  assert.equal(continuation("\t\tfoo", rust), "\t\t");
  assert.equal(continuation("no indent", rust), "");
});

test("opens a level after a trailing opener", () => {
  assert.equal(continuation("fn main() {", rust), "    ");
  assert.equal(continuation("    let v = vec![", rust), "        ");
  assert.equal(continuation("  def f(", python), "      ");
});

test("a trailing opener inside a comment does not open a level", () => {
  // The comment branch wins, which is what a reader expects: continuing
  // `// see foo(` should give `// `, not four spaces.
  assert.equal(continuation("// see foo(", rust), "// ");
});

test("continues a line comment, keeping its one space", () => {
  assert.equal(continuation("// a note", rust), "// ");
  assert.equal(continuation("//no space", rust), "//");
  assert.equal(continuation("    # indented note", python), "    # ");
});

test("a language with no line comment never continues one", () => {
  assert.equal(continuation("  # not a comment here", none), "  ");
});

test("a comment marker that is not at the line start is not a comment", () => {
  assert.equal(continuation('    let s = "// not a comment";', rust), "    ");
});

test("keyOf spells browser keys the way vici does", () => {
  assert.equal(keyOf({ key: "a", ctrlKey: false }), "a");
  assert.equal(keyOf({ key: " ", ctrlKey: false }), " ");
  assert.equal(keyOf({ key: "Escape", ctrlKey: false }), "<Esc>");
  assert.equal(keyOf({ key: "Enter", ctrlKey: false }), "<CR>");
  assert.equal(keyOf({ key: "r", ctrlKey: true }), "<C-r>");
  assert.equal(keyOf({ key: "R", ctrlKey: true }), "<C-r>");
  assert.equal(keyOf({ key: "ArrowLeft", ctrlKey: false }), "<Left>");
  assert.equal(keyOf({ key: "é", ctrlKey: false }), "é");
});

test("keyOf declines keys vici has no name for", () => {
  assert.equal(keyOf({ key: "Shift", ctrlKey: false }), null);
  assert.equal(keyOf({ key: "F13", ctrlKey: false }), null);
});
