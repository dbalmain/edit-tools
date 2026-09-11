"use strict";
// `node --test runtime-js/bundle.test.js` -- the JS mirror of rust/src/{doc,eval}.rs tests.
// Not part of the shipped bundle; the two runtimes are written independently,
// so both need their own evidence.

const test = require("node:test");
const assert = require("node:assert");
const { format, Refusal } = require("./bundle.js");

const toy = (rules) => ({
  format: "et-doc-rules/1",
  indent: 2,
  tokens: ["(", ")", ",", "+"],
  precedence: { "+": 5, "*": 4 },
  rules,
});

const leaf = (type, text) => ({ type, start: 0, end: 0, text });

const run = (pkg, root, width) => runOn(pkg, "", root, width);
const runOn = (pkg, source, root, width) =>
  format({ language: "toy", source, root }, new Map([["toy", pkg]]), width);
const formatTree = (rawPackages, language, source, root, width) =>
  format({ language, source, root }, new Map(Object.entries(rawPackages)), width);

const commentsPkg = (fields = {}) => ({
  format: "et-doc-rules/1",
  indent: 2,
  comments: ["comment"],
  rules: { file: ["each", "named", ["seq"]] },
  ...fields,
});

const commentedFile = (children, end) => ({ type: "file", start: 0, end, children });

const span = (type, start, end, text) => ({ type, start, end, text });

const rangePkg = () => toy({ marker: ["verbatim"] });

function assertInvalidRange(source, root, details) {
  assert.throws(
    () => runOn(rangePkg(), source, root, 80),
    (error) =>
      error instanceof Refusal &&
      /malformed tree: node `marker`/.test(error.message) &&
      details.every((detail) => error.message.includes(detail)),
  );
}

test("tree loader accepts a well-formed UTF-8 range", () => {
  assert.equal(runOn(rangePkg(), "xéy", { type: "marker", start: 1, end: 3 }, 80), "é\n");
});

test("tree loader refuses invalid numeric ranges", () => {
  // These are loader regressions: letting any one through restores the
  // `get`/`subarray` coercion split at downstream source-byte sites.
  assertInvalidRange("hello", { type: "marker", start: 4, end: 2 }, ["reversed range", "4..2"]);
  assertInvalidRange("hello", { type: "marker", start: 0, end: 6 }, ["past the source", "0..6"]);
  assertInvalidRange("hello", { type: "marker", start: -1, end: 2 }, ["invalid start offset", "-1"]);
  assertInvalidRange("hello", { type: "marker", start: 1.5, end: 2 }, ["invalid start offset", "1.5"]);
  assertInvalidRange("hello", { type: "marker", start: null, end: 2 }, ["invalid start offset", "null"]);
  assertInvalidRange("hello", { type: "marker", start: true, end: 2 }, ["invalid start offset", "true"]);
  assertInvalidRange("hello", { type: "marker", start: "0", end: 2 }, ["invalid start offset", "\"0\""]);
  assertInvalidRange("hello", { type: "marker", end: 2 }, ["invalid start offset", "missing"]);
});

test("tree loader refuses UTF-8 splits at either edge", () => {
  assertInvalidRange("xéy", { type: "marker", start: 2, end: 4 }, ["start offset 2", "UTF-8"]);
  assertInvalidRange("xéy", { type: "marker", start: 0, end: 2 }, ["end offset 2", "UTF-8"]);
});

/** `"hi"` as a three-child `quote` node — the shape `verbatim` actually sees. */
function quote(start, end, children) {
  return {
    source: '"hi"',
    root: { type: "quote", start, end, children },
  };
}

function quoteOk() {
  return quote(0, 4, [
    span("open", 0, 1, '"'),
    span("body", 1, 3, "hi"),
    span("close", 3, 4, '"'),
  ]);
}

function list(items, trailing) {
  const children = [leaf("(", "(")];
  items.forEach((item, i) => {
    if (i > 0) children.push(leaf(",", ","));
    children.push(leaf("name", item));
  });
  if (trailing) children.push(leaf(",", ","));
  children.push(leaf(")", ")"));
  return { type: "list", start: 0, end: 0, children };
}

const listRule = [
  "group", ["tok", "("],
  ["indent", ["soft"],
    ["each", "named", ["seq", ["tok", ","], ["line"]]],
    ["trail", ",", "named"]],
  ["soft"], ["tok", ")"],
];

function chain(ops, base, fields = { left: "left", operator: "operator", right: "right" }) {
  let node = leaf("name", base);
  for (const [op, rhs] of ops) {
    node = {
      type: "sum",
      start: 0,
      end: 0,
      children: [
        { ...node, field: fields.left },
        { ...leaf(op, op), field: fields.operator },
        { ...leaf("name", rhs), field: fields.right },
      ],
    };
  }
  return node;
}

const dropList = (children) => ({ type: "list", start: 0, end: 0, children });
const dropRule = { list: ["seq", ["tok", "("], ["drop", "+"], ["child", "*"], ["tok", ")"]] };

test("drop consumes a redundant token without emitting it", () => {
  const root = dropList([leaf("(", "("), leaf("+", "+"), leaf("a", "a"), leaf(")", ")")]);
  assert.equal(run(toy(dropRule), root, 80), "(a)\n");
});

test("drop is a no-op when the token is absent", () => {
  const root = dropList([leaf("(", "("), leaf("a", "a"), leaf(")", ")")]);
  assert.equal(run(toy(dropRule), root, 80), "(a)\n");
});

test("drop refuses a token the package has not declared punctuation", () => {
  const pkg = toy({ list: ["seq", ["tok", "("], ["drop", "a"], ["tok", ")"]] });
  const root = dropList([leaf("(", "("), leaf("a", "a"), leaf(")", ")")]);
  assert.throws(
    () => run(pkg, root, 80),
    (err) => err instanceof Refusal && /not declared punctuation/.test(err.message),
  );
});

test("paren true adds a balanced pair in flat layout", () => {
  const pkg = toy({ list: ["paren", true, ["child", "*"]] });
  const root = dropList([leaf("a", "a")]);
  assert.equal(run(pkg, root, 80), "(a)\n");
});

test("text and multiline predicates follow exact child paths", () => {
  const wrapper = (value) => ({
    type: "wrapper", start: 0, end: 0,
    children: [leaf("name", value)],
  });
  const root = (value) => ({
    type: "file", start: 0, end: 0,
    children: [wrapper(value), leaf("word", "x")],
  });
  const pkg = toy({
    file: [
      "when", ["text", ["t:wrapper", "t:name"], ["block"]],
      ["each", "named", ["sp"]],
      ["each", "named", ["seq"]],
    ],
    wrapper: ["each", "named", ["seq"]],
  });
  assert.equal(run(pkg, root("block"), 80), "block x\n");
  assert.equal(run(pkg, root("inline"), 80), "inlinex\n");

  const multilinePkg = toy({
    file: [
      "when", ["multiline", ["t:wrapper", "t:name"]],
      ["each", "named", ["sp"]],
      ["each", "named", ["seq"]],
    ],
    wrapper: ["each", "named", ["seq"]],
  });
  assert.equal(run(multilinePkg, root("a\nb"), 80), "a\nb x\n");
});

test("source-multiline predicate inspects the node range", () => {
  const pkg = toy({
    file: [
      "when", ["source-multiline"],
      ["seq", ["child", "named"], ["hard"], ["child", "named"]],
      ["each", "named", ["sp"]],
    ],
  });
  const root = {
    type: "file", start: 0, end: 3,
    children: [span("name", 0, 1, "a"), span("name", 2, 3, "b")],
  };
  assert.equal(runOn(pkg, "a\nb", root, 80), "a\nb\n");
  assert.equal(runOn(pkg, "a b", root, 80), "a b\n");

  // Range validity belongs to loading now; the predicate never sees a tree
  // whose source slice would need cross-runtime clamp semantics.
  const past = {
    type: "file", start: 0, end: 99,
    children: [span("name", 0, 1, "a"), span("name", 2, 3, "b")],
  };
  assert.throws(
    () => runOn(pkg, "a\nb", past, 80),
    /malformed tree: node `file`.*past the source/,
  );
});

test("srcgap preserves horizontal space and safely breaks it", () => {
  const pkg = toy({
    file: ["group", ["child", "named"], ["srcgap"], ["child", "named"]],
  });
  const root = {
    type: "file", start: 0, end: 4,
    children: [span("name", 0, 1, "a"), span("name", 3, 4, "b")],
  };
  assert.equal(runOn(pkg, "a  b", root, 80), "a  b\n");
  assert.equal(runOn(pkg, "a  b", root, 1), "a\nb\n");
  const omitted = {
    type: "file", start: 0, end: 3,
    children: [span("name", 0, 1, "a"), span("name", 2, 3, "b")],
  };
  assert.throws(() => runOn(pkg, "a+b", omitted, 80), /only whitespace in a `srcgap`/);

  // Vertical tab is not HTML whitespace and is not Rust's
  // `u8::is_ascii_whitespace` either, so both runtimes must refuse it. This
  // pins the parity: the corpus contains no U+000B, so nothing else can catch
  // the two implementations drifting apart here.
  const vertical = {
    type: "file", start: 0, end: 3,
    children: [span("name", 0, 1, "a"), span("name", 2, 3, "b")],
  };
  assert.throws(
    () => runOn(pkg, "a\u000bb", vertical, 80),
    /only whitespace in a `srcgap`/,
  );

  // Node-local load checks cannot prove a range derived from two overlapping
  // siblings. Refuse that relation where `srcgap` forms it.
  const reversed = {
    type: "file", start: 0, end: 4,
    children: [span("name", 0, 3, "a"), span("name", 1, 4, "b")],
  };
  assert.throws(() => runOn(pkg, "a  b", reversed, 80), /a valid source gap/);
});

test("a group fraction breaks a construct that still fits the line", () => {
  const rule = [
    "group", 0.18, ["tok", "("],
    ["indent", ["soft"],
      ["each", "named", ["seq", ["tok", ","], ["line"]]],
      ["trail", ",", "named"]],
    ["soft"], ["tok", ")"],
  ];
  const pkg = toy({ list: rule });
  assert.equal(run(pkg, list(["aaaa", "bbbb"], false), 80), "(aaaa, bbbb)\n");
  assert.equal(
    run(pkg, list(["aaaaaa", "bbbbbb"], false), 80),
    "(\n  aaaaaa,\n  bbbbbb,\n)\n",
  );
});

