# Go corpus report (stage A)

## Manifest

`harness/languages/go.toml`. Every field that could have been guessed was
observed, re-verified against the live tooling rather than taken from the
previous (interrupted) run.

| Field               | Value                                   | How it was established                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`           | `tree-sitter-go==0.25.0`                | Live PyPI: the distribution name matches the orchestrator's guess, and 0.25.0 is the latest release (checked against `https://pypi.org/pypi/tree-sitter-go/json`, 2026-08-16).                                                                  |
| `grammar_module`    | `tree_sitter_go`                        | `uv run --with tree-sitter-go==0.25.0` then `import tree_sitter_go`. The hyphen-to-underscore swap is correct.                                                                                                                                 |
| `grammar_symbol`    | `language`                              | The module exports `language()` (and `HIGHLIGHTS_QUERY`, `TAGS_QUERY`); it returns a `tree_sitter.Language` capsule.                                                                                                                            |
| `reference`         | `nix shell nixpkgs#go -c gofmt`         | Source on stdin, formatted source on stdout, no fake filename needed. There is no `nixpkgs#gofmt` attribute — gofmt ships inside the go distribution, and `nix run nixpkgs#go` runs `go`, not `gofmt`. `nix shell … -c gofmt` is the working form. |
| `reference_version` | `go version go1.26.5 linux/amd64`      | Printed by `nix shell nixpkgs#go -c go version`. More directly, `go version $(command -v gofmt)` reads the formatter executable's embedded build version as `go1.26.5`, and both binaries resolve inside the same `...-go-1.26.5` Nix output. gofmt has no version flag.                                            |
| `reference_width`   | `fixed`                                 | gofmt has no width knob and does not reflow: a 166-character call stays on one line, its help exposes no width option, and there is no `{width}` to pass. `"fixed"` with a single measurement width is the honest entry.                                                                                         |
| `widths`            | `[80]`                                  | `"fixed"` requires exactly one width. 80 is an arbitrary round measurement width, not a gofmt setting or an official Go default. It only feeds the scorer's comparative line-length measure, which gofmt ignores.                                                                                              |
| `gate3`             | `default`                               | See below.                                                                                                                                                                                                                                      |
| `transparent_wrappers` | `["parenthesized_expression"]`       | Established by running gofmt over the corpus, not by reading the grammar: gofmt removes a redundant inner pair of parentheses (`((1))` → `(1)`) while leaving a single level in place.                                                          |
| `equivalent_kinds`  | `[]`                                    | Nothing was renamed.                                                                                                                                                                                                                            |
| `injection_aliases` | `["go", "golang"]`                      | `go` is canonical; `golang` is the conventional alias (PyMarks / highlight.js both accept it).                                                                                                                                                  |

### gofmt reads no config

gofmt has no config file format, so there is nothing to disable: its output
depends only on the source bytes on stdin. Verified by running it in an empty
directory and in a directory containing a planted `.editorconfig` — identical
output. (`.editorconfig` is the only plausible ambient file that even purports
to affect Go indentation, and gofmt ignores it.) Unlike taplo there is no
config search to suppress, and no environment variable that changes formatting.

`nix shell nixpkgs#go` is not pinned the way `uvx black@25.9.0` is. A nixpkgs
channel bump would change the binary; `gen_reference.py --check` is what would
show it. `reference_version` records the toolchain that actually wrote the
files. Because gofmt has no version flag, the strongest local check is `go
version $(command -v gofmt)`: it inspects gofmt's own embedded build information
and reports `go1.26.5`. The formatter and `go` command also resolve from the same
Nix store output, rather than merely happening to be on the same `PATH`.

### Why `gate3 = "default"`

The generic named-node comparison is the right oracle for Go. The obvious
override — `go/parser` + a `go/ast` dump — would be a *weaker* oracle, and for
the usual reason: it is a data-model loader, not a formatter. A node dump
cannot see gofmt's column alignment (struct fields, const blocks, trailing
comments) or comment placement, and would accept the very token rewrites a
package may never perform. There is no spelling-equivalence problem that would
justify a loader: Go has one literal spelling per construct (no quote-style
swap, no numeric respellings a formatter would perform), and the generic
default already refuses `ERROR` / `MISSING` and compares extras order, which is
where comments live.

`check_gate3.py --language go`: 16 reference outputs accepted, 32 destructive
mutations rejected, 279 useful adversarial mutations checked, 0 wrapper kinds
that would need an override.

## Corpus

Sixteen files in `corpus/src/go/`. Each is valid Go: clean under
tree-sitter-go 0.25.0 (no `ERROR` / `MISSING`).

Required probes:

