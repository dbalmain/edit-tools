# TOML corpus report (stage A)

## Manifest

`harness/languages/toml.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                                     | How it was established                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grammar`              | `tree-sitter-toml==0.7.0`                                                 | Live PyPI: the distribution name matches the orchestrator's guess, and 0.7.0 is the latest release.                                                                            |
| `grammar_module`       | `tree_sitter_toml`                                                        | `uv run --with tree-sitter-toml==0.7.0` then `import tree_sitter_toml`. The hyphen-to-underscore swap is correct here.                                                         |
| `grammar_symbol`       | `language`                                                                | The module exports `language()` (and `HIGHLIGHTS_QUERY`). It returns a `tree_sitter.Language` capsule.                                                                         |
| `reference`            | `nix run nixpkgs#taplo -- fmt --no-auto-config -o column_width={width} -` | Source on stdin, formatted source on stdout. `--stdin-filepath` is **not** required: taplo treats `-` as TOML without a fake name. `--no-auto-config` **is** required (below). |
| `reference_version`    | `taplo 0.10.0`                                                            | Printed by `nix run nixpkgs#taplo -- --version`. Not assumed.                                                                                                                  |
| `reference_width`      | `flag`                                                                    | Ran the same input at 88 and 60 and diffed. Arrays reflow; almost nothing else does. `{width}` is therefore real, and `"fixed"` would be a lie.                                |
| `widths`               | `[88, 60]`                                                                | As asked. taplo's own default is 80, not 88; both scored widths still produce different array layouts on this corpus.                                                          |
| `gate3`                | `default`                                                                 | See below.                                                                                                                                                                     |
| `transparent_wrappers` | `[]`                                                                      | Gate 3 accepted taplo on 28/28 runs without naming a wrapper.                                                                                                                  |
| `equivalent_kinds`     | `[]`                                                                      | Same: nothing was renamed.                                                                                                                                                     |

### `--no-auto-config` is load-bearing

taplo walks from cwd (and ancestors) for `.taplo.toml` / `taplo.toml`. A planted
config with `reorder_keys = true` silently reordered keys.
`--stdin-filepath somedir/x.toml` does **not** load `somedir/.taplo.toml`; cwd
and ancestors do. There is no config in this worktree or its ancestors today, so
auto-config and `--no-auto-config` currently agree here. They will not agree on
a machine that has a `taplo.toml` in `$HOME` or any parent of the checkout. The
committed command therefore includes `--no-auto-config`.
`gen_reference.py --check` is silent with that command.

Reviewer correction to the precedence, established by planting
`column_width = 20` alongside `reorder_keys = true` and re-running: a discovered
config does **not** override `-o`. `-o column_width=88` wins over the file's
`column_width = 20`; with no `-o` the file's value applies. What leaks from a
discovered config is every option the command line does not name —
`reorder_keys`, `allowed_blank_lines`, `align_comments`, `indent_string` — which
is why the flag is still load-bearing. Also note that `--no-auto-config`
disables only the _search_: an explicit `-c` or a `TAPLO_CONFIG` environment
variable is still honoured (verified — `reorder_keys` still applied). That is
the one residual way this corpus could be regenerated non-reproducibly.

`nix run nixpkgs#taplo` is not pinned the way `uvx black@25.9.0` is. A nixpkgs
channel bump would change the binary; `--check` is what would show it.
`reference_version` records the binary that actually wrote these files.

### Why not `gate3 = "toml"` / `tomllib`

`tomllib` is in the stdlib and is a real loader. It is **weaker** than the
generic named-node comparison for the reason that matters in TOML: the same data
has several legal spellings (`[a.b]` vs `[a][b]`, inline table vs header, dotted
key vs table, `[[x]]` vs an array of inline tables) and `tomllib.loads`
collapses all of them. A package that rewrote spelling would pass `tomllib` and
fail the tree comparison. The tree comparison is the right oracle.

`tomllib` would add an independent-parser validity check, but the generic
default already refuses `ERROR` / `MISSING`, and taplo's output is valid TOML by
both parsers on this corpus. Comments are not the override's problem: `gate3.py`
compares extras underneath every override.

`check_gate3.py --language toml`: 28 reference outputs accepted, 54 destructive
mutations rejected, 0 wrapper kinds needed.

## Corpus

Fourteen files in `corpus/src/toml/`. Each is valid TOML: clean under
tree-sitter-toml 0.7.0 (no `ERROR` / `MISSING`), `tomllib`, and `taplo lint`.

