"use strict";
// `node --test runtime-js/bundle.test.js` -- the JS mirror of rust/src/{doc,eval}.rs tests.
// Not part of the shipped bundle; the two runtimes are written independently,
// so both need their own evidence.

const test = require("node:test");
const assert = require("node:assert");
const { format, Refusal } = require("./bundle.js");

const toy = (rules) => ({
  indent: 2,
  tokens: ["(", ")", ",", "+"],
  precedence: { "+": 5, "*": 4 },
  rules,
});

const leaf = (type, text) => ({ type, start: 0, end: 0, text });

const run = (pkg, root, width) => format({ language: "toy", source: "", root }, width, pkg);

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

function chain(ops, base) {
  let node = leaf("name", base);
  for (const [op, rhs] of ops) {
    node = {
      type: "sum",
      start: 0,
      end: 0,
      children: [
        { ...node, field: "left" },
        { ...leaf(op, op), field: "operator" },
        { ...leaf("name", rhs), field: "right" },
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
