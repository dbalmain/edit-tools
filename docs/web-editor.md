# The web editor, the discrepancy app, and the markdown surface

**Status: specified, not started.** Parked 2026-09-06 in favour of finishing the
parse layer for all sixteen tree-sitter languages, which question 1 below shows
is a hard dependency of the interesting version of this.

Three deliverables, in the order Dave asked for them. Each depends on the one
before it.

## The request, verbatim

> Create a web-based editor component. It should use vici for vim keybindings
> with `<leader> F` for formatting. It should have autoindent, autocomment and
> audoformat on "save" (`:w`). Save can simply save the file to the session.
>
> At the same time I want a small web-app that shows me all the discrepancies in
> formatting. I want to see the code in the editor on the left so I can make
> small changes and the correctly formatted code on the right, not in an editor.
> The correctly formatted code on the right shouldn't ever change and there
> should be a refresh button to return the code in the editor to the original
> code. Each language should have it's own page. The main page should be like a
> dashboard that lists the languages and the discrepancy count in each language.
>
> Once all of that is built, I'd like a stackedit.io alternative extending the
> above editor component. Rather than being a split-pane view, I want a single
> pane view where I can edit the markdown directly. If I'm in edit mode, I see
> the current component as markdown, but everything else is formated. i.e.
> headers are headers, lists are lists, etc.

## What the survey established

Facts from reading the two repos, not guesses.

**The formatter ships no parser.** `runtime-js/bundle.js` exports
`format(tree, packages, width)` and takes a `*.tree.json`, so *any* surface that
reformats text a human just typed needs a parse of that text from somewhere.
This is the whole reason the parse layer blocks this work.

**vici gives us the host seams we need, and no more.**

- `:` emits `{ type: 'prompt' }` and stops — the host owns the entire ex command
  line, so `:w` is ours to implement (`js/src/editor.js:610`).
- Bindings are plain data with no closures (`Keymap.bind(layer, spec, binding)`,
  six `B_*` kinds), so **`<leader>F` cannot be bound inside vici** to call our
  formatter. The host intercepts the sequence before `handleKey`.
- Indentation policy is host-supplied — `setIndent({ shiftWidth, tabWidth,
  useTabs })` — but it only drives `>>` and `<<`. **Autoindent and autocomment
  on `o`/`O`/`<CR>` do not exist in vici** and are ours to write in the host,
  from the language package.
- The JS core is `@dbalmain/vici` at `~/w/vici/js`, ESM, `Editor` +
  `handleKey(key) -> Effect[]`.

**The discrepancy data already exists.** `harness/formatter_divergence.py`
defines `FormatterDivergence{language, file, width, our_output,
reference_output, unified_diff, hash}`, and
`harness/reviews/formatter/*.jsonl` holds 142 reviewed records across 14
languages — yaml 20, typescript 17, rust 16, ruby 15, javascript 13, css 12,
scheme 12, html 9, markdown 9, toml 7, go 4, python 4, haskell 3, kotlin 1.
That is the dashboard's number and the per-language page's list.

**There is already a generated review surface.** `harness/review_page.py`
writes `review.html` (378 KB, self-contained, regenerated never edited). The new
app is not a replacement for it: that page is a *frozen* view for approving
divergences, this one is a *live* probe for fixing them. Keep both, and keep the
new one out of `review_page.py`'s way.

## Open questions

Three. Each was going to be asked before any code was written; they are recorded
here with their options so the answer does not have to be reconstructed.

### Q1 — Where does parsing happen?

The formatter needs a tree. The C3 parse layer covers **4 of 16** grammars
today (json, scheme, go, toml).

| Option | Buys | Costs |
| --- | --- | --- |
| **Local dev server, swappable** *(recommended)* | All 16 languages work on day one. A small Python server holds live tree-sitter parsers and answers `POST /parse` with tree JSON; the browser runs the real `runtime-js` formatter on it. One `parse(text, lang)` interface, resolved per grammar to in-browser `ts_lr.mjs` as each is transcoded. | Needs a `./serve.sh` running; not a static page. |
| **Browser only** | No server, deploys as a static page, exercises the C3 layer as the product. | 4 languages — 26 of the 142 divergences — until the other 12 grammars are transcoded. |
| **Server does everything** | Simplest to write: server parses *and* shells to `./fmt-js`. | The formatter stops running in the browser, so the editor component cannot format offline and the eventual in-browser path is never exercised. |

**The one fact that changes the recommendation:** whether this must deploy as a
static page with no local process. If it must, it is option 2 and the parse
layer's coverage is the app's coverage.

### Q2 — What does the left editor hold on load?

| Option | Buys | Costs |
| --- | --- | --- |
| **The original source** *(recommended)* | `:w` becomes the probe: edit `corpus/src/<lang>/<file>`, save, our formatter rewrites the buffer, and the difference from the frozen right pane *is* the divergence. Shorten a line, save, see whether we still disagree. | The divergence is not visible until the first `:w`. |
| **Our formatter's output** | The divergence is visible on load with no keystroke. | `:w` then only re-formats our own output, which tests idempotence rather than showing *why* we diverge. |
| **Both, with a toggle** | Covers both workflows. | More UI, and "refresh" acquires two meanings. |

In all three, the right pane is the **reference formatter's** output (black,
prettier, rustfmt, …), frozen, never re-rendered — that is what "correctly
formatted" means here, and what the refresh button restores the left pane
against.

### Q3 — In the markdown surface, what is "the current component"?

| Option | Buys | Costs |
| --- | --- | --- |
| **The block under the cursor** *(recommended)* | A paragraph, heading, list item, fence or blockquote goes raw as a whole; everything else stays styled. Matches Obsidian and Typora, and a block is whole lines, which keeps vici's linewise motions honest. | A long paragraph reveals all its markers at once. |
| **The line under the cursor** | Finer grained, simplest to compute. | A wrapped paragraph shows half raw and half styled, and a fence's delimiters render separately from its body. |
| **The inline span under the cursor** | Closest to true WYSIWYG. | Hardest to keep byte offsets stable under vici's motions; `w` and `b` start crossing hidden characters. |

## Decided without asking

- **Vanilla ES modules, no build step and no framework**, matching
  `runtime-js`'s existing shape. The editor is one module importable by both
  apps.
- **The editor is a component, not app code** — the discrepancy app and the
  markdown surface are two hosts of the same module.
- **`:w` saves to the session** (in-memory + `sessionStorage`), per the request;
  nothing writes to disk.
- **The dashboard counts every divergence a fresh score run finds**, with the
  approved house-style ones filterable rather than hidden — an approved
  divergence is deliberate, not absent.

## See also

- `docs/parse-layer.md` — why the parser is the dependency, and route C3.
- `harness/review_page.py` — the existing frozen review surface.
- `~/w/vici/js` — the editing core, and `FEATURES.txt` for what is bound.
