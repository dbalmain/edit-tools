# The web apps

Three things, sharing one editor component and one parse layer:

| Page | What it is |
| --- | --- |
| `index.html` | the dashboard: every language and its divergence count |
| `language.html?lang=NAME` | one language's divergences, ours on the left and the reference on the right |
| `markdown.html` | a single-pane markdown editor: the block under the cursor is raw, the rest renders -- except a table, where it is the cell |

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

## The inline grammar is a second table, fetched the same way

Markdown is parsed twice: once by the block grammar, which produces the tree the
formatter reads, and once by `markdown_inline` over each `inline` range, whose
roots are retained *beside* that tree rather than spliced into it. Nothing reads
the second parse yet -- it is the foundation the prose projection will check
candidate line breaks against. `docs/prose-projection.md` is where that goes.

One caveat, until it is fixed: nothing reads the second parse, but the second
parse can still *refuse*. A dirty inline range throws rather than being recorded
and skipped, so it can stop a document formatting that formatted before. That is
a known defect scheduled ahead of A2.1, and it is not what a fenced code block
does -- a guest language that will not parse leaves its fence verbatim and the
page formats normally.

It is a separate asset on purpose: `data/blobs/markdown_inline.blob.json` is
440 KB raw and 43 KB gzipped, against 50 KB gzipped for markdown's own block
table. Bundling the two would very nearly double what every markdown page loads,
to carry a grammar that page may never reach. Kept apart, `js/lang.js` asks for
it on the same terms as a guest table -- only once the document is known to hold
an `inline` node -- so a buffer that is empty, or is nothing but a fenced block,
never fetches it at all.

Which grammars exist and which host node each one reparses come from
`data/secondaries.json`, generated from the manifests, so shipping policy stays
configuration rather than a decision baked into the loader.

## A table is edited cell by cell

Every block goes raw whole when the cursor enters it. A table does not, and the
reason is the only reason to render one at all: markdown tables are wider than
the screen, and a table that reverted to source on entry would hand that width
back at the moment you wanted to edit it.

So a `pipe_table` is drawn as a real `<table>`, which the browser wraps to the
pane, and the **cell** under the cursor is what goes raw -- in monospace, with
its own pipe in front of it, so what you are editing is visibly source. The
delimiter row is the ruler rather than content, so it is drawn only while the
caret is in it.

`<Tab>` and `<S-Tab>` step between cells, skipping the delimiter row. They are
normal-mode only: vici binds `<Tab>` in insert mode to insert a tab, and this
host does not shadow the editing core's own bindings.

Nothing about the *file* changes. The buffer is still the pipe table you typed,
every vi motion still moves over the source, and `:w` re-pads it through the
same formatter the scorer runs. The grid is a view, not a format.

**Why not switch wide tables to HTML instead**, which is where this started:
because the width is the content. Of the 3,860 tables wider than 100 columns
under `~/w`, 3,601 are still wider than 100 with every pad byte removed, and
1,535 have a single cell that alone exceeds it. There is no layout the source
could adopt that would make those narrow, so a format switch at 100 columns
would fire on half of all tables and buy nothing that this does not.

## Keys

vim, from [vici](https://github.com/dbalmain/vici) -- motions, operators,
counts, text objects, visual mode, undo, dot-repeat, macros, marks, surround.
Four things are the host's rather than vici's, and `js/editor.js` says why; a
fifth, cell stepping, belongs to the markdown surface alone:

| Key | What it does |
| --- | --- |
| `:w` | format the buffer and save it to the session |
| `\F` | format without saving |
| `:123` | go to a line |
| `<Tab>`, `<S-Tab>` | in a table, step to the next or previous cell |
| `<CR>`, `o`, `O` | continue the previous line's indentation and comment marker |

Nothing writes to disk. `:w` saves to `sessionStorage`, and closing the tab
discards it.