test("a group cap measures the construct, not the rest of the line", () => {
  const pkg = toy({
    list: [
      "seq",
      ["group", 0.18, ["tok", "("], ["child", "named"], ["tok", ")"]],
      ["sp"],
      ["child", "named"],
    ],
  });
  // "(id)" is 4 columns, under 0.18 * 80 = 14. The 70-column trailer would
  // trip the cap if we measured the line.
  const tree = {
    type: "list",
    start: 0,
    end: 0,
    children: [leaf("(", "("), leaf("name", "id"), leaf(")", ")"), leaf("name", "X".repeat(70))],
  };
  assert.equal(run(pkg, tree, 80), `(id) ${"X".repeat(70)}\n`);
});

test("group refuses a cap outside (0, 1]", () => {
  for (const bad of [0, 1.1, 18, -0.18]) {
    assert.throws(
      () => run(toy({ list: ["group", bad, ["tok", "("]] }), list(["a"], false), 80),
      (err) => err instanceof Refusal && /`group` max must be a fraction in \(0, 1]/.test(err.message),
    );
  }
});

test("width counts scalar values, not UTF-16 code units", () => {
  const pkg = toy({ list: ["group", ["tok", "("], ["each", "named", ["seq", ["line"]]], ["tok", ")"]] });
  const tree = list(["🙂🙂🙂", "x"], false);
  tree.children = tree.children.filter((c) => c.type !== ",");
  assert.equal(run(pkg, tree, 7), "(🙂🙂🙂 x)\n");
  assert.equal(run(pkg, tree, 6), "(🙂🙂🙂\nx)\n");
});

test("Go alignment respects blank-line runs and matches gofmt", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "packages", "go.json"), "utf8"));
  const tree = JSON.parse(fs.readFileSync(path.join(root, "corpus", "trees", "go__alignment.tree.json"), "utf8"));
  const want = fs.readFileSync(path.join(root, "corpus", "reference", "go__alignment@80.txt"), "utf8");
  assert.equal(format(tree, new Map([["go", pkg]]), 80), want);
});

test("fill packs independently per line and counts Unicode scalars", () => {
  const rule = [
    "group", ["tok", "("],
    ["indent", ["soft"], ["fill", "named", ["seq", ["tok", ","], ["line"]]]],
    ["soft"], ["tok", ")"],
  ];
  const pkg = toy({ list: rule });
  assert.equal(
    run(pkg, list(["100", "200", "300", "400"], false), 12),
    "(\n  100, 200,\n  300, 400\n)\n",
  );
  assert.equal(
    run(pkg, list(["🙂🙂", "x", "y"], false), 8),
    "(\n  🙂🙂, x,\n  y\n)\n",
  );
});

test("fill is a fixed point for already packed input", () => {
  const rule = [
    "group", ["tok", "("],
    ["indent", ["soft"], ["fill", "named", ["seq", ["tok", ","], ["line"]]]],
    ["soft"], ["tok", ")"],
  ];
  const pkg = toy({ list: rule });
  const tree = list(["100", "200", "300", "400"], false);
  const once = runOn(pkg, "(\n  100, 200,\n  300, 400\n)", tree, 12);
  const twice = runOn(pkg, once, tree, 12);
  assert.equal(twice, once);
});

test("a BreakParent reaches through fill without disabling its packing", () => {
  const pkg = {
    ...toy({
      list: [
        "group", ["tok", "("],
        ["indent", ["soft"], ["fill", "named", ["seq", ["tok", ","], ["line"]]]],
        ["soft"], ["tok", ")"],
      ],
    }),
    comments: ["comment"],
  };
  const source = "(a,b,c# note)";
  const root = {
    type: "list", start: 0, end: 13,
    children: [
      span("(", 0, 1, "("),
      span("name", 1, 2, "a"),
      span(",", 2, 3, ","),
      span("name", 3, 4, "b"),
      span(",", 4, 5, ","),
      span("name", 5, 6, "c"),
      span("comment", 6, 12, "# note"),
      span(")", 12, 13, ")"),
    ],
  };
  assert.equal(runOn(pkg, source, root, 80), "(\n  a, b, c # note\n)\n");
});

test("a rule that ignores a child refuses rather than dropping it", () => {
  const pkg = toy({ list: ["seq", ["tok", "("]] });
  assert.throws(() => run(pkg, list(["a"], false), 80), (e) => e instanceof Refusal && /left child/.test(e.message));
});

test("an unknown node type refuses rather than guessing", () => {
  assert.throws(() => run(toy({}), list(["a"], false), 80), /no rule for node type `list`/);
});

const prefixPkg = (rules) => ({
  format: "et-doc-rules/1",
  indent: 2,
  tokens: [],
  rules,
});

// The whole point of entry 24: a marker the host owns lands on every line the
// body emits, not just the first one the source already had.
test("prefix puts the marker's text on every line the body emits", () => {
  const pkg = prefixPkg({
    block: ["seq", ["child", "t:word"], ["prefix", "t:marker", ["hard"], ["each", "t:word", ["hard"]]]],
  });
  const root = {
    type: "block",
    start: 0,
    end: 2,
    children: [leaf("word", "head"), { type: "marker", start: 0, end: 2 }, leaf("word", "a"), leaf("word", "b")],
  };
  assert.strictEqual(runOn(pkg, "> x", root, 80), "head\n> a\n> b\n");
});

// Zero matches is an empty prefix that consumes nothing, so one rule serves a
// fence at the top of a document and one four lists deep.
test("prefix without its marker is an empty prefix and consumes nothing", () => {
  const pkg = prefixPkg({ block: ["prefix", "t:marker", ["each", "t:word", ["hard"]]] });
  const root = { type: "block", start: 0, end: 0, children: [leaf("word", "a"), leaf("word", "b")] };
  assert.strictEqual(runOn(pkg, "> x", root, 80), "a\nb\n");
});

// Prefixes concatenate the way indent levels do, so a fence inside a quoted
// list carries both markers.
test("prefixes nest and concatenate", () => {
  const pkg = prefixPkg({
    block: ["prefix", "t:outer", ["prefix", "t:inner", ["each", "t:word", ["hard"]]]],
  });
  const root = {
    type: "block",
    start: 0,
    end: 0,
    children: [
      { type: "outer", start: 0, end: 2 },
      { type: "inner", start: 2, end: 4 },
      leaf("word", "a"),
      leaf("word", "b"),
    ],
  };
  assert.strictEqual(runOn(pkg, "> ..", root, 80), "a\n> ..b\n");
});

// A marker spanning a line ending would write a newline the printer never
// accounted for, so it is refused rather than silently mis-measured.
test("prefix refuses a multiline marker", () => {
  const pkg = prefixPkg({ block: ["prefix", "t:marker", ["each", "t:word", ["hard"]]] });
  const root = {
    type: "block",
    start: 0,
    end: 2,
    children: [{ type: "marker", start: 0, end: 2 }, leaf("word", "a")],
  };
  assert.throws(() => runOn(pkg, "\n ", root, 80), /a single-line marker for `prefix`/);
});

// The marker is consumed without being emitted, so a comment riding on it
// would be lost -- the same guard `drop` carries.
test("prefix refuses a marker carrying a comment", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    comments: ["comment"],
    tokens: [],
    rules: { block: ["prefix", "t:marker", ["each", "t:word", ["hard"]]] },
  };
  const root = {
    type: "block",
    start: 0,
    end: 3,
    children: [
      { type: "comment", start: 0, end: 1, text: "#" },
      { type: "marker", start: 1, end: 3 },
      leaf("word", "a"),
    ],
  };
  assert.throws(() => runOn(pkg, "#> ", root, 80), /no comment on the marker a `prefix` consumes/);
});

test("language regions use their rules and indent then restore the enclosing package", () => {
  const outerBlock = [
    "seq",
    ["tok", "outer"],
    ["indent", ["hard"], ["each", "named", ["hard"]]],
  ];
  const innerBlock = [
    "seq",
    ["tok", "inner"],
    ["indent", ["hard"], ["each", "named", ["hard"]]],
  ];
  const packages = {
    outer: {
      format: "et-doc-rules/1",
      indent: 2,
      tokens: ["outer"],
      rules: {
        outer_block: outerBlock,
        outer_again: outerBlock,
        region: ["verbatim"],
      },
    },
    inner: {
      format: "et-doc-rules/1",
      indent: 4,
      tokens: ["inner"],
      rules: {
        region: innerBlock,
        inner_again: innerBlock,
      },
    },
  };
  const root = {
    type: "outer_block", start: 0, end: 0,
    children: [
      leaf("outer", "outer"),
      leaf("word", "before"),
      {
        type: "region", language: "inner", start: 0, end: 0,
        children: [
          leaf("inner", "inner"),
          leaf("word", "inside"),
          {
            type: "outer_again", language: "outer", start: 0, end: 0,
            children: [leaf("outer", "outer"), leaf("word", "back")],
          },
          {
            type: "inner_again", start: 0, end: 0,
            children: [leaf("inner", "inner"), leaf("word", "restored-inner")],
          },
        ],
      },
      {
        type: "outer_again", start: 0, end: 0,
        children: [leaf("outer", "outer"), leaf("word", "after")],
      },
    ],
  };

  assert.equal(
    formatTree(packages, "outer", "", root, 80),
    "outer\n  before\n  inner\n      inside\n      outer\n        back\n      inner\n          restored-inner\n  outer\n    after\n",
  );
});

test("language regions use their comment policy", () => {
  const packages = {
    outer: {
      format: "et-doc-rules/1",
      indent: 2,
      blank_cap: 0,
      rules: { file: ["child", "named"] },
    },
    inner: {
      format: "et-doc-rules/1",
      indent: 4,
      comments: ["comment"],
      comment_gap: 3,
      blank_cap: 2,
      rules: { region: ["child", "named"] },
    },
  };
  const source = "x# one\n\n\n\n# two";
  const root = {
    type: "file", start: 0, end: 15,
    children: [{
      type: "region", language: "inner", start: 0, end: 15,
      children: [
        { type: "word", start: 0, end: 1, text: "x" },
        { type: "comment", start: 1, end: 6, text: "# one" },
        { type: "comment", start: 10, end: 15, text: "# two" },
      ],
    }],
  };

  assert.equal(
    formatTree(packages, "outer", source, root, 80),
    "x   # one\n\n\n# two\n",
  );
});

test("a missing nested language package refuses and names the language", () => {
  const packages = {
    outer: {
      format: "et-doc-rules/1",
      indent: 2,
      rules: { file: ["child", "named"] },
    },
  };
  const root = {
    type: "file", start: 0, end: 0,
    children: [{
      type: "word", language: "missing-toy", start: 0, end: 0, text: "x",
    }],
  };

  assert.throws(
    () => formatTree(packages, "outer", "", root, 80),
    (error) => error instanceof Refusal && error.message === "no package for language `missing-toy`",
  );
});

