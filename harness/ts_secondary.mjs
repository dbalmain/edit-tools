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
 * Parse every required secondary range and attach one outcome for each.
 *
 * `load(name, blob)` is called at most once per site, and only for a site the
 * document actually reaches -- so in a browser it is a fetch this document
 * needed. A missing table is still a hard refusal: where the declaration
 * applies, the table is mandatory and its absence means the declared pipeline
 * could not run at all.
 *
 * A **dirty parse is not**. It is recorded as `outcome: "dirty"` and costs that
 * range alone, mirroring the rule `ts_inject.mjs` states for a guest language
 * that will not parse: the region stays verbatim and the document formats. The
 * alternative -- throwing -- would let A2.0 stop a buffer formatting that
 * formatted before it existed, which no amount of extra syntax is worth.
 *
 * The array is **total**: one record per host range, always. That is what lets
 * a reader distinguish "no host range here" from "a range I could not parse"
 * from "a range with no record at all", the last being a producer bug. It is
 * also published all-or-nothing, so an unexpected failure mid-walk leaves the
 * document exactly as it found it rather than half-annotated. Must stay
 * byte-identical to `gen_trees.secondary_trees`.
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
      const entry = {
        language: site.name,
        within: site.within,
        start: node.start,
        end: node.end,
        outcome: parsed.dirty ? "dirty" : "clean",
      };
      if (!parsed.dirty) entry.root = rebase(parsed.root, node.start);
      entries.push(entry);
    }
  }
  if (entries.length > 0) doc.secondary = entries;
  return doc;
}
