// The single-pane markdown surface: the block under the cursor is raw, and
// every other block is rendered.
//
// # What "the current component" turned out to be
//
// The premise it was specified under was that `document`'s children are the
// blocks. They are not: `tree-sitter-markdown`'s block grammar nests `section`
// nodes by heading level, so a whole file is usually one `section`, and taking
// the root's child containing the cursor would put the entire document in raw
// mode. The rule that works is to treat `document` and `section` as containers
// and flatten through them, which lands on the `paragraph`, `atx_heading`,
// `list`, `fenced_code_block`, `block_quote`, `table` or `html_block` the
// cursor is actually in.
//
// `CONTAINERS` is therefore the knob. Adding `list` to it narrows the raw
// region from a whole list to one `list_item`; removing `section` widens it to
// a whole heading's worth of document.
//
// # Why the block list is cached and patched rather than re-parsed
//
// A 40 KB document parses in about 81 ms, which is fine on `:w` and much too
// slow on a keystroke. But an edit only ever changes the block the cursor is
// in, so the other blocks' text is still exactly what the last parse said it
// was: shifting their offsets by the edit's delta is not an approximation, it
// is the same answer sooner. A real parse follows on idle, which is what
// notices a block that has just split in two.

import { parse, syntaxOf } from "./lang.js";
import { VimEditor } from "./editor.js";
import { tableSlots } from "./host.js";
import { NORMAL } from "../vendor/vici/index.js";

/** Node types that hold blocks rather than being one. See the header. */
const CONTAINERS = new Set(["document", "section"]);

const STARTER = `# The markdown surface

This pane is one editor. The block your cursor is in shows as **raw markdown**;
every other block is rendered. Move down and watch this paragraph turn back into
prose with asterisks in it.

## What is bound

- vim keys, from vici — motions, operators, counts, text objects, visual mode,
  undo, dot-repeat, macros
- \`:w\` formats the buffer with our own formatter and saves it to the session
- \`\\F\` formats without saving
- autoindent and comment continuation on \`<CR>\`, \`o\` and \`O\`

## What a block is

A block is what the parser says it is, not what a line is. This list is one
block, so the whole list goes raw when you enter it. A fenced code block is one
block too:

\`\`\`js
const blocks = flatten(root);   // containers are walked through, not rendered
\`\`\`

> A block quote is a block. So is a heading, a table, and a thematic break.

Nothing here is written to disk. \`:w\` saves to \`sessionStorage\`, and closing
the tab is how you discard it.
`;

const SESSION_KEY = "editor-tools:markdown";

/** Inline markdown, rendered by hand. */
function inline(text, into) {
  // The block grammar is the one this repo transcodes; emphasis, code spans and
  // links live in `tree-sitter-markdown-inline`, which it does not. So inline
  // rendering here is app-level and deliberately shallow -- enough that a
  // rendered paragraph reads as prose, and honest about not being a parse. The
  // raw block is always one keystroke away and is always the truth.
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)]+)\)/g;
  let at = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > at) into.append(document.createTextNode(text.slice(at, m.index)));
    if (m[1] !== undefined) {
      const code = document.createElement("code");
      code.className = "md-code";
      code.style.display = "inline";
      code.textContent = m[1];
      into.append(code);
    } else if (m[2] !== undefined) {
      const b = document.createElement("strong");
      b.textContent = m[2];
      into.append(b);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const i = document.createElement("em");
      i.textContent = m[3] ?? m[4];
      into.append(i);
    } else {
      const a = document.createElement("a");
      a.href = m[6];
      a.textContent = m[5];
      a.rel = "noreferrer";
      into.append(a);
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) into.append(document.createTextNode(text.slice(at)));
}

/**
 * A pipe table as a real table, with the cell under the cursor left raw.
 *
 * Every other block goes raw whole when the cursor enters it. A table must not,
 * and the measurement says why: of 3,860 tables wider than 100 columns under
 * `~/w`, 3,601 are still wider than 100 with every pad byte removed, and 1,535
 * have one cell that alone exceeds it. The width is the content, so there is no
 * layout change that makes the source narrow -- only drawing it as a grid does,
 * and a table that reverted to source the moment you tried to edit it would
 * hand the width back exactly when it mattered.
 *
 * Returns null when the block is not a table any more, which is what a
 * half-typed row is; the caller then renders it the ordinary way.
 */