Required probes:

- `nested.toml` — arrays of arrays, arrays of inline tables, inline tables
  holding arrays, a dotted table path four segments deep. Width 88 keeps
  `matrix` and `deep` flat; width 60 explodes them one element per line.
- `arrays.toml` — the construct that overflows. Empty, short, medium (fits 88,
  breaks 60), long (breaks both), a source trailing comma, mixed types, and a
  hand-broken array that taplo collapses because it fits and has no comment.
- `comments.toml` — every legal position: file-level, trailing on a pair,
  own-line before a header, trailing on a header, own-line inside a table, after
  `[` on the same line, trailing on an item, own-line between items, before `]`,
  between tables, at the end of a table, consecutive own-line, end of file.
  Inline tables cannot hold comments (a comment forces a newline; newlines are
  illegal there). That is a language fact, not a missing probe.
- `strings.toml` — basic, literal, both multi-line forms, escapes, empty,
  quote-style pairs, a hash that is not a comment, unicode, astral scalars, a
  long basic string that taplo will not wrap.
- `kitchen.toml` — root pairs, a dotted table path, dotted keys mixed into an
  already-opened table, arrays of tables, inline tables, a multi-line string,
  comments in two positions, arrays that reflow.

Characteristic of TOML, one line each:

- `tables.toml` — `[table]` vs dotted `[a.b.c]`, an implicit parent, an empty
  table. The header spelling is the document structure; getting it wrong is the
  first thing a reader would see.
- `inline_tables.toml` — the other table spelling. taplo never breaks one, even
  when it overflows; an array _inside_ one is the only way it becomes
  multi-line.
- `arrays_of_tables.toml` — `[[products]]`, a subtable, nested
  `[[products.sizes]]`, an empty element, a trailing comment on a header.
  Distinct from an array of inline tables and not interchangeable with one.
- `dotted_keys.toml` — `a.b.c = value` as pairs, not headers, including a quoted
  segment (`site."google.com"`) and a dotted key that continues a table already
  opened by `[client]`.
- `keys.toml` — bare, dashed, underscored, digits, `true`/`false`/`inf` as keys,
  basic and literal quoted keys, `"a.b"` vs `a.b` (different keys), unicode,
  spaces, a quoted escape.
- `numbers.toml` — underscores, `+`/`-`, hex/oct/bin, both hex cases, exponent
  forms, `inf`/`nan` with all three signs. taplo preserves every spelling.
- `dates.toml` — the four datetime types, including the space-vs-`T` offset form
  and fractional seconds. Four distinct node kinds (`offset_date_time`,
  `local_date_time`, `local_date`, `local_time`).
- `spelling.toml` — the same data written every legal way in one file, so a
  later package that normalises between them is visible as a tree diff against
  taplo, which does not.
- `blank_lines.toml` — blank lines are the only grouping TOML has between pairs.
  taplo caps runs at 2 and leaves 0 and 1 alone.

Width actually changes four files: `arrays`, `nested`, `kitchen`, `spelling`.
The other ten are identical at 88 and 60. That is taplo, not a corpus hole.

## What taplo does that surprised me

This is the useful section.

### It does not normalise between legal spellings

`[a.b]` stays `[a.b]`. `[a]` then `[a.b]` stays two headers. An inline table
stays inline; a table header stays a header. `[[x]]` stays an array of tables;
`x = [{…}]` stays an array of inline tables. Dotted keys stay dotted.
`"foo-bar"` stays quoted; `foo-bar` stays bare. `"a.b"` and `a.b` remain
different keys.

A formatter that collapsed any of these would be making a semantic-ish choice.
taplo does not. A node-type table can match this by emitting what the tree has.

### Width is an array budget, not a line budget

`column_width` expands and collapses **arrays** (including arrays nested inside
inline tables and arrays of inline tables). It does not wrap:

- strings, including ones far longer than the budget
- inline tables (the `overflows` pair in `inline_tables.toml` is 113 characters
  at both widths)
- dotted keys, table headers, key/value pairs

So `reference_width = "flag"` is correct, but a package that treats `{width}` as
prettier-style print-width will over-break relative to taplo. taplo's own
default is 80; we score 88 and 60 anyway, and both still move arrays.

Multiline arrays get a trailing comma; a single-line array never keeps one. A
hand-broken array that fits and has no comment is collapsed (`already_broken` in
`arrays.toml`). A comment anywhere inside an array pins it open.

### Comment alignment is sibling-aware and width-dependent

