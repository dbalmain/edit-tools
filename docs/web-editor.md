# The web editor, the discrepancy app, and the markdown surface

**Status: all four questions answered 2026-09-07; built.** Parked
2026-09-06 in favour of finishing the parse layer for all sixteen tree-sitter
languages, which question 1 below shows is a hard dependency of the interesting
version of this. That finished 2026-09-07 -- `./harness/ts_check_all.py`
reports 16/16 byte-identical, markdown included, splices and all. Q2, Q3 and Q4
were answered by Dave; Q1 was settled by measuring the two things it turned on.
The answers are recorded in place under each question, with the reasoning that
produced them left standing.

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

Q1 to Q3 were the questions the survey raised. Q4 is Dave's, and arrived after
the first build shipped -- it is here rather than in a changelog because it
changed what the parse layer does.

Three. Each was going to be asked before any code was written; they are recorded
here with their options so the answer does not have to be reconstructed.

### Q1 — Where does parsing happen?

The formatter needs a tree. The C3 parse layer covered **4 of 16** grammars
when this was written (json, scheme, go, toml). **It now covers 16 of 16**,
every one byte-identical against real tree-sitter on the clean corpus and on
the broken one, in both runtimes. The table below is kept as written; the
revision follows it.

| Option | Buys | Costs |
| --- | --- | --- |
| **Local dev server, swappable** *(recommended)* | All 16 languages work on day one. A small Python server holds live tree-sitter parsers and answers `POST /parse` with tree JSON; the browser runs the real `runtime-js` formatter on it. One `parse(text, lang)` interface, resolved per grammar to in-browser `ts_lr.mjs` as each is transcoded. | Needs a `./serve.sh` running; not a static page. |
| **Browser only** | No server, deploys as a static page, exercises the C3 layer as the product. | 4 languages — 26 of the 142 divergences — until the other 12 grammars are transcoded. |
| **Server does everything** | Simplest to write: server parses *and* shells to `./fmt-js`. | The formatter stops running in the browser, so the editor component cannot format offline and the eventual in-browser path is never exercised. |

**The one fact that changes the recommendation:** whether this must deploy as a
static page with no local process. If it must, it is option 2 and the parse
layer's coverage is the app's coverage.

#### Revised 2026-09-07: the recommendation flips to option 2

The whole cost of "browser only" was coverage -- 4 languages and 26 of the 142
divergences. **That cost is now zero.** All sixteen grammars transcode, and
`ts_lr.mjs` parses every one of them byte-identically, so the browser can
answer `parse(text, lang)` for the entire corpus with no server at all.

What option 2 buys, now that it is free: the app deploys as a static page,
`:w` works offline, and the C3 parse layer is exercised *as the product*
rather than as a test harness -- which is the strongest evidence anyone can
generate for it. Option 1's swappable interface was scaffolding for a
migration that no longer has anything left to migrate.

**Two things to check before committing to it**, neither of which is known:

1. **Blob size in a browser.** The sixteen blobs were measured for the runtime
   argument, not for a page load; haskell's tables and its 3,102-interval
   unicode class file are the outliers. Lazy-load per language is the obvious
   answer, but it has not been priced.
2. **Wall-clock to parse a corpus file in `ts_lr.mjs`.** Never measured, and it
   is a per-keystroke cost if `:w` reformats. If it is slow, a worker or a
   debounce is the fix, not a server.

**The one fact that would change it back:** if the parse of a realistic file
takes long enough to be felt on `:w`, option 1's server buys native
tree-sitter speed and the browser path becomes a later optimisation.

#### Answered 2026-09-07: option 2, and both unknowns are now measured

Neither unknown was left as a judgement call. Both were measured before
committing, because both were the reason not to commit.

**Blob size.** All sixteen blobs, raw and gzipped:

| Language | Raw | gzip -9 | | Language | Raw | gzip -9 |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| json | 6.6 KB | 1.5 KB | | markdown | 469 KB | 50 KB |
| html | 30 KB | 12 KB | | javascript | 594 KB | 48 KB |
| toml | 30 KB | 5.0 KB | | python | 790 KB | 63 KB |
| xml | 72 KB | 15 KB | | rust | 1.95 MB | 120 KB |
| scheme | 88 KB | 8.9 KB | | typescript | 2.05 MB | 137 KB |
| css | 121 KB | 18 KB | | ruby | 3.16 MB | 182 KB |
| yaml | 272 KB | 34 KB | | haskell | 5.62 MB | 326 KB |
| go | 373 KB | 36 KB | | kotlin | 7.27 MB | 339 KB |

**The predicted outlier was wrong.** haskell was expected to top the table on
the strength of its 3,102-interval unicode class file; kotlin beats it, at
7.27 MB raw, with no external unicode data at all. The unicode file is not
what drives blob size -- the LR tables are.

