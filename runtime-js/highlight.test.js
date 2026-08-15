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
const jsonPackage = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "json.highlight.json"), "utf8"),
);

const pkg = loadPackage(pythonPackage);

const readTreeIn = (directory, name) =>
  JSON.parse(fs.readFileSync(path.join(root, "corpus", directory, name), "utf8"));
const readTree = (name) => readTreeIn("trees", name);
const readDirtyTree = (name) => readTreeIn("trees-dirty", name);
const readInjectedTree = (name) => readTreeIn("trees-injected", name);

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

function assertMapPartition(tree, packages_, spans) {
  const scopes = new Set(["error"]);
  for (const package_ of packages_.values()) {
    for (const scope of package_.scopes) scopes.add(scope);
  }
  assertPartition(tree, { scopes }, spans);
}

function rustBytes(tree, rawPackages) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hl-identity-"));
  const treePath = path.join(temporary, "tree.json");
  try {
    fs.writeFileSync(treePath, JSON.stringify(tree));
    const mappings = Object.entries(rawPackages).map(([language, package_]) => {
      const packagePath = path.join(temporary, `${language}.json`);
      fs.writeFileSync(packagePath, JSON.stringify(package_));
      return `${language}=${packagePath}`;
    });
    return execFileSync(rust, [treePath, ...mappings], { encoding: "utf8" });
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
}

function loadPackages(rawPackages) {
  return new Map(
    Object.entries(rawPackages).map(([language, package_]) => [language, loadPackage(package_)]),
  );
}

function assertIdentity(tree, rawPackages = { python: pythonPackage }) {
  const loaded = loadPackages(rawPackages);
  const spans = highlight(tree, loaded);
  assert.equal(rustBytes(tree, rawPackages), `${JSON.stringify(spans)}\n`);
  return spans;
}

const errorTree = readDirtyTree("python__dirty_error_recovery.tree.json");

test("package loading expands sugar and refuses invalid scope vocabularies", () => {
  const expanded = loadPackage({
    format: "et-highlight/1",
    scopes: ["base", "keyword", "operator", "punctuation", "error"],
    leaf: { shared: "base" },
    background: { wrapper: "base" },
    keyword: ["shared"],
    operator: ["shared"],
    punctuation: ["shared"],
  });
  assert.equal(expanded.leaf.shared, "punctuation");
  assert.equal(expanded.background.wrapper, "base");
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
  assert.throws(
    () => loadPackage({
      format: "et-highlight/1", scopes: ["base"], background: { wrapper: "missing" },
    }),
    /emitted scope `missing` is not in `scopes`/,
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

test("interior backgrounds paint around refined children", () => {
  const tree = readTree("python__strings.tree.json");
  const spans = assertIdentity(tree);
  const lineOne = byteOffset(tree.source, "line one");
  const newline = byteOffset(tree.source, "\\n", lineOne);
  const lineTwo = newline + 2;
  const tab = byteOffset(tree.source, "\\t", lineTwo);
  const closingQuote = byteOffset(tree.source, '"', tab + 2) + 1;
  assert.equal(spanScope(spans, lineOne - 1, newline), "string");
  assert.equal(spanScope(spans, newline, lineTwo), "string.escape");
  assert.equal(spanScope(spans, lineTwo, tab), "string");
  assert.equal(spanScope(spans, tab, tab + 2), "string.escape");
  assert.equal(spanScope(spans, tab + 2, closingQuote), "string");
  assertPartition(tree, pkg, spans);
});

test("an interior leaf default does not paint around children", () => {
  const rawPackage = {
    format: "et-highlight/1",
    scopes: ["keyword", "parameter", "punctuation", "variable"],
    leaf: { lambda: "keyword", ":": "punctuation", identifier: "variable" },
    context: [
      { parent: "lambda_parameters", type: "identifier", scope: "parameter" },
    ],
  };
  const tree = {
    language: "toy",
    source: "lambda x: x",
    root: {
      type: "module", start: 0, end: 11, children: [{
        type: "lambda", start: 0, end: 11, children: [
          { type: "lambda", start: 0, end: 6, text: "lambda" },
          {
            type: "lambda_parameters", start: 7, end: 8, children: [
              { type: "identifier", start: 7, end: 8, text: "x" },
            ],
          },
          { type: ":", start: 8, end: 9, text: ":" },
          { type: "identifier", start: 10, end: 11, text: "x" },
        ],
      }],
    },
  };
  const spans = assertIdentity(tree, { toy: rawPackage });
  assert.deepEqual(spans, [
    { start: 0, end: 6, scope: "keyword" },
    { start: 7, end: 8, scope: "parameter" },
    { start: 8, end: 9, scope: "punctuation" },
    { start: 10, end: 11, scope: "variable" },
  ]);
  assertPartition(tree, loadPackage(rawPackage), spans);
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
  const spans = assertIdentity(tree, { toy: rawPackage });
  assert.deepEqual(spans, [{ start: 0, end: 4, scope: "outer" }]);
  assertPartition(tree, package_, spans);
});

test("a missing root package stays empty while nested known languages resume painting", () => {
  const tree = readInjectedTree("outer__injected_missing_root.tree.json");
  const rawPackages = { json: jsonPackage, python: pythonPackage };
  const spans = assertIdentity(tree, rawPackages);
  assert.deepEqual(spans, [
    { start: 0, end: 5, scope: "property" },
    { start: 8, end: 12, scope: "constant" },
  ]);
  assertMapPartition(tree, loadPackages(rawPackages), spans);
});

test("nested switches reset ancestor context at each language boundary", () => {
  const tree = readInjectedTree("python__injected_json.tree.json");
  const rawPackages = { json: jsonPackage, python: pythonPackage };
  const spans = assertIdentity(tree, rawPackages);
  assert.deepEqual(spans, [
    { start: 0, end: 5, scope: "type" },
    { start: 6, end: 7, scope: "punctuation" },
    { start: 7, end: 11, scope: "constant" },
    { start: 12, end: 17, scope: "variable" },
    { start: 17, end: 18, scope: "punctuation" },
    { start: 19, end: 23, scope: "type" },
  ]);
  assertMapPartition(tree, loadPackages(rawPackages), spans);
});
