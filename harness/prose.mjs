// The A2.3 prose projection, in JavaScript. `harness/prose.py` is the original
// and carries the design: what A2.1/A2.2 added to A1, why the predicate outside a
// protected range is still a whitelist, and the argument for every character
// it admits. Read that file, not this one, to change the
// policy -- and then change both, because `harness/probe_prose.py`
// compares their output on the same documents and fails if they diverge.
//
// This is a mirror in the same sense `runtime-js/bundle.js` mirrors
// `rust/src/eval.rs`: the same decisions in the same order, structured so the
// two read side by side, rather than the same behaviour reached its own way.
//
// # Nothing in the browser calls this yet, deliberately
//
// `web/js/lang.js` parses with `ts_doc.mjs` and splices with `ts_inject.mjs`,
// and does **not** project. Adding the call is one line, and that one line is
// the moment prose wrap becomes visible to somebody editing a buffer -- which
// is A2's boundary, not A1's. So this is the browser path's implementation,
// proven to agree with Python's on every tracked markdown file in the
// repository that parses cleanly, sitting one line away from being used.
//
// That is worth stating rather than leaving as an apparent omission: "the two
// producers agree" is a weaker claim about a function one of them never runs,
// and the reader should know which kind of claim it is.
//
// It walks the document `ts_doc.mjs` produced, after `ts_inject.mjs` has
// spliced, and returns a rewritten **copy**; the input document is left alone,
// so wiring this into the browser cannot destroy the inline CST that A2 is
// going to need. Offsets are byte offsets into the UTF-8
// encoding of `doc.source`, which is why the source is encoded here rather
// than indexed as a string -- a JavaScript string index is a UTF-16 code unit
// and would silently disagree with Python for any document holding a
// non-ASCII byte before an eligible paragraph.

export const RUN = "prose_run";
export const ATOM = "prose_atom";
export const GAP = "prose_gap";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const SAFE_PUNCTUATION = new Set(",;.'\"!?()-:/");
const SAFE = new Set([...ALNUM, ...SAFE_PUNCTUATION]);

const GAPS = new Set([" ", "\n"]);