test("interior comment without text slices source", () => {
  // tree-sitter-rust's line_comment is an interior node: the `//` token
  // is a child and there is no `text` on the parent. The body lives
  // only in the source range. A doc comment's range includes the
  // trailing newline; that must not become an extra blank line.
  const source = "x // c\n/// doc\n";
  const pkg = commentsPkg({ comments: ["line_comment"] });
  const root = commentedFile([
    { type: "name", start: 0, end: 1, text: "x" },
    {
      type: "line_comment",
      start: 2,
      end: 6,
      children: [{ type: "//", start: 2, end: 4, text: "//" }],
    },
    {
      type: "line_comment",
      start: 7,
      end: 15,
      children: [
        { type: "//", start: 7, end: 9, text: "//" },
        { type: "doc_comment", start: 9, end: 15, text: "/ doc\n" },
      ],
    },
  ], 15);
  assert.equal(runOn(pkg, source, root, 80), "x // c\n/// doc\n");
});

test("doc comment range newline does not eat the following blank", () => {
  const source = "//! inner\n\n// own-line\nfn";
  const pkg = commentsPkg({ comments: ["line_comment"] });
  const root = commentedFile([
    {
      type: "line_comment",
      start: 0,
      end: 10,
      children: [
        { type: "//", start: 0, end: 2, text: "//" },
        { type: "doc_comment", start: 2, end: 10, text: "! inner\n" },
      ],
    },
    {
      type: "line_comment",
      start: 11,
      end: 22,
      children: [{ type: "//", start: 11, end: 13, text: "//" }],
    },
    { type: "name", start: 23, end: 25, text: "fn" },
  ], 25);
  assert.equal(runOn(pkg, source, root, 80), "//! inner\n\n// own-line\nfn\n");
});

test("comment fields default to one", () => {
  const source = "x# one\n\n\n# two";
  const root = commentedFile([
    { type: "name", start: 0, end: 1, text: "x" },
    { type: "comment", start: 1, end: 6, text: "# one" },
    { type: "comment", start: 9, end: 14, text: "# two" },
  ], 14);
  assert.equal(runOn(commentsPkg(), source, root, 80), "x # one\n\n# two\n");
});

test("comment_gap controls trailing comment spacing", () => {
  const source = "x# c";
  const root = commentedFile([
    { type: "name", start: 0, end: 1, text: "x" },
    { type: "comment", start: 1, end: 4, text: "# c" },
  ], 4);
  assert.equal(runOn(commentsPkg({ comment_gap: 4 }), source, root, 80), "x    # c\n");
});

test("blank_cap limits blank lines next to a comment", () => {
  const source = "x\n\n\n\n\n# c";
  const root = commentedFile([
    { type: "name", start: 0, end: 1, text: "x" },
    { type: "comment", start: 6, end: 9, text: "# c" },
  ], 9);
  assert.equal(runOn(commentsPkg({ blank_cap: 3 }), source, root, 80), "x\n\n\n\n# c\n");
});

test("comment fields refuse invalid counts", () => {
  for (const [value, message] of [
    [9, /`comment_gap` is 9; the most allowed is 8/],
    [-1, /`comment_gap` must be a non-negative integer, got -1/],
    [1.5, /`comment_gap` must be a non-negative integer, got 1.5/],
  ]) {
    assert.throws(
      () => runOn(commentsPkg({ comment_gap: value }), "", commentedFile([], 0), 80),
      (e) => e instanceof Refusal && message.test(e.message),
    );
  }
});

test("the current package format is required", () => {
  const pkg = toy({ list: listRule });
  delete pkg.format;
  assert.throws(
    () => run(pkg, list(["a"], false), 80),
    (e) =>
      e instanceof Refusal &&
      /unknown package format undefined; expected "et-doc-rules\/1"/.test(e.message),
  );
});

test("an unknown package format names the value found and expected", () => {
  const pkg = toy({ list: listRule });
  pkg.format = "et-doc-rules/99";
  assert.throws(
    () => run(pkg, list(["a"], false), 80),
    (e) =>
      e instanceof Refusal &&
      /unknown package format "et-doc-rules\/99"; expected "et-doc-rules\/1"/.test(e.message),
  );
});

test("defs expand recursively and accept arbitrary JSON arguments", () => {
  const pkg = toy({
    list: ["use", "wrapped", "(", ")"],
  });
  pkg.defs = {
    emit: ["seq", ["tok", ["$", 0]], ["each", "named", ["$", 1]], ["tok", ["$", 2]]],
    wrapped: ["use", "emit", ["$", 0], ["seq", ["line"]], ["$", 1]],
  };
  const tree = list(["a", "b"], false);
  tree.children = tree.children.filter((child) => child.type !== ",");
  assert.equal(run(pkg, tree, 80), "(a\nb)\n");
});

test("unknown definitions and extra arguments refuse at load time", () => {
  const unknown = toy({ unused: ["use", "missing"] });
  assert.throws(() => run(unknown, list(["a"], false), 80), /unknown definition `missing`/);

  const extra = toy({ unused: ["use", "one", "a", "b"] });
  extra.defs = { one: ["tok", ["$", 0]] };
  assert.throws(
    () => run(extra, list(["a"], false), 80),
    /definition `one` expects 1 arguments, got 2/,
  );
});

test("out-of-range and out-of-body holes refuse at load time", () => {
  const missing = toy({ unused: ["use", "one"] });
  missing.defs = { one: ["tok", ["$", 0]] };
  assert.throws(
    () => run(missing, list(["a"], false), 80),
    /`\$` hole 0 in definition `one` is out of range for 0 arguments/,
  );

  const outside = toy({ unused: ["tok", ["$", 0]] });
  assert.throws(
    () => run(outside, list(["a"], false), 80),
    /`\$` hole is only valid inside a `defs` body/,
  );
});

test("definition cycles refuse at load time", () => {
  const pkg = toy({ unused: ["line"] });
  pkg.defs = { a: ["use", "b"], b: ["use", "a"] };
  assert.throws(
    () => run(pkg, list(["a"], false), 80),
    (e) => e instanceof Refusal && /definition cycle: (a -> b -> a|b -> a -> b)/.test(e.message),
  );
});

test("definition nesting has a fixed load-time limit", () => {
  const pkg = toy({ unused: ["use", "d0"] });
  pkg.defs = {};
  for (let i = 0; i <= 32; i++) {
    pkg.defs[`d${i}`] = i === 32 ? ["line"] : ["use", `d${i + 1}`];
  }
  assert.throws(
    () => run(pkg, list(["a"], false), 80),
    /definition nesting exceeds the maximum depth of 32/,
  );
});

test("every rule is operand-checked at load time", () => {
  const pkg = toy({
    list: listRule,
    unreachable: ["blank", 2, "notalist"],
  });
  assert.throws(
    () => run(pkg, list(["a"], false), 80),
    /expected a list of node types, got "notalist"/,
  );
});

test("a trailing separator is added only when the bracket holds a list", () => {
  const pkg = toy({ list: listRule });
  assert.equal(run(pkg, list(["aaa", "bbb"], false), 4), "(\n  aaa,\n  bbb,\n)\n");
  assert.equal(run(pkg, list(["aaaaaa"], false), 4), "(\n  aaaaaa\n)\n");
  assert.equal(run(pkg, list(["a", "b"], false), 80), "(a, b)\n");
});

test("a separator already in the source pins the layout open", () => {
  assert.equal(run(toy({ list: listRule }), list(["a", "b"], true), 80), "(\n  a,\n  b,\n)\n");
});

test("srcbreak stays expanded when the source broke but still obeys width", () => {
  const objRule = [
    "group", ["tok", "("],
    ["indent", ["srcbreak"],
      ["each", "named", ["seq", ["tok", ","], ["line"]]],
      ["trail", ",", "named"]],
    ["line"], ["tok", ")"],
  ];
  const pkg = toy({ obj: objRule });
  const obj = (source, cs) => ({ type: "obj", start: 0, end: source.length, children: cs });

  const broken = obj("(\n  a,\n  b\n)", [
    span("(", 0, 1, "("), span("a", 4, 5, "a"), span(",", 5, 6, ","),
    span("b", 8, 9, "b"), span(")", 10, 11, ")"),
  ]);
  assert.equal(runOn(pkg, "(\n  a,\n  b\n)", broken, 80), "(\n  a,\n  b,\n)\n");

  const flat = obj("(a, b)", [
    span("(", 0, 1, "("), span("a", 1, 2, "a"), span(",", 2, 3, ","),
    span("b", 4, 5, "b"), span(")", 5, 6, ")"),
  ]);
  assert.equal(runOn(pkg, "(a, b)", flat, 80), "( a, b )\n");

  const wide = obj("(aaaaa, bbbbb)", [
    span("(", 0, 1, "("), span("aaaaa", 1, 6, "aaaaa"), span(",", 6, 7, ","),
    span("bbbbb", 8, 13, "bbbbb"), span(")", 13, 14, ")"),
  ]);
  assert.equal(runOn(pkg, "(aaaaa, bbbbb)", wide, 6), "(\n  aaaaa,\n  bbbbb,\n)\n");
});

test("flatten breaks a whole chain together instead of staircasing", () => {
  const pkg = toy({
    sum: ["group", ["flatten", "sum", ["seq", ["line"], ["child", "f:operator"], ["sp"]]]],
  });
  const tree = chain([["+", "bbb"], ["+", "ccc"]], "aaa");
  assert.equal(run(pkg, tree, 80), "aaa + bbb + ccc\n");
  assert.equal(run(pkg, tree, 4), "aaa\n+ bbb\n+ ccc\n");
});

test("flatten stops where the operator binds tighter", () => {
  const pkg = toy({
    sum: ["group", ["flatten", "sum", ["seq", ["line"], ["child", "f:operator"], ["sp"]]]],
  });
  assert.equal(run(pkg, chain([["*", "bbb"], ["+", "ccc"]], "aaa"), 9), "aaa * bbb\n+ ccc\n");
});

test("flatten uses the package's field names", () => {
  // The defect: these three strings used to live in both evaluators, so a
  // grammar that called them lhs/op/rhs was refused and no package rewrite
  // could save it. The probe built exactly this tree.
  const fields = { left: "lhs", operator: "op", right: "rhs" };
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["+", "*"],
    precedence: { "+": 5, "*": 4 },
    flatten_fields: fields,
    rules: {
      sum: ["group", ["flatten", "sum", ["seq", ["line"], ["child", "f:op"], ["sp"]]]],
    },
  };
  const tree = chain([["+", "bbb"], ["+", "ccc"]], "aaa", fields);
  assert.equal(run(pkg, tree, 80), "aaa + bbb + ccc\n");
  assert.equal(run(pkg, tree, 4), "aaa\n+ bbb\n+ ccc\n");
  // Tightness must read `op` too, or mixed precedence would not split.
  assert.equal(run(pkg, chain([["*", "bbb"], ["+", "ccc"]], "aaa", fields), 9), "aaa * bbb\n+ ccc\n");
});

