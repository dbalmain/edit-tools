# Markdown corpus report (stage A)

## Builder

**grok-4.6 via the grok CLI.**

## Stage-B review (Opus, 2026-08-21)

**Verdict: pass with fixes applied.** The ground truth is honest. What was
re-derived rather than read, and what it showed:

| Check                       | How                                                                              | Result                                                                    |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Reference output is genuine | all 15 files x 2 widths re-run through `npx prettier@3.9.6` directly, then `cmp` | **30/30 byte-identical**, 0 mismatches                                    |
| Version is observed         | `npx --yes prettier@3.9.6 --version`                                             | prints `3.9.6`, matches `reference_version`                               |
| Manifest reproduces         | `gen_reference.py --language markdown --check`                                   | no drift                                                                  |
| Counts                      | `corpus_stats.py --language markdown` run independently                          | 9/15, 5/15, 0/15, overflow @80 2 / @40 49 — **all as reported**           |
| `widths[0]` is the default  | own bisection: 26-ones vs 27-ones JSON array, unprompted vs `@80` vs `@81`       | 27-ones breaks unprompted and @80, flat @81 → **80 confirmed**            |
| Trees parse clean           | `gen_trees.py --language markdown` re-run                                        | 15 trees, byte-identical, no `ERROR`/`MISSING`                            |
| Gate 3                      | `check_gate3.py --language markdown`                                             | 30 accepted, 24 destructive rejected, 262 adversarial, 11 injection cases |
| Shared-file edits           | `git diff 7480e32 -- . ':(exclude)corpus' ':(exclude)harness/languages'`         | **empty** — the report's "None" is true                                   |
| Incomparable files          | read all three                                                                   | one construct each, kitchen not listed, nothing else mixed in             |

`widths = [80, 40]` is the reference's own default, not an inherited 88 — this
corpus does not repeat TOML's stage-B defect.

Three corrections were applied to this report and one to the manifest; each is
marked **Review addendum** at the point it belongs:

1. `embeddedLanguageFormatting = "auto"` was unnamed, and it is what makes the
   whole corpus width-sensitive.
2. `proseWrap = "preserve"` was described as an effect but never connected to
   `srcline`/`srcsoft`/`srctrail`, which is the stage-C handoff.
3. The ATX closing-sequence rewrite (`# Title ###` → `# Title`) was recorded
   nowhere; the corpus's omissions are now classified against `gate3._generic`
   rather than asserted.
4. The proposed `injection.region_for` patch is the **wrong shape** — it fixes
   the parse and silently corrupts the spliced tree. Diagnosis kept, patch
   redirected.

The corpus is width-insensitive in its host language by construction, and that
is prettier's fact rather than a corpus hole — see the note under "Counts".

## Manifest

`harness/languages/markdown.toml`. Every field that could have been guessed was
observed, not assumed.

