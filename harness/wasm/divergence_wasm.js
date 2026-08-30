#!/usr/bin/env node
// Wasm half of the native-vs-wasm divergence experiment, plus the comparison.
//
//     harness/wasm/divergence_wasm.js <workdir>
//
// Reads <workdir>/cases.json and <workdir>/native.json, parses every case with
// web-tree-sitter against the grammar wasm built from the SAME pinned source,
// and reports every difference.
//
// What is controlled, explicitly:
//
//   grammar source   Identical. Both sides parse with the same generated
//                    parser.c and scanner.c -- harness/wasm/grammars.tsv pins
//                    the commit, and build_grammars.sh documents the two places
//                    the sdist and the git tag disagree and what was done about
//                    each. This is the variable the claim under test is about,
//                    so it is the one held fixed.
//   input bytes      Identical. divergence_cases.py writes every case to disk
//                    once; neither side generates or normalizes its own input.
//   tree shape       Identical comparison on both sides: type, byte offsets,
//                    field name, named, missing, extra, error. Not just the
//                    fields gen_trees.py emits -- see divergence_native.py.
//   edit             Identical: one inserted space at the same character, each
//                    side converting to its own index units.
//
// What is NOT controlled, and is the honest answer to "so what could still
// differ": the tree-sitter CORE library version. Native is py-tree-sitter
// 0.26.0; wasm is web-tree-sitter 0.26.13. Same ABI 14 on both sides, but not
// the same build of the runtime. That is the realistic shipping situation for
// route A -- Rust links one libtree-sitter, the browser loads another -- so
// holding it fixed would have tested a configuration nobody ships.
//
// The positive control is a separate run: --control rebuilds the comparison
// with a DIFFERENT grammar version on the wasm side and must report
// differences. A comparison that has never once failed is not evidence.

'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const WASM_DIR = __dirname;
const ROOT = path.resolve(WASM_DIR, '..', '..');
const { Parser, Language, version: wtsVersion, byteOffsets } = require(path.join(WASM_DIR, 'runtime.js'));

function dump(node, bytes) {
  const out = {
    // See divergence_native.py: `sym` is what tells a parse divergence apart
    // from a naming divergence.
    sym: node.grammarId,
    type: node.type,
    grammar_type: node.grammarType,
    start: bytes[node.startIndex],
    end: bytes[node.endIndex],
    named: node.isNamed,
    missing: node.isMissing,
    extra: node.isExtra,
    error: node.type === 'ERROR',
  };
  const kids = [];
  for (let i = 0; i < node.childCount; i++) {
    const entry = dump(node.child(i), bytes);
    const field = node.fieldNameForChild(i);
    if (field !== null && field !== undefined) entry.field = field;
    kids.push(entry);
  }
  if (kids.length) out.children = kids;
  return out;
}

function counts(node) {
  let total = 0;
  let err = 0;
  let missing = 0;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    total++;
    if (n.type === 'ERROR') err++;
    if (n.isMissing) missing++;
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
  }
  return { nodes: total, errors: err, missing };
}

// Three classes of difference, ranked by how much they cost this project.
// Merging them would lose the finding:
//
//   SHAPE    the two runtimes parsed differently -- a different grammar
//            symbol, span, child count, field or flag. A real parse
//            divergence, and the only class that means "route A cannot
//            guarantee the same tree".
//   TYPE     the same node -- same grammar symbol id, same span, same
//            children -- reported under a different `type` string. This is a
//            naming divergence and it costs exactly as much as a shape
//            divergence in this codebase, because dispatch is `node.type`
//            with no fallback (docs/parse-layer.md, "What the tree-interface
//            probe did and did not establish"). A package keyed on a name one
//            runtime spells differently is simply broken on that runtime.
//   GRAMMAR  only `grammarType`/`grammar_name` differs -- the grammar's
//            internal name for a hidden rule. No package reads it and neither
//            runtime exposes it to one. Counted, and then set aside.
//
// `sym`, the grammar's own symbol id, is what separates shape from the other
// two: it is the grammar's identity for a node, and it is stable across
// runtimes in a way the public name is not.

const SHAPE_KEYS = ['sym', 'start', 'end', 'named', 'missing', 'extra', 'field'];
const KIND_RANK = { shape: 3, type: 2, grammar: 1 };

