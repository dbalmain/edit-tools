#!/usr/bin/env node
"use strict";

// Plant JS `widthOf = s.length` (UTF-16), compare against correct rust
// across corpus trees and a width range, then restore the runtime.
//
//   node harness-of-your-own/width-sweep.js [--min W] [--max W]
//
// Prints one row per file: detecting widths and whether 60 or 88 is
// among them. Does not commit the planted bug.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "runtime-js", "bundle.js");
const TREES = path.join(ROOT, "corpus", "trees");
const CORRECT = "const widthOf = (s) => [...s].length;";
const PLANTED = "const widthOf = (s) => s.length;";
const SCORED = [60, 88];

function parseArgs(argv) {
  const out = { min: 1, max: 200 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min") out.min = Number(argv[++i]);
    else if (argv[i] === "--max") out.max = Number(argv[++i]);
  }
  return out;
}

function invoke(exe, treePath, width) {
  const r = spawnSync(exe, [treePath, String(width)], {
    encoding: "buffer",
    timeout: 15000,
    cwd: ROOT,
  });
  return {
    status: r.status,
    stdout: r.stdout || Buffer.alloc(0),
    stderr: (r.stderr || Buffer.alloc(0)).toString("utf8").trim(),
  };
}

function hasAstral(source) {
  for (const ch of source) {
    if (ch.codePointAt(0) > 0xffff) return true;
  }
  return false;
}

function astralCount(source) {
  let n = 0;
  for (const ch of source) if (ch.codePointAt(0) > 0xffff) n++;
  return n;
}

function compactRanges(nums) {
  if (!nums.length) return "—";
  const parts = [];
  let a = nums[0];
  let b = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === b + 1) {
      b = nums[i];
    } else {
      parts.push(a === b ? String(a) : `${a}–${b}`);
      a = b = nums[i];
    }
  }
  parts.push(a === b ? String(a) : `${a}–${b}`);
  return parts.join(", ");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const orig = fs.readFileSync(BUNDLE, "utf8");
  if (!orig.includes(CORRECT)) {
    console.error("bundle.js does not contain the expected widthOf line");
    process.exit(1);
  }
  if (orig.includes(PLANTED) && !orig.includes(CORRECT)) {
    console.error("bundle.js already looks planted; aborting");
    process.exit(1);
  }

  const rust = path.join(ROOT, "fmt-rust");
  const js = path.join(ROOT, "fmt-js");
  const trees = fs
    .readdirSync(TREES)
    .filter((f) => f.endsWith(".tree.json"))
    .sort()
    .map((f) => path.join(TREES, f));

  fs.writeFileSync(BUNDLE, orig.replace(CORRECT, PLANTED));
  const rows = [];
  try {
    for (const treePath of trees) {
      const tree = JSON.parse(fs.readFileSync(treePath, "utf8"));
      const source = tree.source || "";
      const name = path.basename(treePath, ".tree.json");
      const nAstral = astralCount(source);
      const hits = [];
      for (let w = opts.min; w <= opts.max; w++) {
        const r = invoke(rust, treePath, w);
        const j = invoke(js, treePath, w);
        const rOk = r.status === 0;
        const jOk = j.status === 0;
        if (rOk && jOk) {
          if (Buffer.compare(r.stdout, j.stdout) !== 0) hits.push(w);
        } else if (rOk !== jOk) {
          hits.push(w);
        }
      }
      const scored = SCORED.filter((w) => hits.includes(w));
      rows.push({ name, nAstral, hits, scored, hasAstral: hasAstral(source) });
      console.error(
        `${name} astral=${nAstral} hits=${hits.length} ${compactRanges(hits)} scored=${scored.join(",") || "none"}`,
      );
    }
  } finally {
    fs.writeFileSync(BUNDLE, orig);
  }

  const restored = fs.readFileSync(BUNDLE, "utf8");
  if (restored !== orig) {
    console.error("FAILED to restore bundle.js");
    process.exit(1);
  }

  console.log("");
  console.log("| file | astral scalars | `.length` detectable at | 60? | 88? |");
  console.log("| --- | ---: | --- | --- | --- |");
  for (const row of rows) {
    console.log(
      `| \`${row.name}\` | ${row.nAstral} | ${compactRanges(row.hits)} | ${row.scored.includes(60) ? "yes" : "no"} | ${row.scored.includes(88) ? "yes" : "no"} |`,
    );
  }

  const anyScored = rows.some((r) => r.scored.length);
  console.log("");
  if (anyScored) {
    console.log("HOLE NARROWER: at least one corpus file detects `.length` at a scored width.");
  } else {
    console.log("NO corpus file detects a `.length` bug at either scored width (60 or 88).");
  }
}

main();
