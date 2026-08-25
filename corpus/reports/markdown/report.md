# Markdown package report (stage C)

```
gate 0 coverage         pass    (30/30)
gate 1 rust/js parity   pass    (30/30)
gate 2 idempotence      pass    (30/30)
gate 3 non-destruction  pass    (30/30)
gate 4 agreement        15/24 (9 accepted, 0 stale, 0 unreviewed, 0 package bug)
                                3 files excluded as incomparable vs prettier 3.9.6
overflow lines          51 (reference 48)
refusals                none
size                    package 899 B gzip; runtime 16042 B gzip; runtime delta
                        vs pre-markdown main +725 B
```

**This report was written after the package was merged to `main`, not before.**
That is the defect the board's new `C+` token now names. Read the "What the
reviewer is actually being asked" section before anything else.

## Result

Markdown is the sixteenth language and the first host to carry injected guests
that reflow. The package covers the block grammar, delegates paragraphs to
`verbatim` for `proseWrap=preserve`, reconstructs list markers and task markers,
and splits `fenced_code_block` into an injected branch and a verbatim branch.

Two runtime capabilities were added for it:

- **`prefix`** (FINDINGS 24, `ef97d01`, +300 B gzip) — consumes a selected child
  and indents the body by *that child's own source text*, so a host's per-line
  continuation marker survives onto lines the guest invents after the host has
  stopped looking. Three refusals: a marker carrying a comment, an interior
  node, and a marker spanning a line ending.
- **`gap_owner`** (FINDINGS 30, `3555eb2`, +425 B gzip) — a header field mapping
  a parent node type to the child types whose *following* source gap that parent
  owns. For a declared pair the gap is measured to the child's deepest non-empty
  descendant; every other consumer keeps the shipped one-terminator bound. The
  node's own **trailing** blank measure keeps the shallow bound unconditionally,
  which is the whole of what stops a node and its parent claiming the same
  newline.

`packages/json.json` also gained `comments: ["comment"]`, because a ```` ```json
```` fence in `comments.md` contains `//` comments and prettier's json parser
accepts JSONC. That field is inert on JSON-as-host: no JSON corpus file carries
a comment, and JSON is 6/6 unchanged.

Three files are excluded as incomparable, unchanged from stage B:
`emphasis.md`, `list_markers.md` and `thematic.md`. All three are FINDINGS 14
(`respell`) — prettier rewrites emphasis delimiters, bullet characters and
thematic breaks at token level. They participate in coverage, parity,
idempotence and non-destruction; only agreement excludes them.

## What the reviewer is actually being asked

The only markdown stage D on record is grok-4.6's at `e8cdf51`, verdict
**`blocked-correctly`**. Nine commits landed on `main` after it, all built by
Claude (Opus 5), and none has been reviewed by another family:

```
60680fe markdown: html_block does not swallow the blank after it
6e7cf8f findings: what stage D corrected, and the routes it closed
ef97d01 runtime: a host's per-line marker survives the guest's reflow      <- capability
2d7c7b5 markdown: the fence rule splits, and nesting.md stops destroying JSON
cbee4f5 findings 24: built, and the entry's own framing was the expensive part
4252a88 findings 30: capability 1 specified, and it is not the one approved
3555eb2 runtime: the package names which rule may spend a source gap       <- capability
d4e4f89 markdown: the list owns the gaps between its items, and lists.md agrees
0221a87 findings 30: closed, and both of its predictions were wrong
```

Two of those are new runtime capabilities on a shipped runtime. One ledger
record — `markdown/nesting.md@80` — is signed **`Claude (Opus 5), FINDINGS 24
build`**, which is the builder ruling on their own build and is exactly what
stage D exists to prevent. The other eight records are grok's and predate the
build; `lists.md@80` and `lists.md@40` were retired because the case now agrees.

## Divergences

Nine accepted, none a package bug. Eight carry grok-4.6's reasons from the
`blocked-correctly` review and are unchanged. The ninth is the builder-signed
one.

- `markdown/nesting.md@80` — **design limit**, *signed by the builder, needs
  re-ruling.* FINDINGS 24 is built and the host continuation now reaches every
  guest line; what remains is a separate cause the record states.
- `markdown/fences.md@80`, `@40` — **design limit** (grok-4.6). A blank before
  the closing fence of a nested markdown region; the host emits `hard` after an
  injected guest and the markdown guest's last fence already ended with one.
- `markdown/tables.md@80`, `@40` — **house rule** (grok-4.6). Dropped column
  padding, including right-align on `--:`.
- `markdown/kitchen.md@80`, `@40` — **house rule** (grok-4.6). The same pipe
  table as `tables.md`; every other hunk in the file matches.
- `markdown/normalisation.md@80`, `@40` — **house rule** (grok-4.6). `>  bar`
  keeps two spaces after the quote marker.

## Known leftovers, stated rather than hidden

- **`fences.md` is a third closer situation** the fence rule's `when` cannot
  see: guest language, last node already broke. One known leftover, not a table
  of one-offs.
- **The overflow count is 51 against the reference's 48.** Markdown's width
  sensitivity is almost entirely borrowed from its guests.
- **FINDINGS 14 blocks three of twenty-four files** from ever being comparable.
  Decided *build it* on 2026-08-17; still unbuilt.