/** First difference between two dumped trees: {kind, at} or null. */
function firstDifference(a, b, trail = 'root') {
  if (a === undefined || b === undefined || a === null || b === null) {
    return a === b ? null : { kind: 'shape', at: `${trail}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}` };
  }
  for (const k of SHAPE_KEYS) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      return {
        kind: 'shape',
        at: `${trail}.${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`,
      };
    }
  }
  const ka = a.children || [];
  const kb = b.children || [];
  if (ka.length !== kb.length) {
    return {
      kind: 'shape',
      at:
        `${trail} <${a.type}>: ${ka.length} children vs ${kb.length}\n` +
        `      wasm:   ${ka.map((c) => c.type).join(' ')}\n` +
        `      native: ${kb.map((c) => c.type).join(' ')}`,
    };
  }
  // Names are compared only once shape agrees at this node, so a shape
  // difference is never reported as a naming one.
  let best = null;
  const note = (kind, k) => {
    const cand = {
      kind,
      at: `${trail}.${k} (sym ${a.sym}, [${a.start},${a.end}]): ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`,
    };
    if (!best || KIND_RANK[kind] > KIND_RANK[best.kind]) best = cand;
  };
  if (JSON.stringify(a.type) !== JSON.stringify(b.type)) note('type', 'type');
  else if (JSON.stringify(a.grammar_type) !== JSON.stringify(b.grammar_type)) {
    note('grammar', 'grammar_type');
  }

  for (let i = 0; i < ka.length; i++) {
    const d = firstDifference(ka[i], kb[i], `${trail}/${i}<${ka[i].type}>`);
    if (d && d.kind === 'shape') return d; // outranks everything, report now
    if (d && (!best || KIND_RANK[d.kind] > KIND_RANK[best.kind])) best = d;
  }
  return best;
}

const languages = new Map();
async function parserFor(name, overrideDir) {
  const key = `${overrideDir || ''}|${name}`;
  if (languages.has(key)) return languages.get(key);
  const dir = overrideDir || path.join(WASM_DIR, 'build');
  const file = path.join(dir, `tree-sitter-${name}.wasm`);
  const parser = new Parser();
  parser.setLanguage(await Language.load(file));
  languages.set(key, parser);
  return parser;
}

function pointFor(text, charIndex) {
  const prefix = text.slice(0, charIndex);
  const row = (prefix.match(/\n/g) || []).length;
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  return { row, column: line.length };
}