function fieldlessChain(ops, base) {
  let node = leaf("name", base);
  for (const [op, rhs] of ops) {
    node = {
      type: "sum",
      start: 0,
      end: 0,
      children: [node, leaf(op, op), leaf("name", rhs)],
    };
  }
  return node;
}

test("flatten walks a fieldless binary spine", () => {
  // TypeScript unions are `[operand, "|", operand]` with no left/operator/right
  // fields. The same opcode has to flatten that shape, or every nested union
  // staircases.
  const pkg = toy({
    sum: ["group", ["flatten", "sum", ["seq", ["line"], ["tok", "|"], ["sp"]]]],
  });
  const tree = fieldlessChain([["|", "bbb"], ["|", "ccc"]], "aaa");
  assert.equal(run(pkg, tree, 80), "aaa | bbb | ccc\n");
  assert.equal(run(pkg, tree, 4), "aaa\n| bbb\n| ccc\n");
});

test("flatten keeps a suffix comment on a skipped left", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["|"],
    comments: ["comment"],
    rules: {
      sum: ["group", ["flatten", "sum", ["seq", ["line"], ["tok", "|"], ["sp"]]]],
    },
  };
  const source = "aaa | bbb /* c */ | ccc";
  const tree = {
    type: "sum",
    start: 0,
    end: source.length,
    children: [
      {
        type: "sum",
        start: 0,
        end: 9,
        children: [
          { type: "name", start: 0, end: 3, text: "aaa" },
          { type: "|", start: 4, end: 5, text: "|" },
          { type: "name", start: 6, end: 9, text: "bbb" },
        ],
      },
      { type: "comment", start: 10, end: 17, text: "/* c */" },
      { type: "|", start: 18, end: 19, text: "|" },
      { type: "name", start: 20, end: 23, text: "ccc" },
    ],
  };
  const got = runOn(pkg, source, tree, 80);
  assert.match(got, /\/\* c \*\//);
  assert.match(got, /ccc/);
});

test("flatten emits skipped suffix comments at their own spine levels", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["|"],
    comments: ["comment"],
    rules: {
      sum: ["group", ["flatten", "sum", ["seq", ["line"], ["tok", "|"], ["sp"]]]],
    },
  };
  const source = "aaa | bbb /* one */ | ccc /* two */ | ddd";
  const first = {
    type: "sum", start: 0, end: 9,
    children: [span("name", 0, 3, "aaa"), span("|", 4, 5, "|"), span("name", 6, 9, "bbb")],
  };
  const second = {
    type: "sum", start: 0, end: 25,
    children: [first, span("comment", 10, 19, "/* one */"), span("|", 20, 21, "|"), span("name", 22, 25, "ccc")],
  };
  const root = {
    type: "sum", start: 0, end: source.length,
    children: [second, span("comment", 26, 35, "/* two */"), span("|", 36, 37, "|"), span("name", 38, 41, "ddd")],
  };
  assert.equal(runOn(pkg, source, root, 80), "aaa\n| bbb /* one */\n| ccc /* two */\n| ddd\n");
});

test("flatten fieldless fallback keeps the leading-comment refusal", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["|"],
    comments: ["comment"],
    rules: {
      sum: ["group", ["flatten", "sum", ["seq", ["line"], ["tok", "|"], ["sp"]]]],
    },
  };
  const left = fieldlessChain([["|", "bbb"]], "aaa");
  const root = {
    type: "sum", start: 0, end: 0,
    children: [leaf("comment", "/* lead */"), left, leaf("|", "|"), leaf("name", "ccc")],
  };
  assert.throws(
    () => run(pkg, root, 80),
    (err) => err instanceof Refusal && /no leading comment on an operand/.test(err.message),
  );
});

test("flatten emits an after-comment from a skipped fielded operand", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["|", "rhs"],
    comments: ["comment"],
    precedence: { "|": 1 },
    rules: {
      sum: ["group", ["flatten", "sum", ["seq", ["line"], ["child", "f:operator"], ["sp"]]]],
    },
  };
  const source = "aaa | bbb\n/* after */\n| rhs";
  const left = chain([["|", "bbb"]], "aaa");
  left.field = "left";
  const root = {
    type: "sum", start: 0, end: source.length,
    children: [
      left,
      span("comment", 10, 21, "/* after */"),
      { ...span("|", 22, 23, "|"), field: "operator" },
      { ...span("rhs", 24, 27, "rhs"), field: "right" },
    ],
  };
  assert.equal(runOn(pkg, source, root, 80), "aaa\n| bbb\n/* after */\n| rhs\n");
});

test("flatten does not infer tightness past a fielded operator without text", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["+", "*"],
    precedence: { "+": 5, "*": 4 },
    rules: {
      sum: ["group", ["flatten", "sum", ["seq", ["line"], ["child", "f:operator"], ["child", "*"], ["sp"]]]],
      marker: [],
    },
  };
  const marked = (left, op, rhs) => ({
    type: "sum", start: 0, end: 0,
    children: [
      { ...left, field: "left" },
      { type: "marker", start: 0, end: 0, field: "operator", children: [] },
      leaf(op, op),
      { ...leaf("name", rhs), field: "right" },
    ],
  });
  const tree = marked(marked(leaf("name", "aaa"), "*", "bbb"), "+", "ccc");
  assert.equal(run(pkg, tree, 9), "aaa\n* bbb\n+ ccc\n");
});

test("flatten_fields refuses a bad header", () => {
  for (const [value, message] of [
    [["left", "operator", "right"], /`flatten_fields` must be an object, got \["left","operator","right"\]/],
    [{ left: "lhs", operator: "op" }, /`flatten_fields` is missing `right`/],
    [{ left: "lhs", operator: "op", right: "rhs", mid: "x" }, /`flatten_fields` has unknown field `mid`/],
    [{ left: "", operator: "op", right: "rhs" }, /`flatten_fields\.left` must be a non-empty string, got ""/],
    [{ left: 1, operator: "op", right: "rhs" }, /`flatten_fields\.left` must be a non-empty string, got 1/],
    [{ left: "lhs", operator: "lhs", right: "rhs" }, /`flatten_fields` field names must be distinct/],
  ]) {
    const pkg = toy({ file: ["each", "*", ["seq"]] });
    pkg.flatten_fields = value;
    assert.throws(
      () => run(pkg, { type: "file", start: 0, end: 0 }, 80),
      (e) => e instanceof Refusal && message.test(e.message),
    );
  }
});

const quotePkg = () => toy({ quote: ["verbatim"] });

test("verbatim emits the source slice when the subtree checks out", () => {
  const { source, root } = quoteOk();
  assert.equal(runOn(quotePkg(), source, root, 80), '"hi"\n');
});

test("verbatim refuses when a leaf's text does not match the source", () => {
  const { source, root } = quote(0, 4, [
    span("open", 0, 1, '"'),
    span("body", 1, 3, "HI"),
    span("close", 3, 4, '"'),
  ]);
  assert.throws(
    () => runOn(quotePkg(), source, root, 80),
    (e) =>
      e instanceof Refusal &&
      /verbatim `quote`/.test(e.message) &&
      /leaf whose text does not match the source/.test(e.message),
  );
});

test("verbatim refuses when a descendant is outside its parent", () => {
  const { root } = quote(0, 4, [
    span("open", 0, 1, '"'),
    span("body", 1, 5, "hi"),
    span("close", 3, 4, '"'),
  ]);
  const source = '"hi"x';
  assert.throws(
    () => runOn(quotePkg(), source, root, 80),
    (e) =>
      e instanceof Refusal &&
      /verbatim `quote`/.test(e.message) &&
      /outside its parent/.test(e.message),
  );
});

test("verbatim refuses when siblings overlap", () => {
  // Each leaf matches its own slice; the ranges themselves overlap.
  const { source, root } = quote(0, 4, [
    span("open", 0, 2, '"h'),
    span("body", 1, 3, "hi"),
    span("close", 3, 4, '"'),
  ]);
  assert.throws(
    () => runOn(quotePkg(), source, root, 80),
    (e) =>
      e instanceof Refusal &&
      /verbatim `quote`/.test(e.message) &&
      /overlapping siblings/.test(e.message),
  );
});

test("tree loader refuses before verbatim when a range is reversed", () => {
  const { source, root } = quoteOk();
  root.start = 4;
  root.end = 0;
  assert.throws(
    () => runOn(quotePkg(), source, root, 80),
    (e) =>
      e instanceof Refusal &&
      /malformed tree: node `quote`/.test(e.message) &&
      /reversed range/.test(e.message),
  );
});