Raw totals 22.9 MB, which is why blobs are **generated and gitignored, not
committed**. Gzipped they total 1.4 MB, and the number that matters is not the
total but the **worst single page load, 339 KB gzipped**, because each page
loads exactly one language. That is an ordinary bundle, so lazy-load per
language is sufficient and no further work is needed.

**Parse wall-clock**, `harness/ts_lr.mjs` under node, median of 5 after a warm
run, on real files rather than the ~600-byte corpus ones:

| File | Language | Bytes | Blob parse | Parse | Rate |
| --- | --- | ---: | ---: | ---: | ---: |
| `harness/ts_lr.mjs` | javascript | 90,882 | 5 ms | 61 ms | 1.45 MB/s |
| `runtime-js/bundle.js` | javascript | 59,842 | 5 ms | 61 ms | 0.96 MB/s |
| `harness/ts_transcode.py` | python | 45,733 | 6 ms | 55 ms | 0.81 MB/s |
| `rust/src/eval.rs` | rust | 116,908 | 16 ms | 111 ms | 1.03 MB/s |
| `rust/src/pkg.rs` | rust | 40,828 | 12 ms | 39 ms | 1.03 MB/s |
| `docs/parse-all-languages.md` | markdown | 41,459 | 4 ms | 81 ms | 0.50 MB/s |

Roughly **1 MB/s**, and flat across languages within a factor of three. Two
consequences, and they point the same way:

* A corpus file is ~600 bytes, so the discrepancy app's parse is **under a
  millisecond**. Its performance question does not exist.
* A 40 KB markdown document costs **81 ms**, and that is on `:w`, not on a
  keystroke. Felt, but not in the way that would buy a server: the fix, if it
  ever becomes one, is a worker or a debounce.

> **Corrected, 19 September.** The 81 ms was the block parse. A2.0 then put
> secondary attachment on the same `parse()` the markdown surface runs 150 ms
> after typing quiet, which on `docs/onboarding/FINDINGS.md` added **354 ms
> median / 399 ms max**. Nothing read the result, so attachment is now
> opt-in (`?secondaries=1` or `{ secondaries: true }`), default off. The
> 81 ms figure is the default path again. See `web/README.md`.

So the fact that would have flipped it back did not occur, and **the answer is
option 2**. Both figures were measured on this machine on 2026-09-07, by
`ts_check_all.py --keep` for the sizes and a five-run harness around
`parse(blob, bytes)` for the times.

### Q2 — What does the left editor hold on load?

**Answered 2026-09-07: our formatter's output (option 2).** Dave: *"The editor
on the left holds the original source already formatted by our formatter. I
want to be able to scroll through the entries and see the differences. In most
cases, I'm not going to enter the editor at all."*

That is exactly the fact the option-1 recommendation named as the thing that
would change it: the page is read far more often than it is edited, so the
divergence has to be on screen with no keystroke. The edit-save-compare loop
survives anyway -- `:w` reformats the buffer in place, and refresh restores the
left pane to our formatter's output rather than to the raw source.

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

**Answered 2026-09-07: the block under the cursor (option 1), resolved through
tree-sitter.** Dave: *"The current component means the current line component.
The treesitter parser should be used to determine this. I assume markdown has a
series of root-level components or objects which are trees themselves.
Hopefully, if we choose that method of identifying the component, we can adjust
once I start to play around with it."*

The assumption is nearly right and the correction matters. `document`'s
children are **not** the blocks: `tree-sitter-markdown`'s block grammar nests
`section` nodes by heading level, so this file's root has one `section`, and
that section has an `atx_heading`, two `paragraph`s and five nested `section`s.
Taking "the child of the root containing the cursor" would put the whole
document in raw mode.

The rule that does work is one line anyway: **descend from the root, taking
the child that contains the cursor's byte offset, while that child is a
container** -- `document` or `section` -- **and stop at the first one that is
not.** That lands on the `paragraph`, `atx_heading`, `list`,
`fenced_code_block`, `block_quote`, `table` or `html_block` the cursor is in.

The knob Dave wants is then just where that descent stops. Continuing one level
past a `list` narrows to the `list_item`; stopping earlier keeps a whole
section raw. It is a set of node types, so changing it is changing a list.

| Option | Buys | Costs |
| --- | --- | --- |
| **The block under the cursor** *(recommended)* | A paragraph, heading, list item, fence or blockquote goes raw as a whole; everything else stays styled. Matches Obsidian and Typora, and a block is whole lines, which keeps vici's linewise motions honest. | A long paragraph reveals all its markers at once. |
| **The line under the cursor** | Finer grained, simplest to compute. | A wrapped paragraph shows half raw and half styled, and a fence's delimiters render separately from its body. |
| **The inline span under the cursor** | Closest to true WYSIWYG. | Hardest to keep byte offsets stable under vici's motions; `w` and `b` start crossing hidden characters. |

### Q4 — Inside a fenced code block, which parser is running? (added 2026-09-07)

