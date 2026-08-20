# Markdown corpus report (stage A)

## Builder

**grok-4.6 via the grok CLI.**

## Manifest

`harness/languages/markdown.toml`. Every field that could have been guessed
was observed, not assumed.

| Field                  | Value                                                                                      | How it was established                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-markdown==0.5.1`                                                              | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_markdown` guess. `0.5.1` is the latest release and is the pin the injection fixture already used.                                                                                                                                            |
| `grammar_module`       | `tree_sitter_markdown`                                                                     | `uv run --with tree-sitter-markdown==0.5.1` then `import tree_sitter_markdown`. The hyphen-to-underscore swap is correct here.                                                                                                                                                                                         |
| `grammar_symbol`       | `language`                                                                                 | The module exports `language()` (block) and `inline_language()` (inline). Fences, `info_string` and `code_fence_content` live in the block tree, so the host selects `language()` — the same choice `docs/injection.md` recorded. `inline_language()` is unused: the harness has no included-range second pass.        |
| `injection_aliases`    | `["markdown", "md"]`                                                                       | `markdown` is canonical. `md` is the conventional fence spelling (GitHub linguist, prettier's support-info aliases). Both unique across manifests. `pandoc` is a different dialect; `mdx` is prettier's MDX parser, not this grammar.                                                                                  |
| `reference`            | `npx --yes prettier@3.9.6 --no-config --stdin-filepath x.md --print-width {width}`         | Source on stdin, formatted source on stdout. `--stdin-filepath` **is** required: without it and without `--parser`, prettier errors `No parser and no file path given`. `--parser markdown` is an alternative, not a second flag: parser-only, `x.md` and `x.markdown` are byte-identical on dirty input, so `--parser` is omitted. `--no-config` is load-bearing (below). |
| `reference_version`    | `3.9.6`                                                                                    | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Same pin as CSS/YAML/JavaScript; JSON is still on 3.6.2.                                                                                                                                                                                                 |
| `reference_width`      | `flag`                                                                                     | Ran the same input at 80 and 40 and diffed. Paragraphs, tables, list items and headings do **not** reflow (`proseWrap` defaults to `preserve`). Fenced JSON/JS and nested-markdown JSON do. `{width}` is therefore real, but only for embedded guests.                                                                |
| `widths`               | `[80, 40]`                                                                                 | 80 is prettier's own default (below). 40 is the narrow width at which a 27-ones JSON fence, a JS fence, and the same fence nested in a list actually split. 60 still leaves the 27-ones array flat.                                                                                                                    |
| `gate3`                | `default`                                                                                  | See below.                                                                                                                                                                                                                                                                                                             |
| `transparent_wrappers` | `[]`                                                                                       | Gate 3 accepted prettier on 30/30 comparable runs without naming a wrapper. Markdown has no parenthesised-expression node; parentheses in links are structural.                                                                                                                                                        |
| `equivalent_kinds`     | `[]`                                                                                       | Nothing was renamed.                                                                                                                                                                                                                                                                                                   |

`[[injections]]` is declared last, after every root key:

```toml
[[injections]]
node = "fenced_code_block"
info = "info_string"
content = "code_fence_content"
```

That is the shape the fixture already proved. YAML front matter is
`minus_metadata`, a true leaf with no info/content children, so the injection
schema cannot describe it. Kitchen carries a short, already-canonical YAML
front matter; a long flow collection inside it would be a leaf rewrite at one
width and fail gate 3.

### Default width is 80, by bisection

Three independent observations, not `--help` alone:

1. `prettier --help` says `--print-width` defaults to 80; `proseWrap` defaults
   to `preserve`.
2. Unprompted output (no `--print-width`) is byte-identical to
   `--print-width 80` on every probe, including fenced JSON.
3. A 26-ones JSON array in a fence (78 characters) stays flat unprompted. A
   27-ones array (81 characters) breaks unprompted and at `--print-width 80`,
   and stays flat at `--print-width 81`. So 80 is the line length at which the
   unprompted output starts breaking.

### `--no-config` is load-bearing

prettier walks cwd and ancestors for `.prettierrc` / `prettier.config.*` / a
`package.json` `"prettier"` key, and — because the command passes a filepath —
reads `.editorconfig` from that path. A planted config with `proseWrap:
"always"` and `tabWidth: 4` (options the command line does **not** name)
silently reflowed a long paragraph and reindented a nested list. A planted
`.editorconfig` with `indent_size = 8` reindented too. An ancestor
`.prettierrc` is enough; prettier does not stop at cwd.

CLI `--print-width` wins over a file `printWidth` under the default
`--config-precedence cli-override` (the taplo shape: the file fills every
option the CLI does not name). `--config-precedence file-override` lets the
file's `printWidth` win (checked). `--no-config` makes the planted config, the
ancestor config, and `.editorconfig` all inert.

Leftover channels the disable flag leaves open:

- An explicit `--config path` still applies. `--no-config` and `--config`
  together is an error (`Cannot use --no-config and --config together`).
- There is no `PRETTIER_CONFIG` env var. `PRETTIER_CONFIG=/tmp/x.json` plus
  `--no-config` was identical to the baseline.

`gen_reference.py --check` is silent (exit 0); two runs of the same stdin
match.

### Why not `gate3 = "markdown"`

There is no markdown data-model loader that would help. CommonMark ASTs
collapse exactly the spellings a formatter must preserve — emphasis
delimiters, list markers, thematic-break punctuation, fence info strings.
The generic named-node comparison is the right oracle. HTML comments are
`html_block` / anonymous tokens under `inline`, not extras, so the extras
layer is inert on the host (below); guest comments in a spliced JSON fence
are still checked by the guest grammar.

`check_gate3.py --language markdown`: 30 reference outputs accepted (3
incomparable files skip only that assertion), 24 destructive mutations
rejected, 262 useful adversarial mutations (arm inert — no override), 0
wrapper kinds, 11 injection cases checked.

### `[incomparable]`

Three dedicated files, one construct each. Kitchen is not among them.

| File              | Rewrite                                         | Why linearity forbids it                          |
| ----------------- | ----------------------------------------------- | ------------------------------------------------- |
| `emphasis.md`     | `*em*` → `_em_`                                 | Anonymous delimiter token                         |
| `list_markers.md` | `*` / `+` unordered markers → `-`               | Node kind `list_marker_star`/`plus` → `minus`     |
| `thematic.md`     | `***` / `___` / `* * *` → `---`                 | Leaf / anonymous-token spelling of the break      |

The same class, written in canonical form rather than excluded: `__strong__`
→ `**strong**` (kitchen uses `**`), `1)` → `1.` (lists use `.`), `'title'` →
`"title"` on link titles (corpus uses double quotes), `[X]` → `[x]` (lists
use `[x]`).

## Corpus

Fifteen files in `corpus/src/markdown/`. Each is valid markdown: clean under
tree-sitter-markdown 0.5.1 (no `ERROR` / `MISSING`) and accepted by prettier
3.9.6.

Required probes:

- `nesting.md` — lists in lists, deep enough that a JSON fence at two indent
  depths sees different remaining widths. Inner `{ "id": 1 }` objects stay
  flat when the parent array breaks. List-item fences splice; quoted ones
  do not (below).
- `long_sequences.md` — the construct that overflows: a 26-ones JSON array
  (78 chars, flat at both scored widths) next to a 27-ones array (81 chars,
  breaks at 80).
- `comments.md` — HTML comments in every position markdown allows: file-level,
  trailing on a heading, inline in a paragraph, trailing on a list item,
  own-line inside a list, trailing in a quote, own-line in a quote, between
  blocks, consecutive, end of file. Plus a JSON guest with a trailing comment
  and an own-line comment, so the extras layer has something to chew on.
- `strings.md` — code spans (including inner spaces and `` ` ``), backslash
  escapes, entities, a long unbreakable span.
- `normalisation.md` — extra spaces after `#`, extra spaces after `> ` on a
  marker that already has one, fence-info padding, dirty JSON, a run of
  blanks between headings. Empty JSON `{ }` lives in `fences.md`.
- `kitchen.md` — YAML front matter, heading, paragraph with emphasis/link/code,
  quoted list, padded table, task list, JSON fence, unlabelled fence, thematic
  break, reference definition.

Characteristic of markdown, one line each:

- `headings.md` — ATX 1–6, a seven-hash non-heading, setext h1 and h2.
- `lists.md` — tight and loose, nested, ordered (`1.` consecutive), task list
  including `[ ]` (the empty container with a space and no named children).
- `tables.md` — pipe tables already at prettier's padded alignment, empty
  cells, a ten-column table that does not wrap at either width.
- `blockquotes.md` — nested quotes and a quoted list. No fenced guests
  (quoted fences cannot splice; see findings).
- `fences.md` — the defining feature: routed JSON and JavaScript, `{ }`
  written with a space, no-info / unknown / broken-JSON verbatim fallbacks,
  nested `markdown` containing JSON.
- `links.md` — inline link, image, a long autolink that prettier will not
  wrap, a reference definition.

All fifteen files carry an HTML comment. `corpus_stats.py` still reports
**0/15** "carries a comment" because it counts named extras, and
tree-sitter-markdown has none — HTML comments are `html_block` or anonymous
tokens under `inline`. That is a finding about the stats probe, not a
corpus hole. Guest extras are present in `comments.md`'s JSON fence.

## Counts

From `./harness/corpus_stats.py --language markdown` (not a hand-rolled
`cmp`):

| Measure                         | Count                                      |
| ------------------------------- | ------------------------------------------ |
| Files                           | 15                                         |
| Incomparable                    | 3                                          |
| Reference changes at some width | **9/15** (`@80` 9/15, `@40` 9/15)          |
| Differs between the two widths  | **5/15** (exactly one third)               |
| Carries a named extra           | **0/15** (HTML comments are not extras)    |
| Reference overflow              | **`@80` 2, `@40` 49**                      |

The six files byte-identical input to output at every width are the ones
written in prettier's canonical form so gate 3 can see them:
`blockquotes`, `headings`, `links`, `lists`, `strings`, `tables`.
`normalisation.md` is the rewrite probe.

The five width-discriminating files are `comments`, `fences`, `kitchen`,
`long_sequences`, `nesting` — all via fenced JSON/JS. Paragraphs, tables,
list items and headings do not reflow at `proseWrap=preserve`, so the
"a third of files must differ" property is unreachable by those constructs
alone. This is the number, not a padded corpus.

### Reference overflow, broken out

prettier is allowed to overrun its own target, and it does.

**At 80, two line-runs:**

- `links.md` — a 137-character autolink. prettier never wraps URLs.
- `strings.md` — a 158-character code span. prettier never wraps code-span
  interiors.

**At 40, 49 line-runs.** Almost all of them are the same refusal: with
`proseWrap=preserve`, prettier will not wrap a paragraph, a heading, a list
item, an HTML comment, a table row, or a code span. The ten-column table in
`tables.md` is 61 characters wide at both widths. The 27-ones JSON array
*does* wrap at 40; the overflow that remains is prose and tables, not the
guest. A stage-C agent that sees a 76-character paragraph in the width-40
reference is looking at prettier's default, not a corpus bug.

## What prettier did that surprised me

**Prettier does not reflow markdown prose at its default.** `proseWrap`
defaults to `preserve`. A paragraph that exceeds 80 characters stays one
line at both scored widths; `--prose-wrap always` wraps it. That is why
width discrimination had to come from fenced JSON/JS, and why `fill` is not
forced by this corpus. Confirmed against prettier 3.9.6, not taken from
`docs/injection.md`.

**When a container breaks, inner containers that fit stay flat.** Construct:
six `{ "id": 1 }` objects in a JSON fence inside a list item. The parent
array explodes one object per line at both 80 and 40 (the list indent eats
remaining width). Each object stays `{ "id": 1 }` — it would fit with room
to spare, and prettier does not force it open. Four `{ "k": 1 }` objects in
a deeper list stay *flat as an array* at 80 and explode at 40; the objects
themselves stay flat either way. Markdown lists and quotes have no
flat-vs-broken choice of their own: they are always one item per line, one
`>` prefix per line.

**A trailing HTML comment does not count toward its line's width**, because
the line is not being measured for a wrap. Headings, list items and
paragraphs with `<!-- trailing -->` are identical at 80 and 40. A trailing
comment *inside a JSON guest* is a different story: prettier JSON treats it
as a BreakParent and explodes the array one item per line at both widths
(the first draft of `comments.md` did this and lost its width
discrimination). That is the guest's rule, not markdown's.

**Token-level normalisation**, as opposed to line level:

- `#    Title` → `# Title` (gap between `atx_h1_marker` and `inline`; gate 3
  accepts).
- Extra spaces after an already-spaced `> ` marker collapse (`>  bar` →
  `> bar`).
- Fence info ` ```   json` → ` ```json` (the spaces are between delimiter
  and `info_string`, not in the `language` leaf).
- `{"a":1}` → `{ "a": 1 }` inside a JSON fence.
- `{ }` in a JSON fence → `{}` (guest empty container; gate 3 accepts
  because the space is between two anonymous tokens).
- A run of blank lines between headings caps at one.
- `*em*` → `_em_`, `*`/`+` lists → `-`, `***`/`___`/`* * *` → `---`
  (incomparable files).
- **Not probed in a comparable file, because they are leaf rewrites:**
  `>foo` → `> foo` (`block_quote_marker` text is `'>'` vs `'> '`), list
  indent (`list_marker_minus` text is `'  - '` vs `'- '`), table-cell
  padding (`pipe_table_cell` is a true leaf, so `'n    '` ≠ `'n '`),
  destination spaces in `[t](  /url  )` (the `url  ` gap is not all
  whitespace). Those are written canonical. `[ ]` on a task item is
  preserved — that is the empty container with a space, and gate 3 accepts
  prettier's output.

**Quoted fences cannot splice.**
`injection.region_for` takes
`source[content.start_byte:content.end_byte]`. For a fence inside a
blockquote that span includes the `> ` line prefixes (`block_continuation`
children with text `"> "`). JSON parse then fails, the region stays
verbatim, and prettier's guest reformat is a byte-level gate 3 rejection.
List-item fences *do* splice: the continuation is only spaces, which JSON
accepts. The corpus therefore puts nested JSON in list items
(`nesting.md`) and keeps `blockquotes.md` free of fences.

This does not block a required gate — the comparable corpus avoids the
shape. It *will* block a package that wants to format JSON inside a
blockquote the way prettier does. Proposed patch, not applied (shared
file, three other round-4 agents in flight):

- File: `harness/injection.py`, `region_for`, currently lines 43–47.
- Change: assemble the region source from `code_fence_content` **minus**
  any `block_continuation` children, instead of the raw byte slice.
- Shape: no new manifest field required if every host's continuation
  node is layout. If a future host uses `block_continuation` for content,
  an optional `[[injections]]` flag `strip_continuations = true` (bool,
  default false) would keep the change opt-in. Markdown would set it.

**The block grammar does not parse inline structure.** `emphasis`,
`inline_link`, `code_span` exist only on `inline_language()`. Under
`language()` they are anonymous tokens of an `inline` node. A package
dispatches on `inline`, not on `emphasis`. Stage C can format `inline`
verbatim or with `fill`; splicing the inline tree would be a harness
change of the kind this slice is told not to make.

**Refusing is the wrong default, and the corpus states it.** `fences.md`
contains a no-info fence, an unknown-info fence, and a `{broken` JSON
fence. prettier leaves all three interiors alone. The harness does not
stamp `language` on them. A document with one unparseable snippet still
formats.

**YAML front matter is formatted as YAML**, and `minus_metadata` is a
leaf, so any non-canonical spelling or width-sensitive flow collection
inside it is a leaf rewrite. Kitchen's front matter is short and already
canonical (`title: demo` / `tags: [a, b]`).

**prettier's other markdown rewrites, recorded so they are not rediscovered:**
`~~~json` fences become `` ```json ``; four-backtick fences shrink to three
when they can; setext underlines are preserved as-is (including short
`==`); ordered lists keep their starting number (`3. a` stays `3.`) but
renumber subsequent items and rewrite `1)` to `1.`; `[X]` becomes `[x]`;
HTML blocks are not reformatted; indented code is not converted to fences;
`objectWrap` does not apply to markdown.

## Highlight goldens

Six of the fifteen trees contain a spliced JSON (or JSON+JavaScript) region.
`score_highlight.py` highlights any tree that names a language with a
highlight package, so those six are painted with the JSON package and need
committed span goldens. `./test.sh` failed with `missing golden
markdown__*.spans.json` until they existed. Generated with
`./harness/score_highlight.py . --language markdown --update`; they live in
`corpus/highlight/`. Trees with no guest (and no markdown highlight package)
stay unhighlighted, which is not a failure.

This is generated ground truth, same as the trees and the reference output.
There is no markdown highlight package yet; the goldens are the JSON (and, in
`fences.md`, JavaScript) interiors only.

## Changes outside `corpus/` and `harness/languages/`

```
git diff --stat 7480e32 -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty — no output)

## Template delta

- `proseWrap=preserve` is the load-bearing prettier default for markdown.
  The "a third of files must differ between widths" property is
  unreachable by paragraphs, tables or lists, and the brief already
  flagged that. The number is 5/15, all via fenced JSON/JS.
- tree-sitter-markdown has **no named extras**. HTML comments are
  structure. `corpus_stats.py`'s "carries a comment" count is therefore
  0 for every honest markdown corpus. Guest extras still work.
- `block_quote_marker` and `list_marker_*` include their trailing space
  and indent in the leaf text. A normalisation probe that writes `>foo`
  or over-indented `-` items fails gate 3, unlike Python/JS where that
  space is a gap between tokens.
- Quoted fenced guests cannot splice with the current
  `source[start:end]` extraction (`harness/injection.py` 43–47). Proposed
  patch above; not applied.
- A markdown corpus that splices JSON will fail `./test.sh` until
  `corpus/highlight/markdown__*.spans.json` exist. The brief asked for
  trees and reference output, not highlight goldens; they are the same
  kind of generated ground truth and `score_highlight.py --update`
  writes them.