test("both runtimes refuse the same corrupt verbatim tree", () => {
  const { source, root } = quote(0, 4, [
    span("open", 0, 1, '"'),
    span("body", 1, 3, "HI"),
    span("close", 3, 4, '"'),
  ]);
  const pkg = quotePkg();
  assert.throws(
    () => runOn(pkg, source, root, 80),
    (e) =>
      e instanceof Refusal &&
      /verbatim `quote`/.test(e.message) &&
      /leaf whose text does not match the source/.test(e.message),
  );

  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-"));
  const treePath = path.join(dir, "tree.json");
  const pkgDir = path.join(dir, "packages");
  fs.mkdirSync(pkgDir);
  fs.writeFileSync(treePath, JSON.stringify({ language: "toy", source, root }));
  fs.writeFileSync(path.join(pkgDir, "toy.json"), JSON.stringify(pkg));
  const rust = path.join(__dirname, "..", "rust", "target", "release", "docfmt");
  const result = spawnSync(rust, [treePath, "80"], {
    env: { ...process.env, FMT_PACKAGES: pkgDir },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "rust must refuse");
  assert.match(result.stderr, /verbatim `quote`/);
  assert.match(result.stderr, /leaf whose text does not match the source/);
});

function stmtsPkg(around) {
  return {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["(", ")", ",", "+", "def", "="],
    comments: ["comment"],
    rules: {
      file: ["each", "named", ["seq", ["hard"], ["blank", 2, around]]],
      fn: ["seq", ["tok", "def"], ["sp"], ["child", "t:name"],
           ["opt", "t:body", ["child", "t:body"]]],
      body: ["indent", ["hard"],
             ["each", "named", ["seq", ["hard"], ["blank", 1, around]]]],
      assign: ["seq", ["child", "t:name"], ["sp"], ["tok", "="], ["sp"],
               ["child", "t:num"]],
    },
  };
}

/** `x = 1` starting at `at`. */
function assignAt(at, name, num) {
  const n1 = at + name.length;
  const eq = n1 + 1;
  const v0 = eq + 2;
  const v1 = v0 + num.length;
  return {
    type: "assign", start: at, end: v1,
    children: [
      { type: "name", start: at, end: n1, text: name },
      { type: "=", start: eq, end: eq + 1, text: "=" },
      { type: "num", start: v0, end: v1, text: num },
    ],
  };
}

/** `def f` starting at `at`, optionally followed by a `body` child. */
function fnAt(at, name, body) {
  const n0 = at + 4;
  const n1 = n0 + name.length;
  const children = [
    { type: "def", start: at, end: at + 3, text: "def" },
    { type: "name", start: n0, end: n1, text: name },
  ];
  if (body) children.push(body);
  return { type: "fn", start: at, end: body ? body.end : n1, children };
}

test("blank opens to the cap on either side of a listed type", () => {
  // x = 1\ndef f\ny = 2\n  — packed in the source; the def must open
  // the gap *after* itself as well as before, or we have grok's bug.
  const source = "x = 1\ndef f\ny = 2\n";
  const root = {
    type: "file", start: 0, end: 18,
    children: [assignAt(0, "x", "1"), fnAt(6, "f"), assignAt(12, "y", "2")],
  };
  assert.equal(runOn(stmtsPkg(["fn"]), source, root, 80), "x = 1\n\n\ndef f\n\n\ny = 2\n");
});

test("blank inside a block uses the block cap as the floor", () => {
  const source = "def f\n  x = 1\n  def g\n  y = 2\n";
  const root = {
    type: "file", start: 0, end: 30,
    children: [fnAt(0, "f", {
      type: "body", start: 8, end: 29,
      children: [assignAt(8, "x", "1"), fnAt(16, "g"), assignAt(24, "y", "2")],
    })],
  };
  assert.equal(
    runOn(stmtsPkg(["fn"]), source, root, 80),
    "def f\n  x = 1\n\n  def g\n\n  y = 2\n",
  );
});

test("blank does not open a gap between unlisted types", () => {
  const source = "x = 1\ny = 2\n";
  const root = {
    type: "file", start: 0, end: 12,
    children: [assignAt(0, "x", "1"), assignAt(6, "y", "2")],
  };
  assert.equal(runOn(stmtsPkg(["fn"]), source, root, 80), "x = 1\ny = 2\n");
});

test("blank still caps a run longer than n", () => {
  const source = "x = 1\n\n\n\ndef f\n";
  const root = {
    type: "file", start: 0, end: 15,
    children: [assignAt(0, "x", "1"), fnAt(9, "f")],
  };
  assert.equal(runOn(stmtsPkg(["fn"]), source, root, 80), "x = 1\n\n\ndef f\n");
});

test("blank keeps the exact gap after a declared leaf spelling", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    rules: {
      file: [
        "seq",
        ["each", "named", ["seq", ["hard"], ["blank", 1, [], ["|+"]]]],
        ["blank", 1, [], ["|+"]],
      ],
      pair: ["verbatim"],
    },
  };
  const source = "|+\n  keep\n\n\nnext";
  const root = {
    type: "file", start: 0, end: 16,
    children: [
      {
        type: "pair", start: 0, end: 9,
        children: [{
          type: "block_scalar", start: 0, end: 9,
          children: [{ type: "|", start: 0, end: 2, text: "|+" }],
        }],
      },
      {
        type: "pair", start: 12, end: 16,
        children: [{ type: "word", start: 12, end: 16, text: "next" }],
      },
    ],
  };
  assert.equal(runOn(pkg, source, root, 80), "|+\n  keep\n\n\nnext\n");

  const eofSource = "|+\n  keep\n\n\n";
  const eofRoot = {
    type: "file", start: 0, end: 12,
    children: [{
      type: "pair", start: 0, end: 12,
      children: [{
        type: "block_scalar", start: 0, end: 12,
        children: [{ type: "|", start: 0, end: 2, text: "|+" }],
      }],
    }],
  };
  assert.equal(runOn(pkg, eofSource, eofRoot, 80), eofSource);
});

test("blank still caps after a subtree that merely contains the spelling", () => {
  // The `|+` is buried mid-subtree, so the gap that follows the subtree is
  // ordinary trivia belonging to the next item, not scalar content.
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    rules: {
      file: [
        "seq",
        ["each", "named", ["seq", ["hard"], ["blank", 1, [], ["|+"]]]],
        ["blank", 1, [], ["|+"]],
      ],
      pair: ["verbatim"],
    },
  };
  const source = "|+ tail\n\n\nnext";
  const root = {
    type: "file", start: 0, end: 14,
    children: [
      {
        type: "pair", start: 0, end: 7,
        children: [
          { type: "|", start: 0, end: 2, text: "|+" },
          { type: "word", start: 3, end: 7, text: "tail" },
        ],
      },
      {
        type: "pair", start: 10, end: 14,
        children: [{ type: "word", start: 10, end: 14, text: "next" }],
      },
    ],
  };
  assert.equal(runOn(pkg, source, root, 80), "|+ tail\n\nnext\n");
});

test("child-count can dispatch on a field's wrapped construct", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    rules: {
      file: [
        "when", ["child-count", "f:value", "t:block_scalar", 1],
        ["child", "named"], [],
      ],
      wrapper: ["verbatim"],
    },
  };
  const root = {
    type: "file", start: 0, end: 1,
    children: [{
      type: "wrapper", field: "value", start: 0, end: 1,
      children: [{
        type: "block_scalar", start: 0, end: 1,
        children: [{ type: "|", start: 0, end: 1, text: "|" }],
      }],
    }],
  };
  assert.equal(runOn(pkg, "|", root, 80), "|\n");
});

const allPkg = () => ({
  format: "et-doc-rules/1",
  indent: 2,
  rules: {
    file: [
      "when", ["all", "named", ["num", "word"]],
      ["each", "named", ["seq"]],
      [],
    ],
    num: ["verbatim"],
    word: ["verbatim"],
  },
});

test("all holds vacuously when no child matches the selector", () => {
  // Else is `[]` and would refuse leftover children, so a successful
  // empty format is the empty-case pin: both runtimes must agree.
  const root = { type: "file", start: 0, end: 0, children: [] };
  assert.equal(runOn(allPkg(), "", root, 80), "\n");
});

test("all holds when every selected child has a listed type", () => {
  const root = {
    type: "file", start: 0, end: 3,
    children: [
      { type: "num", start: 0, end: 1, text: "1" },
      { type: "word", start: 2, end: 3, text: "a" },
    ],
  };
  assert.equal(runOn(allPkg(), "1 a", root, 80), "1a\n");
});

test("all fails when one selected child has an unlisted type", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    rules: {
      file: [
        "when", ["all", "named", ["num"]],
        [],
        ["each", "named", ["seq"]],
      ],
      num: ["verbatim"],
      word: ["verbatim"],
    },
  };
  const root = {
    type: "file", start: 0, end: 3,
    children: [
      { type: "num", start: 0, end: 1, text: "1" },
      { type: "word", start: 2, end: 3, text: "a" },
    ],
  };
  assert.equal(runOn(pkg, "1 a", root, 80), "1a\n");
});

test("blank opens before a comment that leads a listed type", () => {
  const source = "x = 1\n# c\ndef f\n";
  const root = {
    type: "file", start: 0, end: 16,
    children: [
      assignAt(0, "x", "1"),
      { type: "comment", start: 6, end: 9, text: "# c" },
      fnAt(10, "f"),
    ],
  };
  assert.equal(runOn(stmtsPkg(["fn"]), source, root, 80), "x = 1\n\n\n# c\ndef f\n");
});

test("blank does not move a gap that sits between a comment and a def", () => {
  const source = "x = 1\n# c\n\ndef f\n";
  const root = {
    type: "file", start: 0, end: 17,
    children: [
      assignAt(0, "x", "1"),
      { type: "comment", start: 6, end: 9, text: "# c" },
      fnAt(11, "f"),
    ],
  };
  assert.equal(runOn(stmtsPkg(["fn"]), source, root, 80), "x = 1\n\n\n# c\n\ndef f\n");
});

test("blank without a type list is still only a cap", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["def", "="],
    rules: {
      file: ["each", "named", ["seq", ["hard"], ["blank", 2]]],
      fn: ["seq", ["tok", "def"], ["sp"], ["child", "t:name"]],
      assign: ["seq", ["child", "t:name"], ["sp"], ["tok", "="], ["sp"],
               ["child", "t:num"]],
    },
  };
  const source = "x = 1\ndef f\n";
  const root = {
    type: "file", start: 0, end: 12,
    children: [assignAt(0, "x", "1"), fnAt(6, "f")],
  };
  assert.equal(runOn(pkg, source, root, 80), "x = 1\ndef f\n");
});

test("after comments inside indent keep the indent", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    comments: ["comment"],
    tokens: ["def"],
    rules: {
      file: ["seq", ["tok", "def"], ["child", "t:body"]],
      body: ["indent", ["hard"], ["each", "named", ["hard"]]],
    },
  };
  const source = "def\n  x\n  # c\n";
  const root = {
    type: "file", start: 0, end: 13,
    children: [
      { type: "def", start: 0, end: 3, text: "def" },
      {
        type: "body", start: 4, end: 13,
        children: [
          { type: "name", start: 6, end: 7, text: "x" },
          { type: "comment", start: 10, end: 13, text: "# c" },
        ],
      },
    ],
  };
  assert.equal(runOn(pkg, source, root, 80), "def\n  x\n  # c\n");
});

test("a comment-only descend block keeps the comment inside", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    comments: ["comment"],
    descend: ["block"],
    tokens: ["{", "}"],
    rules: {
      file: ["child", "t:block"],
      block: [
        "seq",
        ["tok", "{"],
        ["indent", ["opt", "named", ["seq", ["hard"], ["each", "named", ["hard"]]]]],
        ["hard"],
        ["tok", "}"],
      ],
    },
  };
  const source = "{\n  /* c */\n}";
  const root = {
    type: "file", start: 0, end: 13,
    children: [{
      type: "block", start: 0, end: 13,
      children: [
        { type: "{", start: 0, end: 1, text: "{" },
        { type: "comment", start: 4, end: 11, text: "/* c */" },
        { type: "}", start: 12, end: 13, text: "}" },
      ],
    }],
  };
  assert.equal(runOn(pkg, source, root, 80), "{\n  /* c */\n}\n");
});

