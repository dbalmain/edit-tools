// The host-side policy vici does not own, with no DOM and no imports.
//
// vici stops where a host has to make a decision, and these are the two
// decisions that are pure functions rather than drawing: how a browser
// `KeyboardEvent` is spelled as a vi key, and what indentation a new line
// inherits. They live apart from `editor.js` so they can be tested under
// `node --test` without a DOM and without `web/vendor/` having been generated.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Browser key names that have a vi spelling. Anything else of length 1 is itself. */
const NAMED = {
  Escape: "<Esc>",
  Enter: "<CR>",
  Tab: "<Tab>",
  Backspace: "<BS>",
  Delete: "<Del>",
  Insert: "<Insert>",
  ArrowLeft: "<Left>",
  ArrowRight: "<Right>",
  ArrowUp: "<Up>",
  ArrowDown: "<Down>",
  Home: "<Home>",
  End: "<End>",
  PageUp: "<PageUp>",
  PageDown: "<PageDown>",
};

/**
 * One `KeyboardEvent` as vici spells it, or null for a key vici has no name
 * for (a bare modifier, a media key).
 *
 * Ctrl is the only modifier translated. Alt is left alone because a browser
 * gives us the composed character for it and vici's `<M-x>` expects the base
 * one; getting that wrong silently would be worse than not binding it.
 */
export function keyOf(event) {
  const named = NAMED[event.key];
  // Shift is spelled out for `<Tab>` alone, because `<S-Tab>` is the only
  // shifted named key anything binds. Spelling it for the rest would hand
  // vici `<S-CR>` and `<S-Left>`, which it has no names for, in place of the
  // unshifted keys it does -- a silent loss of every shifted arrow.
  if (named === "<Tab>" && event.shiftKey && !event.ctrlKey) return "<S-Tab>";
  if (named) return event.ctrlKey ? `<C-${named.slice(1, -1)}>` : named;
  if ([...event.key].length !== 1) return null;
  if (event.ctrlKey) return `<C-${event.key.toLowerCase()}>`;
  return event.key;
}

/** Bytes 0..offset of `text`, decoded -- vici counts in UTF-8, the DOM in UTF-16. */
export function sliceToByte(text, offset) {
  return decoder.decode(encoder.encode(text).subarray(0, offset));
}

/**
 * The whitespace a new line inherits, plus a continued comment marker.
 *
 * Deliberately textual rather than tree-driven. This runs on every `<CR>` in
 * insert mode, and a parse per keystroke is exactly the cost Q1 measured and
 * chose not to pay; the previous line's own prefix is enough to be right in
 * every case a human would notice, and wrong only where they would have fixed
 * it with `<leader>F` anyway.
 */
export function continuation(previousLine, { indent, lineComment, openers = "([{" }) {
  const leading = /^[ \t]*/.exec(previousLine)[0];
  const body = previousLine.slice(leading.length);
  if (lineComment && body.startsWith(lineComment)) {
    const gap = /^\s*/.exec(body.slice(lineComment.length))[0];
    return leading + lineComment + (gap.startsWith(" ") ? " " : "");
  }
  const trimmed = body.trimEnd();
  const last = trimmed[trimmed.length - 1];
  if (last && openers.includes(last)) return leading + " ".repeat(indent);
  return leading;
}

// -- pipe tables -------------------------------------------------------
//
// A table is the one block whose raw region is smaller than the block. Every
// other block goes raw whole when the cursor enters it, which is right for a
// paragraph and wrong for a table: the reason to render a table at all is that
// its source is too wide to read, and going raw on entry hands that width
// straight back at the moment you want to edit.
//
// So the cell under the cursor is raw and the rest of the table stays drawn,
// and this is the function that says where the cells are. It reads the block's
// own text rather than the tree, which is not a shortcut: the block's range is
// patched between parses, so the tree's cell nodes would be stale exactly
// while someone is typing in one. The text is never stale.
//
// Slots tile the line completely -- every byte of a row belongs to exactly one
// cell, including the pipes and the padding -- because the caret has to be
// drawable wherever vici puts it. A cell owns the pipe on its left, so `0` and
// `f|` land inside a cell rather than in a gap between two.

