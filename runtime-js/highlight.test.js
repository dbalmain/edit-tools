"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { highlight, loadPackage, Refusal } = require("./highlight.js");

const root = path.join(__dirname, "..");
const rust = path.join(root, "rust", "target", "release", "hl-rust");

const pythonPackage = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "python.highlight.json"), "utf8"),
);

const pkg = loadPackage(pythonPackage);

const readTreeIn = (directory, name) =>
  JSON.parse(fs.readFileSync(path.join(root, "corpus", directory, name), "utf8"));
const readTree = (name) => readTreeIn("trees", name);
const readDirtyTree = (name) => readTreeIn("trees-dirty", name);

function spanScope(spans, start, end) {
  const span = spans.find((item) => item.start === start && item.end === end);
  assert.ok(span, `expected span [${start}, ${end})`);
  return span.scope;
}

function byteOffset(source, text, after = 0) {
  const index = source.indexOf(text, after);
  assert.notEqual(index, -1, `${text} occurs in source region`);
  return Buffer.byteLength(source.slice(0, index));
}

function assertPartition(tree, package_, spans) {
  const sourceLength = Buffer.byteLength(tree.source);
  for (const span of spans) {
    assert.ok(span.start < span.end, `zero-width span ${JSON.stringify(span)}`);
    assert.ok(span.end <= sourceLength, `span outside source ${JSON.stringify(span)}`);
    assert.ok(package_.scopes.has(span.scope), `scope missing from package ${JSON.stringify(span)}`);
  }
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    assert.ok(previous.end <= current.start, `overlapping spans at ${index}`);
    assert.ok(
      previous.end !== current.start || previous.scope !== current.scope,
      `unmerged spans at ${index}`,
    );
  }
}

function rustBytes(tree, package_) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hl-identity-"));
  const treePath = path.join(temporary, "tree.json");
  const packagePath = path.join(temporary, "package.json");
  try {
    fs.writeFileSync(treePath, JSON.stringify(tree));
    fs.writeFileSync(packagePath, JSON.stringify(package_));
    return execFileSync(rust, [treePath, packagePath], { encoding: "utf8" });
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
}

function assertIdentity(tree, rawPackage = pythonPackage) {
  const spans = highlight(tree, loadPackage(rawPackage));
  assert.equal(rustBytes(tree, rawPackage), `${JSON.stringify(spans)}\n`);
  return spans;
}

const errorTree = readDirtyTree("python__dirty_error_recovery.tree.json");

test("package loading expands sugar and refuses invalid scope vocabularies", () => {
  const expanded = loadPackage({
    format: "et-highlight/1",
    scopes: ["base", "keyword", "operator", "punctuation", "error"],
    leaf: { shared: "base" },
    keyword: ["shared"],
    operator: ["shared"],
    punctuation: ["shared"],
  });
  assert.equal(expanded.leaf.shared, "punctuation");
  assert.throws(
    () => loadPackage({ format: "et-highlight/2", scopes: [] }),
    (error) => error instanceof Refusal && /expected "et-highlight\/1"/.test(error.message),
  );
  assert.throws(
    () => loadPackage({ format: "et-highlight/1", scopes: ["string.escape"] }),
    /requires prefix `string` in `scopes`/,
  );
  assert.throws(
    () => loadPackage({
      format: "et-highlight/1", scopes: ["string", "string.escape.unicode"],
    }),
    /requires prefix `string.escape` in `scopes`/,
  );
});

test("Rust and JS agree on compute and the Python chain falsification cases", () => {
  const calls = readTree("python__calls.tree.json");
  const callSpans = assertIdentity(calls);
  assert.equal(spanScope(callSpans, 9, 16), "function");
  assert.equal(spanScope(callSpans, 17, 22), "variable");
  assertPartition(calls, pkg, callSpans);

  const chains = readTree("python__chains.tree.json");
  const chainSpans = assertIdentity(chains);
  const chainStart = chains.source.indexOf("method_chain =");
  for (const name of ["filter", "order_by", "limit", "offset", "all"]) {
    const start = byteOffset(chains.source, name, chainStart);
    assert.equal(spanScope(chainSpans, start, start + name.length), "function", name);
  }
  const attr = byteOffset(chains.source, "attr");
  assert.equal(spanScope(chainSpans, attr, attr + 4), "property");
  assertPartition(chains, pkg, chainSpans);
});

test("Rust and JS agree on splat parameters", () => {
  const tree = readTree("python__defs.tree.json");
  const spans = assertIdentity(tree);
  const args = byteOffset(tree.source, "*args") + 1;
  const kwargs = byteOffset(tree.source, "**kwargs") + 2;
  assert.equal(spanScope(spans, args, args + 4), "parameter");
  assert.equal(spanScope(spans, kwargs, kwargs + 6), "parameter");
  assertPartition(tree, pkg, spans);
});

test("Rust and JS agree on ERROR child-range backfill", () => {
  const spans = assertIdentity(errorTree);
  assert.deepEqual(spans, [
    { start: 0, end: 3, scope: "function" },
    { start: 3, end: 4, scope: "punctuation" },
    { start: 5, end: 6, scope: "number" },
    { start: 6, end: 7, scope: "error" },
    { start: 7, end: 8, scope: "operator" },
  ]);
  assertPartition(errorTree, pkg, spans);
});

test("unknown nodes stay unpainted while known descendants survive", () => {
  const tree = readDirtyTree("python__dirty_unknown_interior.tree.json");
  const spans = assertIdentity(tree);
  assert.deepEqual(spans, [{ start: 0, end: 1, scope: "variable" }]);
  assertPartition(tree, pkg, spans);
});

test("leaf errors, missing nodes, and separated leftovers agree", () => {
  const leaf = readDirtyTree("python__dirty_leaf_error_missing.tree.json");
  const leafSpans = assertIdentity(leaf);
  assert.deepEqual(leafSpans, [{ start: 0, end: 3, scope: "error" }]);
  assertPartition(leaf, pkg, leafSpans);

  const runs = readDirtyTree("python__dirty_error_two_runs.tree.json");
  const runSpans = assertIdentity(runs);
  assert.deepEqual(runSpans, [
    { start: 0, end: 1, scope: "error" },
    { start: 1, end: 2, scope: "variable" },
    { start: 2, end: 3, scope: "error" },
  ]);
  assertPartition(runs, pkg, runSpans);
});

test("ancestor matching is inclusive of the immediate parent and listed order wins", () => {
  const rawPackage = {
    format: "et-highlight/1",
    scopes: ["outer", "inner", "error"],
    leaf: { identifier: "inner" },
    context: [
      { ancestor: "type", type: "identifier", scope: "outer" },
      { type: "identifier", scope: "inner" },
    ],
  };
  const tree = {
    language: "toy",
    source: "name",
    root: {
      type: "type", start: 0, end: 4, children: [{
        type: "wrapper", start: 0, end: 4, children: [
          { type: "identifier", start: 0, end: 4, text: "name" },
        ],
      }],
    },
  };
  const package_ = loadPackage(rawPackage);
  const spans = assertIdentity(tree, rawPackage);
  assert.deepEqual(spans, [{ start: 0, end: 4, scope: "outer" }]);
  assertPartition(tree, package_, spans);
});
