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

