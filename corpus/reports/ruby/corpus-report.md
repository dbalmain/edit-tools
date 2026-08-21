# Ruby corpus report (stage A)

**Builder:** grok-4.6 via the grok CLI.

## Manifest

`harness/languages/ruby.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                                                                                          | How it was established                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grammar`              | `tree-sitter-ruby==0.23.1`                                                                                                     | Live PyPI: the distribution name matches the orchestrator's guess. `0.7.0` was the template guess; the releases on the index are `0.21.0`, `0.23.0`, `0.23.1`, and `0.23.1` is latest (https://pypi.org/pypi/tree-sitter-ruby/json, 2026-08-22).                                                                                                       |
| `grammar_module`       | `tree_sitter_ruby`                                                                                                             | `uv run --with tree-sitter-ruby==0.23.1` then `import tree_sitter_ruby`. The hyphen-to-underscore swap is correct.                                                                                                                                                                                                                                     |
| `grammar_symbol`       | `language`                                                                                                                     | The module exports `language()` (plus `HIGHLIGHTS_QUERY`, `LOCALS_QUERY`, `TAGS_QUERY`). It returns a `tree_sitter.Language` capsule. No `language_ruby()`.                                                                                                                                                                                            |
| `injection_aliases`    | `["ruby", "rb"]`                                                                                                               | `ruby` is canonical. `rb` is the conventional short alias (GitHub linguist, highlight.js). No other spelling is worth vouching for.                                                                                                                                                                                                                    |
| `reference`            | `nix shell nixpkgs#rubyPackages.syntax_tree -c stree format --config /dev/null --print-width={width}`                          | Source on stdin, formatted source on stdout. `nix run nixpkgs#rubyPackages.syntax_tree` fails: nixpkgs names the default bin `syntax_tree`, but the gem ships `stree` (and `yarv`). `nix shell … -c stree` is the working form, same shape as gofmt. `--config /dev/null` is load-bearing (below). `--extension` is a no-op (below). `{width}` is real. |
| `reference_version`    | `6.3.0`                                                                                                                        | Printed by `nix shell nixpkgs#rubyPackages.syntax_tree -c stree version`. Not assumed. The nix derivation is `ruby3.4-syntax_tree-6.3.0`.                                                                                                                                                                                                              |
| `reference_width`      | `flag`                                                                                                                         | Ran the same input at 80 and 40 and diffed. Kwargs, hashes, argument lists, operator chains and method-chain calls reflow. `{width}` is therefore real.                                                                                                                                                                                                |
| `widths`               | `[80, 40]`                                                                                                                     | 80 is syntax_tree's own default, established by bisection (below). 40 is the narrow width; it is the first round number at which kwargs lists, nested hashes, and single-statement blocks actually split.                                                                                                                                              |
| `gate3`                | `default`                                                                                                                      | See below.                                                                                                                                                                                                                                                                                                                                             |
| `transparent_wrappers` | `[]`                                                                                                                           | Gate 3 accepted syntax_tree on every comparable run without naming a wrapper. syntax_tree keeps redundant parentheses (`((1 + 2))` stays).                                                                                                                                                                                                             |
| `equivalent_kinds`     | `[]`                                                                                                                           | Brace blocks (`block`) and `do/end` blocks (`do_block`) are not the same construct under a different name. The conversion is a token rewrite, not an equivalence.                                                                                                                                                                                      |

### `nix run` is the wrong invocation

WORKFLOW.md's roster line is `nix run nixpkgs#rubyPackages.syntax_tree`. That
attribute exists (`ruby3.4-syntax_tree-6.3.0`) and `nix eval` succeeds, but
`nix run` tries to execute `$out/bin/syntax_tree`, which is not there:

```
error: unable to execute '.../bin/syntax_tree': No such file or directory
```

`$out/bin/` contains `stree` and `yarv`. `nix shell nixpkgs#rubyPackages.syntax_tree
-c stree version` prints `6.3.0`. That is the pinned runner.

