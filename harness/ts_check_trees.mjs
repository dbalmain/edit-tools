#!/usr/bin/env node
// Parse a language's corpus sources with the table interpreter and compare the
// result, byte for byte, against the frozen trees.
//
//     ./harness/ts_check_trees.mjs <blob.json> <language>
//
// The bar is not "parses correctly". It is that the bytes this writes equal the
// bytes in `corpus/trees/<language>__<stem>.tree.json`, which `gen_trees.py`
// produced from real tree-sitter. Anything less is a negative result.
//
// The document shape is `gen_trees.py`'s `convert()`: anonymous nodes kept,
// byte offsets, `field` where the production names one, `text` on leaves.
// Python's `json.dumps(..., indent=1, ensure_ascii=False)` and JavaScript's
// `JSON.stringify(..., null, 1)` agree byte for byte on this shape, so the
// comparison really is over the artifact and not over a normalised form.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { parse, visibleChildren } from "./ts_lr.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const decoder = new TextDecoder("utf-8", { fatal: true });

function convert(lang, node, source) {
  const symbol = node.alias || node.subtree.symbol;
  const start = node.start;
  const end = start + node.subtree.size;
  const out = { type: lang.symbolName(symbol), start, end };
  if (node.field != null) out.field = node.field;
  const kids = visibleChildren(lang, node.subtree, start);
  if (kids.length > 0) {
    out.children = kids.map((k) => convert(lang, k, source));
  } else {
    out.text = decoder.decode(source.subarray(start, end));
  }
  return out;
}

function parseDoc(blob, language, sourcePath) {
  const source = readFileSync(sourcePath);
  const { lang, root, startByte } = parse(blob, source);
  return {
    language,
    source_file: relative(ROOT, sourcePath),
    source: decoder.decode(source),
    root: convert(lang, { subtree: root, alias: 0, start: startByte, field: null }, source),
  };
}

// --emit: parse the newline-separated paths on stdin and write one JSON
// document per line. `harness/ts_differential.py` compares those against real
// tree-sitter over a corpus far larger than the frozen one.
function emit(blobPath, language) {
  const blob = JSON.parse(readFileSync(blobPath, "utf8"));
  const paths = readFileSync(0, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const path of paths) {
    let record;
    try {
      record = { path, doc: parseDoc(blob, language, path) };
    } catch (err) {
      record = { path, error: err.message };
    }
    out.push(JSON.stringify(record));
    if (out.length >= 64) {
      process.stdout.write(out.join("\n") + "\n");
      out.length = 0;
    }
  }
  if (out.length) process.stdout.write(out.join("\n") + "\n");
  return 0;
}

function main(argv) {
  const [blobPath, language, ...rest] = argv;
  if (!blobPath || !language) {
    console.error("usage: ts_check_trees.mjs <blob.json> <language> [--write-dir DIR|--emit]");
    return 2;
  }
  if (rest.includes("--emit")) return emit(blobPath, language);
  const writeIndex = rest.indexOf("--write-dir");
  const writeDir = writeIndex >= 0 ? rest[writeIndex + 1] : null;
  if (writeDir) mkdirSync(writeDir, { recursive: true });

  const blob = JSON.parse(readFileSync(blobPath, "utf8"));
  const srcDir = join(ROOT, "corpus", "src", language);
  const files = readdirSync(srcDir).filter((f) => extname(f) !== "").sort();

  let pass = 0;
  const failures = [];
  for (const file of files) {
    const stem = basename(file, extname(file));
    const expectedPath = join(ROOT, "corpus", "trees", `${language}__${stem}.tree.json`);
    let expected;
    try {
      expected = readFileSync(expectedPath, "utf8");
    } catch {
      failures.push(`${file}: no frozen tree at ${relative(ROOT, expectedPath)}`);
      continue;
    }
    let actual;
    const started = process.hrtime.bigint();
    try {
      actual = JSON.stringify(parseDoc(blob, language, join(srcDir, file)), null, 1) + "\n";
    } catch (err) {
      failures.push(`${file}: ${err.message}`);
      continue;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (writeDir) writeFileSync(join(writeDir, `${language}__${stem}.tree.json`), actual);
    if (actual === expected) {
      pass++;
      console.log(`  ok   ${language}__${stem}  (${ms.toFixed(1)} ms)`);
    } else {
      failures.push(`${file}: ${firstDiff(expected, actual)}`);
    }
  }

  console.log(`\n${pass}/${files.length} byte-identical`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  return failures.length === 0 ? 0 : 1;
}

function firstDiff(expected, actual) {
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) {
      const from = Math.max(0, i - 60);
      return (
        `first difference at char ${i}\n` +
        `      want ...${JSON.stringify(expected.slice(from, i + 60))}\n` +
        `      got  ...${JSON.stringify(actual.slice(from, i + 60))}`
      );
    }
  }
  return `identical for ${n} chars, then lengths differ (${expected.length} vs ${actual.length})`;
}

// `process.exitCode`, not `process.exit()`: writes to a pipe are async, and
// exiting drops whatever is still buffered -- which truncates --emit output at
// the 64 KB pipe buffer.
process.exitCode = main(process.argv.slice(2));