**Answered 2026-09-07 by Dave, unprompted:** *"When I enter a code block, it
should be as if I'm in a file of that language. So if the code block starts
with ` ```ruby `, everything I type after that should be parsed by the ruby
parser. Only when I exit the fenced region should it go back to parsing
Markdown."*

It arrived as a clarification of D6 on the parse-layer board, which had asked a
narrower question -- which oracle should judge markdown's port -- and none of
whose three options changed what the parse layer does. Dave's framing was the
better one, and answering it dissolved D6 rather than settling it.

The gap it exposed was real and unshipped: `web/` did a single markdown parse
with no injection pass, so `fences.md@80` formatted `{ }` where `fmt-rust`
produced `{}`, and `kitchen.md@80` left a 27-element array on one line where
`fmt-rust` broke it. The browser disagreed with the scorer on every markdown
file containing code.

**What it cost was 120 lines, because this is not tree-sitter's included
ranges.** Upstream's injection machinery re-runs the parser over disjoint
ranges of one buffer, which the table interpreter has no entry point for -- but
`harness/injection.py` never used it either. It slices the region's bytes,
parses that slice as a standalone document, and rebases every offset by a
constant, and `ts_lr.mjs` already does both halves. Verified before writing
anything: slicing `fences.md`'s json region, reparsing it and adding 707 to
every offset reproduces the frozen spliced subtree byte for byte.

So `harness/ts_inject.mjs` is that pass, shared by the harness check and the
browser. Three consequences, all measured in headless chromium:

- `formatText` on `fences.md` and `kitchen.md` at width 80 now equals
  `fmt-rust`, which it did not before.
- `treeLanguages` of a document with a json fence and a ruby fence returns
  `markdown, json, ruby`.
- The editor adopts the guest's rules **for the range the guest parser actually
  covered**, not for a range guessed from the info string. In a ` ```ruby `
  fence the status line says `ruby` and `<CR>` after `  # note` continues
  `  # `; on the prose line above it says `markdown` and continues nothing,
  which is markdown's correct answer since it has no line comment.

Innermost wins, so a json fence inside a markdown fence answers json. The fence
lines themselves stay markdown, which is right -- that is where the info string
is edited.

## Editing a table (2026-09-10)

Dave's, and the reason the previous three pieces of work happened at all:

> *"I think I want to be able to edit cells in the table. The way I picture this
> working is that we continue to use the current markdown tables up to 100
> characters and then switch to a different table format (either HTML or some
> other table plugin) when a table grows beyond that."*

**What was built is the first half. The second half was measured and is not
worth building** -- not as stated, and the measurement says why.

### The width is the content, so no format switch fixes it

The 100-column threshold assumes a wide table is wide because of how it is laid
out. Over 8,101 pipe tables in 8,444 markdown files under `~/w`:

| | tables |
| --- | ---: |
| wider than 100 columns | 3,860 |
| still wider than 100 with every pad byte removed | 3,601 |
| holding one cell that alone exceeds 100 characters | 1,535 |

Padding accounts for 259 of the 3,860, which is 7%. Switching format at 100
columns would fire on 48% of all tables and leave 93% of them just as wide, so
it is not an escape hatch -- it is a second default that does not help.

What does help is not changing the source at all. A `<table>` wraps its cells to
the pane at any width, and the browser has done that since 1996.

### So the raw region is the cell, not the block

The surface's one rule is "the block under the cursor is raw". A table is the
one block where that rule is wrong: rendering it is the whole point, and going
raw on entry hands the width straight back at the moment you want to edit.

`web/js/host.js` grew `tableSlots`, which is where the cells are:

- It reads the **block's text**, not the tree. The block's range is patched
  between parses but its interior is not, and the interior is exactly what is
  being typed in; the text is never stale.
- Slots **tile the row**. Every byte of a table row belongs to exactly one cell,
  pipes and padding included, because the caret has to be drawable wherever
  vici puts it. A cell owns the pipe on its left, so `0` and `f|` land inside a
  cell rather than in a gap between two. That totality is the property the unit
  tests assert, rather than a second copy of the offsets.
- It returns **null** when the text is not a table any more, which is what a
  half-typed row is. The caller then renders the block the ordinary way.

Nothing else moved. No opcode, no package field, no runtime change, no corpus
change -- the formatter still emits the same pipe table it always did, and `:w`
re-pads it. The grid is a view.

`<Tab>` and `<S-Tab>` step between cells and skip the delimiter row. Normal mode
only: vici binds `<Tab>` in insert mode, and the host's four behaviours are the
ones vici cannot own, not the ones we would spell differently.

### What is still open

Cells that need a newline or a block inside them are the part of Dave's request
that a pipe table genuinely cannot express, and no amount of rendering changes
that -- GFM has no syntax for it. That is an HTML table, and an HTML table in
this repo is an `html_block`, which step 3 made **opaque**: spliced for readers,
never laid out by the formatter. So the escape hatch is available and its cost
is known, which is the useful state for a question nobody has had to answer yet.

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