function renderTable(text, cursor, draw) {
  const table = tableSlots(text);
  if (table === null) return null;
  const total = table.rows.at(-1).cells.at(-1).end;
  // The cursor may sit one past the last byte, which is a position no range
  // contains; the final cell is where it belongs.
  const holds = (range) =>
    cursor !== null &&
    cursor >= range.start &&
    (cursor < range.end || (range.end === total && cursor === total));

  const node = document.createElement("table");
  node.className = "md-rendered md-table";
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  let drewCursor = false;

  for (const [index, row] of table.rows.entries()) {
    // The delimiter row is the ruler -- layout, not content -- so it is drawn
    // only while the caret is in it, which is the only time it is being edited.
    if (row.delimiter && !holds(row)) continue;
    const tr = document.createElement("tr");
    for (const [column, cell] of row.cells.entries()) {
      const el = document.createElement(index === 0 ? "th" : "td");
      const align = table.aligns[column];
      if (align !== null && align !== undefined) el.style.textAlign = align;
      if (!drewCursor && holds(cell)) {
        el.className = "md-cell-raw";
        // Without its newline: the caret can sit on that newline, and
        // `drawText` already draws an end-of-text caret as a space.
        draw(el, cell.text.replace(/\n$/, ""), cursor - cell.start);
        drewCursor = true;
      } else if (row.delimiter) {
        el.textContent = cell.content;
      } else {
        inline(cell.content, el);
      }
      tr.append(el);
    }
    (index === 0 ? head : body).append(tr);
  }
  if (head.childElementCount > 0) node.append(head);
  if (body.childElementCount > 0) node.append(body);
  return { node, drewCursor };
}

/** One block's rendered form. */
function renderBlock(block) {
  const text = block.text.replace(/\n+$/, "");
  const node = document.createElement("div");
  node.className = "md-rendered";

  if (block.type === "atx_heading") {
    const hashes = /^(#{1,6})\s*/.exec(text);
    const level = hashes ? hashes[1].length : 1;
    node.classList.add(`md-h${level}`);
    inline(hashes ? text.slice(hashes[0].length) : text, node);
    return node;
  }
  if (block.type === "fenced_code_block" || block.type === "indented_code_block") {
    const body = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
    const pre = document.createElement("pre");
    pre.className = "md-code";
    pre.textContent = body;
    node.append(pre);
    return node;
  }
  if (block.type === "block_quote") {
    node.classList.add("md-quote");
    inline(text.replace(/^>\s?/gm, ""), node);
    return node;
  }
  if (block.type === "thematic_break") {
    node.classList.add("md-rule");
    node.append(document.createElement("hr"));
    return node;
  }
  if (block.type === "list") {
    const ordered = /^\s*\d+[.)]/.test(text);
    const list = document.createElement(ordered ? "ol" : "ul");
    for (const line of text.split("\n")) {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) {
        const li = document.createElement("li");
        inline(item[1], li);
        list.append(li);
      } else if (list.lastElementChild && line.trim() !== "") {
        list.lastElementChild.append(document.createTextNode(" " + line.trim()));
      }
    }
    node.append(list);
    return node;
  }
  // paragraph, html_block, and anything the grammar adds later. A table
  // is handled by `renderTable`, which needs the cursor and so is called by
  // `render` rather than from here.
  inline(text, node);
  return node;
}

/**
 * Every injected region, innermost last, with the language it was parsed as.
 *
 * A node carries `language` only if `ts_inject.mjs` put it there, which it does
 * exactly when it reparsed that region with a guest grammar. So this is not a
 * guess about what the fence said -- it is the range the guest parser actually
 * covered, which is why "inside the fence" and "parsed as ruby" cannot drift
 * apart.
 */