test("trailing trivia does not make an own-line comment a suffix", () => {
  // tree-sitter-go's statement_list range includes the newline after
  // the last statement, so an own-line comment before `}` looks
  // adjacent if suffix detection uses node.end.
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    comments: ["comment"],
    descend: ["statements"],
    tokens: ["{", "}"],
    rules: {
      file: ["child", "t:block"],
      block: [
        "seq",
        ["tok", "{"],
        ["child", "t:statements"],
        ["indent"],
        ["hard"],
        ["tok", "}"],
      ],
      statements: ["indent", ["hard"], ["each", "named", ["hard"]]],
      name: ["verbatim"],
    },
  };
  const source = "{\n  x\n  // c\n}";
  const root = {
    type: "file", start: 0, end: 14,
    children: [{
      type: "block", start: 0, end: 14,
      children: [
        { type: "{", start: 0, end: 1, text: "{" },
        {
          type: "statements", start: 4, end: 6,
          children: [
            { type: "name", start: 4, end: 5, text: "x" },
          ],
        },
        { type: "comment", start: 8, end: 12, text: "// c" },
        { type: "}", start: 13, end: 14, text: "}" },
      ],
    }],
  };
  assert.equal(runOn(pkg, source, root, 80), "{\n  x\n  // c\n}\n");
});

test("trail comma precedes an own-line comment before the closer", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["(", ")", ","],
    comments: ["comment"],
    rules: {
      list: [
        "group", ["tok", "("],
        ["indent", ["soft"],
          ["each", "named", ["seq", ["tok", ","], ["line"]]],
          ["trail", ",", "*"]],
        ["soft"], ["tok", ")"],
      ],
    },
  };
  const source = "(a\n# c\n)";
  const root = {
    type: "list", start: 0, end: 8,
    children: [
      { type: "(", start: 0, end: 1, text: "(" },
      { type: "name", start: 1, end: 2, text: "a" },
      { type: "comment", start: 3, end: 6, text: "# c" },
      { type: ")", start: 7, end: 8, text: ")" },
    ],
  };
  assert.equal(runOn(pkg, source, root, 4), "(\n  a,\n  # c\n)\n");
});

test("a flat rule keeps an own-line comment before the closer", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["[", "]", ","],
    comments: ["comment"],
    rules: {
      array: [
        "seq", ["tok", "["],
        ["each", "named", ["seq", ["tok", ","], ["sp"]]],
        ["trail", ",", "*"], ["tok", "]"],
      ],
    },
  };
  const source = "a = [\n  1,\n  # a comment before the closer\n]\n";
  const root = {
    type: "array", start: 4, end: 44,
    children: [
      { type: "[", start: 4, end: 5, text: "[" },
      { type: "integer", start: 8, end: 9, text: "1" },
      { type: ",", start: 9, end: 10, text: "," },
      {
        type: "comment", start: 13, end: 42,
        text: "# a comment before the closer",
      },
      { type: "]", start: 43, end: 44, text: "]" },
    ],
  };
  assert.equal(
    runOn(pkg, source, root, 80),
    "[1,\n# a comment before the closer\n]\n",
  );
});

test("blank at end of a rule preserves trailing trivia", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["["],
    rules: {
      file: ["each", "named", ["seq", ["hard"], ["blank", 2]]],
      table: ["seq", ["tok", "["], ["child", "named"], ["blank", 2]],
    },
  };
  const source = "[a\n\n[b\n";
  const root = {
    type: "file", start: 0, end: 7,
    children: [
      {
        type: "table", start: 0, end: 4,
        children: [
          { type: "[", start: 0, end: 1, text: "[" },
          { type: "name", start: 1, end: 2, text: "a" },
        ],
      },
      {
        type: "table", start: 4, end: 7,
        children: [
          { type: "[", start: 4, end: 5, text: "[" },
          { type: "name", start: 5, end: 6, text: "b" },
        ],
      },
    ],
  };
  assert.equal(runOn(pkg, source, root, 80), "[a\n\n[b\n");
});

// Expansion is memoised on the package object, because it is work proportional
// to the package rather than the tree. These pin the two ways that can go wrong.

test("a malformed package refuses every call, not just the first", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: ["="],
    rules: { file: ["use", "no_such_def"] },
  };
  const root = { type: "file", start: 0, end: 0, children: [] };
  for (const attempt of [1, 2, 3]) {
    assert.throws(
      () => runOn(pkg, "", root, 80),
      /unknown definition `no_such_def`/,
      `attempt ${attempt}`,
    );
  }
});

test("two packages with the same shape do not share an expansion", () => {
  const pkgWith = (open, close) => ({
    format: "et-doc-rules/1",
    indent: 2,
    tokens: [open, close],
    defs: { brackets: ["seq", ["tok", ["$", 0]], ["tok", ["$", 1]]] },
    rules: { file: ["use", "brackets", open, close] },
  });
  const root = (open, close) => ({
    type: "file", start: 0, end: 2,
    children: [leaf(open, open), leaf(close, close)],
  });
  assert.equal(runOn(pkgWith("[", "]"), "[]", root("[", "]"), 80), "[]\n");
  assert.equal(runOn(pkgWith("{", "}"), "{}", root("{", "}"), 80), "{}\n");
});

test("tab_stop respells a finished indent column, and refuses the two clashes", () => {
  // indent 9 under a stop of 8: one tab, then the residual space.
  const pkg = (fields) => ({
    format: "et-doc-rules/1",
    indent: 9,
    tokens: ["("],
    rules: { list: ["seq", ["tok", "("], ["indent", ["hard"], ["child", "named"]]] },
    ...fields,
  });
  const root = { type: "list", start: 0, end: 0, children: [leaf("(", "("), leaf("name", "b")] };
  assert.equal(run(pkg({}), root, 80), "(\n         b\n");
  assert.equal(run(pkg({ tab_stop: 8 }), root, 80), "(\n\t b\n");
  assert.equal(run({ ...pkg({ tab_stop: 8 }), indent: 8 }, root, 80), "(\n\tb\n");
  const blank = {
    type: "list", start: 0, end: 0,
    children: [leaf("(", "("), leaf("name", "b")],
  };
  const blankPkg = {
    ...pkg({ tab_stop: 8 }),
    rules: { list: ["seq", ["tok", "("], ["hard"], ["hard"], ["child", "named"]] },
  };
  assert.equal(run(blankPkg, blank, 80), "(\n\nb\n");
  assert.throws(
    () => run(pkg({ tab_stop: 8, tab_indent: true }), root, 80),
    (err) => err instanceof Refusal && /both spell the indent/.test(err.message),
  );
  assert.throws(
    () => run(pkg({ tab_stop: 8, comment_cells: true }), root, 80),
    (err) => err instanceof Refusal && /disagree about columns/.test(err.message),
  );
  assert.throws(() => run(pkg({ tab_stop: 8, comment_cells: "block" }), root, 80));
  assert.doesNotThrow(() => run(pkg({ tab_stop: 0, tab_indent: true }), root, 80));
  assert.doesNotThrow(() => run(pkg({ tab_stop: 0, comment_cells: "block" }), root, 80));
  for (const tab_stop of [-1, 1.5, "8", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => run(pkg({ tab_stop }), root, 80),
      (err) => err instanceof Refusal && /non-negative safe integer/.test(err.message),
    );
  }
});

test("a fill separator breaks while a suffix is pending", () => {
  // FINDINGS 33, the JS mirror of doc.rs's
  // a_fill_separator_breaks_while_a_suffix_is_pending. `a` carries a trailing
  // comment queued until a break. A flat separator does not flush it, so it
  // would land after `b` -- and after anything `b` emits first, which for a
  // leading line comment means inside it.
  const pkg = {
    ...toy({
      list: [
        "group", ["tok", "("],
        ["indent", ["soft"], ["fill", "named", ["seq", ["tok", ","], ["line"]]]],
        ["soft"], ["tok", ")"],
      ],
    }),
    comments: ["comment"],
  };
  // `a # one` then a leading `# two` on `b`: the two comments must not merge.
  const source = "(a# one\n# two\n,b,c)";
  const root = {
    type: "list", start: 0, end: 19,
    children: [
      span("(", 0, 1, "("),
      span("name", 1, 2, "a"),
      span("comment", 2, 7, "# one"),
      span("comment", 8, 13, "# two"),
      span(",", 13, 14, ","),
      span("name", 14, 15, "b"),
      span(",", 15, 16, ","),
      span("name", 16, 17, "c"),
      span(")", 18, 19, ")"),
    ],
  };
  const out = runOn(pkg, source, root, 80);
  assert.equal(out, "(\n  a, # one\n  # two\n  b, c\n)\n");
  // The two comments stay two comments: nothing follows `# one` on its line.
  assert.ok(!/# one .*# two/.test(out), `comments merged onto one line: ${out}`);
});

// FINDINGS 30's remaining half, the JS mirror of eval.rs's
// a_declared_gap_owner_measures_past_the_childs_own_subtree. The source blank
// sits INSIDE the first item, one level below where peeling one terminator
// reaches -- markdown's loose list, where the blank that makes the list loose
// lives in the preceding list_item.
test("a declared gap owner measures past the child's own subtree", () => {
  const pkg = (gap_owner) => ({
    format: "et-doc-rules/1",
    indent: 2,
    tokens: [],
    gap_owner,
    rules: {
      file: ["each", "named", ["seq", ["hard"], ["blank", 1]]],
      item: ["child", "t:name"],
      name: ["verbatim"],
    },
  });
  const source = "a\n\nb";
  const root = () => ({
    type: "file", start: 0, end: 4,
    children: [
      { type: "item", start: 0, end: 3, children: [{ type: "name", start: 0, end: 1, text: "a" }] },
      { type: "item", start: 3, end: 4, children: [{ type: "name", start: 3, end: 4, text: "b" }] },
    ],
  });
  assert.equal(runOn(pkg({}), source, root(), 80), "a\nb\n");
  assert.equal(runOn(pkg({ file: ["item"] }), source, root(), 80), "a\n\nb\n");
  assert.equal(runOn(pkg({ file: ["other"] }), source, root(), 80), "a\nb\n");
});

// The double-count that made every global depth worse than no depth at all:
// the enclosing separator and the node's own trailing `blank` both see one
// source blank. Ownership settles the sibling gap only.
test("a gap owner does not move the trailing blank", () => {
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: [],
    gap_owner: { file: ["item"] },
    rules: {
      file: ["seq", ["each", "named", ["seq", ["hard"], ["blank", 1]]], ["blank", 1]],
      item: ["child", "t:name"],
      name: ["verbatim"],
    },
  };
  const root = {
    type: "file", start: 0, end: 6,
    children: [
      { type: "item", start: 0, end: 3, children: [{ type: "name", start: 0, end: 1, text: "a" }] },
      { type: "item", start: 3, end: 6, children: [{ type: "name", start: 3, end: 4, text: "b" }] },
    ],
  };
  // Deep here would reach `b` and count the trailing blank a second time.
  assert.equal(runOn(pkg, "a\n\nb\n\n", root, 80), "a\n\nb\n");
});

