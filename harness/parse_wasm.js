#!/usr/bin/env node
// Parse a source file with web-tree-sitter and emit gen_trees.py's JSON shape.
//
//     harness/parse_wasm.js <source-file> <language>   # emit one tree
//     harness/parse_wasm.js --check [--language NAME]  # diff the whole corpus
//
// This is the control arm for docs/parse-layer.md item 4: the route-A parse
// layer, actually run, so the wasm numbers in that document stop being proxies.
// It is measurement scaffolding and is on no shipped path.
//
// The acceptance bar is that `--check` finds zero differences against
// corpus/trees/*.tree.json. Those trees were produced by NATIVE tree-sitter
// through py-tree-sitter; this script produces them through the same grammar
// version compiled to wasm and run by web-tree-sitter. So `--check` is also the
// experiment that settles docs/parse-layer.md's claim for route A -- "with the
// same grammar version behind native and wasm, the parse layer cannot diverge
// between runtimes". A mismatch here falsifies that sentence.
//
// Requires: `npm install` in harness/wasm, and harness/wasm/build_grammars.sh.

'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const WASM_DIR = path.join(ROOT, 'harness', 'wasm');
const BUILD_DIR = path.join(WASM_DIR, 'build');
const LANG_DIR = path.join(ROOT, 'harness', 'languages');

// harness/ has no node_modules of its own; the rig's deps live in harness/wasm.
const rigRequire = createRequire(path.join(WASM_DIR, 'package.json'));
const TOML = rigRequire('smol-toml');
const { Parser, Language, byteOffsets } = require(path.join(WASM_DIR, 'runtime.js'));

// --------------------------------------------------------------------------
// manifests -- the same harness/languages/*.toml that gen_trees.py reads,
// restricted to the fields a parse needs. Nothing here validates them; that is
// manifest.py's job and duplicating it would be a second source of truth.

function loadManifests() {
  const out = {};
  for (const file of fs.readdirSync(LANG_DIR).sort()) {
    if (!file.endsWith('.toml')) continue;
    const raw = TOML.parse(fs.readFileSync(path.join(LANG_DIR, file), 'utf8'));
    out[raw.name] = {
      name: raw.name,
      extensions: raw.extensions,
      grammar: raw.grammar,
      injectionAliases: raw.injection_aliases || [],
      injections: (raw.injections || []).map((i) => ({
        node: i.node,
        info: i.info ?? null,
        content: i.content ?? null,
        guest: i.guest ?? null,
      })),
    };
  }
  return out;
}

function injectionMap(manifests) {
  const out = {};
  for (const m of Object.values(manifests)) {
    for (const alias of m.injectionAliases) out[alias] = m;
  }
  return out;
}

// --------------------------------------------------------------------------
// offsets
//
// gen_trees.py works in BYTE offsets: py-tree-sitter's start_byte/end_byte, and
// leaf text is `outer_source[start:end].decode("utf-8")` over a bytes object.
// web-tree-sitter reports UTF-16 code-unit indices instead, so every index
// crosses byteOffsets() on the way out. The why, and the measurement behind it,
// are in harness/wasm/runtime.js.

// --------------------------------------------------------------------------
// grammar loading

const languageCache = new Map();

function wasmPath(name) {
  return path.join(BUILD_DIR, `tree-sitter-${name}.wasm`);
}

