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
export const SEGMENT = "prose_segment";
export const CONTINUATION = "prose_continuation";
export const CONTAINER_INLINE = "container_inline";
export const BLANK = "container_blank";

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
  "fenced_code_block",
  "html_block",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function continuations(inline, source) {
  const out = [];
  for (const child of inline.children ?? []) {
    if (child.type !== "block_continuation") continue;
    const newline = child.start - 1;
    if (newline < inline.start || source[newline] !== 0x0a) continue;
    out.push([newline, child.start, child.end]);
  }
  return out;
}

function logicalText(source, first, last, continuationRanges) {
  const parts = [];
  let at = first;
  for (const [, prefixStart, prefixEnd] of continuationRanges) {
    if (prefixEnd <= first || prefixStart >= last) continue;
    parts.push(source.subarray(at, Math.max(at, prefixStart)));
    at = Math.max(at, prefixEnd);
  }
  parts.push(source.subarray(at, last));
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return decoder.decode(joined);
}

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
function protectedRanges(inline, record, owned = []) {
  if (record === undefined) return [null, "no inline parse"];
  if (record.outcome !== "clean") return [null, "dirty inline parse"];
  const out = [];
  const admit = (child, inEmphasis = false) => {
    if (owned.some(([first, last]) => first <= child.start && child.end <= last)) {
      return true;
    }
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
function blockSafe(start, end, source, candidates, continuationRanges = []) {
  const drop = new Set();
  const edges = [start, ...candidates.map(([, gapEnd]) => gapEnd)];
  const stops = [...candidates.map(([gapStart]) => gapStart), end];
  for (let index = 0; index < edges.length; index += 1) {
    const atom = logicalText(
      source,
      edges[index],
      stops[index],
      continuationRanges,
    );
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
function fenceHazard(start, end, source, breakable, continuationRanges = []) {
  const edges = [start, ...breakable.map(([, gapEnd]) => gapEnd)];
  const stops = [...breakable.map(([gapStart]) => gapStart), end];
  for (let index = 0; index < edges.length; index += 1) {
    const lines = logicalText(
      source,
      edges[index],
      stops[index],
      continuationRanges,
    ).split("\n");
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
  if (
    children.length === 0 ||
    children[0].type !== "inline" ||
    children.slice(1).some((child) => child.type !== "block_continuation")
  ) {
    return ["paragraph shape", []];
  }
  const inline = children[0];
  const { start, end } = inline;
  const continuationRanges = continuations(inline, source);

  const [ranges, why] = protectedRanges(
    inline,
    secondary.get(`${start},${end}`),
    continuationRanges.map(([, prefixStart, prefixEnd]) => [prefixStart, prefixEnd]),
  );
  if (ranges === null) return [why, []];

  let text;
  try {
    text = logicalText(source, start, end, continuationRanges);
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
  const prefixRanges = continuationRanges.map(([, prefixStart, prefixEnd]) => [prefixStart, prefixEnd]);
  const continuationAt = new Map(
    continuationRanges.map(([newline, , prefixEnd]) => [newline, prefixEnd]),
  );
  let byteAt = start;
  let absorbedUntil = start;
  for (const char of text) {
    const size = encoder.encode(char).length;
    while (inside(prefixRanges, byteAt)) {
      byteAt = prefixRanges.find(
        ([first, last]) => first <= byteAt && byteAt < last,
      )[1];
    }
    if (byteAt < absorbedUntil) {
      byteAt += size;
      continue;
    }
    if (!inside(ranges, byteAt)) {
      if (GAPS.has(char)) {
        let gapEnd = byteAt + size;
        if (char === "\n" && continuationAt.has(byteAt)) {
          gapEnd = continuationAt.get(byteAt);
          while (gapEnd < end && source[gapEnd] === 0x20) gapEnd += 1;
          absorbedUntil = gapEnd;
        }
        candidates.push([byteAt, gapEnd]);
      }
      else if (char.codePointAt(0) < 128 && !SAFE.has(char)) {
        return ["byte", []];
      }
    }
    byteAt += size;
  }
  for (let i = 1; i < candidates.length; i += 1) {
    if (candidates[i - 1][1] === candidates[i][0]) return ["whitespace run", []];
  }

  // The one hazard bilateral protection cannot repair; see DELIMITER_ROW.
  if (
    candidates.length > 0 &&
    DELIMITER_ROW.test(
      logicalText(
        source,
        candidates[candidates.length - 1][1],
        end,
        continuationRanges,
      ),
    )
  ) {
    return ["delimiter row", []];
  }

  const breakable = blockSafe(start, end, source, candidates, continuationRanges);
  if (fenceHazard(start, end, source, breakable, continuationRanges)) {
    return ["fence opener", []];
  }
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
  const atom = (first, last) => {
    const children = [];
    let at = first;
    for (const [newline, , prefixEnd] of continuations(inline, source)) {
      if (newline < first || prefixEnd > last) continue;
      if (at < newline) {
        children.push({
          type: SEGMENT,
          start: at,
          end: newline,
          text: decoder.decode(source.subarray(at, newline)),
        });
      }
      children.push({
        type: CONTINUATION,
        start: newline,
        end: prefixEnd,
        text: decoder.decode(source.subarray(newline, prefixEnd)),
      });
      at = prefixEnd;
    }
    if (at < last) {
      children.push({
        type: SEGMENT,
        start: at,
        end: last,
        text: decoder.decode(source.subarray(at, last)),
      });
    }
    return { type: ATOM, start: first, end: last, children };
  };
  const out = [];
  let at = inline.start;
  for (const [gapStart, gapEnd] of breakable) {
    out.push(atom(at, gapStart));
    out.push({
      type: GAP,
      start: gapStart,
      end: gapEnd,
      text: decoder.decode(source.subarray(gapStart, gapEnd)),
    });
    at = gapEnd;
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
  const stack = [[doc.root, false]];
  while (stack.length > 0) {
    const [node, inListItem] = stack.pop();
    if (CONTAINERS.has(node.type) || node.language !== undefined) continue;
    const [verdict, breakable] =
      node.type === "paragraph"
        ? analyse(node, source, secondary)
        : ["not a paragraph", []];
    if (node.type === "paragraph" && inListItem) {
      for (const child of (node.children ?? []).slice(1)) {
        if (
          child.type === "block_continuation" &&
          (child.text ?? "").startsWith(">") &&
          child.text.trimEnd() === child.text
        ) {
          child.type = BLANK;
        }
      }
    }
    if (verdict === null) {
      const inline = node.children[0];
      // Key order is `type, start, end, field, children`; see prose.py.
      const run = { type: RUN, start: inline.start, end: inline.end };
      if (inline.field !== undefined) run.field = inline.field;
      run.children = partition(inline, source, breakable);
      node.children = [run, ...node.children.slice(1)];
      continue;
    }
    if (node.type === "paragraph" && (node.children ?? []).length > 0) {
      const inline = node.children[0];
      const ownsPrefix =
        continuations(inline, source).length > 0 ||
        node.children.slice(1).some(
          (child) => child.type === "block_continuation" || child.type === BLANK,
        );
      if (inline.type === "inline" && ownsPrefix) {
        const atom = partition(inline, source, [])[0];
        const logical = {
          type: CONTAINER_INLINE,
          start: inline.start,
          end: inline.end,
        };
        if (inline.field !== undefined) logical.field = inline.field;
        logical.children = atom.children;
        node.children = [logical, ...node.children.slice(1)];
        continue;
      }
    }
    const childInListItem = inListItem || node.type === "list_item";
    for (const child of node.children ?? []) stack.push([child, childInListItem]);
  }
  return doc;
}
