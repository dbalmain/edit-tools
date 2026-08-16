# YAML corpus report (stage A)

## Manifest

`harness/languages/yaml.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                                                  | How it was established                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grammar`              | `tree-sitter-yaml==0.7.2`                                                              | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_yaml` guess, and 0.7.2 is the latest release (2025-10-07).                                                                                                                                                                                                                    |
| `grammar_module`       | `tree_sitter_yaml`                                                                     | `uv run --with tree-sitter-yaml==0.7.2` then `import tree_sitter_yaml`. The hyphen-to-underscore swap is correct here.                                                                                                                                                                                                                                 |
| `grammar_symbol`       | `language`                                                                             | The module exports `language()` (and `HIGHLIGHTS_QUERY`). It returns a `tree_sitter.Language` capsule. No `language_yaml()`.                                                                                                                                                                                                                           |
| `injection_aliases`    | `["yaml", "yml"]`                                                                      | `yaml` is the canonical info-string. `yml` is in prettier's own `support-info` aliases and is the conventional fence spelling; I will vouch for it. Nothing else.                                                                                                                                                                                      |
| `reference`            | `npx --yes prettier@3.9.6 --parser yaml --no-config --print-width {width}`             | Source on stdin, formatted source on stdout. `--parser yaml` is required (no parser and no filepath: "couldn't infer a parser"). `--stdin-filepath` is **not** required and is omitted (below). `--no-config` **is** required (below).                                                                                                                 |
| `reference_version`    | `3.9.6`                                                                                | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Published 2026-07-21, well past a seven-day cooldown. JSON is still on 3.6.2; this pin is current.                                                                                                                                                                                        |
| `reference_width`      | `flag`                                                                                 | Ran the same input at 80 and 40 and diffed. Flow collections reflow; almost nothing else does. `{width}` is therefore real.                                                                                                                                                                                                                            |
| `widths`               | `[80, 40]`                                                                             | 80 is prettier's own default, established by bisection: a flow-sequence line of exactly 80 characters stays flat and 81 breaks. 40 is the narrow width; it forces the flow expand/collapse that 80 lets a package dodge.                                                                                                                               |
| `gate3`                | `default`                                                                              | See below.                                                                                                                                                                                                                                                                                                                                             |
| `transparent_wrappers` | `[]`                                                                                   | Gate 3 accepted prettier on 32/32 runs without naming a wrapper.                                                                                                                                                                                                                                                                                       |
| `equivalent_kinds`     | `[]`                                                                                   | Same: nothing was renamed. `flow_node` / `block_node` and `flow_sequence` / `block_sequence` are structural, not wrappers.                                                                                                                                                                                                                             |

### `--parser yaml` is sufficient; `--stdin-filepath` opens a channel

`--parser yaml` and `--stdin-filepath x.yaml` produce byte-identical YAML on a
clean machine. The filepath is how JSON selects a parser, so it looks
load-bearing. It is not, once `--parser` is set.

It is redundant once the parser is explicit. A planted `.editorconfig` with
`indent_size = 8` and `quote_type = single` changes output only when a filepath
is present **and auto-config remains enabled**. With the exact reference command
above, `--no-config` makes that editorconfig inert on both prettier 3.6.2 and
3.9.6, with or without `--stdin-filepath`. Omitting the filepath is still the
smaller command, but it is not an additional config-safety boundary here.

`--use-tabs` has no effect on YAML (checked). `--trailing-comma` and
`--no-bracket-spacing` likewise do nothing. `--tab-width` and `--single-quote`
do change YAML; they are not on the command line.

### `--no-config` is load-bearing

prettier walks cwd and ancestors for `.prettierrc` / `prettier.config.*` / a
`package.json` `"prettier"` key. A planted config with `tabWidth: 4` and
`singleQuote: true` — options the command line does **not** name — silently
reindents and requotes. That is the taplo shape: CLI `--print-width` wins
over a file `printWidth` under the default `--config-precedence cli-override`
(checked: file `printWidth: 40` plus CLI `--print-width 80` keeps a
49-character flow sequence flat); the file fills every option the CLI does
not name. `--config-precedence file-override` lets the file's `printWidth`
win (checked). `--no-config` plus `--config` is refused. There is no
`PRETTIER_CONFIG` environment variable that reopens the search. Residual
channel: an explicit `--config`, which cannot be combined with `--no-config`.

There is no prettier config in this worktree or its ancestors today, so
auto-config and `--no-config` currently agree here. They will not agree on a
machine that has a `.prettierrc` in `$HOME`. The committed command therefore
includes `--no-config`. `gen_reference.py --check` is silent with that
command (exit 0, "committed reference output matches the pinned formatters").
Two runs of the same stdin match.

### Why not `gate3 = "yaml"` / `yaml.safe_load`

A data-model loader collapses the spellings a formatter must preserve: block
vs flow, `"hello"` vs `'hello'` vs `hello`, `null` / `~` / empty, `yes` /
`true`, `0xFF` vs `255`, `|` vs `>`. The generic named-node comparison is
the right oracle. Extras still cover comments.

`check_gate3.py --language yaml`: 32 reference outputs accepted, 64
destructive mutations rejected, 524 useful adversarial mutations (the arm is
inert because there is no override), 0 wrapper kinds needed.

## Corpus

Sixteen files in `corpus/src/yaml/`. Each is valid YAML: clean under
tree-sitter-yaml 0.7.2 (no `ERROR` / `MISSING`) and under prettier 3.9.6.

Required probes:

- `nested.yaml` — flow sequences of flow sequences, flow mappings of flow
  mappings, a tiny `{ ok: 1 }` that still fits when every ancestor has
  broken. Width 80 keeps `matrix` flat; width 40 explodes the outer
  collections and leaves `[1, 2, 3, 4]`, `tags: [a, b]`, and `{ ok: 1 }`
  flat.
- `flow_sequence.yaml` — the construct that overflows. Short, medium (fits
  80, breaks 40), long (breaks both), mixed types, nested sequences, flow
  mappings as items, and a hand-broken sequence prettier collapses because
  it fits and has no comment. Taken from DeepSeek's source probe;
  trees and references regenerated with prettier 3.9.6.
- `flow_mapping.yaml` — the `{ }` spelling alongside it. Short, medium
  (pair-breaks at 80, items-break at 40), long (breaks both), nested,
  a sequence inside, mixed types. Same origin and pin.
- `comments.yaml` — every legal position: file-level, trailing on a pair,
  own-line before a nested mapping, own-line inside a mapping, after a key
  and before a flow collection, after `[` on the same line, trailing on an
  item, own-line between items, before `]`, the same four inside `{…}`,
  own-line and trailing on a block sequence, consecutive own-line, end of
  file. A comment immediately after `[` is moved onto the next line
  (prettier will not leave a comment on the same line as `[`).
- `strings.yaml` — plain, double-quoted, the one single-quoted form prettier
  keeps (`'say "hi"'`), empty, escapes, a hash that is not a comment,
  unicode, astral scalars, a long double-quoted string prettier will not
  wrap. Single-quoted strings that do not contain `"` are **not** in this
  file: prettier rewrites them to double quotes, which changes
  `single_quote_scalar` leaf text, and gate 3 would then reject the
  reference.
- `normalisation.yaml` — input written the way a person writes YAML and
  prettier does not: padded `:` , padded / tight flow brackets, unpadded
  flow braces, spaced empty `[ ]` / `{ }`, flush sequence dashes, a
  dash-on-its-own-line nested sequence, runs of spaces and a tab before a
  trailing comment, a source trailing comma, an explicit `?` key,
  three-or-more blank lines.
- `kitchen.yaml` — block mappings, flow collections that reflow, an anchor
  plus merge key, a block scalar, comments in two positions, arrays that
  reflow.

Characteristic of YAML, one line each:

- `block_collections.yaml` — block mappings and block sequences, including
  a nested `- - item` sequence. The other container spelling; prettier
  never converts these to flow, even when they would fit on one line.
- `block_scalars.yaml` — `|`, `>`, `|-`, `|+`, `|2`, and a relative extra
  indent inside a literal. Interior is content; prettier does not reflow a
  `>` line that overruns the width.
- `anchors.yaml` — `&name`, `*name`, `<<:` merge, an anchor on a flow
  mapping that breaks at 40. The grammar has distinct `anchor` /
  `anchor_name` and `alias` / `alias_name` nodes; `<<` is a `string_scalar`.
- `tags.yaml` — `!!str` / `!!int` / `!!float` / `!!bool` / `!!null` /
  `!!map` / `!!seq`, a local `!custom`, a `%TAG` handle, a tag on a block
  scalar. Distinct `tag` node.
- `documents.yaml` — `%YAML 1.2`, three documents, `---` / `...`. Root is
  `stream` of `document`; the markers are anonymous tokens.
- `scalars.yaml` — `null` / `~` / empty, `true` / `True` / `TRUE` / `yes` /
  `on` / `false` / `no` / `off`, `1_000`, `0xFF` / `0xff`, `0o755`,
  `0b1010`, `.inf` / `+.inf` / `-.inf` / `.nan`. Prettier preserves every
  spelling.
- `keys.yaml` — bare, dashed, underscored, quoted (`"dotted.key"`, `"a:b"`,
  `"true"`), and flow collections as keys (`[a, b]:`, `{ k: v }:`).
- `spelling.yaml` — the same data as a block mapping and as a flow mapping,
  as a block sequence and as a flow sequence, as a long flow next to the
  block form of the same list, three nulls, `yes` vs `true`.
- `blank_lines.yaml` — prettier caps a run at one and leaves zero alone.

The ten files that used to be byte-identical at width 80
(`anchors`, `block_collections`, `block_scalars`, `documents`, `keys`,
`nested`, `scalars`, `spelling`, `strings`, `tags`) now carry the same
class of still-valid spacing prettier rewrites in `normalisation.yaml`.
Block-scalar *bodies* stay at prettier's indent; only the keys around
the indicators are padded.

**Comments.** 16 of 16 files carry at least one comment. The extras layer
of gate 3 is live on every file.

**A prettier parse quirk, recorded so it is not "fixed" later.** A comment
sitting *between* a plain pair and a flow-collection key in the same
mapping is a prettier `SyntaxError: Map comment with trailing content`.
tree-sitter-yaml accepts it. `keys.yaml` puts the flow-collection keys
first so the file is prettier-valid.

## Corpus-quality counts

From `./harness/corpus_stats.py --language yaml` against the committed
reference, not a live prettier:

```
yaml  --  16 files, vs 3.9.6
  reference changes    16/16 at some width   (@80 16/16  @40 16/16)
  differs by width     6/16
  carries a comment    16/16
  reference overflow   @80 3  @40 17
```

16 of 16 files change at width 80. The previous draft left ten files
already in prettier's own spacing, so a width-80 diff tested only what
prettier *breaks*. Those ten now carry deliberate, still-valid spacing
or indentation that prettier rewrites: padded or tight `:` , unpadded
flow braces, tight flow commas, flush sequence dashes, extra space
after a dash. `normalisation.yaml` is no longer the only rewrite probe.

6 of 16 files differ between width 80 and width 40: `anchors`,
`flow_mapping`, `flow_sequence`, `kitchen`, `nested`, `spelling`. That
is above a third. Every width-discriminating file is a flow collection
(or contains one). Block mappings, block sequences, strings, comments,
block scalars, tags, and document markers do not reflow; they cannot
contribute to this count. That is a fact about prettier, not a corpus
hole.

## Reference overflow

`score.py` skips yaml (no `packages/yaml.json` yet) so it does not print
"its own overflow" for this language. The number below is `score.py`'s
`overflow_lines` run against the committed reference and the committed
trees — the same function, the same exemption for a line that contains a
token longer than the width.

**its own overflow: 20** across 32 line-runs (16 files × 2 widths).
`corpus_stats.py` prints this as `@80 3  @40 17`.

| File            | @80 | @40 | Cause                                                                                          |
| --------------- | --: | --: | ---------------------------------------------------------------------------------------------- |
| `block_scalars` |   2 |   3 | Folded-scalar interiors prettier will not wrap (119 and 150 cols); plus a `\|2` content line   |
| `strings`       |   1 |   3 | Quoted strings prettier will not wrap (`long_double` 94; `escaped` 50; `astral` 62)            |
| `comments`      |   0 |   4 | Trailing comments on pairs that fit without them; prettier will not break to make them fit     |
| `keys`          |   0 |   2 | Same: a short pair plus a trailing comment                                                    |
| `kitchen`       |   0 |   4 | `listen: {…} # comment` (61); two origin URLs (42); `authorization: Bearer placeholder` (42)   |
| `tags`          |   0 |   1 | `as_string: !!str 123 # still looks like a number` (48)                                        |

A long own-line comment is usually *exempt* (the comment token itself is
longer than 40, so `overflow_lines` does not count the line). The 20 that
count are real overruns prettier manufactured or refused to fix, not
comment-only lines.

## What prettier does that surprised me

This is the useful section.

### It does not convert between block and flow

A flow sequence stays a flow sequence. A block sequence stays a block
sequence. The same for mappings. A short block list that would fit as
`[a, b]` is left as two dashed items. A long flow list that overflows is
**not** rewritten as a block list; it stays flow, with the brackets on
their own lines and a trailing comma:

```yaml
tags:
  [
    alpha,
    bravo,
  ]
```

That is still `flow_sequence` in the tree, so a node-type table can match
it with `group` + `trail`. Converting it to `- alpha` would be a
token-level rewrite the linearity invariant forbids, and prettier does not
ask for it. Whole file classes are therefore *winnable* on this axis.

The named tree of the flat form and the broken form is identical
(commas and brackets are anonymous). Gate 3 therefore accepts both, which
is why a third of the corpus can discriminate width without failing the
gate.

### When a container breaks, children that fit stay flat

Constructed case, committed as `nested.yaml`. At width 40 the outer
`matrix` and `servers` collections break. The children that still fit —
`[1, 2, 3, 4]`, `tags: [a, b]`, and `{ ok: 1 }` — stay on one line, with
room to spare. Prettier does **not** force an inner container open because
an ancestor opened.

This is the opposite of taplo (unconditional, crosses inline-table
boundaries). A package that models each container as an independent group
**matches** prettier on this point. Getting it wrong the taplo way would
diverge on every nested flow collection.

A medium-length child of a broken parent *does* break, but only because
*it* overflows the remaining width, not because the parent did. At width
80, `matrix: [[1, 2, 3, 4], …]` is one line; the same file at 40 opens
the outer sequence and keeps each inner four-tuple flat.

### A trailing comment does not count toward its line's width

`items: [aa, bb, cc] # this comment is long enough to overflow a forty column budget`
is 83 characters at both widths. Prettier leaves it flat. The collection
itself fits; the comment is ignored for the break decision. Same for
`host: localhost-example # a fairly long trailing comment about the host`
and for every trailing comment in `comments.yaml` / `keys.yaml` /
`kitchen.yaml`.

Prettier will **not** destroy a flat collection in a futile attempt to
fit a comment it cannot move. That is the opposite of taplo. Trailing
comments also never wrap, and own-line comments never wrap.

`fits` in this project's printer *does* count a trailing comment. A
package that uses a normal `group` around a flow collection will break
earlier than prettier on any pair whose comment is what pushes the line
over. Stage C should expect that divergence and classify it as a design
limit (or a house-style choice), not a corpus bug.

### Token-level normalisation

Spacing, delimiter padding, indentation — as opposed to line level:

- One space after `:`. Hand-padded `name:    demo` collapses.
- Flow sequences: `[1, 2, 3]` — no padding inside the brackets, space
  after each comma. `[ 1 , 2 , 3 ]` and `[1,2,3]` both become that.
- Flow mappings: `{ x: 1, y: 2 }` — **does** pad inside the braces.
  `{x: 1,y: 2}` becomes padded. Arrays and maps are not the same shape.
- Sequence dashes are indented one level under their key. Flush
  `root:\n- a` becomes `root:\n  - a`.
- A nested sequence written with the dash on its own line becomes the
  compact `- - item` form.
- A source trailing comma on a *flat* flow collection is dropped. A
  *broken* flow collection gets a trailing comma (the `trail` policy).
- Runs of spaces or a tab before a trailing comment become one space.
  Prettier does **not** align trailing comments with siblings.
- Blank-line runs cap at one (`blank_cap` 1). Zero is left alone.
- Explicit `?` keys become implicit (`? explicit\n: value` →
  `explicit: value`). The `?` is anonymous; the named tree is unchanged,
  so gate 3 accepts the rewrite.
- A hand-broken flow collection that fits and has no comment is collapsed.
  A comment anywhere inside pins it open.
- A comment on the same line as `[` or `{` is moved to the next line
  (or onto the key: `items: [ # c` becomes `items: # c` then a broken
  collection). Comment *text* and *order* are preserved.

Quote style is a token rewrite, not spacing:

- `'hello'` → `"hello"` (default `singleQuote: false`).
- `"say \"hi\""` → `'say "hi"'` (prefer the quote that needs no escape).
- `"plainish"` is **not** unquoted. `hello` is **not** quoted.
- `null` / `~` / empty, `yes` / `true`, `0xFF` / `255` are not rewritten
  into each other.

The first two quote rewrites change `single_quote_scalar` /
`double_quote_scalar` leaf text. Gate 3 would reject the reference, so
they are not in the corpus. They remain a finding: the linearity
invariant forbids any package from matching prettier on quote
normalisation. Files that started life single-quoted are unwinnable for
that reason, the same way black-without-`-S` made Python strings
unwinnable.

### Prettier reindents block-scalar bodies; that rewrite is now rejected

`block_scalar` has no named children. The indicator (`|`, `>-`, `|2`, …)
is an anonymous child; the interior is an untokenised source gap, not a
child. prettier reindents a 4-space literal to 2-space. The YAML *data*
is unchanged (the block indent is stripped), but a package cannot
reproduce the rewrite: there is no named child to recurse into, so the
construct needs `verbatim`, which preserves the source bytes including
a non-canonical indent.

The previous draft said gate 3 discarded that gap and therefore accepted
both a reindent and a body rewrite (`d: |\n  x` → `d: |\n  y`). That
account of the gate was wrong. After `06a7694` on `main`, a node whose
children are all anonymous keeps any non-whitespace source gap. Confirmed
on the live `tree-sitter-yaml` grammar: body rewrite, body deletion,
folded-body rewrite, and a 2-space → 4-space reindent are all rejected;
`[ ]` → `[]` and `{ }` → `{}` are still accepted, because those gaps are
whitespace only.

So a block-scalar body rewrite **is** rejected. `block_scalars.yaml` is
already at prettier's 2-space indent with canonical indicator order
because a non-canonical body would fail "the reference must pass gate 3",
not because the gate is blind. Matching prettier's reindent remains
impossible under linearity. The same is true of indicator-order
canonicalisation (`|-2` → `|2-`) and terminal whitespace / chomping
layout; those stay omitted.

A relative extra indent inside the block (`echo hello` then `  nested`)
is data and is preserved. Folded `>` interiors are **not** reflowed, even
at 150 columns. Chomping indicators and the indent indicator stay.
The file's noncanonical spacing is around the keys (`script : |`,
`desc:  >`), which prettier collapses and gate 3 accepts.

### Anchors, aliases, tags, multi-document streams

The grammar gives these distinct node types, observed:

- `anchor` / `anchor_name`, `alias` / `alias_name`
- `tag` (local `!custom` and global `!!str` are the same kind)
- `yaml_directive` / `yaml_version`; `%TAG` is a directive
- `stream` of `document`; `---` and `...` are anonymous

Prettier preserves all of them. An anchor on a flow mapping that breaks
moves onto the next line (`pair:\n  &p { … }`) and stays an anchor; the
mapping is not converted to block. Merge keys (`<<: *def`) stay merge
keys.

### What a node-type table cannot express, named

- **Quote normalisation.** No opcode rewrites token text.
- **Block-scalar reindent.** The interior is not in the tree; `verbatim`
  preserves source bytes, including an indent prettier would change.
  Gate 3 now keeps that gap, so a non-canonical body also fails "the
  reference must pass".
- **Explicit-key canonicalisation.** Prettier removes the anonymous `?` from a
  simple explicit mapping key; no package policy may delete it.
- **"Break this group only if the *collection* overflows, ignoring a
  trailing comment."** `fits` counts the comment. Prettier does not.
- **Moving a comment from after `[` onto the key.** Comment attachment is
  runtime-owned and does not relocate a comment across a token like that.
- **Sibling-aware comment alignment** is not a prettier behaviour, so it
  is not a YAML problem. (It was taplo's.)

Block vs flow is *not* on this list: prettier preserves the tree's
spelling, and a table that emits what it is given matches.

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as
written. No harness script was edited. `./test.sh` is green: yaml is
reported as `awaiting package` and excluded from scoring, which is the
stage-0 fix the TOML builders asked for.

## Files touched outside `corpus/` and `harness/languages/`

```
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

No `rust/`, no `runtime-js/`, no shared harness script. The grammar pin
is in the manifest; it is not in anyone's inline `dependencies` block.

## Template delta

The brief says `--stdin-filepath` is "genuinely required for prettier". That is
true when the parser is inferred from a name, which is how JSON works. YAML can
set `--parser yaml` instead. The template should describe these as alternative
parser selectors and ask for the smaller verified command; it should not imply
that filepath inference is universally required. With `--no-config`, the
filepath did not reopen editorconfig in either prettier version tested.

The widths guess `[80, 40]` was right for prettier. The grammar guess
was right. `gate3 = "default"` held.
