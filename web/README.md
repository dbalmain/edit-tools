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
- `data/divergences/<lang>.json` -- both texts, the diff and the ledger verdict
- `data/blobs/<lang>.blob.json` -- transcoded parse tables, 6 KB to 7.3 MB
- `data/packages/<lang>.json` -- the formatting packages, copied
- `vendor/vici/` -- the editing core, copied from `~/w/vici/js/src`
- `vendor/ts_*.mjs` -- the parse layer, copied from `harness/`
- `vendor/runtime.mjs` -- `runtime-js/bundle.js` with its one CommonJS export
  line rewritten as ESM. Otherwise byte-identical, so the browser runs the same
  formatter the scorer does.

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