- `normalisation.go` — input written the way a person writes it and gofmt does
  not: spaces around parameters and inside parens (`func normalise( a int , b
  int )`), redundant parens (`((1))`), space inside brackets (`[ 3 ]int`),
  explicit semicolons, a run of spaces before a trailing comment, over-indented
  tabs. The `func weird( )` parameter list in this file is the probe that
  exposed the gate-3 "anonymous-token whitespace is layout" defect (`( )` →
  `()`); it stays because it earned its place.
- `alignment.go` — gofmt's column alignment, the construct the runtime gives
  rules no way to express. See the dedicated section below.
- `nesting.go` — composite literals inside composite literals (slice of slices,
  map of maps, a self-referential tree literal), deep enough that no single
  line holds them.
- `long_sequences.go` — the constructs that most often overflow a line: a long
  argument list, a chained method call, a long slice literal, a map of slices.
- `comments.go` — every position a comment can sit: file-level, trailing on an
  import, doc comment, own-line and trailing inside a body, inside a slice
  literal, a block comment, before a closing brace, at end of file.
- `strings.go` — interpreted, raw (multi-line), and rune literals, escapes,
  struct tags, unicode, astral characters.
- `composite_literals.go` — slice/map/struct literals: single-line with a
  trailing comma, hand-broken, a slice of struct literals, nested slices.
- `control_flow.go` — if/else chains, classic `for`, `range` `for`, type switch,
  `select`.
- `functions.go` — short, many-arg, named returns, variadic, pointer- and
  value-receiver methods.
- `generics.go` — type parameters, generic methods, generic functions,
  constraint interfaces with type sets.
- `imports.go` — the four import forms: plain, aliased, blank, dot.
- `interfaces.go` — interface declarations, embedding, compile-time interface
  assertions.
- `iota.go` — `iota`, implicit repetition, bit-shift definitions.
- `operators.go` — binary operator spacing by precedence.
- `structs.go` — field embedding, field tags, empty struct, type alias,
  multi-name fields.
- `kitchen.go` — several constructs interacting, the one file allowed to be
  messy.

## Counts (from `cmp` loops)

- **Files gofmt changes at all: 16 of 16.** `for f in corpus/src/go/*.go; do
  cmp -s "$f" "corpus/reference/go__$(basename "$f" .go)@80.txt" …` reports no
  byte-identical input/output pair.
- **Files carrying a comment: 16 of 16.** The universal extras layer of gate 3
  has comments as its only input; a comment-less file is a file where that layer
  is inert. The previous run left 12 of 16 files comment-less (4 carried a
  comment); this run added comments to every remaining file so the extras layer
  is exercised across the whole corpus. `check_gate3.py` consequently reports
  32 destructive mutations rejected (up from 20), because the dropped-comment
  arm now has a comment to drop in every file.
- **"Differs between two widths" does not apply.** gofmt has one output. There
  is a single width in the manifest (`[80]`), and `reference_width = "fixed"`
  forbids more. A comparison loop over two independent reference invocations
  found 0 of 16 differences; those are determinism runs, not two width settings.
  Nothing in the corpus can tell two widths apart because the reference has no
  width to tell.

## What gofmt does that surprised me

### It has no width, and that is the finding

gofmt refuses to reflow. A 166-character call, a chained method call, and a long
slice literal all stay on one line. The manifest is `reference_width = "fixed"`
and agreement-at-two-widths is structurally inapplicable.

