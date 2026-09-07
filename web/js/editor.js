// The editor component: vici's editing core with a view, an ex line, and the
// four host-side behaviours vici deliberately does not own.
//
// vici is headless. It gives us modes, motions, operators, counts, text
// objects, visual mode, undo, dot-repeat, macros and marks, and it stops
// exactly where a host has to make a policy decision. Four things are
// therefore ours, and each is here because vici cannot do it rather than
// because it forgot to:
//
//   * `:` emits `{ type: 'prompt' }` and stops -- the whole ex line is the
//     host's, so `:w` is ours to define.
//   * Bindings are plain data with no closures, so `<leader>F` cannot be a
//     vici binding that calls our formatter. The host intercepts the sequence
//     before `handleKey` sees it.
//   * `setIndent` drives `>>` and `<<` only. Autoindent and autocomment on
//     `<CR>`, `o` and `O` do not exist in vici, and are written here from the
//     language's indent width and comment marker.
//   * A view. `handleKey` returns effects; drawing them is the host's job.
//
// The whole component is one class with a small surface, because it has two
// hosts -- the discrepancy app and the markdown surface -- and anything either
// of them needs from it should be visible in one place.

import { Editor, keyText } from "../vendor/vici/index.js";
import { NORMAL, INSERT, REPLACE, VISUAL, VISUAL_LINE } from "../vendor/vici/index.js";
import { keyOf, continuation, sliceToByte } from "./host.js";

export { keyOf, continuation };

const MODE_NAME = new Map([
  [NORMAL, ""],
  [INSERT, "-- INSERT --"],
  [REPLACE, "-- REPLACE --"],
  [VISUAL, "-- VISUAL --"],
  [VISUAL_LINE, "-- VISUAL LINE --"],
]);

export class VimEditor {
  /**
   * @param {HTMLElement} host container to build the view in
   * @param {object} options
   * @param {string} [options.text]
   * @param {string} [options.language]
   * @param {number} [options.indent]
   * @param {string|null} [options.lineComment]
   * @param {(text: string) => Promise<string>|string} [options.format] what `:w` and `<leader>F` run
   * @param {(text: string) => void} [options.onWrite] called after a successful `:w`
   * @param {(text: string) => void} [options.onChange] called whenever the buffer changes
   * @param {string} [options.leader]
   */
  constructor(host, options = {}) {
    this.options = { indent: 4, lineComment: null, leader: "\\", ...options };
    this.editor = new Editor(options.text ?? "");
    this.editor.setIndent({ shiftWidth: this.options.indent, tabWidth: 8, useTabs: false });
    this.language = options.language ?? null;
    /** Non-null while the ex line is open; holds what has been typed after the `:`. */
    this.ex = null;
    /** True while a leader sequence is half-typed. */
    this.leaderPending = false;
    /** True while `#feed` is replaying keys, so autoindent cannot recurse. */
    this.replaying = false;
    this.message = "";
    this.build(host);
    this.render();
  }

  // -- view ------------------------------------------------------------

  build(host) {
    host.classList.add("vici");
    host.innerHTML =
      '<div class="vici-view" tabindex="0" role="textbox" aria-multiline="true">' +
      '<pre class="vici-code"></pre></div>' +
      '<div class="vici-status"><span class="vici-mode"></span>' +
      '<span class="vici-message"></span><span class="vici-ex"></span>' +
      '<span class="vici-pending"></span></div>';
    this.view = host.querySelector(".vici-view");
    this.code = host.querySelector(".vici-code");
    this.modeEl = host.querySelector(".vici-mode");
    this.messageEl = host.querySelector(".vici-message");
    this.exEl = host.querySelector(".vici-ex");
    this.pendingEl = host.querySelector(".vici-pending");
    this.view.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.view.addEventListener("mousedown", () => this.view.focus());
  }

  focus() {
    this.view.focus();
  }

