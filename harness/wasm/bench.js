#!/usr/bin/env node
// Measure what route A actually costs: bytes on the wire, and milliseconds.
//
//     harness/wasm/bench.js [--runs N] [--json FILE]
//
// This is docs/parse-layer.md item 4 -- "measure the real thing once, end to
// end" -- for everything except the tree-identity half, which is
// harness/parse_wasm.js --check.
//
// Three honest warnings about the timings, stated here rather than buried in
// the output:
//
//  1. The corpus is TINY. The largest file in any language is 2,346 bytes and
//     the median is under 1,100. Parsing one is tens of microseconds, which is
//     a number about function-call overhead as much as about parsing. The
//     brief asked for the largest corpus file per language and that column is
//     here as asked, but a second column parses the same content repeated to
//     ~64 KB -- roughly a real editor buffer -- because that is the figure
//     anyone deciding route A actually needs. Neither is a substitute for the
//     other and both are reported.
//
//  2. "Cold parse" means a fresh Parser in a warm process: the wasm module is
//     compiled, the grammar is loaded, the JIT has seen this code. It does NOT
//     include process start, module instantiation or grammar download. Those
//     are the `Language.load` column and the size table respectively.
//
//  3. Medians over N runs, with p90 alongside, because a single mean over a
//     GC-ed run is a number that moves when you look at it again.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Parser, Language, version } = require(path.join(__dirname, 'runtime.js'));

const WASM_DIR = __dirname;
const ROOT = path.resolve(WASM_DIR, '..', '..');
const BUILD = path.join(WASM_DIR, 'build');
const TARGET_BYTES = 64 * 1024;

// Real `gzip -9`, not zlib level 9. They are not the same: on
// tree-sitter-python.wasm zlib gives 64,863 and gzip gives 65,206, a 0.5%
// gap. Small, but the brief asked for gzip -9 and every figure in
// docs/parse-layer.md it will be compared against was measured with gzip -9.
const gz = (buf) => execFileSync('gzip', ['-9', '-c'], { input: buf, maxBuffer: 1 << 28 }).length;
const kb = (n) => (n / 1024).toFixed(1);

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], min: s[0] };
}

function time(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out };
}

/** The manifest languages, and the largest corpus source file for each. */
function corpusTargets() {
  const treeDir = path.join(ROOT, 'corpus', 'trees');
  const best = new Map();
  for (const file of fs.readdirSync(treeDir)) {
    if (!file.endsWith('.tree.json')) continue;
    const frozen = JSON.parse(fs.readFileSync(path.join(treeDir, file), 'utf8'));
    const src = path.join(ROOT, frozen.source_file);
    const size = fs.statSync(src).size;
    const prev = best.get(frozen.language);
    if (!prev || size > prev.size) {
      best.set(frozen.language, { language: frozen.language, file: frozen.source_file, size });
    }
  }
  return [...best.values()].sort((a, b) => a.language.localeCompare(b.language));
}

/** The single-character edit: insert a space at the last mid-line space. */
function editSite(text) {
  for (let i = text.length - 1; i > 0; i--) {
    if (text[i] === ' ' && !' \n\t'.includes(text[i - 1])) return i;
  }
  return null;
}

function pointFor(text, at) {
  const prefix = text.slice(0, at);
  return { row: (prefix.match(/\n/g) || []).length, column: prefix.length - (prefix.lastIndexOf('\n') + 1) };
}