`align_comments` defaults on. Consecutive trailing comments on pairs line up
with each other (`comments.toml`, columns 28 at both widths).

The kitchen file is sharper. At width 88 the root block is four consecutive
pairs, only one of which has a trailing comment. taplo pads that comment so it
starts just past the **longest sibling line**, which is `features = […]` at 83
characters — a line that has no comment at all. The result is a 107-character
line, over `column_width`. At width 60 `features` itself breaks, so it is no
longer a long single line, and the comment sits one space after its pair.

That is three things a node-type table cannot express at once: look at sibling
formatted widths, pad a comment on a _different_ node, and have the padding
depend on whether a sibling array broke. Stage C should expect to diverge on
`kitchen@88` (and on the aligned block in `comments.toml`) and classify that as
a design limit, not a package bug.

Comments are extras. tree-sitter-toml parents them under the nearest enclosing
construct: a trailing comment on a pair is a child of that `pair`; a comment
sitting between two tables is a child of the _previous_ table; a comment at the
end of the file is a child of the last table. The grammar does not say which
construct a floating comment "belongs to". The extras sequence still preserves
order, which is why gate 3's universal layer is enough here.

### Inline tables become multi-line only through a broken value

`{ name = "primary-server", tags = [ … ] }` is the case. The table itself does
not break; the array inside it does, and the braces end up on different lines.
Nested inline tables stay on one line. Trailing commas and comments inside an
inline table are syntax errors, not style choices.

### Number, date, and string spellings are preserved exactly

`0xDEAD_BEEF` vs `0xdeadbeef`, `+inf` vs `inf`, `1979-05-27 07:32:00Z` vs the
`T` form, `"hello"` vs `'hello'`, multi-line inner whitespace including runs of
more than two blanks. None of these are rewritten. Quote normalisation is not a
taplo behaviour and will not be a source of unwinnable files the way it is
against black.

### Blank lines cap at 2

Three or more consecutive blanks become two (`allowed_blank_lines`). Zero and
one are left alone. That is `["blank", 2]` if a later package wants it.

### Config discovery would have made this corpus unreproducible

Covered above. Mentioned here because it is the kind of "output depends on
something other than the input line" finding the brief asked for. With
`--no-auto-config` the output is deterministic: two runs of the same stdin
match, and `gen_reference.py --check` is silent.

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as written.
No harness script was edited.

## Files touched outside `corpus/` and `harness/languages/`

None. No `rust/`, no `runtime-js/`, no shared harness script. The grammar pin is
in the manifest; it is not in anyone's inline `dependencies` block.

## Template delta

**`./test.sh` cannot go green at stage A.** `test.sh` runs `score.py`, and
`score.py` requires a package for every language that has trees. This slice is
forbidden to write one. Result, as run: rust/js unit suites green, clippy
`-D warnings` green, `check_gate3.py` green across all three languages (58
reference outputs, 90 mutations rejected), `check_width.py --language toml`
green at 1414/1414 (both runtimes refuse every toml tree — shared refusal is
agreement), then `score.py` reports 30/58 coverage and DISQUALIFIED because
`packages/toml.json` does not exist.

That is not a toml-shaped fact. It is the brief asking for a green `./test.sh`
from a stage that cannot produce one. I did not add a `toml` branch to
`score.py` and I did not add a stub package.

The missing piece is a way to say "this language has a corpus and no package
yet". Two shapes, either of which is a one-file-friendly change:

1. A manifest field, e.g. `score = false`, default true. Stage A sets it; stage
   C flips it. Needs a line in `manifest.py`'s `_KNOWN` set — a shared edit, but
   a small one, and every later language needs it.
2. No new field: `score.py` skips a language that has no `packages/<name>.json`,
   and reports it as unscored rather than as a coverage failure. No schema
   change; still a shared-file edit.

(1) is louder. (2) is less work. Either is better than the current "stage A
lands a red `./test.sh`" or "stage A writes a fake package".

The WORKFLOW.md example command includes `--stdin-filepath x.toml` and omits
`--no-auto-config`. The filepath is unnecessary for taplo; the auto-config flag
is the one that decides whether the committed files are reproducible. The
example widths are `[60, 80]`; the brief asked for `[88, 60]`. I followed the
brief, and 80 is taplo's default rather than a scored width.

`nix run nixpkgs#taplo` is the documented runner and it works. It is not a
version pin. If later languages using `nix run nixpkgs#…` start drifting under
`--check`, the template will want a pinned nixpkgs rev the way the python and
json commands pin a package version.