  /** The block cursor, covering one character. */
  caret(under) {
    const node = document.createElement("span");
    node.className = "vici-cursor";
    node.textContent = under;
    this.cursorEl = node;
    return node;
  }

  /**
   * Append `text` to `into`, drawing the block cursor at `cursorByte` if the
   * cursor falls inside this run.
   *
   * Split into its own method because the markdown surface draws the same run
   * of text inside a per-block wrapper, and a second copy of the byte-offset
   * arithmetic is exactly the kind of thing that drifts.
   */
  drawText(into, text, cursorByte = null) {
    if (cursorByte === null) {
      into.append(document.createTextNode(text));
      return;
    }
    const before = sliceToByte(text, cursorByte);
    const rest = text.slice(before.length);
    // The character *under* the cursor, which is what a block cursor covers.
    // At end of text, and on an empty line, there is none -- draw a space, so
    // the block still has something to be.
    const atBreak = rest === "" || rest.startsWith("\n");
    const under = atBreak ? " " : [...rest][0];
    if (before) into.append(document.createTextNode(before));
    into.append(this.caret(under));
    const after = atBreak ? rest : rest.slice(under.length);
    if (after) into.append(document.createTextNode(after));
  }

  drawStatus() {
    this.modeEl.textContent = MODE_NAME.get(this.editor.mode) ?? "";
    this.messageEl.textContent = this.message;
    this.exEl.textContent = this.ex === null ? "" : `:${this.ex}`;
    this.pendingEl.textContent = this.editor
      .pendingKeys()
      .map((k) => (k === " " ? "<Space>" : k))
      .join("");
    this.cursorEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  render() {
    this.code.textContent = "";
    this.drawText(this.code, this.editor.text(), this.editor.cursor);
    this.drawStatus();
  }

  // -- input -----------------------------------------------------------

  onKeyDown(event) {
    const key = keyOf(event);
    if (key === null) return;
    // A browser shortcut the page has no business eating. Ctrl-r is vici's
    // redo and is claimed; the rest of the ctrl range that browsers use for
    // navigation is left to the browser on purpose.
    if ((event.metaKey || event.altKey) && key.length === 1) return;
    event.preventDefault();
    this.handle(key);
  }

  /** Feed one key, in vici's spelling. Also the entry point for tests. */
  handle(key) {
    this.message = "";
    if (this.ex !== null) return this.exKey(key);
    if (this.leaderPending) return this.leaderKey(key);
    if (key === this.options.leader && this.editor.mode === NORMAL) {
      this.leaderPending = true;
      return this.render();
    }
    this.dispatch(key);
    this.render();
  }

  /** `handleKey` plus the host-side behaviours its effects imply. */
  dispatch(key) {
    const wasInsert = this.editor.mode === INSERT;
    const effects = this.editor.handleKey(key);
    for (const effect of effects) {
      if (effect.type === "prompt") {
        this.ex = "";
      } else if (effect.type === "edit" && (wasInsert || this.editor.mode === INSERT)) {
        this.autoIndent(effect.edit);
      }
    }
  }

  /**
   * Continue the previous line's indentation and comment marker into a line
   * an edit has just opened.
   *
   * `newEndPoint.row > startPoint.row` is the signal: an insert-mode edit that
   * added a row is a `<CR>`, an `o` or an `O`, and nothing else. Indentation is
   * fed as keys rather than written into the buffer so that it is part of the
   * insert session's undo group and part of what `.` replays -- which is what
   * vim does, and the reason `o` followed by `.` indents twice rather than once.
   */
  autoIndent(edit) {
    if (this.replaying) return;
    if (edit.newEndPoint.row <= edit.startPoint.row) return;
    const text = this.editor.text();
    const before = sliceToByte(text, this.editor.cursor);
    const start = before.lastIndexOf("\n");
    if (before.slice(start + 1) !== "") return; // not at a fresh line's start
    const previous = before.slice(0, start);
    const line = previous.slice(previous.lastIndexOf("\n") + 1);
    const prefix = continuation(line, {
      indent: this.options.indent,
      lineComment: this.options.lineComment,
    });
    if (prefix === "") return;
    this.replaying = true;
    try {
      for (const ch of prefix) this.editor.handleKey(ch === "\t" ? "<Tab>" : ch);
    } finally {
      this.replaying = false;
    }
  }

  leaderKey(key) {
    this.leaderPending = false;
    if (key === "F") {
      this.runFormat();
    } else if (key !== "<Esc>") {
      this.message = `no mapping for ${this.options.leader}${keyText(key) ?? key}`;
    }
    this.render();
  }

  // -- the ex line -----------------------------------------------------

  exKey(key) {
    if (key === "<Esc>") {
      this.ex = null;
    } else if (key === "<CR>") {
      const line = this.ex;
      this.ex = null;
      this.runEx(line.trim());
    } else if (key === "<BS>") {
      if (this.ex === "") this.ex = null;
      else this.ex = this.ex.slice(0, -1);
    } else if (key.length === 1) {
      this.ex += key;
    }
    this.render();
  }

  /**
   * The ex commands this host defines. Deliberately four, not an ex parser:
   * anything beyond these belongs in vici or in the app, and a half-built ex
   * language is the kind of thing that quietly becomes the product.
   */
  runEx(line) {
    if (line === "w" || line === "write") return this.runFormat({ write: true });
    if (line === "q" || line === "q!") {
      this.message = "nothing to quit -- this editor is the page";
      return this.render();
    }
    if (/^\d+$/.test(line)) {
      const buffer = this.editor.buffer;
      const row = Math.min(Math.max(Number(line) - 1, 0), buffer.rowCount - 1);
      this.editor.jumpTo(buffer.rowStart(row));
      return this.render();
    }
    this.message = line === "" ? "" : `not an editor command: ${line}`;
    this.render();
  }

  // -- formatting ------------------------------------------------------

  /**
   * Run the host's formatter over the buffer and put the result back.
   *
   * Both `<leader>F` and `:w` land here; `write` only decides whether
   * `onWrite` fires, because "save" in this app means "format and keep",
   * and a save that skipped the format would be a different feature.
   *
   * The cursor is restored by row and column rather than by offset. A
   * reformat moves every byte after the first change, so an offset is
   * meaningless afterwards, while a row survives all but the rewrapping ones.
   */
  async runFormat({ write = false } = {}) {
    const format = this.options.format;
    if (!format) {
      this.message = "no formatter attached";
      return this.render();
    }
    const before = this.editor.text();
    const { row, col } = this.editor.cursorPoint();
    this.message = "formatting…";
    this.render();
    let after;
    try {
      after = await format(before);
    } catch (error) {
      this.message = error?.message ?? String(error);
      return this.render();
    }
    if (after !== before) {
      this.replaceAll(after);
      const buffer = this.editor.buffer;
      const target = Math.min(row, buffer.rowCount - 1);
      const start = buffer.rowStart(target);
      this.editor.jumpTo(Math.min(start + col, buffer.rowContentEnd(target)));
      this.options.onChange?.(after);
    }
    this.message = write
      ? after === before
        ? "written (no change)"
        : "written"
      : after === before
        ? "already formatted"
        : "formatted";
    if (write) this.options.onWrite?.(after);
    this.render();
  }

  // -- host access -----------------------------------------------------

  text() {
    return this.editor.text();
  }

  /**
   * Replace the whole buffer. The one seam a subclass needs, because a
   * wholesale replacement invalidates anything cached about the old text --
   * which is exactly what the markdown surface caches.
   */
  replaceAll(text) {
    this.editor.setText(text);
  }

  setText(text) {
    this.replaceAll(text);
    this.message = "";
    this.ex = null;
    this.render();
  }

  /** The cursor's byte offset -- what the markdown surface asks the tree about. */
  get cursor() {
    return this.editor.cursor;
  }
}