The brief said there is no ruby on PATH. There is: `/home/dave/.nix-profile/bin/ruby`
is `ruby 3.4.9 (2026-03-11 revision 76cca827ab) +PRISM [x86_64-linux]`. LANGUAGES.md
was the accurate one. The reference still goes through nix so a profile ruby
cannot leak a different gem.

No fake filename is needed. The CLI default `--extension` is `.rb`, which is
this manifest's own `extensions` entry. `--extension=.rb` is byte-identical to
omitting it; `--extension` is therefore omitted. stdin with no files and no
`-e` is the documented fallback (CLI reads STDIN).

### `--config /dev/null` is load-bearing

syntax_tree reads `.streerc` from **cwd only** — not ancestors (verified: a
parent `.streerc` with `--print-width=20` is inert when cwd is a subdirectory).
There is no `--no-config`. Config arguments are prepended, then the CLI;
OptionParser last-wins per flag.

Method: plant a config that sets an option the command line does **not** pass.

| Channel                                      | Without `--config /dev/null`                                                                                         | With `--config /dev/null` |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `.streerc` in cwd, `--print-width=20` (CLI omits width) | array that is flat at 80 wraps                                                                                       | inert (unprompted = 80)   |
| `.streerc` in cwd, `--plugins=plugin/single_quotes` (CLI passes `--print-width=80`) | `"hello"` becomes `'hello'` — CLI width does **not** stop the leak                                                   | stays `"hello"`           |
| `.streerc` in an ancestor                    | inert (cwd-only search)                                                                                              | n/a                       |
| `STREERC` / `SYNTAX_TREE_CONFIG` env         | do not exist; no effect                                                                                              | n/a                       |

CLI `--print-width=80` **wins** over a file `--print-width=20` (verified). That
is the trap: testing with the option you already pass hides the leak. What a
discovered file still supplies is every option the CLI does not name —
`--plugins`, `--target-ruby-version`, `--extension`. The planted
`plugin/single_quotes` is the proof: it is a shipped plugin
(`lib/syntax_tree/plugin/single_quotes.rb`), it changes output, and
`--print-width` on the CLI does not block it.

`--config /dev/null` yields empty arguments (`File.readlines("/dev/null")` is
`[]`) and is the disable. Residual channel: an explicit `--config path` (we
pass `/dev/null`). `--config` to a missing file raises `Invalid configuration
file`.

`--target-ruby-version` is not passed. It defaults to the runner's
`RUBY_VERSION`, which for this nix package is 3.4.9. The only in-gem branch on
it is hash-pattern spacing below 2.7.3. Pinning it would be a no-op on this
corpus; a nixpkgs bump that changed the gem would show up as
`gen_reference.py --check` drift either way.

`gen_reference.py --check` is silent (exit 0). Two runs of the same stdin match.

### Widths, by bisection not by `--help`

`stree help` says `--print-width=NUMBER` and the library constant is
`DEFAULT_PRINT_WIDTH = 80`, but the brief forbids trusting that. A formatted
call of **exactly 80 characters**:

```
configure(host: "localhost", port: 8080, timeout: 30, retries: 3, verbose: true)
```

stays flat with no width flag and with `--print-width=80`, and wraps at
`--print-width=79`. Unprompted output is byte-identical to `--print-width=80`
on every probe tried. 40 is the narrow width.

### No gate3 override

The generic default is selected. A Ruby AST dump (Ripper, Prism,
`RubyVM::AbstractSyntaxTree`) would collapse the spellings syntax_tree itself
preserves — `1_000`, `0xdead` vs `0xDEAD`, `"double"` vs a rewritten `'single'`,
`puts x` vs `puts(x)` — and would be weaker than the named-node comparison.
Leave wrappers empty: syntax_tree does not add or remove parentheses around a
wrapped expression, and `parenthesized_statements` is structural (`(x)` is not
`x` in a call-arg or a `not`). `check_gate3.py --language ruby`: 30 reference
outputs checked, 60 destructive mutations rejected, 503 useful adversarial
mutations against the generic default (inert, as designed), 0 wrapper kinds
named.

`block_conversion.rb@40` is the one skipped assertion:
`check_gate3.py --verbose` prints `incomparable (reference rewrite skipped)
ruby__block_conversion@40`. `gate3.describe` on that pair is `root/program[0]/call[2]:
node kind 'block' became 'do_block'`. At width 80 the same file is
byte-identical input to output, so the assertion is skipped only at 40.

