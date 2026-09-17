// Manifest-declared parallel parses over contiguous host CST ranges.
//
// Unlike an injection, a secondary tree never replaces host nodes: the block
// CST remains the formatter's tree and each rebased secondary root is retained
// beside it. That lets a later projection consult both grammars at one gap.

import { parseRootWithStatus } from "./ts_doc.mjs";

/** Host nodes only: do not reinterpret a CST already spliced as a guest. */
function* hostNodes(root, kind) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.language !== undefined) continue;
    if (node.type === kind) yield node;
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

function rebase(node, by) {
  const out = { type: node.type, start: node.start + by, end: node.end + by };
  if (node.field !== undefined) out.field = node.field;
  if (node.children) out.children = node.children.map((child) => rebase(child, by));
  else out.text = node.text;
  if (node.missing) out.missing = true;
  return out;
}

/**
 * Parse and attach every required secondary range.
 *
 * `load(name, blob)` is called at most once per site, and only for a site the
 * document actually reaches -- so in a browser it is a fetch this document
 * needed. Missing tables and dirty roots are then hard refusals: where the
 * declaration applies it promises syntax, not an optional enhancement.
 */
export async function attachSecondaries(doc, source, config, load) {
  const entries = [];
  for (const site of config.sites[doc.language] ?? []) {
    // Demand decides the fetch, not the declaration. A markdown buffer with no
    // `inline` node -- an empty one, or one that is nothing but a fenced block
    // -- never pays for the inline table, the same rule a document with no
    // fence gets from `injectAll`. So the walk comes first and `load` is
    // reached only if it found something; a table is required where it is
    // needed rather than wherever it is declared.
    const nodes = [...hostNodes(doc.root, site.within)];
    if (nodes.length === 0) continue;
    const blob = await load(site.name, site.blob);
    if (blob == null) {
      throw new Error(`secondary grammar ${site.name} has no parse table`);
    }
    for (const node of nodes) {
      const slice = source.subarray(node.start, node.end);
      const parsed = parseRootWithStatus(blob, slice);
      if (parsed.dirty) {
        throw new Error(
          `${doc.source_file.split("/").at(-1)}: secondary grammar ${site.name} ` +
          `refused dirty ${site.within} range ${node.start}..${node.end}`,
        );
      }
      entries.push({
        language: site.name,
        within: site.within,
        start: node.start,
        end: node.end,
        root: rebase(parsed.root, node.start),
      });
    }
  }
  if (entries.length > 0) doc.secondary = entries;
  return doc;
}