// Rust deserialises gap_owner as a map of node type to a set of node types; a
// package that loads in one runtime and refuses in the other is a parity break
// no corpus can see (FINDINGS 29b).
test("gap_owner refuses a shape Rust would reject", () => {
  const pkg = (gap_owner) => ({
    format: "et-doc-rules/1", indent: 2, tokens: [], gap_owner,
    rules: { file: ["each", "named", ["hard"]] },
  });
  const root = { type: "file", start: 0, end: 0, children: [] };
  assert.throws(() => runOn(pkg(["list"]), "", root, 80), /`gap_owner` must be an object/);
  assert.throws(() => runOn(pkg({ list: "list_item" }), "", root, 80), /must be an array of node types/);
  assert.throws(() => runOn(pkg({ list: [7] }), "", root, 80), /must be an array of node types/);
});

test("a swallowed terminator is peeled once and only once", () => {
  // FINDINGS 30, the JS mirror of eval.rs's
  // a_swallowed_terminator_is_peeled_once_and_only_once. Same source, same
  // rules; the two trees differ only in where the first node ends, which is all
  // that separates markdown's atx_heading (swallows its line ending) from
  // toml's table_array_element (swallows that AND the blank run its own rule
  // already accounts for).
  const pkg = {
    format: "et-doc-rules/1",
    indent: 2,
    tokens: [],
    rules: {
      file: ["each", "named", ["seq", ["hard"], ["blank", 1]]],
      item: ["child", "t:name"],
      name: ["verbatim"],
    },
  };
  const source = "a\n\nb";
  const tree = (firstEnd, fileEnd = 4) => ({
    type: "file", start: 0, end: fileEnd,
    children: [
      { type: "item", start: 0, end: firstEnd,
        children: [{ type: "name", start: 0, end: 1, text: "a" }] },
      { type: "item", start: 3, end: 4,
        children: [{ type: "name", start: 3, end: 4, text: "b" }] },
    ],
  });
  assert.equal(runOn(pkg, source, tree(2), 80), "a\n\nb\n");
  assert.equal(runOn(pkg, source, tree(3), 80), "a\nb\n");
  // The loader now owns this invariant, so `newlines` cannot revive the old
  // `get`/`subarray` clamp disagreement at its downstream byte loop.
  assert.throws(
    () => runOn(pkg, source, tree(2, 50), 80),
    /malformed tree: node `file`.*past the source/,
  );
});

// --- table -----------------------------------------------------------------

const tablePkg = () => ({
  format: "et-doc-rules/1",
  indent: 2,
  tokens: ["|", "cont"],
  rules: { table: ["table"] },
});

const cell = (type, start, end) => ({ type, start, end, children: [] });
const bar = (at) => ({ type: "|", start: at, end: at + 1, text: "|" });
const row = (type, start, end, cells) => ({
  type,
  start,
  end,
  children: [bar(start), ...cells, bar(end - 1)],
});

// `| a | bb |` / `|:-|-:|` / `| longer | 2 |`, with the grammar's own cell
// spans: it strips a cell's leading space and keeps its trailing one.
const wonky =
  "| a | bb |\n" +
  "|:-|-:|\n" +
  "| longer | 2 |\n";

const wonkyTable = () => ({
  type: "table",
  start: 0,
  end: 34,
  children: [
    row("head", 0, 10, [cell("cell", 2, 4), cell("cell", 6, 9)]),
    row("ruler", 11, 18, [cell("rule", 12, 14), cell("rule", 15, 17)]),
    row("body", 19, 33, [cell("cell", 21, 28), cell("cell", 30, 32)]),
  ],
});

test("table pads to the widest cell and redraws the ruler to match", () => {
  assert.strictEqual(
    runOn(tablePkg(), wonky, wonkyTable(), 80),
    "| a      |  bb |\n| :----- | --: |\n| longer |   2 |\n",
  );
});

test("table floors a column at three and never measures the ruler", () => {
  // Both columns hold one character; the ruler in the source is seven wide
  // and carries no alignment, so every column comes out at the floor.
  const source = "| a | b |\n|-------|-|\n";
  const root = {
    type: "table",
    start: 0,
    end: 22,
    children: [
      row("head", 0, 9, [cell("cell", 2, 4), cell("cell", 6, 8)]),
      row("ruler", 10, 21, [cell("rule", 11, 18), cell("rule", 19, 20)]),
    ],
  };
  assert.strictEqual(
    runOn(tablePkg(), source, root, 80),
    "| a   | b   |\n| --- | --- |\n",
  );
});

test("table keeps a container's per-line marker in front of its row", () => {
  // What a table inside a block quote looks like: the host's `> ` arrives as
  // a token child of the table, between the rows it prefixes.
  const source = "| a |\n> |-|\n> | bb |\n";
  const root = {
    type: "table",
    start: 0,
    end: 21,
    children: [
      row("head", 0, 5, [cell("cell", 2, 4)]),
      { type: "cont", start: 6, end: 8, text: "> " },
      row("ruler", 8, 11, [cell("rule", 9, 10)]),
      { type: "cont", start: 12, end: 14, text: "> " },
      row("body", 14, 20, [cell("cell", 16, 19)]),
    ],
  };
  assert.strictEqual(
    runOn(tablePkg(), source, root, 80),
    "| a   |\n> | --- |\n> | bb  |\n",
  );
});

test("table leaves a ragged row ragged rather than squaring it off", () => {
  const source = "| a | b |\n| - | - |\n| 1 |\n";
  const root = {
    type: "table",
    start: 0,
    end: 26,
    children: [
      row("head", 0, 9, [cell("cell", 2, 4), cell("cell", 6, 8)]),
      row("ruler", 10, 19, [cell("rule", 12, 13), cell("rule", 16, 17)]),
      row("body", 20, 25, [cell("cell", 22, 24)]),
    ],
  };
  assert.strictEqual(
    runOn(tablePkg(), source, root, 80),
    "| a   | b   |\n| --- | --- |\n| 1   |\n",
  );
});

test("table refuses to share its node with another expression", () => {
  const pkg = tablePkg();
  pkg.rules.table = ["seq", ["child", "t:cont"], ["table"]];
  const root = wonkyTable();
  root.children.unshift({ type: "cont", start: 0, end: 0, text: "" });
  assert.throws(
    () => runOn(pkg, wonky, root, 80),
    (e) => e instanceof Refusal && /`table` takes every child/.test(e.message),
  );
});

// --- blank_owner -----------------------------------------------------------

// `block` is a leaf whose source range runs past the blank line that ends it,
// which is markdown's `indented_code_block`. `p` is an ordinary paragraph.
const spentPkg = (owner) => ({
  format: "et-doc-rules/1",
  indent: 2,
  blank_cap: 1,
  ...(owner ? { blank_owner: owner } : {}),
  rules: {
    file: ["each", "named", ["blank", 1, ["list", "p", "block"]]],
    p: ["verbatim"],
  },
});

//        0        9 10          24        33
const spentSrc = "one line\n\n    code\n\nlast line\n";
const spentTree = () => ({
  type: "file",
  start: 0,
  end: 30,
  children: [
    { type: "p", start: 0, end: 9, children: [] },
    { type: "block", start: 10, end: 20, text: "    code\n\n" },
    { type: "p", start: 20, end: 30, children: [] },
  ],
});

test("a listed node's own trailing blank is not emitted twice", () => {
  assert.strictEqual(
    runOn(spentPkg(["block"]), spentSrc, spentTree(), 80),
    "one line\n\n    code\n\nlast line\n",
  );
});

test("without the declaration the same tree grows a blank line", () => {
  assert.strictEqual(
    runOn(spentPkg(null), spentSrc, spentTree(), 80),
    "one line\n\n    code\n\n\nlast line\n",
  );
});

test("blank_owner reaches a listed node through the spine that ends where it does", () => {
  // The blank is eaten by a `block` nested inside the item, and the separator
  // that has to know is the one *after the item*.
  const src = "- a\n\n      code\n\n- b\n";
  const root = {
    type: "file",
    start: 0,
    end: 21,
    children: [
      {
        type: "p",
        start: 0,
        end: 17,
        children: [
          { type: "lead", start: 0, end: 4, text: "- a\n" },
          { type: "block", start: 4, end: 17, text: "\n      code\n\n" },
        ],
      },
      { type: "p", start: 17, end: 21, children: [] },
    ],
  };
  assert.strictEqual(
    runOn(spentPkg(["block"]), src, root, 80),
    "- a\n\n      code\n\n- b\n",
  );
});

test("blank_owner refuses anything but an array of node types", () => {
  assert.throws(
    () => runOn(spentPkg("block"), spentSrc, spentTree(), 80),
    (e) => e instanceof Refusal && /`blank_owner` must be an array/.test(e.message),
  );
});

test("table refuses an ERROR where a cell goes rather than re-emitting it", () => {
  // What `` `||` `` in a cell produces: the grammar splits the code span and
  // leaves a bare `|` behind as an ERROR, which would come back as a column.
  const source = "| a |\n| - |\n| ` | | ` |\n";
  const root = {
    type: "table",
    start: 0,
    end: 24,
    children: [
      row("head", 0, 5, [cell("cell", 2, 4)]),
      row("ruler", 6, 11, [cell("rule", 8, 9)]),
      {
        type: "body",
        start: 12,
        end: 23,
        children: [
          bar(12),
          cell("cell", 14, 16),
          bar(16),
          { type: "ERROR", start: 17, end: 18, children: [] },
          bar(18),
          cell("cell", 20, 22),
          bar(22),
        ],
      },
    ],
  };
  assert.throws(
    () => runOn(tablePkg(), source, root, 80),
    (e) => e instanceof Refusal && /has an unparsed cell at byte 17, so its columns cannot be measured/.test(e.message),
  );
});

