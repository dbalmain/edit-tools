// Gate for the browser parse wrapper's secondary-attachment flag.
//
//     node --test harness/lang_parse.test.mjs
//
// `harness/test_lang_parse.py` shells out to this, so `python3 -m unittest
// discover -s harness` -- and therefore `./test.sh` -- runs it too.
//
// `harness/probe_secondary_grammar.py` proves the two *producers* agree on
// 2,553 rebased inline CSTs. It never calls `web/js/lang.js`, so a flag that
// defaulted into those producers would drop that line to 0/0 and still pass.
// This file is the other half: it calls `parse()` both ways and fails if
// either direction stops working. The fetch log is the visible half of the
// win -- the 43 KB inline blob must not be asked for when the flag is off.
//
// Needs `./web/gen.py` the same way the secondary-grammar probe does: the
// wrapper loads real tables through `fetch`.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "web", "vendor", "ts_secondary.mjs");
const MARKDOWN = join(ROOT, "web", "data", "blobs", "markdown.blob.json");
const INLINE = join(ROOT, "web", "data", "blobs", "markdown_inline.blob.json");

const WITH_INLINE = "hello **world**\n";
const FENCE_ONLY = "```\ncode\n```\n";

const fetches = [];

function requireGenerated() {
  for (const path of [VENDOR, MARKDOWN, INLINE]) {
    if (!existsSync(path)) {
      throw new Error(`missing ${path}; run ./web/gen.py`);
    }
  }
}

function installFetch() {
  globalThis.fetch = async (url) => {
    const href = String(url);
    fetches.push(href);
    let body;
    try {
      body = readFileSync(new URL(href), "utf8");
    } catch {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => {
          throw new Error(`${href}: 404`);
        },
      };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
}

function askedFor(name) {
  return fetches.some((href) => href.endsWith(name));
}

async function load() {
  requireGenerated();
  installFetch();
  return import("../web/js/lang.js");
}

const lang = await load();

function prepare() {
  fetches.length = 0;
  lang.resetAssets();
  delete globalThis.location;
}

test("secondariesWanted: omitted is off, ?secondaries=1 is on, explicit wins", () => {
  assert.equal(lang.secondariesWanted({}), false);
  assert.equal(lang.secondariesWanted({}, ""), false);
  assert.equal(lang.secondariesWanted({}, "?foo=1"), false);
  assert.equal(lang.secondariesWanted({}, "?secondaries"), false);
  assert.equal(lang.secondariesWanted({}, "?secondaries=0"), false);
  assert.equal(lang.secondariesWanted({}, "?secondaries=1"), true);
  assert.equal(lang.secondariesWanted({ secondaries: true }, ""), true);
  assert.equal(lang.secondariesWanted({ secondaries: false }, "?secondaries=1"), false);
});

test("flag off: no secondary field and no inline-blob fetch", async () => {
  prepare();
  const doc = await lang.parse(WITH_INLINE, "markdown");
  assert.equal(doc.secondary, undefined);
  assert.equal(askedFor("markdown_inline.blob.json"), false);
  assert.equal(askedFor("secondaries.json"), false);
  assert.equal(askedFor("markdown.blob.json"), true);
});

test("flag on: attaches a clean inline tree and fetches the blob", async () => {
  prepare();
  const doc = await lang.parse(WITH_INLINE, "markdown", { secondaries: true });
  assert.ok(Array.isArray(doc.secondary), "expected doc.secondary");
  assert.ok(doc.secondary.length > 0, "attachment produced no ranges");
  assert.equal(doc.secondary[0].language, "markdown_inline");
  assert.equal(doc.secondary[0].outcome, "clean");
  assert.ok(doc.secondary[0].root, "clean range attached no tree");
  assert.equal(askedFor("markdown_inline.blob.json"), true);
  assert.equal(askedFor("secondaries.json"), true);
});

test("flag on still does not fetch the blob for a fence-only buffer", async () => {
  prepare();
  const doc = await lang.parse(FENCE_ONLY, "markdown", { secondaries: true });
  assert.equal(doc.secondary, undefined);
  assert.equal(askedFor("secondaries.json"), true);
  assert.equal(askedFor("markdown_inline.blob.json"), false);
});

test("?secondaries=1 attaches; an explicit false still wins", async () => {
  prepare();
  globalThis.location = { search: "?secondaries=1" };
  const on = await lang.parse(WITH_INLINE, "markdown");
  assert.ok(on.secondary?.length > 0);
  assert.equal(on.secondary[0].outcome, "clean");

  prepare();
  globalThis.location = { search: "?secondaries=1" };
  const off = await lang.parse(WITH_INLINE, "markdown", { secondaries: false });
  assert.equal(off.secondary, undefined);
  assert.equal(askedFor("markdown_inline.blob.json"), false);
});
