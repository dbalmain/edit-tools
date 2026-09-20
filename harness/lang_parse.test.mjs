// Gate for the browser parse wrapper's secondary-attachment flag.
//
//     node --test harness/lang_parse.test.mjs
//
// `harness/test_lang_parse.py` shells out to this, so `python3 -m unittest
// discover -s harness` -- and therefore `./test.sh` -- runs it too.
//
// The corpus probe never calls `web/js/lang.js`. These tests cover what
// nothing else does: the browser default is off, an explicit option wins
// over `?secondaries=1`, and the 43 KB inline blob is not fetched when the
// flag is off.
//
// `web/js/lang.js` imports `../vendor/` at module level, and that directory
// is written by `./web/gen.py` (which also needs a vici checkout). A clean
// checkout has neither, so this file remaps those four imports to stubs
// before loading `lang.js`. Flag resolution and which URLs `fetch` is asked
// for are the claims; CST agreement is the corpus probe, and the real
// loader's laziness is `ts_secondary.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const STUBS = {
  "../vendor/ts_doc.mjs": `
    export function parseDoc(blob, name, source, sourceFile) {
      const text = new TextDecoder().decode(source);
      const end = source.length;
      const root = { type: "document", start: 0, end, children: [] };
      if (text.trimStart().startsWith("\`\`\`")) {
        root.children.push({
          type: "fenced_code_block",
          start: 0,
          end,
          children: [{ type: "code_fence_content", start: 0, end, text: "" }],
        });
      } else {
        root.children.push({
          type: "paragraph",
          start: 0,
          end,
          children: [{ type: "inline", start: 0, end, text }],
        });
      }
      return { language: name, source_file: sourceFile, source: "", root };
    }
  `,
  "../vendor/ts_secondary.mjs": `
    function* hostNodes(root, kind) {
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.language !== undefined) continue;
        if (node.type === kind) yield node;
        const children = node.children ?? [];
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    }
    export async function attachSecondaries(doc, source, config, load) {
      const entries = [];
      for (const site of config.sites[doc.language] ?? []) {
        const nodes = [...hostNodes(doc.root, site.within)];
        if (nodes.length === 0) continue;
        const blob = await load(site.name, site.blob);
        if (blob == null) {
          throw new Error(\`secondary grammar \${site.name} has no parse table\`);
        }
        for (const node of nodes) {
          entries.push({
            language: site.name,
            within: site.within,
            start: node.start,
            end: node.end,
            outcome: "clean",
            root: { type: "inline", start: node.start, end: node.end, children: [{}] },
          });
        }
      }
      if (entries.length > 0) doc.secondary = entries;
    }
  `,
  "../vendor/ts_inject.mjs": `
    export async function injectAll(doc) { return doc; }
  `,
  "../vendor/prose.mjs": `
    export function project(doc) { return { ...doc, projected: true }; }
  `,
  "../vendor/runtime.mjs": `
    export function format(tree) {
      return JSON.stringify({
        projected: tree.projected === true,
        secondary: Array.isArray(tree.secondary) && tree.secondary.length > 0,
      });
    }
    export class Refusal extends Error {}
  `,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS[specifier] && context.parentURL?.endsWith("/web/js/lang.js")) {
      return {
        url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const lang = await import("../web/js/lang.js");

const WITH_INLINE = "hello **world**\n";
const FENCE_ONLY = "```\ncode\n```\n";

const FIXTURES = {
  "markdown.blob.json": {},
  "markdown_inline.blob.json": {},
  "markdown.json": { source_partitions: ["prose_run"] },
  "secondaries.json": {
    grammars: { markdown_inline: { source_language: "markdown" } },
    sites: {
      markdown: [
        {
          name: "markdown_inline",
          within: "inline",
          blob: "markdown_inline.blob.json",
        },
      ],
    },
  },
  "injections.json": { sites: {}, aliases: {}, blobs: {} },
};

const fetches = [];

globalThis.fetch = async (url) => {
  const href = String(url);
  fetches.push(href);
  const name = href.split("/").pop();
  if (!Object.hasOwn(FIXTURES, name)) {
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => {
        throw new Error(`${href}: 404`);
      },
    };
  }
  const body = FIXTURES[name];
  return { ok: true, status: 200, json: async () => structuredClone(body) };
};

function askedFor(name) {
  return fetches.some((href) => href.endsWith(name));
}

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

test("formatting follows the package opt-in and projects a secondary-backed view", async () => {
  prepare();
  const output = JSON.parse(
    await lang.formatText(WITH_INLINE, "markdown", 40, { secondaries: false }),
  );
  assert.deepEqual(output, { projected: true, secondary: true });
  assert.equal(askedFor("markdown.json"), true);
  assert.equal(askedFor("secondaries.json"), true);
  assert.equal(askedFor("markdown_inline.blob.json"), true);
});