async function loadLanguage(name) {
  if (languageCache.has(name)) return languageCache.get(name);
  const file = wasmPath(name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no grammar wasm for ${name} at ${path.relative(ROOT, file)} -- ` +
        `run harness/wasm/build_grammars.sh`
    );
  }
  const lang = await Language.load(file);
  languageCache.set(name, lang);
  return lang;
}

const parserCache = new Map();

async function parserFor(name) {
  if (parserCache.has(name)) return parserCache.get(name);
  const parser = new Parser();
  parser.setLanguage(await loadLanguage(name));
  parserCache.set(name, parser);
  return parser;
}

// --------------------------------------------------------------------------
// injection -- the JS twin of harness/injection.py
//
// Only markdown declares injections today (fenced_code_block, routed by
// info_string), and it is the only language whose frozen trees carry embedded
// subtrees. Reimplemented rather than skipped because 6 of the 15 markdown
// trees contain one, and skipping them would have made the acceptance bar
// 228 files instead of 234.

function directChild(node, kind) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === kind) return child;
  }
  return null;
}

function regionFor(node, src, host, aliases) {
  const site = host.injections.find((s) => s.node === node.type);
  if (!site) return null;
  const content = site.content === null ? node : directChild(node, site.content);
  if (!content) return null;
  const info = site.info === null ? null : directChild(node, site.info);
  const words = info ? src.slice(info.startIndex, info.endIndex).split(/\s+/).filter(Boolean) : [];
  let guest = site.guest === null ? null : aliases[site.guest] ?? null;
  if (guest === null && words.length) guest = aliases[words[0]] ?? null;
  return { content, source: src.slice(content.startIndex, content.endIndex), guest };
}

/** A clean guest root, or null when the region must stay verbatim. */
function parseRegion(region, parsers) {
  if (!region.guest) return null;
  const parser = parsers.get(region.guest.name);
  if (!parser) return null;
  const root = parser.parse(region.source).rootNode;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'ERROR' || node.isMissing) return null;
    for (let i = 0; i < node.childCount; i++) stack.push(node.child(i));
  }
  return root;
}

// --------------------------------------------------------------------------
// convert -- the JS twin of gen_trees.py's convert()
//
// Key order matters for a byte comparison of the serialized form, so the
// property insertion order below is deliberate: type, start, end, field, then
// children OR text. Anonymous nodes are kept, exactly as there.

function convert(node, ctx, field) {
  const start = ctx.base + ctx.bytes[node.startIndex];
  const end = ctx.base + ctx.bytes[node.endIndex];

  let region = null;
  let root = null;
  if (ctx.manifest && ctx.aliases && ctx.parsers) {
    region = regionFor(node, ctx.src, ctx.manifest, ctx.aliases);
    root = region ? parseRegion(region, ctx.parsers) : null;
  }

  const embed = (guestRoot, guestRegion, guestField) => {
    const guest = guestRegion.guest;
    const inner = {
      src: guestRegion.source,
      bytes: byteOffsets(guestRegion.source),
      base: ctx.base + ctx.bytes[guestRegion.content.startIndex],
      outer: ctx.outer,
      manifest: guest,
      aliases: ctx.aliases,
      parsers: ctx.parsers,
    };
    const embedded = convert(guestRoot, inner, guestField);
    embedded.language = guest.name;
    return embedded;
  };

  if (region && root && sameNode(region.content, node)) {
    return embed(root, region, field);
  }

  const out = { type: node.type, start, end };
  if (field !== null && field !== undefined) out.field = field;

  if (node.childCount > 0) {
    const children = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      const childField = node.fieldNameForChild(i);
      if (region && root && sameNode(child, region.content)) {
        children.push(embed(root, region, childField));
      } else {
        children.push(convert(child, ctx, childField));
      }
    }
    out.children = children;
  } else {
    // gen_trees.py slices the OUTER bytes, so a spliced subtree has the same
    // offset contract as its host. Slicing ctx.src would give the same string
    // for a non-embedded node and the wrong one for an embedded leaf.
    out.text = ctx.outer.toString('utf8', start, end);
  }
  return out;
}

function sameNode(a, b) {
  if (!a || !b) return false;
  if (typeof a.equals === 'function') return a.equals(b);
  return a.id === b.id;
}

// --------------------------------------------------------------------------

/** Every node kind in a tree that is ERROR or MISSING, as gen_trees.py checks. */
function problems(node, name, src) {
  const out = [];
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'ERROR' || n.isMissing) {
      const line = src.slice(0, n.startIndex).split('\n').length;
      out.push(`${name}:${line}: ${n.type}${n.isMissing ? ' (missing)' : ''}`);
    }
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
  }
  return out;
}

async function parseDoc(manifest, src, sourceFile, manifests) {
  const aliases = injectionMap(manifests);
  // Every guest a host might route to has to be loadable before the walk;
  // convert() is synchronous because gen_trees.py's is.
  const parsers = new Map();
  const needed = new Set([manifest.name]);
  for (const site of manifest.injections) {
    if (site.guest) needed.add(site.guest);
    else for (const m of Object.values(aliases)) needed.add(m.name);
  }
  for (const name of needed) {
    if (fs.existsSync(wasmPath(name))) parsers.set(name, await parserFor(name));
  }

  const parser = parsers.get(manifest.name);
  const tree = parser.parse(src);
  const ctx = {
    src,
    bytes: byteOffsets(src),
    base: 0,
    outer: Buffer.from(src, 'utf8'),
    manifest,
    aliases,
    parsers,
  };
  return {
    doc: {
      language: manifest.name,
      source_file: sourceFile,
      source: src,
      root: convert(tree.rootNode, ctx, null),
    },
    problems: problems(tree.rootNode, path.basename(sourceFile), src),
    tree,
  };
}

// --------------------------------------------------------------------------
// --check
//
// Two comparisons, deliberately separated:
//
//   structure  -- both trees re-serialized by the SAME serializer. This is the
//                 acceptance bar: it answers "does wasm produce tree-sitter's
//                 tree", with no Python-vs-JSON.stringify noise in the answer.
//   bytes      -- our serialization against the committed file verbatim. A
//                 failure here with structure passing is a pretty-printer
//                 difference and nothing else, so it is reported separately
//                 rather than counted as a mismatch.

function serialize(doc) {
  return JSON.stringify(doc, null, 1) + '\n';
}

function firstDifference(a, b, trail = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null) {
    return `${trail}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  if (typeof a !== 'object') return `${trail}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${trail}: array/object shape`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      const kindsA = a.map((c) => c && c.type).join(' ');
      const kindsB = b.map((c) => c && c.type).join(' ');
      return `${trail}: ${a.length} children != ${b.length}\n    wasm:   ${kindsA}\n    frozen: ${kindsB}`;
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${trail}[${i}]${a[i] && a[i].type ? `<${a[i].type}>` : ''}`);
      if (d) return d;
    }
    return null;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.join(',') !== keysB.join(',')) {
    return `${trail}: keys ${keysA.join(',')} != ${keysB.join(',')}`;
  }
  for (const k of keysA) {
    const d = firstDifference(a[k], b[k], `${trail}.${k}`);
    if (d) return d;
  }
  return null;
}

async function check(only) {
  const manifests = loadManifests();
  const treeDir = path.join(ROOT, 'corpus', 'trees');
  const files = fs.readdirSync(treeDir).filter((f) => f.endsWith('.tree.json')).sort();

  const stats = new Map();
  const failures = [];
  let byteMismatch = 0;

  for (const file of files) {
    const frozen = JSON.parse(fs.readFileSync(path.join(treeDir, file), 'utf8'));
    const lang = frozen.language;
    if (only && lang !== only) continue;
    if (!stats.has(lang)) stats.set(lang, { total: 0, match: 0, bytes: 0 });
    const s = stats.get(lang);
    s.total++;

    const manifest = manifests[lang];
    const srcPath = path.join(ROOT, frozen.source_file);
    const src = fs.readFileSync(srcPath, 'utf8');
    const { doc } = await parseDoc(manifest, src, frozen.source_file, manifests);

    const diff = firstDifference(doc, frozen);
    if (diff === null) {
      s.match++;
      const raw = fs.readFileSync(path.join(treeDir, file), 'utf8');
      if (serialize(doc) === raw) s.bytes++;
      else byteMismatch++;
    } else {
      failures.push({ file, lang, diff });
    }
  }

  const langs = [...stats.keys()].sort();
  let total = 0;
  let matched = 0;
  console.log('language      files  identical  mismatched');
  for (const lang of langs) {
    const s = stats.get(lang);
    total += s.total;
    matched += s.match;
    const flag = s.match === s.total ? '' : '   <-- MISMATCH';
    console.log(
      `${lang.padEnd(12)} ${String(s.total).padStart(5)}  ${String(s.match).padStart(9)}  ${String(s.total - s.match).padStart(10)}${flag}`
    );
  }
  console.log(`${'TOTAL'.padEnd(12)} ${String(total).padStart(5)}  ${String(matched).padStart(9)}  ${String(total - matched).padStart(10)}`);
  console.log(
    `\nserialization: ${total - byteMismatch - (total - matched)}/${matched} of the matching trees ` +
      `also re-serialize byte-identical to the committed file`
  );

  if (failures.length) {
    console.log(`\n${failures.length} mismatching file(s):`);
    for (const f of failures) console.log(`\n  ${f.file} (${f.lang})\n    ${f.diff}`);
  }
  return failures.length === 0 ? 0 : 1;
}

// --------------------------------------------------------------------------

async function main(argv) {
  await Parser.init();

  const checkAt = argv.indexOf('--check');
  if (checkAt !== -1) {
    const langAt = argv.indexOf('--language');
    return check(langAt === -1 ? null : argv[langAt + 1]);
  }

  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length !== 2) {
    console.error('usage: parse_wasm.js <source-file> <language>');
    console.error('       parse_wasm.js --check [--language NAME]');
    return 2;
  }
  const [file, lang] = positional;
  const manifests = loadManifests();
  if (!manifests[lang]) {
    console.error(`no manifest for '${lang}'; known: ${Object.keys(manifests).sort().join(', ')}`);
    return 2;
  }
  const abs = path.resolve(file);
  const src = fs.readFileSync(abs, 'utf8');
  const rel = path.relative(ROOT, abs);
  const { doc, problems: bad } = await parseDoc(manifests[lang], src, rel, manifests);
  if (bad.length) {
    // Same refusal as gen_trees.py: a tree with ERROR or MISSING in it is a
    // different problem than the one we meant to pose.
    console.error('parse errors:');
    for (const p of bad) console.error(`  ${p}`);
    return 1;
  }
  process.stdout.write(serialize(doc));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}

module.exports = { loadManifests, parseDoc, byteOffsets, serialize, parserFor, loadLanguage, ROOT, BUILD_DIR, WASM_DIR };