function guestsOf(root) {
  const out = [];
  const walk = (node) => {
    if (node.language !== undefined) {
      out.push({ start: node.start, end: node.end, language: node.language });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

/** Every non-container block, in document order, with its byte range. */
function flatten(root) {
  const out = [];
  const walk = (node) => {
    if (CONTAINERS.has(node.type)) {
      for (const child of node.children ?? []) walk(child);
    } else {
      out.push({ type: node.type, start: node.start, end: node.end });
    }
  };
  walk(root);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Absorb an edit's size delta into the range holding the cursor, and slide
 * every range after it.
 *
 * Shared by the block list and the guest list because they are the same shape
 * and the same edit moved both -- and a second copy of this arithmetic that
 * drifted from the first would put the caret in one block and the syntax rules
 * of another.
 */
function shift(ranges, delta, cursor) {
  for (const range of ranges) {
    if (cursor <= range.start) {
      range.start += delta;
      range.end += delta;
    } else if (cursor <= range.end + Math.max(delta, 0)) {
      // The cursor is inside this range, so the range grew rather than moved.
      // Tested per range rather than by "everything after the edited one",
      // because guest regions nest: a json fence inside a markdown fence is
      // inside its parent's range, and sliding it whole would tear it loose.
      range.end += delta;
    }
  }
}

/**
 * A markdown editor: everything `VimEditor` does, drawn as blocks.
 *
 * Only `render` is overridden. The editing core, the ex line, `<leader>F` and
 * autoindent are all inherited unchanged, which is the point of the component
 * having two hosts.
 */
class MarkdownEditor extends VimEditor {
  constructor(host, options) {
    super(host, options);
    /** Block ranges from the last real parse, patched by every edit since. */
    this.blocks = null;
    /** Injected regions from the same parse, patched the same way. */
    this.guests = [];
    /** Indent width and comment marker per guest language, fetched once each. */
    this.syntaxes = new Map();
    this.reparseTimer = null;
    this.scheduleReparse(0);
  }

  /** Re-derive block ranges from a real parse, after `delay` ms of quiet. */
  scheduleReparse(delay = 150) {
    clearTimeout(this.reparseTimer);
    this.reparseTimer = setTimeout(async () => {
      const text = this.editor.text();
      try {
        const tree = await parse(text, "markdown");
        this.blocks = flatten(tree.root);
        this.guests = guestsOf(tree.root);
        for (const guest of this.guests) {
          if (this.syntaxes.has(guest.language)) continue;
          this.syntaxes.set(guest.language, await syntaxOf(guest.language));
        }
      } catch {
        this.blocks = null; // fall back to plain text rather than to a wrong shape
        this.guests = [];
      }
      if (this.editor.text() === text) this.render();
    }, delay);
  }

  /**
   * Markdown, unless the cursor is inside a fence that routed to a guest --
   * then that guest's, which is what Dave asked for: a ```ruby block should
   * behave as if it were a ruby file, right up to the closing fence.
   *
   * Innermost wins, so a json fence inside a markdown fence answers json. The
   * ranges are the guest *content*, not the whole `fenced_code_block`, so the
   * fence lines themselves are still markdown -- which is right, because that
   * is where the info string is edited.
   *
   * A guest with no package (`indent: null`) keeps the host's width rather
   * than inheriting a null; only what the guest actually declares overrides.
   */
  syntax() {
    const host = super.syntax();
    const cursor = this.editor.cursor;
    let best = null;
    for (const guest of this.guests ?? []) {
      if (cursor < guest.start || cursor >= guest.end) continue;
      if (best === null || guest.end - guest.start <= best.end - best.start) best = guest;
    }
    if (best === null) return host;
    const rules = this.syntaxes?.get(best.language);
    return {
      language: best.language,
      indent: rules?.indent ?? host.indent,
      lineComment: rules?.lineComment ?? null,
    };
  }

  /**
   * The table block holding `cursor`, with its cells, or null.
   *
   * Derived from the block's text rather than kept as state, for the same
   * reason `renderTable` is: between two parses the block's range is patched
   * but its interior is not, and the interior is exactly what is being typed
   * in. A table is small, so re-deriving it per keystroke is free.
   */
  tableAt(cursor) {
    const bytes = encoder.encode(this.editor.text());
    for (const block of this.blocks ?? []) {
      if (block.type !== "pipe_table") continue;
      const start = Math.min(block.start, bytes.length);
      const end = Math.min(block.end, bytes.length);
      if (cursor < start || cursor > end) continue;
      const table = tableSlots(decoder.decode(bytes.subarray(start, end)));
      if (table !== null) return { table, base: start };
    }
    return null;
  }

  /**
   * Move to the next or previous cell's content. Returns false when there is
   * no table, or no cell that way -- the key then does whatever it usually
   * does, which for `<Tab>` in normal mode is nothing.
   *
   * The delimiter row is skipped: it is the ruler, and the formatter redraws
   * it on `:w` from the alignment colons, so tabbing into it would offer to
   * edit the one row whose content is not content.
   */
  moveCell(direction) {
    const found = this.tableAt(this.editor.cursor);
    if (found === null) return false;
    const cells = found.table.rows.flatMap((row) => (row.delimiter ? [] : row.cells));
    const cursor = this.editor.cursor - found.base;
    let index = cells.findIndex((cell) => cursor >= cell.start && cursor < cell.end);
    if (index === -1) index = cursor < cells[0].start ? 0 : cells.length - 1;
    const next = cells[index + direction];
    if (next === undefined) return false;
    this.editor.jumpTo(found.base + next.contentStart);
    return true;
  }

  /**
   * `<Tab>` and `<S-Tab>` step between cells, and are intercepted here rather
   * than bound in vici because vici's bindings are data and cannot call this.
   *
   * Normal mode only. vici binds `<Tab>` in insert mode to insert a tab, and
   * shadowing a documented binding of the editing core is not this host's to
   * do -- the four host-side behaviours are the ones vici cannot own, not the
   * ones we would spell differently.
   */
  handle(key) {
    const stepping = key === "<Tab>" || key === "<S-Tab>";
    if (stepping && this.ex === null && !this.leaderPending && this.editor.mode === NORMAL) {
      this.message = "";
      if (this.moveCell(key === "<Tab>" ? 1 : -1)) return this.render();
    }
    super.handle(key);
  }

  render() {
    if (!this.code) return; // called from the base constructor, before blocks exist
    const text = this.editor.text();
    const bytes = encoder.encode(text);
    const cursor = this.editor.cursor;
    const blocks = this.blocks;

    if (!blocks || blocks.length === 0) {
      super.render();
      return;
    }

    // The blocks are byte ranges from a possibly-stale parse; clamp them and
    // drop any that no longer fit, so a stale list degrades to less rendering
    // rather than to wrong text.
    this.code.textContent = "";
    let at = 0;
    let drewCursor = false;
    const slice = (from, to) => decoder.decode(bytes.subarray(from, to));

    // The whitespace between two blocks belongs to neither, and the cursor can
    // sit in it -- on the blank line between two paragraphs. It is drawn as
    // plain text, with the caret in it when that is where the caret is.
    const gap = (from, to) => {
      if (to <= from) return;
      const text = slice(from, to);
      if (!drewCursor && cursor >= from && cursor < to) {
        const span = document.createElement("span");
        this.drawText(span, text, cursor - from);
        this.code.append(span);
        drewCursor = true;
      } else {
        this.code.append(document.createTextNode(text));
      }
    };

    const draw = (into, text, offset) => this.drawText(into, text, offset);

    for (const block of blocks) {
      const start = Math.min(block.start, bytes.length);
      const end = Math.min(block.end, bytes.length);
      if (end <= start || start < at) continue;
      gap(at, start);
      const text = slice(start, end);
      const inBlock = !drewCursor && cursor >= start && cursor <= end;
      // A table draws itself even while the caret is in it. If it declined to
      // hold the caret it cannot be used, or the caret would vanish -- so the
      // ordinary raw path takes over, which is also what a stale block range
      // and a half-typed row land on.
      const table =
        block.type === "pipe_table" ? renderTable(text, inBlock ? cursor - start : null, draw) : null;
      if (table !== null && (!inBlock || table.drewCursor)) {
        this.code.append(table.node);
        if (table.drewCursor) drewCursor = true;
      } else if (inBlock) {
        const span = document.createElement("span");
        span.className = "md-block-raw";
        this.drawText(span, text, cursor - start);
        this.code.append(span);
        drewCursor = true;
      } else {
        this.code.append(renderBlock({ type: block.type, text }));
      }
      at = end;
    }
    gap(at, bytes.length);
    // A cursor past everything the stale block list covers still has to be
    // drawn, or the caret vanishes until the next parse lands.
    if (!drewCursor) this.code.append(this.caret(" "));
    this.drawStatus();
  }

  /**
   * `dispatch`, not `handle`: the base class renders once at the end of
   * `handle`, so patching the block ranges here means that single render
   * already sees them shifted. Overriding `handle` instead would draw the
   * document twice on every keystroke that changed it.
   */
  dispatch(key) {
    const before = this.editor.text();
    super.dispatch(key);
    const after = this.editor.text();
    if (after === before) return;
    this.patch(before, after);
    this.scheduleReparse();
    this.options.onChange?.(after);
  }

  /** A whole-buffer replacement invalidates every cached range. */
  replaceAll(text) {
    this.blocks = null;
    this.guests = [];
    super.replaceAll(text);
    this.scheduleReparse(0);
  }

  /**
   * Shift cached block ranges by an edit's size delta.
   *
   * The edited block is the one holding the cursor, so it absorbs the delta and
   * every later block slides. Blocks before it are untouched, and their text is
   * unchanged, which is what makes rendering them from the cache correct rather
   * than merely fast.
   */
  patch(before, after) {
    if (!this.blocks) return;
    const delta = encoder.encode(after).length - encoder.encode(before).length;
    if (delta === 0) return;
    const cursor = this.editor.cursor;
    shift(this.blocks, delta, cursor);
    shift(this.guests, delta, cursor);
  }
}

async function main() {
  const host = document.getElementById("editor");
  const saved = sessionStorage.getItem(SESSION_KEY);
  const editor = new MarkdownEditor(host, {
    language: "markdown",
    text: saved ?? STARTER,
    indent: 2,
    lineComment: null,
    format: async (text) => {
      const { formatText } = await import("./lang.js");
      return formatText(text, "markdown", 80);
    },
    onWrite: (text) => sessionStorage.setItem(SESSION_KEY, text),
  });
  editor.focus();
}

main();
