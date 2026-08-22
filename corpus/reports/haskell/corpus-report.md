# Haskell corpus report (stage A)

Builder: **grok-4.6 via the grok CLI**. Reviewed at stage B by **Opus**.

## Stage B review, and what it changed

Verdict: **pass with fixes applied**. Everything the builder measured
re-measured identically — all 16 reference files (15 at the time) are
byte-identical to a fresh `ormolu` run, `corpus_stats` and `check_gate3`
reproduce, the `reference_width = "fixed"` claim survives an independent test,
and the FINDINGS 12 call is correct.

Two gaps were found and fixed in the corpus, both of the same kind — a rewrite
ormolu performs that no corpus file made it perform:

1. **`import_merging.hs` added**, and the `[incomparable]` block rewritten.
   ormolu collapses repeated imports of one module as well as sorting them; the
   manifest recorded only the sorting. See
   [the incomparable section](#incomparable-the-import-block-which-is-two-rewrites-not-one).
2. **`normalisation.hs` no longer supplies the blank line after its module
   header**, so ormolu has to insert it. Previously all fifteen files supplied
   it and the claimed rewrite was unprobed.

Neither gap was visible to any count: after both fixes the four `corpus_stats`
numbers are what they would have been anyway. Details in [Counts](#counts).

## Manifest

`harness/languages/haskell.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                  | How it was established                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-haskell==0.23.1`                          | Live PyPI (`https://pypi.org/pypi/tree-sitter-haskell/json`). The distribution name matches the orchestrator's guess. Releases on the index are 0.21.0, 0.23.0, 0.23.1; 0.23.1 is latest. The `0.7.0` guess does not exist.                                                                                                  |
| `grammar_module`       | `tree_sitter_haskell`                                  | `uv run --with tree-sitter-haskell==0.23.1` then `import tree_sitter_haskell`. The hyphen-to-underscore swap is correct.                                                                                                                                                                                                     |
| `grammar_symbol`       | `language`                                             | The module exports `language()` (plus `HIGHLIGHTS_QUERY`, `INJECTIONS_QUERY`, `LOCALS_QUERY`). It returns a `tree_sitter.Language` capsule.                                                                                                                                                                                  |
| `injection_aliases`    | `["haskell", "hs"]`                                    | `haskell` is canonical. `hs` is the conventional short alias (highlight.js lists `haskell`, `hs`, `lhs`). `lhs` is literate Haskell, a different surface syntax, and is not this grammar.                                                                                                                                    |
| `reference`            | `nix run nixpkgs#ormolu -- --no-cabal --no-dot-ormolu` | See below.                                                                                                                                                                                                                                                                                                                   |
| `reference_version`    | `ormolu 0.8.0.2`                                       | Printed by `nix run nixpkgs#ormolu -- --version` (also `using ghc-lib-parser 9.12.3.20251228`). Observed, not assumed.                                                                                                                                                                                                       |
| `reference_width`      | `fixed`                                                | There is no CLI width flag. `--column`, `--print-width`, `--line-length` and `--max-width` all reprint usage. A 187-character export list, a 155-character list and a 177-character equation all stay on one line. Two runs of the command are identical because there is nothing to pass. `{width}` is therefore forbidden. |
| `widths`               | `[80]`                                                 | `"fixed"` requires exactly one entry. 80 is an arbitrary measurement width, not an ormolu setting: ormolu has no column limit (fourmolu added one because ormolu does not). It only feeds the scorer's comparative line-length measure.                                                                                      |
| `gate3`                | `default`                                              | See below.                                                                                                                                                                                                                                                                                                                   |
| `transparent_wrappers` | `["parens"]`                                           | Named by the gate, then proved. ormolu parenthesises a single-constraint context (`class Eq a =>` → `class (Eq a) =>`), wrapping the `apply` in a one-child `parens`. Operator sections are `left_section` / `right_section` / `prefix_id`, not `parens`.                                                                    |
| `equivalent_kinds`     | `[]`                                                   | Nothing was renamed.                                                                                                                                                                                                                                                                                                         |

### Command: `--no-cabal` is required; the other flags were tested and dropped or kept for a reason

Nothing is installed globally. `nix run nixpkgs#ormolu` is the runner; the
nixpkgs attribute exists and runs ormolu, unlike `nixpkgs#gofmt` which does not.

**Stdin without `--no-cabal` refuses.** Exit 9,
`The --stdin-input-file option is necessary when using input from stdin and accounting for .cabal files`.
`--no-cabal` is the flag that makes stdin work. No fake filename is needed:
`--stdin-input-file x.hs`, `x.haskell`, and omitted are byte-identical once
`--no-cabal` is set. The brief's `x.haskell` warning does not apply; ormolu does
not infer a parser from a filename.

**Ambient config, two channels, planted options the command line does not
pass.**

`.cabal` / `--stdin-input-file`. A planted `dummy.cabal` with
`default-extensions: ImportQualifiedPost` (an extension in `--manual-exts`, not
on by default) rewrites `import qualified Data.List as L` to
`import Data.List qualified as L` when `--stdin-input-file` points at a file
next to that cabal. `--no-cabal` leaves the qualified-pre form in place.
`--debug` shows `cfgDynOptions = [DynOption "-XImportQualifiedPost"]` with the
cabal file and `[]` without it.

What a discovered cabal can still supply: `default-extensions` (and
dependencies, which feed operator fixity). Command-line `-o -X…` **overrides by
adding**, it does not merely fill gaps — `-o -XImportQualifiedPost` on a command
that also has `--no-cabal` still rewrites the import. Residual channel of
`--no-cabal`: `-o` on the CLI. This command does not pass `-o`.
`--stdin-input-file` is the remaining search channel if `--no-cabal` is dropped.

`.ormolu`. Discovered from a **file path** (`--stdin-input-file` or a FILE arg),
not from cwd on bare stdin. A planted `infixr 0 +++` changes a broken operator
chain from hanging-infix

```
f =
  a
    +++ b
    +++ c
```

to a right-assoc staircase

```
f =
  a +++
    b +++
      c
```

`--debug` shows `cfgFixityOverrides = fromList [(+++, InfixR 0)]` when a path is
supplied and `fromList []` on bare stdin even with the file sitting in cwd.
`--no-dot-ormolu` suppresses the load. Bare stdin never opens the channel, so
the flag is a no-op on this exact command; it is kept because it is the disable
for a channel we established exists. Residual with the flag: `-f` / `-r` on the
CLI. No `ORMOLU_CONFIG` env was observed (planted, ignored).

`.editorconfig` is ignored. Planted `indent_size = 8` / `max_line_length = 20`
in cwd, output identical. `--color never` is identical to auto on a pipe (no
ANSI either way). `-t module` is identical to auto on `module X where` files.
Those three are omitted.

`nix run nixpkgs#ormolu` is not revision-pinned the way `uvx black@25.9.0` is. A
nixpkgs channel bump would change the binary; `gen_reference.py --check` is what
would show it. `reference_version` records the toolchain that wrote the files.

`gen_reference.py --language haskell --check` is silent (exit 0). Two
independent runs match.

### Width is not a knob, and ormolu does not reflow

Tried `--column`, `--print-width`, `--line-length`, `--max-width`: all reprint
usage. A 190-character export list written on one line stays on one line. An
already-broken list stays broken. This is `reference_width = "fixed"` with one
measurement width, like gofmt, not like ktfmt (which has an internal 100 it will
not take on the CLI). ormolu has no internal column limit to bisect.

"At least a third of files must differ between the two widths" cannot apply. The
manifest forbids a second width.

### Why `gate3 = "default"`

The generic named-node comparison is the right oracle. A GHC AST dump or
`haskell-src-exts` parse would collapse the spellings ormolu itself preserves
(`1_000`, `0xdead`, `"caf\xe9"` vs `"café"`, explicit `{;}` braces vs layout)
and would be weaker than the tree comparison.

`transparent_wrappers = ["parens"]` was empty until the gate named it on
`signatures.hs`: `class Eq a => Sized a` became `class (Eq a) => Sized a`, and
the kind `apply` became `parens`. Proved by dumping both trees:

- source `context` child is `apply` (`Eq` applied to `a`);
- reference `context` child is `parens` around that same `apply`.

`parens` is always one named child. Tuples are `tuple`, unit is `unit`, operator
sections are `left_section` / `right_section` / `prefix_id`. Eliding it does not
hide a dropped argument: `show (size x)` vs `show size x` reparses as different
`apply` spines (`apply(show, apply(size, x))` vs `apply(apply(show, size), x)`),
so the parent still fails. `(Just n)` as a pattern vs `Just n` as two patterns
is the same shape. The Lisp warning does not apply: Haskell application is
`apply`, not `parens`.

`((1))` is kept. ormolu does not strip redundant grouping parens the way gofmt
does.

Empty containers written with a space — `[ ]`, `( )`, `r { }` — are in
`normalisation.hs`. ormolu rewrites them to `[]`, `()`, `r {}`. Gate 3 accepts:
the no-named-child path drops the whitespace between anonymous tokens. That is
the Go/CSS probe; it did not fail.

`check_gate3.py --language haskell`: 16 reference outputs checked, 2
incomparable skipped, 32 destructive mutations rejected, 262 useful adversarial
mutations checked (leaf-rewrite 64, number-respell 52, sibling-swap 64,
string-respell 18, subtree-duplicate 64), 0 generic/override disagreements.

**Stage-B check of the elision (reviewer).** Nine paren-drop attacks were run
through `gate3.signature`; six are rejected — dropped application argument
(`show (size x)`), precedence (`(a + b) * c`), associativity (`(a : b) : c`),
negative-literal argument (`g (-1)`), type arrow (`(a -> b) -> c`) and a lambda
argument. Three are accepted, and each is either intended or harmless: the
class-context case (that is the rewrite the declaration exists for), `((1))` →
`1` (redundant grouping, semantics-preserving — note that gate 3 does _not_
protect the `((1))` spelling; the committed reference bytes do), and
`g (do x; y)` → `g do x; y`, which is only valid GHC under `BlockArguments`.
That last one is a real, narrow gap in the elision: a formatter that stripped
parens around a `do` block would pass gate 3 and emit code GHC rejects without
the extension. It is inherent to paren transparency and the alternative — not
declaring `parens` — is worse, since the gate would then reject ormolu's own
output. Recorded, not fixed.

All 25 `parens` nodes across corpus and reference have exactly one named child,
so the elision's precondition holds everywhere it fires.

## Corpus

Sixteen files in `corpus/src/haskell/`. Each is valid Haskell: clean under
tree-sitter-haskell 0.23.1 (no `ERROR` / `MISSING`) and accepted by ormolu
0.8.0.2. (Re-verified at stage B over both `corpus/src` and `corpus/reference`:
clean.)

Required probes:

- `nesting.hs` — records in lists in records, a `Tree` literal deep enough that
  no single line holds it, a matrix of one-line inner lists inside a broken
  outer. Inner one-liners stay flat (see surprises).
- `long_sequences.hs` — a 187-character export list, a 155-character list, a
  177-character equation, a 12-constructor data type. The constructs that
  overflow a line; ormolu will not break any of them.
- `comments.hs` — file-level, trailing on an import, Haddock (`-- |`, a named
  extra of kind `haddock` not `comment`), own-line and trailing inside a body,
  inside a list, inside a record, block `{- -}`, before a closing brace, at end
  of file.
- `strings.hs` — ordinary strings, escapes, hex, continued `"multi\ \line"`,
  chars including `'\n'` and `'\''`, unicode, astral, `1_000` / `0xdead` /
  `1.5e-2` / `0o10` / `0b1010`. Numeric and string spellings are preserved.
- `normalisation.hs` — input written the way a person writes it and ormolu does
  not: `add a b=a+b`, `[ 1,2,3 ]`, `( 1,2 )`, a run of spaces before a trailing
  comment, over-indented `do`, packed `do x<-pure 1;pure x`. `[ ]`, `( )` and
  `r { }` are the empty-container probes. `((1))` is kept. It also omits the
  blank line after `module Normalisation where`, so ormolu has to insert one
  (added at stage B; see the counts section).
- `kitchen.hs` — data, `do`, `let`, `where`, guards, a list of records, a used
  import. The one file allowed to be messy, and never `incomparable`.

Characteristic of Haskell (one line each):

- `where_clauses.hs` — `where` hanging off a declaration, nested `where`,
  `where` on a guarded equation, `let`/`in` next to `where`. Indent is relative
  to the declaration, not the line.
- `sections.hs` — `(+ 1)`, `(1 +)`, ``(`div` 2)``, ``10 `div` 3``, `(+)`,
  `(++)`. The parens are structural (`left_section` / `right_section` /
  `prefix_id`); they are not `parens` and are not declared transparent.
- `layout.hs` — `do`, `let`/`in`, guards, `case of`, and explicit `do { x; y }`
  braces that ormolu strips.
- `imports.hs` — four distinct unsorted imports with already-sorted names inside
  each list. An `incomparable` file: ormolu sorts import declarations and a
  linear formatter cannot reorder siblings. Dedicated to statement reordering
  alone.
- `import_merging.hs` — one module imported twice identically, and one module
  imported twice with different lists. The second `incomparable` file: ormolu
  collapses both into a single declaration. Modules and names are written in the
  order ormolu already emits, so it probes collapsing alone and never
  reordering. Added at stage B.
- `data_types.hs` — sum types, records, `newtype`, a recursive `Tree`,
  `deriving`.
- `signatures.hs` — class with a context (the `parens` wrapper case), instances,
  a multi-constraint signature, a type synonym.
- `operators.hs` — mixed-precedence arith, `&&`/`||`, `$`, `.`, `++`, a hanging
  unknown-operator chain, prefix `(+)`.
- `functions.hs` — multiple equations, tuple and list patterns, a lambda, an
  `infixl` infix declaration.
- `lists.hs` — `[]`, `()`, tuples, a broken list (trailing commas), ranges, a
  comprehension. The space-padded empty form lives in `normalisation.hs`.

### `[incomparable]`: the import block, which is two rewrites, not one

**Corrected at stage B.** ormolu rewrites imports in two separable ways and the
original manifest recorded only the first. That is the ktfmt
`sortedAndDistinctImports` precedent exactly — one exclusion named, more than
one performed — so each now has its own dedicated file.

`imports.hs` — **reordering.** Written unsorted on purpose; ormolu reorders
alphabetically by module name. Gate 3 rejects with
`leaf text 'Data' became 'Control'`. That is the outcome, not a prose reason.

`import_merging.hs` — **collapsing.** Measured at stage B, not previously probed
at all:

| Source                                               | ormolu output                  |
| ---------------------------------------------------- | ------------------------------ |
| `import Data.List` twice                             | one `import Data.List`         |
| `import Data.List (sort)` + `import Data.List (nub)` | `import Data.List (nub, sort)` |

Gate 3 rejects with `4 named children became 2`. Modules and names in this file
are written in the order ormolu already emits, so it never also exercises
reordering.

Both files are out of the agreement denominator and skip only the "reference
must itself pass gate 3" assertion.

**Intra-list name sorting and de-duplication.** Also measured at stage B:
`(sort, nub, foldl')` → `(foldl', nub, sort)` and `(sort, nub, sort)` →
`(nub, sort)`. This is the same reorder class as `imports.hs`; every corpus
import list is written already-sorted and duplicate-free, so no file depends on
it. Recorded in the manifest rather than given a third file.

Import **groups** (blank-line separated) are flattened into one sorted list —
confirmed at stage B. Unmeasured rather than riding on either exclusion: no file
has groups.

`ImportQualifiedPost` (`import qualified X` → `import X qualified`) is a
different rewrite, triggered only with `-o -XImportQualifiedPost` or a cabal
`default-extensions`. The command enables neither. Written in the qualified-pre
form throughout, so it is never rewritten. Recorded here rather than given a
dedicated incomparable file.

## Counts

From `./harness/corpus_stats.py --language haskell`:

```
haskell  --  16 files, vs ormolu 0.8.0.2
  incomparable         2  (gated; out of the agreement denominator)
  reference changes    16/16 at some width   (@80 16/16)
  differs by width     n/a -- fixed-width reference, one width
  carries a comment    16/16
  reference overflow   @80 5
```

**16 of 16 changed.** None is byte-identical input to output.

The stage-B additions moved only the file count. The `import_merging.hs` probe
adds a changed file; the `normalisation.hs` module-header probe changes **none**
of the four counts, because inserting a blank line after the module header is a
width-insensitive rewrite in a file that already changed and already carried a
comment. That is the JavaScript stage-B lesson repeating: counting is a floor,
not a probe audit, and the report-to-corpus direction is the only thing that
finds this class.

"Differs between two widths" does not apply. One width in the manifest.

Every file carries a comment (or a Haddock, which is also a named extra).
tree-sitter-haskell's extras are `comment`, `haddock` and `pragma`, all named.
Gate 3's extras layer compares their text; `drop_a_comment` finds any named
extra. `comments.hs` is the file that exercises `haddock`.

### Reference overflow at the measurement width 80

Five lines, all manufactured by writing a one-line construct ormolu will not
break. ormolu has no target width to overflow; this is the comparative
line-length diagnostic, same class as gofmt's.

| File             | Line | Length | Cause                                                                |
| ---------------- | ---- | ------ | -------------------------------------------------------------------- |
| `long_sequences` | 1    | 187    | one-line export list, source-driven, never broken                    |
| `long_sequences` | 21   | 177    | one-line equation plus trailing comment                              |
| `long_sequences` | 19   | 155    | one-line list                                                        |
| `nesting`        | 13   | 136    | inner one-line record inside a broken parent — cascade does not fire |
| `imports`        | 10   | 90     | tuple of used names; incomparable file, still counts for overflow    |

A stage-C agent reading a 187-character line at "width 80" as a corpus bug would
be formatting away from the reference. Match the reference; do not chase zero.

## Option table

Dumped from `nix run nixpkgs#ormolu -- --help`. Every flag, then which defaults
are load-bearing.

```
Usage: ormolu [-v|--version] [--manual-exts] [-i | (-m|--mode MODE)]
              [-o|--ghc-opt OPT] [-f|--fixity FIXITY] [-r|--reexport REEXPORT]
              [-p|--package PACKAGE] [-u|--unsafe] [-d|--debug]
              [-c|--check-idempotence] [--color WHEN] [--start-line START]
              [--end-line END] [--no-cabal] [--no-dot-ormolu]
              [--stdin-input-file ARG] [-t|--source-type TYPE] [FILE]
```

| Flag                        | Default                            | Load-bearing here?                                                                                                                    |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode`                    | `stdout`                           | No. stdin → stdout is the default. `-i` / `check` would not produce the committed files.                                              |
| `--ghc-opt` / `-o`          | none                               | Residual of `--no-cabal`. `-o -XImportQualifiedPost` rewrites `import qualified`. Not passed.                                         |
| `--fixity` / `-f`           | none                               | Residual of `--no-dot-ormolu`. `-f 'infixr 0 +++'` changes a broken operator chain. Not passed.                                       |
| `--reexport` / `-r`         | built-in lens/optics/servant/hspec | Not exercised. Built-in re-exports are always on (`--debug` shows them with `--no-dot-ormolu`).                                       |
| `--package` / `-p`          | `base`                             | Feeds operator fixity. Not passed; `--debug` shows `cfgDependencies = [base]`.                                                        |
| `--unsafe`                  | off                                | Skips defect detection. Not passed.                                                                                                   |
| `--debug`                   | off                                | Used to prove config load; not in the committed command.                                                                              |
| `--check-idempotence`       | off                                | Not passed. Determinism is `gen_reference.py --check`, which is silent.                                                               |
| `--color`                   | `auto`                             | Auto emits no ANSI on a pipe. `--color never` is identical. Omitted.                                                                  |
| `--start-line`/`--end-line` | whole file                         | Not passed.                                                                                                                           |
| `--no-cabal`                | search on                          | **Yes.** Required for stdin; closes `.cabal` `default-extensions`.                                                                    |
| `--no-dot-ormolu`           | search on                          | Closes `.ormolu` fixity when a path is supplied. No-op on bare stdin; kept as the disable for that channel.                           |
| `--stdin-input-file`        | none                               | Locates `.cabal` / `.ormolu` from a path. No-op with `--no-cabal` on output. Omitted.                                                 |
| `--source-type`             | `auto`                             | Auto detects `ModuleSource` from `module X where`. `-t module` is identical. Omitted. Files without a header also format (`foo = 1`). |
| FILE                        | stdin                              | Default.                                                                                                                              |

**No width option exists.** That is the load-bearing default.

**The default that makes layout depend on the input's line breaks rather than on
width alone:** there is no flag for it, because it is the whole style. A
one-line list, export, record, signature or call stays on one line no matter how
long; an already-broken one stays broken (and picks up trailing commas). This is
prettier's `objectWrap: preserve` for every construct, and gofmt's source-driven
composites. A package that models each container as an ordinary width `group`
will agree on files that happen to already be broken or already be short, and
diverge the moment a long one-liner appears — the same bytes as a width-driven
break, the wrong model. Stage C has to reach for `srcline` / `srcsoft` /
`srctrail`. Matching the reference on `nesting.hs` without that is an accident.

`--manual-exts` is not a formatting option; it lists extensions that need `-o`
(CPP, TemplateHaskell, BangPatterns, ImportQualifiedPost, …). The corpus stays
inside the default-enabled set. BangPatterns is refused without `-o`;
TypeApplications, LambdaCase, RecordWildCards, TupleSections are accepted
without a pragma.

## What ormolu does that surprised me

### It has no width, and line structure is source-driven

Covered above. The measurement width 80 is not a target ormolu honours.

### When a container breaks, the containers inside it do not

Constructed: a broken outer list whose children are one-line lists that fit with
room to spare.

```
matrix =
  [ [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9]
  ]
```

The inner `[1, 2, 3]` is 9 characters. ormolu does not explode it. Same for the
inner `Node {value = 2, children = []}` sitting inside a broken record in
`nesting.hs`. This is the opposite of taplo's cascade. A package that models
each container as an independent group — breaking children because the parent
broke — would diverge on every nested literal that the source wrote flat.

### A trailing comment does not count toward line width (there is no width)

The question is moot. A 15-element one-line list with a trailing comment stays
one-line; ormolu never reflows to make room for a comment the way taplo pads a
sibling to align one. Comments _do_ pin line structure: a comment inside a
broken list stays on its element.

### Token-level normalisation is the real job

At token level ormolu rewrites aggressively, and that is what 16/16 changed
files are measuring. Each entry below names the file that forces it — the
report-to-corpus direction, re-run at stage B:

- spaces around `=`, `,`, operators, backticks (`(+1)` → `(+ 1)`, ``10`div`3`` →
  ``10 `div` 3``);
- padding inside lists, tuples, records (`[ 1,2,3 ]` → `[1, 2, 3]`, `( 1,2 )` →
  `(1, 2)`, `r { }` → `r {}`);
- empty `[ ]` → `[]`, `( )` → `()`;
- a run of spaces before a trailing comment collapsed to one;
- indentation normalised to two spaces (the corpus writes extra indent in
  `normalisation.hs` so ormolu has to fix it);
- a blank line after `module X where` (and after the import block) —
  `normalisation.hs`, which omits it; **before stage B every source file already
  supplied this blank line, so nothing forced the rewrite**;
- blank lines between top-level bindings (`normalisation.hs`, whose bindings are
  written adjacent);
- leading commas converted to trailing commas on multi-line lists and records
  (`trail`);
- explicit `{ }` layout braces stripped (`do { x; y }` → `do x; y` on one line,
  or a layout `do` if the source was already multi-line);
- a single-constraint class context parenthesised (`Eq a` → `(Eq a)`);
- `let`/`in` hanging: `in` sits one column to the right of `let`'s `l` when the
  `let` is itself indented (`let` at column 2, `in` at column 3).

It does **not** rewrite numeric or string spellings, does **not** strip `((1))`,
does **not** sort deriving lists, export lists or instance methods, and does
**not** reflow a one-line construct.

### Operator sections are a different node from grouping parens

Dumped, not read from the grammar:

| Source        | Node            | Named children        |
| ------------- | --------------- | --------------------- |
| `(+ 1)`       | `right_section` | `operator`, `literal` |
| `(1 +)`       | `left_section`  | `literal`, `operator` |
| ``(`div` 2)`` | `right_section` | `infix_id`, `literal` |
| `(+)`         | `prefix_id`     | `operator`            |
| `(1 + 2)`     | `parens`        | `infix`               |
| `(1, 2)`      | (tuple)         | two `literal`s        |
| `()`          | `unit`          | none                  |

Declaring `parens` transparent does not touch the section nodes. Declaring a
section node transparent would let a formatter turn `(+ 1)` into `+ 1` and pass
— that is the Lisp case, and it was not declared.

### The layout rule is in the tree, not in a gap between nodes

FINDINGS 12 (YAML `|+`) is semantic content living in whitespace _between_ two
nodes, outside every range. Haskell's offside rule looks like a candidate. It is
not that shape.

Smallest case, dumped:

```
f = g
  where
    x = 1
    y = 2
```

parses as one `bind` whose `local_binds` holds both `x` and `y`.

```
f = g
  where
    x = 1
y = 2
```

parses as two sibling `bind`s; `y` is a top-level declaration. The indent is
consumed by the parser to _build_ the tree, then discarded. Gate 3 comparing
named nodes sees the meaning. A continued string `"foo\<newline>    \bar"`
includes the gap **inside** the `string` node, not between siblings.

Explicit `{;}` vs layout is punctuation (anonymous `{` `}` `;`), so ormolu
stripping braces passes gate 3: the named children of `do` are unchanged. That
is a stage-C `drop` / layout question, not a gate defect.

An outdented `do` body at column 0 is valid GHC (the first token after `do` sets
the indent, and column 0 equals that indent). ormolu reindents it.
tree-sitter-haskell produces the same `do` nesting either way.

### A tree-sitter-haskell lexer quirk around `'\n'`

Not FINDINGS 12, and not incomparable. Smallest case:

```
module M where
x='\n'
y='a'
```

parses as **one** `bind` whose span covers both lines. `x='\n'` followed by
`y=1` parses as two binds; `x = '\n'` (spaces around `=`) followed by `y = 'a'`
parses as two. ormolu emitting spaces around `=` changes the tree-sitter parse,
and gate 3 then reports `14 named children became 15` on `strings.hs`. The GHC
parser ormolu uses is fine either way.

The construct stays in the corpus, written with spaces around `=` on character
literals so both sides parse as GHC does. The no-space form is a grammar bug on
the input, not a reference rewrite. Reported rather than hidden behind
`[incomparable]`.

### Comments and Haddock are both extras; pragmas would be too

`comment` and `haddock` (`-- |`) are named extras; so is `pragma`
(`{-# LANGUAGE … #-}`). No corpus file uses a pragma. The extras layer is not
inert: 16/16 files have at least one named extra, and `drop_a_comment` rejected
16 of the 32 destructive mutations (the other 16 are dropped tokens).

## Files touched outside `corpus/` and `harness/languages/`

None.

```
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

No `rust/`, no `runtime-js/`, no `packages/`, no shared harness script. Neither
`gen_trees.py` nor `gen_reference.py` needed a change. `./test.sh` is green:
haskell shows as `awaiting package`.
`./harness/check_width.py . 20 120 --language haskell` is
`[PASS] width-sweep  1616/1616 agree` (shared refusal: no package yet).

Still true after the stage-B fixes, which touched `corpus/src/haskell/`,
`corpus/reference/`, `corpus/trees/` and `harness/languages/haskell.toml` only.

## Template delta

- **"A third of files must differ between two widths" cannot apply.** ormolu has
  one output. The brief correctly framed this as a hypothesis to test; the test
  is `reference_width = "fixed"` and one width, not a second invented width.
- **"Ormolu needs to know the file is Haskell and may need language extensions
  declared."** It does not, for this corpus. Stdin with `--no-cabal` is enough;
  `--source-type auto` detects `module X where`; default-enabled extensions
  cover everything here. A fake filename is a no-op and was omitted. The
  `x.haskell` warning in the brief is right about extensions vs language names
  in general and inapplicable here.
- **`--no-dot-ormolu` is a no-op on bare stdin** because `.ormolu` is found via
  a file path, not cwd. The brief's "verify every flag" rule would drop it; it
  is kept as the disable for a channel we proved exists the moment
  `--stdin-input-file` is added. Worth saying that "does this flag change output
  on _this_ command" and "does this flag close a documented channel" are
  different tests.
- **"Pinned-runner" is too strong for `nix run nixpkgs#ormolu`**, same as
  gofmt/ktfmt. Observed version, not a locked revision.
- **tree-sitter-haskell extras are not only `comment`.** `haddock` and `pragma`
  are named extras too. `corpus_stats` "carries a comment" counts them, which is
  the right behaviour for the extras layer, but a builder who grepped for `--`
  would under-count Haddock-only files.
- **The layout-rule / FINDINGS 12 hunt is the right question and the answer is
  no.** Layout is tree nesting. The `'\n'` char-literal lexer quirk is a grammar
  bug, not semantic whitespace between nodes.
