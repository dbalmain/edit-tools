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
// The routing comes from `ts_secondaries.config()` over the real manifests,
// not from a copy written here: a second spelling of the same declaration
// would agree with itself while both halves drifted from markdown.toml.
const { config, cases } = JSON.parse(fs.readFileSync(0, "utf8"));
const out = [];

for (const item of cases) {
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
    // A dirty range is an outcome now, so nothing below throws for one. What
    // still reaches the catch is infrastructure failure -- a missing table --
    // which the Python side never produces, so any catch here is a divergence.
  } catch (error) {
    out.push({ secondary: [], error: error.message });
  }
}

process.stdout.write(JSON.stringify(out));
