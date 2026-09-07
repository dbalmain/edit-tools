# The web apps

Three things, sharing one editor component and one parse layer:

| Page | What it is |
| --- | --- |
| `index.html` | the dashboard: every language and its divergence count |
| `language.html?lang=NAME` | one language's divergences, ours on the left and the reference on the right |
| `markdown.html` | a single-pane markdown editor: the block under the cursor is raw, the rest renders |

## Running it

```sh
./web/gen.py        # writes web/data/ and web/vendor/; takes a few minutes
./web/serve.sh      # http://localhost:8017/
```

`gen.py` is the only build step, and both directories it writes are
gitignored. `--skip-blobs` reuses the parse tables when only the divergence
data has changed, which is the common case.

<details>
<summary>fish</summary>

```fish
./web/gen.py --skip-blobs; and ./web/serve.sh
```

</details>

## Why it is static

The formatter ships no parser, so anything that reformats text a human just
typed needs a parse from somewhere. Until 2026-09-07 that meant a local parse
server, because the C3 parse layer covered 4 of 16 grammars. It covers all
sixteen now, so the browser answers `parse(text, lang)` for the whole corpus
and there is nothing for a server to do. See `docs/web-editor.md`, Q1.

Two measurements decided it, and both are recorded there: the worst single
page load is kotlin's parse table at 339 KB gzipped, and `ts_lr.mjs` parses at
roughly 1 MB/s -- sub-millisecond for a corpus file, 81 ms for a 40 KB
markdown document, on `:w` rather than per keystroke.

## What is generated

Everything under `web/data/` and `web/vendor/`. Nothing hand-written lives in
either, so deleting them is always safe.

- `data/languages.json` -- the registry the dashboard renders
- `data/injections.json` -- which node types hold an embedded region, and which
  info string routes to which guest grammar
- `data/divergences/<lang>.json` -- both texts, the diff and the ledger verdict
- `data/blobs/<lang>.blob.json` -- transcoded parse tables, 6 KB to 7.3 MB
- `data/packages/<lang>.json` -- the formatting packages, copied
- `vendor/vici/` -- the editing core, copied from `~/w/vici/js/src`
- `vendor/ts_*.mjs` -- the parse layer, copied from `harness/`
- `vendor/runtime.mjs` -- `runtime-js/bundle.js` with its one CommonJS export
  line rewritten as ESM. Otherwise byte-identical, so the browser runs the same
  formatter the scorer does.

## Inside a fenced code block, it is that language

A ` ```ruby ` block is parsed by the ruby parser, not held as opaque markdown
text. `js/lang.js` runs the same second pass `harness/injection.py` does --
slice the fence's content, parse it with the guest grammar, rebase every offset
and splice it in -- so a markdown buffer holding ruby holds a real ruby tree.

Two things follow, and both are visible:

- `:w` and `\F` **format the code inside the fence**, because the formatter is
  handed a tree that knows what the fence is. Without it, `web/` disagreed with
  `fmt-rust` on every markdown file with a code block.
- The editor **adopts the guest's rules while the cursor is in the region**.
  The status line names the language, `<CR>` continues ruby's `#` rather than
  markdown's nothing, and `>>` shifts by ruby's width. Leave the fence and it
  is markdown again, which is what the range the guest parser actually covered
  says -- not a guess from the info string.

Guest tables are fetched only when a document routes to them, so a markdown
page with no fences never pays for one.

## Keys

vim, from [vici](https://github.com/dbalmain/vici) -- motions, operators,
counts, text objects, visual mode, undo, dot-repeat, macros, marks, surround.
Four things are the host's rather than vici's, and `js/editor.js` says why:

| Key | What it does |
| --- | --- |
| `:w` | format the buffer and save it to the session |
| `\F` | format without saving |
| `:123` | go to a line |
| `<CR>`, `o`, `O` | continue the previous line's indentation and comment marker |

Nothing writes to disk. `:w` saves to `sessionStorage`, and closing the tab
discards it.
