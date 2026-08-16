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

test("width counts scalar values, not UTF-16 code units", () => {
  const pkg = toy({ list: ["group", ["tok", "("], ["each", "named", ["seq", ["line"]]], ["tok", ")"]] });
  const tree = list(["🙂🙂🙂", "x"], false);
  tree.children = tree.children.filter((c) => c.type !== ",");
  assert.equal(run(pkg, tree, 7), "(🙂🙂🙂 x)\n");
  assert.equal(run(pkg, tree, 6), "(🙂🙂🙂\nx)\n");
});

test("a rule that ignores a child refuses rather than dropping it", () => {
  const pkg = toy({ list: ["seq", ["tok", "("]] });
  assert.throws(() => run(pkg, list(["a"], false), 80), (e) => e instanceof Refusal && /left child/.test(e.message));
});

test("an unknown node type refuses rather than guessing", () => {
  assert.throws(() => run(toy({}), list(["a"], false), 80), /no rule for node type `list`/);
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
  pkg.format = "et-doc-rules/2";
  assert.throws(
    () => run(pkg, list(["a"], false), 80),
    (e) =>
      e instanceof Refusal &&
      /unknown package format "et-doc-rules\/2"; expected "et-doc-rules\/1"/.test(e.message),
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
  const { source, root } = quote(0, 4, [
    span("open", 0, 1, '"'),
    span("body", 1, 10, "hi"),
    span("close", 3, 4, '"'),
  ]);
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

test("verbatim refuses when a range is inverted", () => {
  const { source, root } = quoteOk();
  root.start = 4;
  root.end = 0;
  assert.throws(
    () => runOn(quotePkg(), source, root, 80),
    (e) =>
      e instanceof Refusal &&
      /verbatim `quote`/.test(e.message) &&
      /inverted range/.test(e.message),
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