async function main(argv) {
  const controlAt = argv.indexOf('--control');
  const controlDir = controlAt === -1 ? null : argv[controlAt + 1];
  const controlLang = controlAt === -1 ? null : argv[controlAt + 2];
  const work = path.resolve(argv.filter((a) => !a.startsWith('--'))[0]);

  await Parser.init();
  const spec = JSON.parse(fs.readFileSync(path.join(work, 'cases.json'), 'utf8'));
  const native = JSON.parse(fs.readFileSync(path.join(work, 'native.json'), 'utf8'));

  const stats = new Map();
  const diffs = [];
  let brokenCases = 0;
  let totalErrorNodes = 0;

  for (const c of spec.cases) {
    if (controlLang && c.language !== controlLang) continue;
    const key = `${c.language}/${c.mutation}`;
    if (!stats.has(key)) stats.set(key, { total: 0, same: 0, shape: 0, type: 0, grammar: 0 });
    const s = stats.get(key);
    s.total++;

    const src = fs.readFileSync(path.join(work, c.file), 'utf8');
    const bytes = byteOffsets(src);
    const parser = await parserFor(c.language, controlDir);
    const tree = parser.parse(src);
    const mine = dump(tree.rootNode, bytes);
    const theirs = native.cases[c.id];

    const n = counts(tree.rootNode);
    if (n.errors || n.missing) brokenCases++;
    totalErrorNodes += n.errors + n.missing;

    const d = firstDifference(mine, theirs.root);
    if (d === null) s.same++;
    else {
      s[d.kind]++;
      diffs.push({ id: c.id, language: c.language, mutation: c.mutation, kind: d.kind, diff: d.at });
    }
  }

  // Incremental arm. Three comparisons per file, because two of them can catch
  // a bug the third cannot: an incremental reparse that is wrong the same way
  // on both sides would still match native-vs-wasm.
  const incr = { total: 0, crossSame: 0, wasmFreshSame: 0, nativeFreshSame: 0 };
  const incrDiffs = [];
  for (const e of spec.edits) {
    if (controlLang && e.language !== controlLang) continue;
    incr.total++;
    const text = fs.readFileSync(path.join(work, e.file), 'utf8');
    const at = e.insert_at_char;
    const newText = text.slice(0, at) + ' ' + text.slice(at);
    const p = pointFor(text, at);

    const parser = await parserFor(e.language, controlDir);
    const oldTree = parser.parse(text);
    oldTree.edit({
      startIndex: at,
      oldEndIndex: at,
      newEndIndex: at + 1,
      startPosition: p,
      oldEndPosition: p,
      newEndPosition: { row: p.row, column: p.column + 1 },
    });
    const incrementalTree = parser.parse(newText, oldTree);
    const freshTree = parser.parse(newText);
    const nb = byteOffsets(newText);

    const wasmIncremental = dump(incrementalTree.rootNode, nb);
    const wasmFresh = dump(freshTree.rootNode, nb);
    const nat = native.edits[e.id];

    const cross = firstDifference(wasmIncremental, nat.incremental);
    if (cross === null) incr.crossSame++;
    else incrDiffs.push({ id: e.id, kind: `wasm-incr vs native-incr (${cross.kind})`, diff: cross.at });

    const selfWasm = firstDifference(wasmIncremental, wasmFresh);
    if (selfWasm === null) incr.wasmFreshSame++;
    else incrDiffs.push({ id: e.id, kind: `wasm-incr vs wasm-fresh (${selfWasm.kind})`, diff: selfWasm.at });

    const selfNative = firstDifference(nat.incremental, nat.fresh);
    if (selfNative === null) incr.nativeFreshSame++;
    else incrDiffs.push({ id: e.id, kind: `native-incr vs native-fresh (${selfNative.kind})`, diff: selfNative.at });
  }

  // ---- report
  const label = controlDir ? `POSITIVE CONTROL (wasm from ${controlDir})` : 'native vs wasm';
  console.log(`== ${label}`);
  console.log(`   native runtime: ${native.runtime}`);
  console.log(`   wasm runtime:   web-tree-sitter ${wtsVersion}`);

  const byMutation = new Map();
  for (const [key, s] of stats) {
    const mutation = key.split('/')[1];
    if (!byMutation.has(mutation)) byMutation.set(mutation, { total: 0, same: 0, shape: 0, type: 0, grammar: 0 });
    const m = byMutation.get(mutation);
    m.total += s.total;
    m.same += s.same;
    m.shape += s.shape;
    m.type += s.type;
    m.grammar += s.grammar;
  }
  console.log('\nmutation            cases  identical  shape-diff  type-diff  grammar-only');
  const g = { total: 0, same: 0, shape: 0, type: 0, grammar: 0 };
  for (const [mutation, m] of byMutation) {
    for (const k of Object.keys(g)) g[k] += m[k];
    console.log(
      `${mutation.padEnd(18)} ${String(m.total).padStart(6)}  ${String(m.same).padStart(9)}  ` +
        `${String(m.shape).padStart(10)}  ${String(m.type).padStart(9)}  ${String(m.grammar).padStart(12)}`
    );
  }
  console.log(
    `${'TOTAL'.padEnd(18)} ${String(g.total).padStart(6)}  ${String(g.same).padStart(9)}  ` +
      `${String(g.shape).padStart(10)}  ${String(g.type).padStart(9)}  ${String(g.grammar).padStart(12)}`
  );
  const gt = g.total;
  const gs = g.same;
  console.log(
    `\n${brokenCases}/${gt} cases actually contain ERROR or MISSING nodes ` +
      `(${totalErrorNodes} such nodes in total) -- the arm the frozen corpus cannot reach`
  );

  console.log(
    `\nincremental (${incr.total} files, one inserted space each):\n` +
      `  wasm-incremental   == native-incremental : ${incr.crossSame}/${incr.total}\n` +
      `  wasm-incremental   == wasm-fresh         : ${incr.wasmFreshSame}/${incr.total}\n` +
      `  native-incremental == native-fresh       : ${incr.nativeFreshSame}/${incr.total}`
  );

  // A grammar-name-only difference is noted, not failed on: nothing reads it.
  const material = diffs.filter((d) => d.kind !== 'grammar');
  const materialIncr = incrDiffs.filter((d) => !d.kind.includes('grammar)'));

  if (material.length) {
    console.log(`\n${material.length} materially differing case(s) (shape or type):`);
    for (const d of material.slice(0, 25)) {
      console.log(`\n  ${d.id} [${d.mutation}] ${d.kind.toUpperCase()}\n    ${d.diff}`);
    }
    if (material.length > 25) console.log(`\n  ... and ${material.length - 25} more`);
  }
  if (incrDiffs.length) {
    console.log(`\n${incrDiffs.length} incremental difference(s) (${materialIncr.length} material):`);
    for (const d of incrDiffs.slice(0, 15)) console.log(`\n  ${d.id} [${d.kind}]\n    ${d.diff}`);
  }

  const clean = material.length === 0 && materialIncr.length === 0;
  if (controlDir) {
    console.log(
      clean
        ? '\nCONTROL FAILED: a deliberately different grammar version produced no difference. ' +
            'The comparison is not sensitive and the main result means nothing.'
        : '\nCONTROL PASSED: the comparison detects a grammar-version difference.'
    );
    return clean ? 1 : 0;
  }
  console.log(clean ? '\nNo divergence found.' : '\nDIVERGENCE FOUND.');
  return clean ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  }
);
