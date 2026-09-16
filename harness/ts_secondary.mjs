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
 * `load(name, blob)` may fetch lazily. Missing tables and dirty roots are hard
 * refusals: the declaration promises syntax, not an optional enhancement.
 */
export async function attachSecondaries(doc, source, config, load) {
  const entries = [];
  for (const site of config.sites[doc.language] ?? []) {
    const blob = await load(site.name, site.blob);
    if (blob == null) {
      throw new Error(`secondary grammar ${site.name} has no parse table`);
    }
    for (const node of hostNodes(doc.root, site.within)) {
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