/** A delimiter row's cell: dashes, with optional alignment colons. */
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * `out[i]` is the UTF-8 byte offset of `text`'s `i`th UTF-16 code unit.
 *
 * vici counts in bytes and the DOM in code units, and a table is where the
 * difference stops being theoretical: CJK is exactly what makes a table too
 * wide to read in the first place.
 */
function byteIndex(text) {
  const out = new Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i);
    const units = code > 0xffff ? 2 : 1;
    for (let k = 0; k < units; k += 1) out[i + k] = bytes;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += units;
  }
  out[text.length] = bytes;
  return out;
}

/** The `|` positions that separate cells. A `\|` is content, not a separator. */
function separators(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "|") continue;
    let slashes = 0;
    while (i - 1 - slashes >= 0 && line[i - 1 - slashes] === "\\") slashes += 1;
    if (slashes % 2 === 0) out.push(i);
  }
  return out;
}

/**
 * One line's slots, tiling `[0, line.length)`. Each is `{s, e}` for the slot
 * and `{bs, be}` for the cell body inside it, without its pipes.
 *
 * The two ends are where a table row is allowed to vary: GFM lets a row open
 * and close with a pipe or not, in any combination, so a blank run outside the
 * outermost pipes is that pipe's padding and a non-blank one is a cell.
 */
function tile(line) {
  const pipes = separators(line);
  if (pipes.length === 0) return null;
  const out = pipes.map((pipe, k) => {
    const end = k + 1 < pipes.length ? pipes[k + 1] : line.length;
    return { s: pipe, e: end, bs: pipe + 1, be: end };
  });
  if (line.slice(0, pipes[0]).trim() === "") out[0].s = 0;
  else out.unshift({ s: 0, e: pipes[0], bs: 0, be: pipes[0] });
  const last = out[out.length - 1];
  if (out.length > 1 && line.slice(last.s + 1).trim() === "") {
    out.pop();
    const closing = out[out.length - 1];
    closing.e = line.length;
    closing.be = last.s;
  }
  return out;
}

/**
 * A pipe table's rows and cells, or `null` when `text` is not one any more.
 *
 * Offsets are UTF-8 byte offsets into `text`, so they are directly comparable
 * with the editor's cursor once the block's start is subtracted. `text` and
 * `content` are strings, because that is what gets drawn.
 *
 * Returning `null` is load-bearing rather than defensive: the caller renders
 * the block raw instead, which is what should happen while a row is half-typed
 * and briefly is not a table.
 */
export function tableSlots(text) {
  const at = byteIndex(text);
  const rows = [];
  for (let start = 0; start <= text.length; ) {
    const brk = text.indexOf("\n", start);
    const end = brk === -1 ? text.length : brk;
    const line = text.slice(start, end);
    if (line.trim() === "") {
      if (brk === -1) break;
      return null; // a blank line is the end of the table, not a row of it
    }
    const bounds = tile(line);
    if (bounds === null) return null;
    const cells = bounds.map(({ s, e, bs, be }, k) => {
      const stop = k === bounds.length - 1 && brk !== -1 ? brk + 1 : start + e;
      const body = line.slice(bs, be);
      // An empty cell has no content to point at, so `contentStart` points one
      // space past the pipe -- where a person typing into it would want to be,
      // rather than at the far pipe, which belongs to the next cell.
      const trimmed = body.trimStart();
      const lead = trimmed === "" ? Math.min(1, body.length) : body.length - trimmed.length;
      return {
        start: at[start + s],
        end: at[stop],
        text: text.slice(start + s, stop),
        content: body.trim(),
        contentStart: at[start + bs + lead],
      };
    });
    rows.push({
      start: at[start],
      end: at[brk === -1 ? end : brk + 1],
      cells,
      delimiter: cells.every((cell) => DELIMITER_CELL.test(cell.content)),
    });
    if (brk === -1) break;
    start = brk + 1;
  }
  // GFM puts the delimiter row second and nowhere else, and a table with no
  // body row is still a table -- it is what a table looks like as you type it.
  if (rows.length < 2 || rows[0].delimiter || !rows[1].delimiter) return null;
  const aligns = rows[1].cells.map((cell) => {
    const left = cell.content.startsWith(":");
    const right = cell.content.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
  return { aligns, rows };
}