// Whitespace trivia is declared by kind, checked against source, and consumed
// before attachment. These toy kinds exercise the capability without Markdown.
const whitespacePkg = (fields = {}) => ({
  format: "et-doc-rules/2", indent: 2, whitespace_nodes: ["gap"],
  comments: ["comment"],
  rules: { file: ["each", "named", ["blank", 1]], gap: ["verbatim"] },
  ...fields,
});
function triviaFile(chunks) {
  let source = "";
  const children = chunks.map(([kind, text]) => {
    const start = Buffer.byteLength(source);
    source += text;
    return span(kind, start, Buffer.byteLength(source), text);
  });
  return { source, root: { type: "file", start: 0, end: Buffer.byteLength(source), children } };
}
const runTrivia = (pkg, { source, root }) => runOn(pkg, source, root, 80);

test("declared whitespace leaves form one capped gap and no edge items", () => {
  const file = triviaFile([["gap", "\n\n"], ["a", "a\n"], ["gap", "\n"],
    ["gap", "\n\n"], ["b", "b\n"], ["gap", "\n\n"]]);
  assert.equal(runTrivia(whitespacePkg(), file), "a\n\nb\n");
  assert.equal(runTrivia(whitespacePkg(), triviaFile([["gap", "\n\n"]])), "\n");
});

test("whitespace trivia is opt in and separators still see their real neighbours", () => {
  const file = triviaFile([["a", "a\n"], ["gap", "\n"], ["b", "b\n"]]);
  const rules = { file: ["each", "named", ["hard"]] };
  assert.equal(runTrivia(whitespacePkg({ rules }), file), "a\n\nb\n");
  assert.equal(runTrivia(whitespacePkg({ rules, whitespace_nodes: [] }), file), "a\n\n\n\nb\n");
  const adjacent = triviaFile([["a", "a\n"], ["gap", ""], ["b", "b\n"]]);
  assert.equal(runTrivia(whitespacePkg({ rules: {
    file: ["each", "named", ["blank", 1, ["a"]]],
  } }), adjacent), "a\n\nb\n");
});

test("non-whitespace, interior nodes and injection boundaries remain items", () => {
  const file = triviaFile([["gap", "# Keep\n"], ["gap", "\u00a0\n"]]);
  assert.equal(runTrivia(whitespacePkg(), file), file.source);
  const interior = triviaFile([["gap", " \n"]]);
  const parent = interior.root.children[0];
  parent.children = [span("content", 0, 2, " \n")];
  delete parent.text;
  assert.equal(runTrivia(whitespacePkg(), interior), " \n");
  const injected = triviaFile([["a", "a\n"], ["gap", "\n"], ["b", "b\n"]]);
  injected.root.children[1].language = "toy";
  assert.equal(runTrivia(whitespacePkg({ rules: { file: ["each", "named", ["hard"]] } }), injected), "a\n\n\n\nb\n");
});

test("comments attach across whitespace trivia without being swallowed", () => {
  const file = triviaFile([["a", "a\n"], ["gap", "\n"], ["comment", "# keep"],
    ["gap", "\n\n"], ["b", "b\n"]]);
  assert.equal(runTrivia(whitespacePkg(), file), "a\n\n# keep\n\nb\n");
});

test("whitespace trivia cannot hide stale text or overlapping ranges", () => {
  const stale = triviaFile([["gap", "x"]]);
  stale.root.children[0].text = " ";
  assert.throws(() => runTrivia(whitespacePkg(), stale), /text does not match the source/);
  const overlap = triviaFile([["a", "a\n"], ["gap", "\n"], ["b", "b\n"]]);
  overlap.root.children[0].end = 3;
  overlap.root.children[0].text = "a\n\n";
  assert.throws(() => runTrivia(whitespacePkg(), overlap), /overlapping siblings/);
});

test("whitespace declarations require v2, a list of kinds, and disjoint comments", () => {
  const file = triviaFile([["a", "a\n"]]);
  for (const value of [null, "gap", {}, [1]]) {
    assert.throws(() => runTrivia(whitespacePkg({ whitespace_nodes: value }), file), Refusal);
  }
  assert.throws(() => runTrivia(whitespacePkg({ format: "et-doc-rules/1" }), file), /requires package format/);
  assert.throws(() => runTrivia(whitespacePkg({ format: "et-doc-rules/1", whitespace_nodes: [] }), file), /requires package format/);
  assert.throws(() => runTrivia(whitespacePkg({ comments: ["gap"] }), file), /must not overlap/);
});

// Discriminating trees from the 889c3ac repro: a `prose_run` that claims
// `[0, 16)` over `alpha beta gamma` but may omit children inside it.
const fs = require("node:fs");
const path = require("node:path");
const partitionPkg = (fields = {}) => ({
  format: "et-doc-rules/3",
  indent: 2,
  tokens: [],
  whitespace_nodes: ["prose_gap"],
  source_partitions: ["prose_run"],
  rules: {
    prose_run: ["fill", "t:prose_atom", ["line"]],
    prose_atom: ["verbatim"],
  },
  ...fields,
});
function partitionFixture(name) {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "testdata", "source_partitions", `${name}.tree.json`),
    "utf8",
  ));
}

test("a complete source partition formats", () => {
  const { source, root } = partitionFixture("full");
  assert.equal(runOn(partitionPkg(), source, root, 80), "alpha beta gamma\n");
});

test("a declared partition with a leading hole refuses", () => {
  const { source, root } = partitionFixture("hole-lead");
  assert.throws(
    () => runOn(partitionPkg(), source, root, 80),
    (e) => e instanceof Refusal && e.message === "source_partitions `prose_run` has a leading gap",
  );
});

test("a declared partition with an interior hole refuses", () => {
  const { source, root } = partitionFixture("hole-mid");
  assert.throws(
    () => runOn(partitionPkg(), source, root, 80),
    (e) => e instanceof Refusal && e.message === "source_partitions `prose_run` has an interior gap",
  );
});

const PARTITION_SOURCE = "alpha beta gamma";
const partitionRoot = (children) => ({ type: "prose_run", start: 0, end: 16, children });
const proseAtom = (start, end, text) => ({
  type: "prose_atom",
  start,
  end,
  children: [span("word", start, end, text)],
});
const proseGap = (start, end) => span("prose_gap", start, end, " ");

test("a declared partition with a trailing hole refuses", () => {
  const root = partitionRoot([
    proseAtom(0, 5, "alpha"),
    proseGap(5, 6),
    proseAtom(6, 10, "beta"),
    proseGap(10, 11),
  ]);
  assert.throws(
    () => runOn(partitionPkg(), PARTITION_SOURCE, root, 80),
    (e) => e instanceof Refusal && e.message === "source_partitions `prose_run` has a trailing gap",
  );
});

test("a declared partition with a zero-width child refuses", () => {
  const root = partitionRoot([
    proseAtom(0, 5, "alpha"),
    span("prose_gap", 5, 5, ""),
    proseGap(5, 6),
    proseAtom(6, 10, "beta"),
    proseGap(10, 11),
    proseAtom(11, 16, "gamma"),
  ]);
  assert.throws(
    () => runOn(partitionPkg(), PARTITION_SOURCE, root, 80),
    (e) => e instanceof Refusal && e.message === "source_partitions `prose_run` has a zero-width child",
  );
});

test("a childless non-empty declared node refuses", () => {
  assert.throws(
    () => runOn(partitionPkg(), PARTITION_SOURCE, partitionRoot([]), 80),
    (e) =>
      e instanceof Refusal
      && e.message === "source_partitions `prose_run` has no children but a non-empty range",
  );
});

test("a childless empty declared node formats", () => {
  assert.equal(
    runOn(partitionPkg(), "", { type: "prose_run", start: 0, end: 0, children: [] }, 80),
    "\n",
  );
});

test("a one-child declared node that covers its parent formats", () => {
  assert.equal(
    runOn(partitionPkg(), PARTITION_SOURCE, partitionRoot([proseAtom(0, 16, "alpha beta gamma")]), 80),
    "alpha beta gamma\n",
  );
});

test("an undeclared node type with the same hole still formats", () => {
  const { source, root } = partitionFixture("hole-lead");
  assert.equal(runOn(partitionPkg({ source_partitions: [] }), source, root, 80), "beta gamma\n");
});

test("whitespace nodes at format 3 still format", () => {
  const file = triviaFile([["a", "a\n"], ["gap", "\n"], ["b", "b\n"]]);
  assert.equal(runTrivia(whitespacePkg({ format: "et-doc-rules/3" }), file), "a\n\nb\n");
});

test("source_partitions require v3, a list of kinds, and disjoint roles", () => {
  const file = partitionFixture("full");
  for (const value of [null, "prose_run", {}, [1]]) {
    assert.throws(() => runOn(partitionPkg({ source_partitions: value }), file.source, file.root, 80), Refusal);
  }
  for (const value of [[], ["prose_run"]]) {
    assert.throws(
      () => runOn(partitionPkg({
        format: "et-doc-rules/1",
        source_partitions: value,
        whitespace_nodes: undefined,
      }), file.source, file.root, 80),
      /`source_partitions` requires package format et-doc-rules\/3/,
    );
    assert.throws(
      () => runOn(partitionPkg({ format: "et-doc-rules/2", source_partitions: value }), file.source, file.root, 80),
      /`source_partitions` requires package format et-doc-rules\/3/,
    );
  }
  assert.throws(
    () => runOn(partitionPkg({ comments: ["prose_run"] }), file.source, file.root, 80),
    /`source_partitions` and `comments` must not overlap/,
  );
  assert.throws(
    () => runOn(partitionPkg({ whitespace_nodes: ["prose_run"] }), file.source, file.root, 80),
    /`source_partitions` and `whitespace_nodes` must not overlap/,
  );
  assert.equal(runOn(partitionPkg({ source_partitions: [] }), file.source, file.root, 80), "alpha beta gamma\n");
});

test("both runtimes refuse the same corrupt source partition", () => {
  const { source, root } = partitionFixture("hole-lead");
  const pkg = partitionPkg();
  assert.throws(
    () => runOn(pkg, source, root, 80),
    (e) => e instanceof Refusal && e.message === "source_partitions `prose_run` has a leading gap",
  );

  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-partitions-"));
  const treePath = path.join(dir, "tree.json");
  const pkgDir = path.join(dir, "packages");
  fs.mkdirSync(pkgDir);
  fs.writeFileSync(treePath, JSON.stringify({ language: "toy", source, root }));
  fs.writeFileSync(path.join(pkgDir, "toy.json"), JSON.stringify(pkg));
  const rust = path.join(__dirname, "..", "rust", "target", "release", "docfmt");
  const result = spawnSync(rust, [treePath, "80"], {
    env: { ...process.env, FMT_PACKAGES: pkgDir },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "rust must refuse");
  assert.equal(result.stderr.trim(), "source_partitions `prose_run` has a leading gap");
});