async function main(argv) {
  const runsAt = argv.indexOf('--runs');
  const RUNS = runsAt === -1 ? 200 : Number(argv[runsAt + 1]);
  const LOAD_RUNS = 20;
  const jsonAt = argv.indexOf('--json');

  await Parser.init();

  // ---------------------------------------------------------------- sizes
  const runtimeWasm = fs.readFileSync(path.join(WASM_DIR, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'));
  const runtimeGlue = fs.readFileSync(path.join(WASM_DIR, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.js'));

  console.log(`web-tree-sitter ${version}, node ${process.version}, sizes are gzip -9\n`);
  console.log('== runtime, once per page, cached across every language');
  console.log('component                        raw        gz');
  console.log(`web-tree-sitter.wasm      ${String(runtimeWasm.length).padStart(9)} ${String(gz(runtimeWasm)).padStart(9)}`);
  console.log(`web-tree-sitter.js (glue) ${String(runtimeGlue.length).padStart(9)} ${String(gz(runtimeGlue)).padStart(9)}`);
  const runtimeGz = gz(runtimeWasm) + gz(runtimeGlue);
  console.log(`TOTAL                     ${String(runtimeWasm.length + runtimeGlue.length).padStart(9)} ${String(runtimeGz).padStart(9)}   (${kb(runtimeGz)} KB gz)\n`);

  // ------------------------------------------------------- grammars + timing
  const targets = corpusTargets();
  const rows = [];

  for (const t of targets) {
    const wasmFile = path.join(BUILD, `tree-sitter-${t.language}.wasm`);
    const raw = fs.readFileSync(wasmFile);

    // Language.load: the latency a lazy per-language download pays AFTER the
    // bytes have arrived. Fresh load each time; the OS page cache is warm, so
    // this is compile-and-instantiate, not disk.
    const loadSamples = [];
    for (let i = 0; i < LOAD_RUNS; i++) {
      const { ms } = await (async () => {
        const t0 = process.hrtime.bigint();
        await Language.load(wasmFile);
        return { ms: Number(process.hrtime.bigint() - t0) / 1e6 };
      })();
      loadSamples.push(ms);
    }
    const language = await Language.load(wasmFile);
    const parser = new Parser();
    parser.setLanguage(language);

    const small = fs.readFileSync(path.join(ROOT, t.file), 'utf8');
    const reps = Math.max(1, Math.ceil(TARGET_BYTES / Buffer.byteLength(small)));
    const big = small.repeat(reps);

    const measure = (src) => {
      // cold: a fresh parser each time, so no incremental state survives.
      const cold = [];
      for (let i = 0; i < RUNS; i++) {
        const p = new Parser();
        p.setLanguage(language);
        const { ms, out } = time(() => p.parse(src));
        cold.push(ms);
        out.delete();
        p.delete();
      }
      const at = editSite(src);
      const warm = [];
      if (at !== null) {
        const newSrc = src.slice(0, at) + ' ' + src.slice(at);
        const pt = pointFor(src, at);
        for (let i = 0; i < RUNS; i++) {
          const old = parser.parse(src);
          old.edit({
            startIndex: at,
            oldEndIndex: at,
            newEndIndex: at + 1,
            startPosition: pt,
            oldEndPosition: pt,
            newEndPosition: { row: pt.row, column: pt.column + 1 },
          });
          const { ms, out } = time(() => parser.parse(newSrc, old));
          warm.push(ms);
          out.delete();
          old.delete();
        }
      }
      return { cold: stats(cold), warm: warm.length ? stats(warm) : null };
    };

    const smallM = measure(small);
    const bigM = measure(big);

    // Node count, so a ms figure can be read against how much tree it built.
    const tree = parser.parse(big);
    let nodes = 0;
    const stack = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop();
      nodes++;
      for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
    }
    tree.delete();

    rows.push({
      language: t.language,
      file: t.file,
      raw: raw.length,
      gz: gz(raw),
      load: stats(loadSamples),
      smallBytes: Buffer.byteLength(small),
      bigBytes: Buffer.byteLength(big),
      bigNodes: nodes,
      small: smallM,
      big: bigM,
    });
    parser.delete();
  }

  // ---------------------------------------------------------------- report
  console.log('== grammar wasm, one per language, downloaded lazily');
  console.log('language          raw        gz    load ms   load p90');
  for (const r of rows) {
    console.log(
      `${r.language.padEnd(12)} ${String(r.raw).padStart(9)} ${String(r.gz).padStart(9)}` +
        `  ${r.load.median.toFixed(2).padStart(9)}  ${r.load.p90.toFixed(2).padStart(9)}`
    );
  }
  const gzTotal = rows.reduce((a, r) => a + r.gz, 0);
  console.log(`${'TOTAL'.padEnd(12)} ${String(rows.reduce((a, r) => a + r.raw, 0)).padStart(9)} ${String(gzTotal).padStart(9)}   (${kb(gzTotal)} KB gz for all ${rows.length})\n`);

  console.log(`== parse, largest corpus file per language (median of ${RUNS})`);
  console.log('language        bytes   cold ms   warm ms   speedup');
  for (const r of rows) {
    const w = r.small.warm;
    console.log(
      `${r.language.padEnd(12)} ${String(r.smallBytes).padStart(6)}  ${r.small.cold.median.toFixed(3).padStart(8)}  ` +
        `${(w ? w.median.toFixed(3) : '-').padStart(8)}  ${(w ? (r.small.cold.median / w.median).toFixed(1) + 'x' : '-').padStart(7)}`
    );
  }

  console.log(`\n== parse, same content repeated to ~${kb(TARGET_BYTES)} KB (median of ${RUNS})`);
  console.log('language        bytes    nodes   cold ms   warm ms   speedup   MB/s');
  for (const r of rows) {
    const w = r.big.warm;
    const mbs = r.bigBytes / 1e6 / (r.big.cold.median / 1000);
    console.log(
      `${r.language.padEnd(12)} ${String(r.bigBytes).padStart(6)} ${String(r.bigNodes).padStart(8)}  ` +
        `${r.big.cold.median.toFixed(2).padStart(8)}  ${(w ? w.median.toFixed(3) : '-').padStart(8)}  ` +
        `${(w ? (r.big.cold.median / w.median).toFixed(0) + 'x' : '-').padStart(7)}  ${mbs.toFixed(1).padStart(5)}`
    );
  }

  if (jsonAt !== -1) {
    fs.writeFileSync(
      argv[jsonAt + 1],
      JSON.stringify({ runtime: { version, wasm: runtimeWasm.length, wasmGz: gz(runtimeWasm), glue: runtimeGlue.length, glueGz: gz(runtimeGlue) }, grammars: rows }, null, 1) + '\n'
    );
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  }
);
