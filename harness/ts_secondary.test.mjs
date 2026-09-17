// Unit tests for when a secondary grammar's parse table is asked for.
//
//     node --test harness/ts_secondary.test.mjs
//
// `harness/test_ts_secondary.py` shells out to this, so `python3 -m unittest
// discover -s harness` -- and therefore `./test.sh` -- runs it too.
//
// `harness/probe_secondary_grammar.py` covers what the two producers agree
// *about*: 2,553 rebased inline CSTs, byte for byte. It cannot see what this
// file tests, because the thing under test is a fetch that does not happen.
// Both producers return the same `secondary` array whether the table was
// loaded once, eagerly, or not at all, and the probe compares only the array.
// So the loader is counted here instead.

import test from "node:test";
import assert from "node:assert/strict";
import { attachSecondaries } from "./ts_secondary.mjs";

// The real routing, as `ts_secondaries.config()` emits it from markdown.toml.
const CONFIG = {
  grammars: { markdown_inline: { source_language: "markdown" } },
  sites: {
    markdown: [
      { name: "markdown_inline", within: "inline", blob: "markdown_inline.blob.json" },
    ],
  },
};

const leaf = (type, start, end) => ({ type, start, end, text: "" });
const doc = (root, language = "markdown") =>
  ({ language, source_file: "buffer.md", source: "", root });

/** A loader that records what it was asked for and hands back `blob`. */
function counting(blob = null) {
  const calls = [];
  return {
    calls,
    load: async (name, path) => {
      calls.push([name, path]);
      return blob;
    },
  };
}

test("a document with no host node never asks for the table", async () => {
  const loader = counting();
  const tree = doc({
    type: "document",
    start: 0,
    end: 8,
    children: [
      {
        type: "fenced_code_block",
        start: 0,
        end: 8,
        children: [leaf("code_fence_content", 3, 5)],
      },
    ],
  });
  await attachSecondaries(tree, new Uint8Array(8), CONFIG, loader.load);
  assert.deepEqual(loader.calls, []);
  assert.equal(tree.secondary, undefined);
});

test("an inline node inside an injected region is not a host node", async () => {
  // `hostNodes` stops at a spliced guest, so the only `inline` here belongs to
  // a nested markdown tree the guest grammar already parsed. Without that
  // guard this fetches a table to reinterpret a CST that is not ours.
  const loader = counting();
  const guest = {
    type: "block",
    start: 0,
    end: 4,
    language: "markdown",
    children: [leaf("inline", 0, 4)],
  };
  const tree = doc({ type: "document", start: 0, end: 4, children: [guest] });
  await attachSecondaries(tree, new Uint8Array(4), CONFIG, loader.load);
  assert.deepEqual(loader.calls, []);
});

test("a language with no declared site never asks for a table", async () => {
  const loader = counting();
  const tree = doc({ type: "source", start: 0, end: 0, children: [] }, "rust");
  await attachSecondaries(tree, new Uint8Array(0), CONFIG, loader.load);
  assert.deepEqual(loader.calls, []);
});

test("one host node asks once, and a missing table is a refusal", async () => {
  // The other half of the rule: where the declaration does apply, the table is
  // mandatory. `load` returning null is the browser's "fetch produced nothing",
  // and it must not degrade to an unannotated document.
  const loader = counting(null);
  const tree = doc({
    type: "document",
    start: 0,
    end: 2,
    children: [
      { type: "paragraph", start: 0, end: 2, children: [leaf("inline", 0, 2)] },
    ],
  });
  await assert.rejects(
    () => attachSecondaries(tree, new Uint8Array(2), CONFIG, loader.load),
    /secondary grammar markdown_inline has no parse table/,
  );
  assert.deepEqual(loader.calls, [["markdown_inline", "markdown_inline.blob.json"]]);
});

test("many host nodes still ask once", async () => {
  const loader = counting(null);
  const inline = (start, end) => ({
    type: "paragraph",
    start,
    end,
    children: [leaf("inline", start, end)],
  });
  const tree = doc({
    type: "document",
    start: 0,
    end: 9,
    children: [inline(0, 2), inline(3, 5), inline(6, 9)],
  });
  await assert.rejects(() =>
    attachSecondaries(tree, new Uint8Array(9), CONFIG, loader.load));
  assert.equal(loader.calls.length, 1);
});