// `prose.py`'s `_ACQUIRES`, character for character. The `:-+:?$` alternative
// is a GFM one-column table delimiter row, which needs no pipe; `prose.py`
// carries the counterexample that put it there. `$` rather than Python's `\Z`
// because this regex is not multiline, where the two are the same.
// `[0-9]` not `\d`: Python's `\d` matches Unicode Nd, JS's does not, and
// the pinned grammar agrees with CommonMark that `١.` is not a list marker.
const ACQUIRES = /^(?:[-+>#=|~]|[0-9]+[.)]|```|~~~|:-+:?$)/;

// `prose.py`'s `CONSTRUCTS`: the three inline constructs A2.1 admits, each
// protected whole. `prose.py` carries the argument for why `<` and `[` are
// deliberately not also block-acquisition hazards.
export const CONSTRUCTS = new Set(["code_span", "inline_link", "uri_autolink"]);

// Unlike the protected-whole constructs, emphasis is traversed. Only its
// delimiter leaves are opaque, so interior gaps remain layout candidates.
export const EMPHASIS = new Set(["emphasis", "strong_emphasis"]);
const DELIMITER_COUNTS = new Map([
  ["emphasis", 2],
  ["strong_emphasis", 4],
]);
const EMPHASIS_DELIMITER = "emphasis_delimiter";

// `prose.py`'s `_DELIMITER_ROW`: a **last** atom spelling a GFM one-column
// delimiter row refuses the whole paragraph, because it turns the *preceding
// line* into a table header and the preceding line is decided by gaps that are
// still breakable. `prose.py` carries the argument for why this is the one
// hazard bilateral protection cannot repair.
const DELIMITER_ROW = /^:?-+:?$/;

// `prose.py`'s `_FENCE`: a fence opener at a line start the output can
// produce. The second hazard gap protection cannot repair, because a fence
// opener's validity depends on the **rest of its line** -- a backtick fence's
// info string may not contain a backtick -- so truncating a line can turn a
// non-opener into an opener. `prose.py` carries the live case that found it,
// and the measurement behind the leading `[ \t]*`: CommonMark's three-space
// bound is not the right one here, because four or more spaces corrupts too,
// as an `indented_code_block` rather than as a fence.
const FENCE = /^[ \t]*(?:```|~~~)/;

const CONTAINERS = new Set([
  "block_quote",
  "list_item",
  "list",
  "fenced_code_block",
  "html_block",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * `doc.secondary`'s inline records, keyed by the host range they cover.
 * See `prose.py`: the table is total, so a missing key is a producer bug and
 * not an ordinary dirty parse, and the two get different refusals.
 */
export function secondaryIndex(doc) {
  const out = new Map();
  for (const entry of doc.secondary ?? []) {
    if (entry.within === "inline") out.set(`${entry.start},${entry.end}`, entry);
  }
  return out;
}

/** Opaque construct and emphasis-delimiter ranges, or a refusal reason. */
function protectedRanges(inline, record) {
  if (record === undefined) return [null, "no inline parse"];
  if (record.outcome !== "clean") return [null, "dirty inline parse"];
  const out = [];
  const admit = (child, inEmphasis = false) => {
    if (CONSTRUCTS.has(child.type)) {
      out.push([child.start, child.end]);
      return true;
    }
    if (EMPHASIS.has(child.type)) {
      const children = child.children ?? [];
      const delimiters = children.filter(
        (nested) => nested.type === EMPHASIS_DELIMITER,
      );
      if (delimiters.length !== DELIMITER_COUNTS.get(child.type)) return false;
      return children.every((nested) => admit(nested, true));
    }
    if (inEmphasis && child.type === EMPHASIS_DELIMITER) {
      out.push([child.start, child.end]);
      return true;
    }
    return SAFE_PUNCTUATION.has(child.type);
  };
  for (const child of record.root.children ?? []) {
    if (!admit(child)) return [null, "inline construct"];
  }
  return [out, null];
}

const inside = (ranges, at) =>
  ranges.some(([start, end]) => start <= at && at < end);

/**
 * `candidates`, less every gap flanking an atom that could open a block.
 * Bilateral, not predecessor-only; `prose.py` carries the counterexample and
 * the reason removing from one set is what unions the merges into connected
 * components.
 */
function blockSafe(start, end, source, candidates) {
  const drop = new Set();
  const edges = [start, ...candidates.map((gap) => gap + 1)];
  const stops = [...candidates, end];
  for (let index = 0; index < edges.length; index += 1) {
    const atom = decoder.decode(source.subarray(edges[index], stops[index]));
    if (!ACQUIRES.test(atom)) continue;
    if (index > 0) drop.add(candidates[index - 1]);
    if (index < candidates.length) drop.add(candidates[index]);
  }
  return candidates.filter((gap) => !drop.has(gap));
}

/**
 * Can any line start the output produces begin a fence? See FENCE.
 * `prose.py`'s `_fence_hazard` carries the argument, including why an atom
 * after a breakable gap needs no check.
 */
function fenceHazard(start, end, source, breakable) {
  const edges = [start, ...breakable.map((gap) => gap + 1)];
  const stops = [...breakable, end];
  for (let index = 0; index < edges.length; index += 1) {
    const lines = decoder
      .decode(source.subarray(edges[index], stops[index]))
      .split("\n");
    for (let offset = 0; offset < lines.length; offset += 1) {
      if (offset === 0 && index > 0) continue;
      if (FENCE.test(lines[offset])) return true;
    }
  }
  return false;
}

/**
 * The verdict for this paragraph, and its breakable gap offsets.
 * One function, so `refusal` and `project` cannot disagree about which gaps
 * are breakable. `prose.py`'s `analyse` is the original.
 */
export function analyse(paragraph, source, secondary) {
  const children = paragraph.children ?? [];
  if (children.length !== 1 || children[0].type !== "inline") {
    return ["paragraph shape", []];
  }
  const inline = children[0];
  const { start, end } = inline;

  const [ranges, why] = protectedRanges(
    inline,
    secondary.get(`${start},${end}`),
  );
  if (ranges === null) return [why, []];

  let text;
  try {
    text = decoder.decode(source.subarray(start, end));
  } catch {
    return ["non-ascii", []];
  }
  if (text.length === 0 || GAPS.has(text[0]) || GAPS.has(text[text.length - 1])) {
    return ["edge whitespace", []];
  }

  // Scalars, not bytes and not UTF-16 code units. A Latin-1 letter is one
  // scalar and two UTF-8 bytes; a non-BMP scalar is one scalar and two
  // UTF-16 code units. Indexing `text` by byte offset would disagree with
  // Python on either.
  const candidates = [];
  let byteAt = start;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (!inside(ranges, byteAt)) {
      if (GAPS.has(char)) candidates.push(byteAt);
      else if (char.codePointAt(0) < 128 && !SAFE.has(char)) {
        return ["byte", []];
      }
    }
    byteAt += size;
  }
  for (let i = 1; i < candidates.length; i += 1) {
    if (candidates[i] - candidates[i - 1] === 1) return ["whitespace run", []];
  }

  // The one hazard bilateral protection cannot repair; see DELIMITER_ROW.
  if (
    candidates.length > 0 &&
    DELIMITER_ROW.test(
      decoder.decode(source.subarray(candidates[candidates.length - 1] + 1, end)),
    )
  ) {
    return ["delimiter row", []];
  }

  const breakable = blockSafe(start, end, source, candidates);
  if (fenceHazard(start, end, source, breakable)) return ["fence opener", []];
  if (breakable.length === 0) return ["single atom", []];
  return [null, breakable];
}

/** Why this paragraph is not eligible, or null if it is. */
export function refusal(paragraph, source, secondary) {
  return analyse(paragraph, source, secondary)[0];
}

/**
 * The alternating atom/gap children covering `inline`'s whole range: the
 * maximal source spans **between the breakable gaps**, so every gap not proved
 * safe stays exact text inside an atom. `prose.py` carries the polarity
 * argument.
 */
export function partition(inline, source, breakable) {
  // A leaf, not a wrapper: `source_partitions` on the enclosing run validates
  // leaf text against the source, so the interior node the design doc asked
  // for bought nothing. `prose.py` carries the measurement.
  const atom = (first, last) => ({
    type: ATOM,
    start: first,
    end: last,
    text: decoder.decode(source.subarray(first, last)),
  });
  const out = [];
  let at = inline.start;
  for (const gap of breakable) {
    out.push(atom(at, gap));
    out.push({
      type: GAP,
      start: gap,
      end: gap + 1,
      text: decoder.decode(source.subarray(gap, gap + 1)),
    });
    at = gap + 1;
  }
  out.push(atom(at, inline.end));
  return out;
}

/**
 * Every paragraph the walk reaches, in document order, with its verdict.
 * See `prose.py`'s `reasons` for why the refusals are exposed at all: without
 * them the producer comparison is vacuous on a document with no eligible
 * paragraph, which is most documents.
 */
export function reasons(doc) {
  const source = encoder.encode(doc.source);
  const secondary = secondaryIndex(doc);
  const out = [];
  const walk = (node) => {
    if (CONTAINERS.has(node.type) || node.language !== undefined) return;
    if (node.type === "paragraph") {
      out.push([node.start, refusal(node, source, secondary) ?? "eligible"]);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(doc.root);
  return out;
}

/**
 * A copy of `doc` with every eligible paragraph projected. `doc` is untouched.
 * See `prose.py`: the projection replaces a paragraph's `inline` child, and the
 * syntax tree has to survive for highlighting, so this must never be the thing
 * the browser's one `parse()` mutates.
 */
export function project(doc) {
  doc = structuredClone(doc);
  const source = encoder.encode(doc.source);
  const secondary = secondaryIndex(doc);
  const stack = [doc.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (CONTAINERS.has(node.type) || node.language !== undefined) continue;
    const [verdict, breakable] =
      node.type === "paragraph"
        ? analyse(node, source, secondary)
        : ["not a paragraph", []];
    if (verdict === null) {
      const inline = node.children[0];
      // Key order is `type, start, end, field, children`; see prose.py.
      const run = { type: RUN, start: inline.start, end: inline.end };
      if (inline.field !== undefined) run.field = inline.field;
      run.children = partition(inline, source, breakable);
      node.children = [run];
      continue;
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return doc;
}
