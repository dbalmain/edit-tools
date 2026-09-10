// The host-side behaviours, tested where they are pure.
//
// `VimEditor` needs a DOM and is exercised in a browser; `continuation` and
// `keyOf` are the two pieces that decide behaviour rather than draw it, and
// both are reachable from node. Autoindent is the one worth a suite: it runs on
// every `<CR>` and it is the only place this component guesses.

import test from "node:test";
import assert from "node:assert/strict";
import { continuation, keyOf, tableSlots } from "./host.js";

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

// -- tableSlots --------------------------------------------------------
//
// The property worth testing is **totality**: the slots tile the block. Every
// byte of every row belongs to exactly one cell, so wherever vici puts the
// cursor there is a cell to draw the caret in. Assert that directly rather
// than cell by cell -- a test that re-lists the offsets is a second copy of
// the arithmetic, and would agree with a wrong one.

const PADDED = "| name  |   n | ok  |\n| ----- | --: | --- |\n| alpha |   1 | yes |\n";

/** Every cell's byte range, in order. */
function ranges(table) {
  return table.rows.flatMap((row) => row.cells.map((cell) => [cell.start, cell.end]));
}

function assertTiles(text) {
  const table = tableSlots(text);
  assert.ok(table, "expected a table");
  const total = new TextEncoder().encode(text).length;
  let at = 0;
  for (const [start, end] of ranges(table)) {
    assert.equal(start, at, `slot starts where the last one ended, in ${JSON.stringify(text)}`);
    assert.ok(end > start, "a slot is never empty");
    at = end;
  }
  assert.equal(at, total, `slots cover the block, in ${JSON.stringify(text)}`);
  return table;
}

test("a padded table's slots tile it, and a cell owns the pipe on its left", () => {
  const table = assertTiles(PADDED);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(
    table.rows[2].cells.map((cell) => cell.text),
    ["| alpha ", "|   1 ", "| yes |\n"],
  );
  assert.deepEqual(
    table.rows[2].cells.map((cell) => cell.content),
    ["alpha", "1", "yes"],
  );
});

test("slots still tile a row that omits its outer pipes", () => {
  // GFM allows all four combinations, so all four have to be drawable.
  assertTiles("a | b\n--- | ---\n1 | 2\n");
  assertTiles("| a | b\n| --- | ---\n| 1 | 2\n");
  assertTiles("a | b |\n--- | --- |\n1 | 2 |\n");
  assertTiles("|a|b|\n|-|-|\n|1|2|\n");
});

test("the last cell of a row owns the newline, so end-of-line has a cell", () => {
  const table = tableSlots(PADDED);
  const first = table.rows[0].cells.at(-1);
  assert.ok(first.text.endsWith("\n"));
  // The row after it starts exactly there: no byte belongs to both.
  assert.equal(table.rows[1].cells[0].start, first.end);
});

test("offsets are byte offsets, not code units", () => {
  // The cursor vici hands us counts UTF-8, and a wide table is exactly where
  // that stops being the same number.
  const table = assertTiles("| 日本 | b |\n| --- | --- |\n| x | y |\n");
  // `| 日本 ` is 5 code units and 9 bytes; the second cell starts at 9.
  assert.equal(table.rows[0].cells[1].start, 9);
  assert.equal(table.rows[0].cells[0].contentStart, 2);
});

test("an escaped pipe is content, not a separator", () => {
  const table = assertTiles("| a \\| b | c |\n| --- | --- |\n| 1 | 2 |\n");
  assert.equal(table.rows[0].cells.length, 2);
  assert.equal(table.rows[0].cells[0].content, "a \\| b");
});

test("alignment comes from the delimiter row's colons", () => {
  const table = tableSlots("| a | b | c | d |\n| :-- | --: | :-: | --- |\n| 1 | 2 | 3 | 4 |\n");
  assert.deepEqual(table.aligns, ["left", "right", "center", null]);
});

test("contentStart points past the padding, which is where a cell is edited", () => {
  const table = tableSlots(PADDED);
  const [name, n] = table.rows[0].cells;
  assert.equal(PADDED.slice(name.contentStart, name.contentStart + 4), "name");
  assert.equal(PADDED.slice(n.contentStart, n.contentStart + 1), "n");
});

test("what is not a table returns null, so the caller renders it raw", () => {
  assert.equal(tableSlots("| a | b |\n| c | d |\n"), null, "no delimiter row");
  assert.equal(tableSlots("| --- | --- |\n| a | b |\n"), null, "delimiter first");
  assert.equal(tableSlots("| a | b |\n| --- | --- |\n\n| c |\n"), null, "a blank line");
  assert.equal(tableSlots("just a paragraph\n"), null, "no pipes at all");
  assert.equal(tableSlots("| a | b |\n"), null, "a header with nothing under it");
});

test("a half-typed row is still a table until it stops being one", () => {
  // This is what the block looks like between two parses, and the caller
  // renders whatever comes back -- so it has to be right mid-keystroke.
  assertTiles("| a | b |\n| --- | --- |\n| 1 |");
  assert.equal(tableSlots("| a | b |\n| --- | --- |\n1"), null);
});

test("an empty cell puts the caret inside itself, not on the next cell's pipe", () => {
  const table = tableSlots("| a | b |\n| --- | --- |\n|   | 2 |\n");
  const empty = table.rows[2].cells[0];
  assert.ok(empty.contentStart > empty.start, "past the pipe");
  assert.ok(empty.contentStart < empty.end, "before the next cell");
});

test("keyOf spells shift-tab, and leaves every other shifted key alone", () => {
  assert.equal(keyOf({ key: "Tab", shiftKey: true, ctrlKey: false }), "<S-Tab>");
  assert.equal(keyOf({ key: "Tab", shiftKey: false, ctrlKey: false }), "<Tab>");
  // vici has no `<S-Left>` or `<S-CR>`; sending one would lose the plain key.
  assert.equal(keyOf({ key: "ArrowLeft", shiftKey: true, ctrlKey: false }), "<Left>");
  assert.equal(keyOf({ key: "Enter", shiftKey: true, ctrlKey: false }), "<CR>");
  assert.equal(keyOf({ key: "A", shiftKey: true, ctrlKey: false }), "A");
});