The current scorer nevertheless computes and prints `its own overflow: N`
against the manifest's arbitrary 80. That label is misleading: gofmt has no
target width to overflow. For a fixed-width reference the human report should
print `its own overflow: n/a (fixed reference; measurement width 80)` (and the
package's width gate remains waived). The raw count may remain in JSON as a
comparative line-length diagnostic if it is explicitly named as such. A stage-C
package that emits gofmt's output byte for byte needs no width at all.

### Line structure is source-driven, not width-driven

gofmt preserves the author's single-line vs multi-line decision for composite
literals and argument/parameter lists, and it does so on both sides:

- a single-line literal is never split, however long (see `long_sequences.go`);
- a hand-broken literal with no comment is **kept broken**, not collapsed
  (`broken` / `brokenMap` / `matrix` in `composite_literals.go`). This is the
  opposite of taplo, which collapses a broken array that fits and has no
  comment.

The one structural exception is a redundant parenthesis pair, which gofmt
*removes* (`((1))` → `(1)`), renaming the tree — hence
`transparent_wrappers = ["parenthesized_expression"]`.

### When a container breaks, the containers inside it do not

gofmt never breaks a container the source wrote single-line, even when it sits
inside a broken parent. A broken argument list whose argument is a single-line
`[]int{1, 2, 3}` keeps that inner literal on one line (verified). This is the
opposite of taplo's cascade. A package that models each container as an
independent group — breaking children because the parent broke — would diverge
on every nested literal in `nesting.go` and `composite_literals.go`.

### A trailing comment does not count toward line width (there is no width)

The question "does a trailing comment count toward its line's width" is moot
for gofmt — nothing counts toward a width. Comments *do* pin line structure: a
comment inside a composite literal forces it open, and a trailing comment after
an element pins that element to its line, but gofmt never reflows a line to
make room for a comment the way taplo pads a sibling to align one.

### Token-level normalisation is the real job

At token level gofmt rewrites aggressively:

- binary-operator spacing follows precedence — `a+b*c+d/e` → `a + b*c + d/e`,
  but the mixed-precedence case is the sharp one: `a+b<c+d&&a!=0` →
  `a+b < c+d && a != 0` (tight `+` inside the comparison operand, spaced
  comparison and logical operators);
- comma spacing (`f(first, second)`) and `:=`/`=` spacing;
- padding inside brackets and braces is removed (`[ 3 ]int` → `[3]int`,
  `{ 1, 2, 3 }` → `{1, 2, 3}`);
- explicit semicolons are removed (`var semis = 1; var two = 2`);
- indentation is normalised to tabs (the corpus is written with two-space
  indentation in places specifically so gofmt has to fix it);
- a trailing comma on a single-line composite literal is removed; a multi-line
  one keeps it.

### Alignment is computed across siblings, and resets on blank lines

This is the single most important thing Go has to teach this project, and the
corpus leans into it. gofmt aligns:

- struct field names and types in two columns (`Server`);
- struct fields with tags in three columns, tag and all (`Config`);
- a field's trailing comment in a third column (`Commented` — name, type, and
  comment each align);
- const values on `=` (`StatusOK` block) and const trailing comments in their
  own column (`One`/`TwoLonger`/`Three`);
- trailing comments on consecutive top-level declarations (`var first … // …
  var secondLonger … // …`).

The subtle part is `Grouped`: a blank line ends an alignment group. `A`/`B`
align with each other, then `LongFieldName`/`C` start a fresh group. The
runtime deliberately gives rules no way to express "align to the longest
*sibling within the current non-blank run*", because the grouping is not a
property of any one node. A package that aligns all siblings uniformly diverges
here; stage C should expect this file to be a design limit, not a bug.

### Comments are extras, and gofmt preserves them exactly

gofmt keeps every comment, in order, attached to the right place — doc comments
before a declaration, trailing comments on their line, block comments intact,
a comment at end of file. Comments are extras in tree-sitter-go, parented under
the nearest construct; the extras sequence preserves order, which is why gate
3's universal layer is sufficient and no override is needed.

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as written,
including installing the pinned grammar. No harness script was edited.
`gen_reference.py --language go --check` is silent (exit 0): the committed
reference output is reproducible.

## Files touched outside `corpus/` and `harness/languages/`

None. After merging the current `main`, the branch-only diff excluding those two
paths is empty:

```
$ git diff --stat main...HEAD -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

No `rust/`, no `runtime-js/`, no `packages/`, no shared harness script. The
grammar pin is in the manifest; it is not in anyone's inline `dependencies`
block.

## Template delta

- **"A third of files must differ between two widths" cannot apply.** gofmt has
  one output. The manifest says `reference_width = "fixed"`, which is the
  schema's own way of expressing "this reference has no width". I did not
  invent a second width to satisfy a property the reference cannot meet.
- **"The reference's own overflow count" cannot apply as currently worded.**
  There is no width to overflow. The brief should say what the scorer prints for
  `reference_width = "fixed"`; `n/a (fixed reference; measurement width 80)` is
  honest, while an unlabeled count against arbitrary 80 is not.
- **"Most files should carry a comment" was the one real miss in the previous
  run**, at 4 of 16. It is fixed (16 of 16), and the report states the count
  rather than asserting it.
- **“Pinned-runner” is too strong for the Nix examples.** `nix shell
  nixpkgs#go` records and rechecks an observed version but follows the caller's
  nixpkgs registry; it does not pin a revision the way `uvx black@25.9.0` pins a
  release. The brief should call this a runner pattern or require a locked flake
  reference when it truly means pinned.
- **`--stdin-filepath` is noise for gofmt.** Unlike prettier, gofmt infers
  nothing from a filename on stdin; there is no fake filename to pass. The
  runner form `nix shell nixpkgs#go -c gofmt` is the whole command, and
  `nix run nixpkgs#go` would run `go`, not `gofmt` — worth recording because a
  later Go-adjacent language could copy the wrong form.
- **`./test.sh` does go green at stage A now.** The `awaiting_package` path in
  `score.py` (landed after the TOML slice) reports `awaiting package  go
  (corpus landed, not yet scored)` instead of a coverage failure, so this slice
  needs no stub package and no `score.py` edit.
