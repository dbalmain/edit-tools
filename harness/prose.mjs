// The A1 prose projection, in JavaScript. `harness/prose.py` is the original
// and carries the design: why the predicate is a whitelist, and the argument
// for every character it admits. Read that file, not this one, to change the
// policy -- and then change both, because `harness/probe_prose_parity.py`
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
// repository, sitting one line away from being used.
//
// That is worth stating rather than leaving as an apparent omission: "the two
// producers agree" is a weaker claim about a function one of them never runs,
// and the reader should know which kind of claim it is.
//
// It walks the document `ts_doc.mjs` produced, after `ts_inject.mjs` has
// spliced, and rewrites it in place. Offsets are byte offsets into the UTF-8
// encoding of `doc.source`, which is why the source is encoded here rather
// than indexed as a string -- a JavaScript string index is a UTF-16 code unit
// and would silently disagree with Python for any document holding a
// non-ASCII byte before an eligible paragraph.

export const RUN = "prose_run";
export const ATOM = "prose_atom";
export const GAP = "prose_gap";
export const TEXT = "prose_text";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const SAFE_PUNCTUATION = new Set(",;.'\"!?()-:/");
const SAFE = new Set([...ALNUM, ...SAFE_PUNCTUATION]);

const GAPS = new Set([" ", "\n"]);

// `prose.py`'s `_ACQUIRES`, character for character.
const ACQUIRES = /^(?:[-+*>#=|~]|\d+[.)]|```|~~~)/;

const CONTAINERS = new Set([
  "block_quote",
  "list_item",
  "list",
  "fenced_code_block",
  "html_block",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Why this paragraph is not eligible, or null if it is. */
export function refusal(paragraph, source) {
  const children = paragraph.children ?? [];
  if (children.length !== 1 || children[0].type !== "inline") return "paragraph shape";
  const inline = children[0];
  for (const child of inline.children ?? []) {
    if (!SAFE_PUNCTUATION.has(child.type)) return "inline token";
  }
  let text;
  try {
    text = decoder.decode(source.subarray(inline.start, inline.end));
  } catch {
    return "non-ascii";
  }
  // `decode` only rejects invalid UTF-8. Python asked for ASCII, so a valid
  // multi-byte character has to refuse here too or the two disagree.
  if (/[^\x00-\x7f]/.test(text)) return "non-ascii";
  if (text.length === 0 || GAPS.has(text[0]) || GAPS.has(text[text.length - 1])) {
    return "edge whitespace";
  }
  let run = 0;
  for (const char of text) {
    if (GAPS.has(char)) {
      run += 1;
      if (run > 1) return "whitespace run";
      continue;
    }
    run = 0;
    if (!SAFE.has(char)) return "byte";
  }
  const atoms = text.split(/[ \n]/);
  if (atoms.length < 2) return "single atom";
  if (atoms.some((atom) => ACQUIRES.test(atom))) return "block acquisition";
  return null;
}

/** The alternating atom/gap children covering `inline`'s whole range. */
export function partition(inline, source) {
  const out = [];
  let at = inline.start;
  while (at < inline.end) {
    let stop = at;
    while (stop < inline.end && !GAPS.has(String.fromCharCode(source[stop]))) stop += 1;
    out.push({
      type: ATOM,
      start: at,
      end: stop,
      children: [
        {
          type: TEXT,
          start: at,
          end: stop,
          text: decoder.decode(source.subarray(at, stop)),
        },
      ],
    });
    if (stop === inline.end) break;
    out.push({
      type: GAP,
      start: stop,
      end: stop + 1,
      text: decoder.decode(source.subarray(stop, stop + 1)),
    });
    at = stop + 1;
  }
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
  const out = [];
  const walk = (node) => {
    if (CONTAINERS.has(node.type) || node.language !== undefined) return;
    if (node.type === "paragraph") {
      out.push([node.start, refusal(node, source) ?? "eligible"]);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(doc.root);
  return out;
}

/** Rewrite every eligible paragraph in `doc`, in place. Returns how many. */
export function project(doc) {
  const source = encoder.encode(doc.source);
  let count = 0;
  const stack = [doc.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (CONTAINERS.has(node.type) || node.language !== undefined) continue;
    if (node.type === "paragraph" && refusal(node, source) === null) {
      const inline = node.children[0];
      // Key order is `type, start, end, field, children`; see prose.py.
      const run = { type: RUN, start: inline.start, end: inline.end };
      if (inline.field !== undefined) run.field = inline.field;
      run.children = partition(inline, source);
      node.children = [run];
      count += 1;
      continue;
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return count;
}
