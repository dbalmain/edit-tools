// The injection second pass: reparse a fenced region with its own grammar and
// splice the result into the host tree.
//
// This is `harness/injection.py` plus the splice branch of `gen_trees.convert`,
// in JavaScript. It is what makes a `” ```ruby ”` block behave like a ruby file
// rather than like opaque markdown text -- for the formatter, which then
// formats the ruby, and for any surface that wants to know what language the
// cursor is in.
//
// # It is not tree-sitter's included ranges
//
// That distinction is the whole reason this is 120 lines rather than a rewrite
// of the parser. Upstream's injection machinery re-runs the parser over a set
// of disjoint ranges of the *same* buffer, which the table interpreter has no
// entry point for. `injection.py` never used it either: it slices the region's
// bytes out, parses that slice as a standalone document, and rebases every
// offset by a constant. Both halves are things `ts_lr.mjs` already does --
// `parseRoot` takes any `Uint8Array`, and rebasing is addition.
//
// So this reproduces the committed fixtures exactly, and it was verified that
// way before being written: slicing `fences.md`'s json region, reparsing it and
// rebasing gave the frozen spliced subtree byte for byte.
//
// # Splicing after conversion, not during
//
// `gen_trees.convert` splices while it walks the parser's internal nodes. This
// walks the emitted document instead, which is a plain tree of
// `{type, start, end, children | text}`. Everything the routing rule needs --
// a node's type, its direct children's types, and byte ranges -- survives into
// that shape, so the later pass sees exactly the same information and needs
// none of the parser's internals.
//
// # A region that cannot be routed stays verbatim
//
// Four ways that happens, and none of them is an error: the site declares no
// guest and the info string is absent or unknown (` ```xyzzy `), no parse table
// for the guest is loaded, or the guest parse is not clean. The last mirrors
// `injection.parse`: **any ERROR or MISSING node anywhere in the guest tree
// rejects the whole region.** Half-parsed ruby spliced into a markdown tree
// would be worse than leaving the fence as text, because the formatter would
// then reformat it as if it had understood it.

import { parseRoot } from "./ts_doc.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The first direct child with this type, or null. */
function childOfType(node, type) {
  return (node.children ?? []).find((child) => child.type === type) ?? null;
}

/** Every node in a document, itself included. */
function* nodes(root) {
  yield root;
  for (const child of root.children ?? []) yield* nodes(child);
}

/**
 * The region a node declares, and the guest it routes to -- or null.
 *
 * Mirrors `injection.region_for`. `content: null` means the node is its own
 * content; a site declares exactly one of `info` (route by the fence's info
 * string) or `guest` (route unconditionally), which the manifest enforces.
 */
function regionFor(node, sites, aliases, source) {
  const site = sites.find((s) => s.node === node.type);
  if (!site) return null;
  const content = site.content === null ? node : childOfType(node, site.content);
  if (content === null) return null;
  // Already spliced: `language` is stamped by this pass and nothing else.
  if (content.language !== undefined) return null;
  let guest = site.guest === null ? null : aliases[site.guest] ?? null;
  if (guest === null && site.info !== null) {
    const info = childOfType(node, site.info);
    const words = info === null
      ? []
      : decoder.decode(source.subarray(info.start, info.end)).split(/\s+/).filter(Boolean);
    if (words.length > 0) guest = aliases[words[0]] ?? null;
  }
  if (guest === null) return null;
  return { node, content, guest };
}

/** Shift every offset by `by`, and put `field` back where the host had it. */
function rebase(node, by, field) {
  const out = { type: node.type, start: node.start + by, end: node.end + by };
  if (field != null) out.field = field;
  if (node.children) out.children = node.children.map((c) => rebase(c, by, c.field));
  else out.text = node.text;
  if (node.missing) out.missing = true;
  return out;
}

/** True when a guest tree is clean enough to splice. Mirrors `injection.parse`. */
function isClean(root) {
  for (const node of nodes(root)) {
    if (node.type === "ERROR" || node.missing) return false;
  }
  return true;
}

/**
 * Guest languages this document routes to but has no parse table for.
 *
 * Separate from `inject` so a browser can `await` the fetches between the two.
 * It walks already-spliced subtrees as well, which is what lets a markdown
 * fence inside markdown resolve on a later round.
 */
export function pendingGuests(doc, source, config, blobs) {
  const out = new Set();
  const walk = (root, language) => {
    const sites = config.sites[language] ?? [];
    for (const node of nodes(root)) {
      if (node !== root && node.language !== undefined) {
        walk(node, node.language);
        continue;
      }
      if (sites.length === 0) continue;
      const region = regionFor(node, sites, config.aliases, source);
      if (region && !blobs.has(region.guest)) out.add(region.guest);
    }
  };
  walk(doc.root, doc.language);
  return out;
}

/**
 * Splice every routable region whose guest table is loaded.
 *
 * Idempotent: a region whose content already carries `language` is skipped, so
 * calling this again after loading more tables only fills in what was missing.
 * Mutates in place, which is safe because the document was built by this
 * process and nothing else holds a reference into it.
 */
export function inject(doc, source, config, blobs) {
  const walk = (root, language) => {
    const sites = config.sites[language] ?? [];
    for (const node of nodes(root)) {
      if (node !== root && node.language !== undefined) {
        walk(node, node.language);
        continue;
      }
      if (sites.length === 0) continue;
      const region = regionFor(node, sites, config.aliases, source);
      if (region === null) continue;
      const blob = blobs.get(region.guest);
      if (!blob) continue;
      const slice = source.subarray(region.content.start, region.content.end);
      let guestRoot;
      try {
        guestRoot = parseRoot(blob, slice);
      } catch {
        continue; // a guest the table interpreter refuses stays verbatim
      }
      if (!isClean(guestRoot)) continue;
      const spliced = rebase(guestRoot, region.content.start, region.content.field);
      spliced.language = region.guest;
      if (region.content === node) {
        // The node is its own content: replace it in place, keeping identity so
        // the parent's children array does not have to be rewritten.
        for (const key of Object.keys(node)) delete node[key];
        Object.assign(node, spliced);
      } else {
        const kids = node.children;
        kids[kids.indexOf(region.content)] = spliced;
      }
      walk(spliced, region.guest);
    }
  };
  walk(doc.root, doc.language);
  return doc;
}

/**
 * Parse and splice until nothing new is needed.
 *
 * `load` returns a parse table for a language, or null. It may be async, which
 * is the only reason this exists as a helper rather than as two calls at every
 * call site: node has every table in hand, a browser fetches them.
 *
 * The round cap is a termination guarantee, not a depth limit that anything is
 * expected to hit -- markdown holding a markdown fence holding a json fence is
 * two rounds.
 */
export async function injectAll(doc, source, config, load, blobs = new Map(), rounds = 4) {
  for (let round = 0; round < rounds; round++) {
    const pending = pendingGuests(doc, source, config, blobs);
    if (pending.size === 0) break;
    let loaded = 0;
    for (const language of pending) {
      const blob = await load(language);
      // Record the miss too, so a language with no table is asked for once.
      blobs.set(language, blob ?? null);
      if (blob) loaded += 1;
    }
    if (loaded === 0) break;
    inject(doc, source, config, blobs);
  }
  return doc;
}
