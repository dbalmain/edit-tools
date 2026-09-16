#!/usr/bin/env node
// Browser half of probe_secondary_grammar.py. Sources arrive as base64 so the
// Python and JavaScript producers consume identical bytes, including fixtures.

import fs from "node:fs";
import { parseDoc } from "./ts_doc.mjs";
import { attachSecondaries } from "./ts_secondary.mjs";

const [blockPath, inlinePath] = process.argv.slice(2);
if (!blockPath || !inlinePath) {
  console.error("usage: probe_secondary_driver.mjs BLOCK_BLOB INLINE_BLOB");
  process.exit(2);
}

const block = JSON.parse(fs.readFileSync(blockPath, "utf8"));
const inline = JSON.parse(fs.readFileSync(inlinePath, "utf8"));
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const config = {
  sites: {
    markdown: [{
      name: "markdown_inline",
      within: "inline",
      blob: "markdown_inline.blob.json",
    }],
  },
};
const out = [];

for (const item of payload) {
  const source = Buffer.from(item.source, "base64");
  const doc = parseDoc(block, "markdown", source, item.source_file);
  try {
    await attachSecondaries(doc, source, config, async () => inline);
    const wanted = item.ranges === null
      ? null
      : new Set(item.ranges.map(([start, end]) => `${start}:${end}`));
    out.push({
      secondary: (doc.secondary ?? []).filter((entry) =>
        wanted === null || wanted.has(`${entry.start}:${entry.end}`)),
      error: null,
    });
  } catch (error) {
    out.push({ secondary: [], error: error.message });
  }
}

process.stdout.write(JSON.stringify(out));
