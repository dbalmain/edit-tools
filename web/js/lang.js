// The language registry: what each language is, and how to parse and format it.
//
// Everything here is lazy and cached. A page load costs one `languages.json`
// (a few KB); a parse table is fetched only when something first needs a parse,
// which -- because the left pane holds our formatter's output, pre-computed by
// `gen.py` -- means only on the first `:w`.
//
// That ordering is the point. The blobs run from 6 KB (json) to 7.1 MB
// (kotlin), and a page that fetched one eagerly would pay for a parser most
// visits never use.

import { parseDoc } from "../vendor/ts_doc.mjs";
import { format, Refusal } from "../vendor/runtime.mjs";

const DATA = new URL("../data/", import.meta.url);

const encoder = new TextEncoder();

let index = null;
const blobs = new Map();
const packages = new Map();
const divergences = new Map();

async function json(path) {
  const response = await fetch(new URL(path, DATA));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
  return response.json();
}

/** Every language, in corpus order. @returns {Promise<object[]>} */
export async function languages() {
  if (index === null) index = await json("languages.json");
  return index;
}

/** One language's registry entry, or null. */
export async function language(name) {
  return (await languages()).find((entry) => entry.name === name) ?? null;
}

/** Every current divergence for one language, both texts and its ledger verdict. */
export async function casesFor(name) {
  if (!divergences.has(name)) divergences.set(name, await json(`divergences/${name}.json`));
  return divergences.get(name);
}

/** The parse table for one language. Megabytes; fetched once, held forever. */
export async function blobFor(name) {
  if (!blobs.has(name)) blobs.set(name, await json(`blobs/${name}.blob.json`));
  return blobs.get(name);
}

/** One formatting package. */
export async function packageFor(name) {
  if (!packages.has(name)) packages.set(name, await json(`packages/${name}.json`));
  return packages.get(name);
}

/**
 * Parse text with the C3 table interpreter.
 *
 * Bytes, not characters: the tables index UTF-8, and every offset in the
 * resulting tree is a byte offset. Encoding here rather than inside the parser
 * keeps that visible at the call site.
 */
export async function parse(text, name) {
  const blob = await blobFor(name);
  return parseDoc(blob, name, encoder.encode(text), `<${name} buffer>`);
}

/**
 * Format text: parse it, then run the same `runtime-js` formatter the scorer
 * runs. Returns the formatted text.
 *
 * A `Refusal` is the formatter declining a tree it cannot format, which is a
 * normal outcome for a buffer someone is halfway through editing. It is
 * rethrown rather than swallowed so the caller can say so instead of silently
 * leaving the buffer alone.
 */
export async function formatText(text, name, width) {
  const tree = await parse(text, name);
  const pkgs = new Map();
  for (const lang of treeLanguages(tree)) pkgs.set(lang, await packageFor(lang));
  return format(tree, pkgs, width);
}

/**
 * Every language a tree needs a package for -- its own, plus any an injected
 * region names. `fmt-js` does this too; the browser needs it for the same
 * reason, since a markdown file with a fenced rust block formats the rust.
 */
export function treeLanguages(tree) {
  const out = new Set([tree.language]);
  const visit = (node) => {
    if (node.language !== undefined) out.add(node.language);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree.root);
  return out;
}

export { Refusal };
