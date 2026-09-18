// The document shape the frozen fixtures and the formatter both speak, built
// from what `ts_lr.mjs` produces.
//
// This is `gen_trees.py`'s `convert()` in JavaScript: anonymous nodes kept,
// byte offsets, `field` where the production names one, `text` on leaves, and
// `missing` stamped last so key order matches Python's insertion order byte for
// byte. `JSON.stringify(doc, null, 1)` and Python's
// `json.dumps(..., indent=1, ensure_ascii=False)` agree on this shape, which is
// what lets `ts_check_trees.mjs` compare artifacts rather than normalised forms.
//
// It lives in its own file because it has two consumers with nothing else in
// common: the corpus check, which runs under node and reads files, and the web
// apps, which run in a browser and hold their source in a buffer. Neither
// should own the serialiser the other depends on.

import { parse, visibleChildren } from "./ts_lr.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function convert(lang, node, source) {
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
  // `parse_oracle.convert` stamps this after children/text, so it is last in
  // insertion order and the key order matches byte for byte. A MISSING node is
  // a zero-width leaf and is otherwise indistinguishable from a real empty one,
  // which is the whole reason the oracle track added the key.
  if (node.subtree.isMissing) out.missing = true;
  return out;
}

// The root this interpreter produces for one buffer, serialised the way the
// frozen fixtures serialise theirs.
export function parseRoot(blob, source) {
  const { lang, root, startByte } = parse(blob, source);
  return convert(lang, { subtree: root, alias: 0, start: startByte, field: null }, source);
}

// A secondary grammar must never attach a plausible-looking partial CST, so
// this *detects* dirtiness and leaves the caller to record it: `ts_secondary`
// writes an `outcome: "dirty"` entry with no tree, rather than refusing the
// document. `errorCost` includes ERROR and MISSING descendants even when a
// missing symbol is invisible, so it is the browser equivalent of native
// tree-sitter's `root_node.has_error`.
export function parseRootWithStatus(blob, source) {
  const { lang, root, startByte } = parse(blob, source);
  return {
    root: convert(lang, { subtree: root, alias: 0, start: startByte, field: null }, source),
    dirty: root.errorCost !== 0,
  };
}

// A whole document, in the shape `runtime-js`'s `format(tree, packages, width)`
// takes: the language, the source it was parsed from, and the root.
//
// `sourceFile` is metadata only -- the formatter never reads it -- but the
// frozen fixtures carry it, so it is a parameter rather than an omission.
export function parseDoc(blob, language, source, sourceFile = "<buffer>") {
  return {
    language,
    source_file: sourceFile,
    source: decoder.decode(source),
    root: parseRoot(blob, source),
  };
}