| Field                  | Value                                                                              | How it was established                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-markdown==0.5.1`                                                      | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_markdown` guess. `0.5.1` is the latest release and is the pin the injection fixture already used.                                                                                                                                                                                                 |
| `grammar_module`       | `tree_sitter_markdown`                                                             | `uv run --with tree-sitter-markdown==0.5.1` then `import tree_sitter_markdown`. The hyphen-to-underscore swap is correct here.                                                                                                                                                                                                                                             |
| `grammar_symbol`       | `language`                                                                         | The module exports `language()` (block) and `inline_language()` (inline). Fences, `info_string` and `code_fence_content` live in the block tree, so the host selects `language()` — the same choice `docs/injection.md` recorded. `inline_language()` is unused: the harness has no included-range second pass.                                                            |
| `injection_aliases`    | `["markdown", "md"]`                                                               | `markdown` is canonical. `md` is the conventional fence spelling (GitHub linguist, prettier's support-info aliases). Both unique across manifests. `pandoc` is a different dialect; `mdx` is prettier's MDX parser, not this grammar.                                                                                                                                      |
| `reference`            | `npx --yes prettier@3.9.6 --no-config --stdin-filepath x.md --print-width {width}` | Source on stdin, formatted source on stdout. `--stdin-filepath` **is** required: without it and without `--parser`, prettier errors `No parser and no file path given`. `--parser markdown` is an alternative, not a second flag: parser-only, `x.md` and `x.markdown` are byte-identical on dirty input, so `--parser` is omitted. `--no-config` is load-bearing (below). |
| `reference_version`    | `3.9.6`                                                                            | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Same pin as CSS/YAML/JavaScript; JSON is still on 3.6.2.                                                                                                                                                                                                                                                     |
| `reference_width`      | `flag`                                                                             | Ran the same input at 80 and 40 and diffed. Paragraphs, tables, list items and headings do **not** reflow (`proseWrap` defaults to `preserve`). Fenced JSON/JS and nested-markdown JSON do. `{width}` is therefore real, but only for embedded guests.                                                                                                                     |
| `widths`               | `[80, 40]`                                                                         | 80 is prettier's own default (below). 40 is the narrow width at which a 27-ones JSON fence, a JS fence, and the same fence nested in a list actually split. 60 still leaves the 27-ones array flat.                                                                                                                                                                        |
| `gate3`                | `default`                                                                          | See below.                                                                                                                                                                                                                                                                                                                                                                 |
| `transparent_wrappers` | `[]`                                                                               | Gate 3 accepted prettier on 30/30 comparable runs without naming a wrapper. Markdown has no parenthesised-expression node; parentheses in links are structural.                                                                                                                                                                                                            |
| `equivalent_kinds`     | `[]`                                                                               | Nothing was renamed.                                                                                                                                                                                                                                                                                                                                                       |

`[[injections]]` is declared last, after every root key:

```toml
[[injections]]
node = "fenced_code_block"
info = "info_string"
content = "code_fence_content"
```

That is the shape the fixture already proved. YAML front matter is
`minus_metadata`, a true leaf with no info/content children, so the injection
schema cannot describe it. Kitchen carries a short, already-canonical YAML front
matter; a long flow collection inside it would be a leaf rewrite at one width
and fail gate 3.

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
reads `.editorconfig` from that path. A planted config with
`proseWrap: "always"` and `tabWidth: 4` (options the command line does **not**
name) silently reflowed a long paragraph and reindented a nested list. A planted
`.editorconfig` with `indent_size = 8` reindented too. An ancestor `.prettierrc`
is enough; prettier does not stop at cwd.

CLI `--print-width` wins over a file `printWidth` under the default
`--config-precedence cli-override` (the taplo shape: the file fills every option
the CLI does not name). `--config-precedence file-override` lets the file's
`printWidth` win (checked). `--no-config` makes the planted config, the ancestor
config, and `.editorconfig` all inert.

Leftover channels the disable flag leaves open:

- An explicit `--config path` still applies. `--no-config` and `--config`
  together is an error (`Cannot use --no-config and --config together`).
- There is no `PRETTIER_CONFIG` env var. `PRETTIER_CONFIG=/tmp/x.json` plus
  `--no-config` was identical to the baseline.

`gen_reference.py --check` is silent (exit 0); two runs of the same stdin match.

### Why not `gate3 = "markdown"`

There is no markdown data-model loader that would help. CommonMark ASTs collapse
exactly the spellings a formatter must preserve — emphasis delimiters, list
markers, thematic-break punctuation, fence info strings. The generic named-node
comparison is the right oracle. HTML comments are `html_block` / anonymous
tokens under `inline`, not extras, so the extras layer is inert on the host
(below); guest comments in a spliced JSON fence are still checked by the guest
grammar.

`check_gate3.py --language markdown`: 30 reference outputs accepted (3
incomparable files skip only that assertion), 24 destructive mutations rejected,
262 useful adversarial mutations (arm inert — no override), 0 wrapper kinds, 11
injection cases checked.

### `[incomparable]`

Three dedicated files, one construct each. Kitchen is not among them.

| File              | Rewrite                           | Why linearity forbids it                      |
| ----------------- | --------------------------------- | --------------------------------------------- |
| `emphasis.md`     | `*em*` → `_em_`                   | Anonymous delimiter token                     |
| `list_markers.md` | `*` / `+` unordered markers → `-` | Node kind `list_marker_star`/`plus` → `minus` |
| `thematic.md`     | `***` / `___` / `* * *` → `---`   | Leaf / anonymous-token spelling of the break  |

The same class, written in canonical form rather than excluded: `__strong__` →
`**strong**` (kitchen uses `**`), `1)` → `1.` (lists use `.`), `'title'` →
`"title"` on link titles (corpus uses double quotes), `[X]` → `[x]` (lists use
`[x]`).

## Corpus

Fifteen files in `corpus/src/markdown/`. Each is valid markdown: clean under
tree-sitter-markdown 0.5.1 (no `ERROR` / `MISSING`) and accepted by prettier
3.9.6.

Required probes:

- `nesting.md` — lists in lists, deep enough that a JSON fence at two indent
  depths sees different remaining widths. Inner `{ "id": 1 }` objects stay flat
  when the parent array breaks. List-item fences splice; quoted ones do not
  (below).
- `long_sequences.md` — the construct that overflows: a 26-ones JSON array (78
  chars, flat at both scored widths) next to a 27-ones array (81 chars, breaks
  at 80).
- `comments.md` — HTML comments in every position markdown allows: file-level,
  trailing on a heading, inline in a paragraph, trailing on a list item,
  own-line inside a list, trailing in a quote, own-line in a quote, between
  blocks, consecutive, end of file. Plus a JSON guest with a trailing comment
  and an own-line comment, so the extras layer has something to chew on.
- `strings.md` — code spans (including inner spaces and `` ` ``), backslash
  escapes, entities, a long unbreakable span.
- `normalisation.md` — extra spaces after `#`, extra spaces after `>` on a
  marker that already has one, fence-info padding, dirty JSON, a run of blanks
  between headings. Empty JSON `{ }` lives in `fences.md`.
- `kitchen.md` — YAML front matter, heading, paragraph with emphasis/link/code,
  quoted list, padded table, task list, JSON fence, unlabelled fence, thematic
  break, reference definition.

Characteristic of markdown, one line each:

- `headings.md` — ATX 1–6, a seven-hash non-heading, setext h1 and h2.
- `lists.md` — tight and loose, nested, ordered (`1.` consecutive), task list
  including `[ ]` (the empty container with a space and no named children).
- `tables.md` — pipe tables already at prettier's padded alignment, empty cells,
  a ten-column table that does not wrap at either width.
- `blockquotes.md` — nested quotes and a quoted list. No fenced guests (quoted
  fences cannot splice; see findings).
- `fences.md` — the defining feature: routed JSON and JavaScript, `{ }` written
  with a space, no-info / unknown / broken-JSON verbatim fallbacks, nested
  `markdown` containing JSON.
- `links.md` — inline link, image, a long autolink that prettier will not wrap,
  a reference definition.

All fifteen files carry an HTML comment. `corpus_stats.py` still reports
**0/15** "carries a comment" because it counts named extras, and
tree-sitter-markdown has none — HTML comments are `html_block` or anonymous
tokens under `inline`. That is a finding about the stats probe, not a corpus
hole. Guest extras are present in `comments.md`'s JSON fence.

## Counts

From `./harness/corpus_stats.py --language markdown` (not a hand-rolled `cmp`):

| Measure                         | Count                                   |
| ------------------------------- | --------------------------------------- |
| Files                           | 15                                      |
| Incomparable                    | 3                                       |
| Reference changes at some width | **9/15** (`@80` 9/15, `@40` 9/15)       |
| Differs between the two widths  | **5/15** (exactly one third)            |
| Carries a named extra           | **0/15** (HTML comments are not extras) |
| Reference overflow              | **`@80` 2, `@40` 49**                   |

The six files byte-identical input to output at every width are the ones written
in prettier's canonical form so gate 3 can see them: `blockquotes`, `headings`,
`links`, `lists`, `strings`, `tables`. `normalisation.md` is the rewrite probe.

The five width-discriminating files are `comments`, `fences`, `kitchen`,
`long_sequences`, `nesting` — all via fenced JSON/JS. Paragraphs, tables, list
items and headings do not reflow at `proseWrap=preserve`, so the "a third of
files must differ" property is unreachable by those constructs alone. This is
the number, not a padded corpus.

> **Review addendum (stage B): can a corpus this width-insensitive support a
> stage-C package? Yes — but only because the insensitivity is the language's,
> and stage C has to be told that in those words.**
>
> Both numbers are confirmed independently and neither is padded. 5/15 clears
> the one-third bar and 9/15 is the lowest of the four round-4 corpora, and the
> builder reported both rather than hiding the weaker one — which is the
> behaviour the brief asks for and the opposite of TOML's stage B.
>
> The honest reading is not "thin corpus". It is that **markdown's host layer
> makes no width decisions at all.** Every one of the 5 comes from a guest;
> lists and quotes have no flat-vs-broken choice; prose is governed by source
> line breaks. A wider corpus of markdown would not move these numbers, because
> there is no markdown construct left that a width could break.
>
> That changes what stage C is being asked to build. The markdown package is a
> **normalisation and source-preservation** problem with a width-driven layer
> only at injection sites — not the `group`/`fill` problem the other three
> round-4 languages pose. The danger here is not a flattering corpus; it is that
> a package built to the usual width-driven model passes the 6 byte-identical
> files, scores respectably, and is wrong in a way **no count in
> `corpus_stats.py` can see** — because a preserved break and a width-driven
> break are the same bytes. The two defaults now recorded under "What prettier
> did that surprised me" (`proseWrap`, `embeddedLanguageFormatting`) are the
> whole of that risk, and they are the reason those addenda exist.

### Reference overflow, broken out

prettier is allowed to overrun its own target, and it does.

**At 80, two line-runs:**

- `links.md` — a 137-character autolink. prettier never wraps URLs.
- `strings.md` — a 158-character code span. prettier never wraps code-span
  interiors.

**At 40, 49 line-runs.** Almost all of them are the same refusal: with
`proseWrap=preserve`, prettier will not wrap a paragraph, a heading, a list
item, an HTML comment, a table row, or a code span. The ten-column table in
`tables.md` is 61 characters wide at both widths. The 27-ones JSON array _does_
wrap at 40; the overflow that remains is prose and tables, not the guest. A
stage-C agent that sees a 76-character paragraph in the width-40 reference is
looking at prettier's default, not a corpus bug.

## What prettier did that surprised me

**Prettier does not reflow markdown prose at its default.** `proseWrap` defaults
to `preserve`. A paragraph that exceeds 80 characters stays one line at both
scored widths; `--prose-wrap always` wraps it. That is why width discrimination
had to come from fenced JSON/JS, and why `fill` is not forced by this corpus.
Confirmed against prettier 3.9.6, not taken from `docs/injection.md`.

> **Review addendum (stage B).** This is the brief's "layout depends on the
> input's line breaks rather than on width alone" default, and it is the one the
> brief says to flag above all others. Stated as an effect ("does not reflow")
> it reads as prettier declining to act; it is stronger than that. Same words,
> same width, two source layouts:
>
> ```sh
> printf 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron\n' | \
>   npx --yes prettier@3.9.6 --no-config --stdin-filepath x.md --print-width 80
> # -> one line
> printf 'alpha beta gamma\ndelta epsilon zeta eta theta\niota kappa lambda mu nu xi omicron\n' | \
>   npx --yes prettier@3.9.6 --no-config --stdin-filepath x.md --print-width 80
> # -> three lines, the source's own three
> ```
>
> The three-line layout survives `--print-width 200`, so width cannot explain
> it. **Stage C must reach for the runtime's `srcline` / `srcsoft` / `srctrail`
> for every markdown paragraph, heading, list item and table row.** A package
> that models prose as a width-driven `fill` will reproduce the 6 byte-identical
> files and diverge the moment it meets a paragraph whose source breaks disagree
> with its width, which is most real markdown. No count in `corpus_stats.py` can
> see that divergence, because a preserved break and a width-driven break are
> the same bytes.

**`embeddedLanguageFormatting` defaults to `auto`, and that is the only reason
this corpus discriminates by width at all.** Not named anywhere in the original
report; it is the second shape the brief asks for — on by default, and its _off_
setting is exactly what a naive package implements.

````sh
printf '```json\n{"a":1,   "b":[1,2,3]}\n```\n' | \
  npx --yes prettier@3.9.6 --no-config --stdin-filepath x.md --print-width 80
# ```json
# { "a": 1, "b": [1, 2, 3] }
# ```
printf '```json\n{"a":1,   "b":[1,2,3]}\n```\n' | \
  npx --yes prettier@3.9.6 --no-config --stdin-filepath x.md --print-width 80 \
  --embedded-language-formatting off
# ```json
# {"a":1,   "b":[1,2,3]}
# ```
````

All 5 width-discriminating files, and every guest normalisation in the
"Token-level normalisation" list, rest on this default. Leaving a fence interior
verbatim is the obvious first implementation — and `fences.md`'s own "refusing
is the wrong default" section is about _unparseable_ fences, which a reader can
easily generalise into "leave fences alone". Such a package passes all 6
byte-identical files and scores zero on the other 9.

**When a container breaks, inner containers that fit stay flat.** Construct: six
`{ "id": 1 }` objects in a JSON fence inside a list item. The parent array
explodes one object per line at both 80 and 40 (the list indent eats remaining
width). Each object stays `{ "id": 1 }` — it would fit with room to spare, and
prettier does not force it open. Four `{ "k": 1 }` objects in a deeper list stay
_flat as an array_ at 80 and explode at 40; the objects themselves stay flat
either way. Markdown lists and quotes have no flat-vs-broken choice of their
own: they are always one item per line, one `>` prefix per line.

**A trailing HTML comment does not count toward its line's width**, because the
line is not being measured for a wrap. Headings, list items and paragraphs with
`<!-- trailing -->` are identical at 80 and 40. A trailing comment _inside a
JSON guest_ is a different story: prettier JSON treats it as a BreakParent and
explodes the array one item per line at both widths (the first draft of
`comments.md` did this and lost its width discrimination). That is the guest's
rule, not markdown's.

**Token-level normalisation**, as opposed to line level:

- `#    Title` → `# Title` (gap between `atx_h1_marker` and `inline`; gate 3
  accepts).
- Extra spaces after an already-spaced `>` marker collapse (`>  bar` → `> bar`).
- Fence info ` ```   json` → ` ```json` (the spaces are between delimiter and
  `info_string`, not in the `language` leaf).
- `{"a":1}` → `{ "a": 1 }` inside a JSON fence.
- `{ }` in a JSON fence → `{}` (guest empty container; gate 3 accepts because
  the space is between two anonymous tokens).
- A run of blank lines between headings caps at one.
- `*em*` → `_em_`, `*`/`+` lists → `-`, `***`/`___`/`* * *` → `---`
  (incomparable files).
- **Not probed in a comparable file, because they are leaf rewrites:** `>foo` →
  `> foo` (`block_quote_marker` text is `'>'` vs `'> '`), list indent
  (`list_marker_minus` text is `'  - '` vs `'- '`), table-cell padding
  (`pipe_table_cell` is a true leaf, so `'n    '` ≠ `'n '`), destination spaces
  in `[t](  /url  )` (the `url` gap is not all whitespace). Those are written
  canonical. `[ ]` on a task item is preserved — that is the empty container
  with a space, and gate 3 accepts prettier's output.

**Quoted fences cannot splice.** `injection.region_for` takes
`source[content.start_byte:content.end_byte]`. For a fence inside a blockquote
that span includes the `>` line prefixes (`block_continuation` children with
text `"> "`). JSON parse then fails, the region stays verbatim, and prettier's
guest reformat is a byte-level gate 3 rejection. List-item fences _do_ splice:
the continuation is only spaces, which JSON accepts. The corpus therefore puts
nested JSON in list items (`nesting.md`) and keeps `blockquotes.md` free of
fences.

This does not block a required gate — the comparable corpus avoids the shape. It
_will_ block a package that wants to format JSON inside a blockquote the way
prettier does. Proposed patch, not applied (shared file, three other round-4
agents in flight):

- File: `harness/injection.py`, `region_for`, currently lines 43–47.
- Change: assemble the region source from `code_fence_content` **minus** any
  `block_continuation` children, instead of the raw byte slice.
- Shape: no new manifest field required if every host's continuation node is
  layout. If a future host uses `block_continuation` for content, an optional
  `[[injections]]` flag `strip_continuations = true` (bool, default false) would
  keep the change opt-in. Markdown would set it.

> **Review addendum (stage B): the defect is real, the proposed patch is the
> wrong shape.**
>
> The defect reproduces exactly as described. For `> ```json` / `> { "a": 1 }` /
> `> ``` `, `region_for` returns `b'{ "a": 1 }\n> '`, JSON parse fails, and the
> region stays verbatim. The list-item form returns `b'{ "a": 1 }\n  '` and
> parses clean, so the diagnosis — that JSON tolerates the space continuation
> and not the `>` one — is correct.
>
> But `region.source` is not only parsed; it is **spliced**, and the splice has
> an offset contract the patch breaks. `gen_trees.convert` rebases guest offsets
> onto the host with a single additive `base`, then reads every leaf's text out
> of the **host** bytes:
>
> ```python
> base = base + region.content.start_byte      # gen_trees.py:84
> out["text"] = outer_source[start:end].decode("utf-8")   # gen_trees.py:107
> ```
>
> Deleting `block_continuation` bytes from `region.source` makes that mapping
> piecewise instead of additive. Measured on a multi-line quoted JSON fence, the
> stripped source parses clean — and **16 of its 17 leaves then read the wrong
> host bytes**: `"alpha"` becomes `' "alp'`, `:` becomes `a`, `[` becomes `a`.
> Nothing rejects this. `check_clean` looks for `ERROR` and `MISSING`, and a
> misaligned leaf is neither, so the corruption lands silently in a frozen tree
> that every submission reads.
>
> The right shape is therefore **not** a stripped byte string plus a bool. It is
> a stripped byte string **plus an offset map** — `Region` has to carry the
> guest-offset-to-host-offset correspondence (a list of retained
> `(guest_start, host_start, length)` runs is enough), and `gen_trees.convert`
> has to consume that map instead of adding a scalar `base`. `gate3` needs the
> same treatment wherever it pins `region.source` against host spans.
>
> That is a materially larger change than the report implies, and it is a
> harness change, so it stays out of this slice. Recorded here so the next agent
> to pick it up does not implement the additive version and discover the
> corruption downstream.

**The block grammar does not parse inline structure.** `emphasis`,
`inline_link`, `code_span` exist only on `inline_language()`. Under `language()`
they are anonymous tokens of an `inline` node. A package dispatches on `inline`,
not on `emphasis`. Stage C can format `inline` verbatim or with `fill`; splicing
the inline tree would be a harness change of the kind this slice is told not to
make.

**Refusing is the wrong default, and the corpus states it.** `fences.md`
contains a no-info fence, an unknown-info fence, and a `{broken` JSON fence.
prettier leaves all three interiors alone. The harness does not stamp `language`
on them. A document with one unparseable snippet still formats.

**YAML front matter is formatted as YAML**, and `minus_metadata` is a leaf, so
any non-canonical spelling or width-sensitive flow collection inside it is a
leaf rewrite. Kitchen's front matter is short and already canonical
(`title: demo` / `tags: [a, b]`).

**prettier's other markdown rewrites, recorded so they are not rediscovered:**
`~~~json` fences become ` ```json `; four-backtick fences shrink to three when
they can; setext underlines are preserved as-is (including short `==`); ordered
lists keep their starting number (`3. a` stays `3.`) but renumber subsequent
items and rewrite `1)` to `1.`; `[X]` becomes `[x]`; HTML blocks are not
reformatted; indented code is not converted to fences; `objectWrap` does not
apply to markdown.

> **Review addendum (stage B): one rewrite was missing, and the omissions are
> now classified.**
>
> The report-to-corpus direction turned up one prettier rewrite recorded nowhere
> above: an **ATX closing sequence is deleted** — `# Title ###` becomes
> `# Title`, `## Another one ##` becomes `## Another one`. `headings.md` probes
> levels 1–6, seven hashes and both setext forms, but never a closing sequence,
> so nothing in the corpus forces it.
>
> That omission is correct, and so is every other one — but the report asserted
> it rather than showing it, so each was run through `gate3._generic` directly:
>
> | Rewrite                              | gate 3      | Signature difference                           |
> | ------------------------------------ | ----------- | ---------------------------------------------- |
> | `# Title ###` → `# Title`            | **rejects** | `inline` `('Title ','#','#','#')` vs `'Title'` |
> | `~~~json` → ` ```json `              | **rejects** | `fenced_code_block_delimiter` leaf text        |
> | `1. 5. 9.` → `1. 2. 3.`              | **rejects** | `list_marker_dot` leaf text                    |
> | blank run inside a list caps at one  | **rejects** | a `block_continuation` child disappears        |
> | `#    Title` → `# Title` _(control)_ | **accepts** | gap between named siblings                     |
>
> So all four are genuinely incomparable: written into a comparable file, each
> would fail `check_gate3.py`. Writing them canonical and omitting them is the
> same policy the report already applies to `>foo`, list indent and table-cell
> padding, and it is applied consistently. The control confirms the gate is not
> simply rejecting everything — the one normalisation `normalisation.md` does
> probe at heading level passes.
>
> Only the ATX closing sequence was a genuine gap, and it is a gap in the
> **record**, not in the corpus.

## Highlight goldens

Six of the fifteen trees contain a spliced JSON (or JSON+JavaScript) region.
`score_highlight.py` highlights any tree that names a language with a highlight
package, so those six are painted with the JSON package and need committed span
goldens. `./test.sh` failed with `missing golden markdown__*.spans.json` until
they existed. Generated with
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

- `proseWrap=preserve` is the load-bearing prettier default for markdown. The "a
  third of files must differ between widths" property is unreachable by
  paragraphs, tables or lists, and the brief already flagged that. The number is
  5/15, all via fenced JSON/JS.
- tree-sitter-markdown has **no named extras**. HTML comments are structure.
  `corpus_stats.py`'s "carries a comment" count is therefore 0 for every honest
  markdown corpus. Guest extras still work.
- `block_quote_marker` and `list_marker_*` include their trailing space and
  indent in the leaf text. A normalisation probe that writes `>foo` or
  over-indented `-` items fails gate 3, unlike Python/JS where that space is a
  gap between tokens.
- Quoted fenced guests cannot splice with the current `source[start:end]`
  extraction (`harness/injection.py` 43–47). Proposed patch above; not applied.
- A markdown corpus that splices JSON will fail `./test.sh` until
  `corpus/highlight/markdown__*.spans.json` exist. The brief asked for trees and
  reference output, not highlight goldens; they are the same kind of generated
  ground truth and `score_highlight.py --update` writes them.