## Corpus

Fifteen files in `corpus/src/ruby/`. Each is valid Ruby: clean under
tree-sitter-ruby 0.23.1 (no `ERROR` / `MISSING`). Every file carries at least
one comment.

Required probes:

- `nesting.rb` — hashes inside hashes and arrays inside arrays. syntax_tree
  **cascades** a broken hash into every hash inside it, even `{ a: 1 }`; an
  array of arrays keeps inner `[1, 2, 3]` flat. `row` is flat at 80 and stacked
  at 40.
- `long_sequences.rb` — kwargs, a long `%i` list, an operator chain, an array
  of hashes, a long positional call. The 80-character `configure(…)` wraps at
  40.
- `comments.rb` — magic comments (`encoding`, `frozen_string_literal`),
  own-line, trailing, inside `[]` and `{}`, before a closing delimiter,
  `=begin`/`=end` (also a `comment` extra), end of file. Magic comments are
  preserved byte-for-byte, including extra spaces; they are not moved.
- `strings.rb` — double quotes (syntax_tree's default), a string that must stay
  single-quoted because it contains `"`, interpolation, `%Q`, regex, heredocs
  (`<<~` and `<<~'`), escapes, unicode, astral. String interiors never reflow;
  a long assignment wraps *before* the string.
- `normalisation.rb` — input written the way a person writes it: padding
  inside `[ ]` / `{ }` / `foo( )` / `def empty( )`, missing operator spaces,
  extra indent, a run of spaces before a trailing comment, packed hashes,
  semicolons. The empty containers with a space are the no-named-children
  probe; syntax_tree collapses them and the default gate accepts the rewrite
  (anonymous-token spellings compared, inter-token layout ignored).
- `kitchen.rb` — class, kwargs, `begin`/`rescue`, a brace block, a hash splat,
  a method chain. Written in syntax_tree's token form so it stays comparable.

Characteristic of Ruby, one line each:

- `blocks.rb` — brace and `do/end` forms that are **stable at both widths**:
  short braces, nested braces that still fit at 40, multi-statement `do/end`,
  a brace on a parenthesised call, a `do/end` after a bare call (braces would
  bind to the last arg), block-locals.
- `block_conversion.rb` — **incomparable.** A single-statement block that is
  braces at 80 and `do/end` at 40. There is no source form stable at both
  widths for a near-threshold single-statement block: fitting `do/end` becomes
  braces at 80, overflowing braces become `do/end` at 40. Gate 3 rejects the
  named-node change `block` → `do_block` at 40.
- `calls.rb` — optional parentheses are **left alone** on calls (`puts x` and
  `puts(x)` both survive). Kwargs wrap as a group at 40. Splats, a trailing
  brace block, a trailing comment that does not force a wrap at 80.
- `defs.rb` — methods, `def self`, a singleton class, kwargs that wrap at 40,
  an endless method, `...` forwarding. Headers are already parenthesised:
  syntax_tree *adds* parens to `def foo a, b`, and that rewrite **passes**
  gate 3 (anonymous tokens).
- `operators.rb` — arithmetic chains, `&&` / `||` (not rewritten to `and` /
  `or` or vice versa), unary, `not` in parens, safe navigation. The
  `&&` chain wraps at 80.
- `chains.rb` — short chain stays flat; medium chain breaks at the call's
  brackets at 40; long chain breaks at the dots even at 80.
- `control_flow.rb` — multi-branch `if`/`elsif`/`else` and `case`/`when` so
  they cannot collapse to a modifier or a ternary; `for`; modifier `while` /
  `until` already in canonical form; `begin`/`rescue`/`ensure`.
- `collections.rb` — `[]`/`{}`, `%i`/`%w` already in canonical form (the
  `[:a, :b]` → `%i[a b]` rewrite **rejects** gate 3: `array` became
  `symbol_array`), a mixed array that is not rewritten, an array of hashes
  whose inners stay flat.
- `patterns.rb` — `case`/`in`, hash and array patterns, a find pattern. The
  hash pattern wraps at 40.

Rewrites that are **not** in dedicated `[incomparable]` files, by the markdown
policy: write the construct in the reference's own canonical form so it appears
throughout and is never rewritten. Recorded here, with the gate-3 outcome of
the rewrite itself (run as a ten-line oracle, not inferred):

| Rewrite                                         | Gate 3 on the rewrite itself                          | What the corpus does                                      |
| ----------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `'hello'` → `"hello"`                           | **passes** (anonymous delimiters)                     | written as doubles, except when the string contains `"`   |
| `[:a, :b]` → `%i[a b]`                          | **rejects** (`array` → `symbol_array`)                | written as `%i` / mixed                                   |
| `["a", "b"]` → `%w[a b]`                        | same shape as `%i`                                    | written as `%w`                                           |
| `{ :a => 1 }` → `{ a: 1 }`                      | **rejects** (`simple_symbol` → `hash_key_symbol`)     | written as labels                                         |
| `def foo a, b` → `def foo(a, b)`                | **passes** (anonymous parens)                         | headers already parenthesised                             |
| `if a; 1; else; 2; end` → `(a ? 1 : 2)`         | **rejects** (`if` → `parenthesized_statements`)       | multi-branch `if`, or already-ternary                     |
| `while x; work; end` → `work while x`           | **rejects** (`while` → `while_modifier`)              | written as modifiers                                      |
| `{…}` ⇄ `do…end` by whether the body fits       | **rejects** (`block` → `do_block`) at width 40        | dedicated `block_conversion.rb`; stable forms elsewhere   |

A dedicated file per row would have been eight incomparable files against seven
comparable ones. The conversion is the one that cannot be written in a form
stable at both widths, so it is the one that is gated.

## Counts (from two `cmp` loops, and from `corpus_stats.py`)

```sh
changed80=0; changed40=0; any=0; width=0; total=0
for f in corpus/src/ruby/*.rb; do
  stem=$(basename "$f" .rb)
  total=$((total + 1))
  if ! cmp -s "$f" "corpus/reference/ruby__${stem}@80.txt"; then
    changed80=$((changed80 + 1))
  fi
  if ! cmp -s "$f" "corpus/reference/ruby__${stem}@40.txt"; then
    changed40=$((changed40 + 1))
  fi
  if ! cmp -s "$f" "corpus/reference/ruby__${stem}@80.txt" \
     || ! cmp -s "$f" "corpus/reference/ruby__${stem}@40.txt"; then
    any=$((any + 1))
  fi
  if ! cmp -s "corpus/reference/ruby__${stem}@80.txt" \
            "corpus/reference/ruby__${stem}@40.txt"; then
    width=$((width + 1))
  fi
done
echo "changed@80 $changed80 / $total"
echo "changed@40 $changed40 / $total"
echo "changed any $any / $total"
echo "width_diff $width / $total"
```

**How many files the reference changes at all**

| Width | Changed | Identical |
| ----- | ------- | --------- |
| 80    | 5       | 10        |
| 40    | 12      | 3         |

Union: **12 of 15** files differ from their input at at least one width.
Identical at every width: `blocks.rb`, `comments.rb`, `control_flow.rb` — written
already in syntax_tree's spacing, and none of them can break. `normalisation.rb`
is the rewrite probe and is **not** in that three.

**How many files differ between the two widths**

**11 of 15.** Same at both widths: `blocks`, `comments`, `control_flow`,
`normalisation`. 11/15 is well above a third. The constructs that respond are
kwargs, hashes, argument lists, operator chains, method-chain calls, hash
patterns, and the brace/`do/end` conversion.

From `./harness/corpus_stats.py --language ruby`:

```
ruby  --  15 files, vs 6.3.0
  incomparable         1  (gated; out of the agreement denominator)
  reference changes    12/15 at some width   (@80 5/15  @40 12/15)
  differs by width     11/15
  carries a comment    15/15
  reference overflow   @80 3  @40 10
```

**15 of 15 files carry a comment.** The extras layer is not inert.

### The reference's own overflow

**its own overflow: 3 at 80, 10 at 40.**

| File              | Width | Line | Len | Cause                                                                                          |
| ----------------- | ----- | ---- | --- | ---------------------------------------------------------------------------------------------- |
| `long_sequences`  | 80    | 4    | 108 | `configure(…)` is 80 characters of code plus a trailing comment. Comments do not count toward width, so the call stays flat and the comment hangs off. |
| `nesting`         | 80    | 4    | 104 | Same shape: `row = { … }` fits, trailing comment hangs off.                                    |
| `strings`         | 80    | 12   | 83  | Long string assignment. The string interior does not wrap; the line is indent + quotes + content. |
| `chains`          | 40    | 4    | 47  | `short = user.name.upcase # still one line at 40`. Trailing comment, chain will not wrap.      |
| `collections`     | 40    | 15   | 73  | `mixed = [:alpha, "beta", :gamma] # …`. Trailing comment on a mixed array that will not wrap.  |
| `comments`        | 40    | 6    | 46  | `require "json" # trailing comment on a require`.                                              |
| `comments`        | 40    | 11   | 50  | `result = a + b # trailing comment on a statement`.                                            |
| `comments`        | 40    | 30   | 72  | `=begin` body line; block comments are not reflowed.                                           |
| `comments`        | 40    | 34   | 42  | Trailing comment at the end of a block.                                                        |
| `kitchen`         | 40    | 26   | 73  | Interpolated error string; string interior does not wrap.                                      |
| `normalisation`   | 40    | 26   | 56  | `trailing_spaces = 1 # lots of spaces before this comment`.                                    |
| `patterns`        | 40    | 16   | 41  | Find pattern plus trailing comment.                                                            |
| `strings`         | 40    | 15   | 75  | Interpolated string; interior does not wrap.                                                   |

The two 80-width overruns are the manufactured-looking ones: an 80-character
call that *does* fit, plus a comment the formatter will not move and does not
budget for. A stage-C agent that "fixes" them by wrapping the call is fighting
the reference.

## The reference's own option table

Dumped from `nix shell nixpkgs#rubyPackages.syntax_tree -c stree help`
(the command that enumerates them; there is no `--support-info`):

```
stree ast [--plugins=...] [--print-width=NUMBER] [-e SCRIPT] FILE
stree check [--plugins=...] [--print-width=NUMBER] [-e SCRIPT] FILE
stree ctags [-e SCRIPT] FILE
stree debug [--plugins=...] [--print-width=NUMBER] [-e SCRIPT] FILE
stree doc [--plugins=...] [-e SCRIPT] FILE
stree expr [-e SCRIPT] FILE
stree format [--plugins=...] [--print-width=NUMBER] [-e SCRIPT] FILE
stree json [--plugins=...] [-e SCRIPT] FILE
stree match [--plugins=...] [-e SCRIPT] FILE
stree help
stree lsp [--plugins=...] [--print-width=NUMBER]
stree search PATTERN [-e SCRIPT] FILE
stree version
stree write [--plugins=...] [--print-width=NUMBER] [-e SCRIPT] FILE

--ignore-files=...     glob; can be repeated. Irrelevant on stdin.
--plugins=...          comma-separated; each does require "syntax_tree/#{plugin}".
--print-width=...      maximum line width. Default 80 (bisected, not just --help).
-e ...                 inline script; we use stdin instead.
--extension=...        stdin / -e handler. Defaults to '.rb'. No-op here; omitted.
--config=...           path to a config file. Defaults to .streerc in cwd.
```

`--target-ruby-version=VERSION` is accepted by OptionParser and is **not** in
the help text. Default is `RUBY_VERSION` of the runner.

Shipped plugins, loaded only if named (each defines a constant that
`Formatter::Options` reads):

| Plugin                         | Constant                 | Default without plugin | Effect                                              |
| ------------------------------ | ------------------------ | ---------------------- | --------------------------------------------------- |
| `plugin/single_quotes`         | `SINGLE_QUOTES`          | `"`                    | prefer `'`                                          |
| `plugin/trailing_comma`        | `TRAILING_COMMA`         | false                  | trailing commas on broken lists                     |
| `plugin/disable_auto_ternary`  | `DISABLE_AUTO_TERNARY`   | false (auto-ternary **on**) | keep `if`/`else` instead of converting to `? :` |

Load-bearing defaults — the ones a naive package implements by doing nothing,
and the ones it would get wrong:

- **`--print-width` 80.** Width-driven. Honour `{width}`.
- **Double quotes.** Quote swap is a token rewrite; the corpus is written in
  doubles. A package that requotes will match a `.streerc` with
  `plugin/single_quotes` and diverge from this reference.
- **No trailing comma.** Broken lists do *not* gain a comma; a source trailing
  comma on a list that fits is *removed* (`[1, 2,]` → `[1, 2]`). FINDINGS 13
  (deletion) if a package tried to match the removal.
- **Auto-ternary on.** Single-statement `if`/`else` used as an expression
  becomes `(a ? 1 : 2)`. The corpus avoids the construct.
- **Block delimiters by fitness, not by source form.** This is the Ruby-shaped
  finding. It is not a width-`group` over a fixed pair of tokens. `{` and
  `do`/`end` are different named nodes. A package cannot convert them
  (linearity). Stage C agrees on the forms that are stable at a given width
  and loses `block_conversion.rb`.
- **Author line breaks are not preserved.** A hand-broken array or hash that
  fits is collapsed. This is the opposite of prettier's `objectWrap: preserve`
  (JavaScript) and of gofmt. Layout depends on width, not on the input's line
  breaks, for hashes/arrays/calls. Do **not** reach for `srcline` / `srcsoft`
  for those. Exceptions, which *are* source-shaped: a comment inside an array
  pins it open; a heredoc body keeps its lines; implicit string concatenation
  gains a `\` continuation (not in this corpus).

`--ignore-files`, `-e`, `--extension`, `write` vs `format` are not load-bearing
for this command. `format` prints to stdout and does not write the file;
`write` would.

## What syntax_tree does that surprised me

### It is a real reflowing formatter, and it is aggressive about tokens

The roster put Ruby in T4 next to ormolu and emacs `indent-region`, which
invited a "maybe fixed-width" reading. syntax_tree is not that. `--print-width`
is real, default 80, and it rewrites *tokens* as well as layout: quotes, `%i` /
`%w`, hash rockets, `if` → ternary, `while` → modifier, `{` ⇄ `do`/`end`,
semicolons to newlines. Most of those fail gate 3. The package can match the
*layout* half and cannot match the token half; that is why the corpus is
written in the reference's token form.

### When a container breaks, it depends on the container

Constructed: `{ alpha: { a: 1 }, beta: { b: 2 }, … }` at width 80. The parent
breaks, and **every inner `{ a: 1 }` breaks too**, with room to spare. At width
200 the same input stays one line, inners included. Hash-in-hash is taplo's
cascade.

The opposite, on the same formatter: `[[1, 2, 3], [4, 5, 6], …]` breaks the
outer array and keeps every inner array flat. An array of `{ name: "alice",
age: 30 }` hashes keeps those inner hashes flat too. A package that models
every container as an independent group matches arrays and diverges on nested
hashes. A package that opens every nested group when the parent opens matches
hashes and diverges on arrays. Stage C has to pick per node kind.

Nested blocks are independent: at 40,
`outer.each { |a| inner.each { |b| work(a, b) } }` becomes `do/end` on the
outer and keeps braces on the inner. That pair is in `block_conversion`
territory (named-node rewrite) if the outer no longer fits; `blocks.rb` only
has nestings that still fit at 40.

### A trailing comment does **not** count toward its line's width

`configure(host: "localhost", port: 8080, timeout: 30)` is 53 characters and
stays flat at 70. The same call plus ` # trailing comment here` is 77
characters and **still stays flat at 70**. At 50 the call itself is over budget
and wraps; the comment then rides on the closing `)`. An array that fits
without its comment never wraps to make room for one, at any width tried.
Opposite of taplo and of ktfmt; same direction as "the comment is a suffix,
not a width cost".

syntax_tree will therefore *manufacture* overflow: the 80-character
`configure(…)` in `long_sequences.rb` is exactly the default width, the
trailing comment makes the line 108, and the formatter will not wrap it. That
is three of the counted overflow lines and it is reference behaviour.

Comments *do* pin a list open when they sit **inside** it (`[1, # first`).
They do not align into a column.

### Token-level normalisation

At token level, what `normalisation.rb` is for:

- binary-operator spacing, uniformly (`a + b * 2`, not gofmt's precedence-tight
  `*`)
- comma and hash-rocket-or-label spacing (`{ a: 1, b: 2 }`)
- padding inside brackets, braces and calls is removed (`[ ]` → `[]`, `{ }` →
  `{}`, `foo( )` → `foo()`, `def empty( )` → `def empty()`)
- a run of spaces before a trailing comment collapses to one space
- indentation is 2 spaces; extra spaces and over-indent go
- explicit semicolons become newlines (`x = 1; y = 2; z = 3` → three
  statements)
- three consecutive blank lines collapse to one
- `return(result)` keeps the parens

It does **not** respell `1_000`, `0xdead`, `0xDEAD`, `0o755`, `1.0`, `1e10`.
It does **not** add or remove parentheses on calls. It does **not** convert
`&&` to `and`. It does **not** touch magic comments.

### Optional parentheses are left on calls and added on defs

`puts x` stays `puts x`. `puts(x)` stays `puts(x)`. That is the opposite of
"always one form". A package that normalised call parens would diverge on
`calls.rb` at both widths, and the rewrite would *pass* gate 3 (anonymous
tokens), so it would be a silent agreement miss rather than a gate-3 skip.
The corpus contains both forms so stage C can see it.

`def foo a, b` becomes `def foo(a, b)`. Headers in `defs.rb` are already
parenthesised. `def foo` with no parameters stays without parens; `def empty()`
from a spaced `def empty( )` keeps the empty pair.

### Block form is a layout decision that linearity cannot make

This is the LANGUAGES.md stress, and it is sharper than "it converts one to
the other". The conversion is **width-dependent and bidirectional**:

- single-statement, fits → `{ … }`
- single-statement, doesn't fit → `do … end`, and the call inside may wrap
- multi-statement → `do … end` at every width
- a block after a *bare* call is `do/end` even when the body is one expression
  (`foo 1, 2 do |x| x end`), because braces would bind to `2`

tree-sitter-ruby names the two forms `block` (`block_body`) and `do_block`
(`body_statement`). Gate 3 sees the rename. A `group` over a fixed delimiter
pair cannot express this. Stage C should treat `{`/`do` as different rules
and accept that near-threshold single-statement blocks are out of the
denominator.

## Everything outside `corpus/` and `harness/languages/`

```
git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

No shared harness script was edited. No grammar was added to an inline
`dependencies` block. No ruby branch was added to `score.py`, `gen_trees.py`
or `gate3.py`. `rust/` and `runtime-js/` were not touched.

## Template delta

- The brief said there is no ruby on PATH. There is (`ruby 3.4.9`). LANGUAGES.md
  had it right. Using the global ruby would have been the wrong pin; nix shell
  is still the right runner.
- WORKFLOW.md's roster invocation `nix run nixpkgs#rubyPackages.syntax_tree`
  does not run. The working form is `nix shell … -c stree`, same class as
  gofmt. Worth a roster-line fix so the next T4 language does not copy it.
- `x.ruby` as a fake stdin filename would have been wrong twice: no fake name
  is needed, and if one were, it would be `x.rb` from `extensions`. The brief
  already warns about this; recording that Ruby is in the "not needed" camp,
  not the "needed and `.rb`" camp.
- Optional parentheses were framed as add/remove. The reference **leaves**
  call parens and **adds** def parens. Both pass gate 3. The interesting probe
  is "both forms in the corpus", not an `[incomparable]` file.
- Block conversion cannot be written in a canonical form that is stable at
  both widths. That is the one rewrite for which a dedicated `[incomparable]`
  file is forced, even under the markdown policy. The brief's "if it converts,
  give it its own file" is right here, and the "write canonical form" policy
  is right for every other token rewrite syntax_tree performs.
