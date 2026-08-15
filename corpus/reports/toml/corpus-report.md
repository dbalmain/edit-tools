# TOML corpus and harness entry — stage A report

## The manifest

`harness/languages/toml.toml`. Every field that had to be _discovered_ rather
than copied, and how:

| Field                                       | Value                                                                                             | How it was established                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `grammar`                                   | `tree-sitter-toml==0.7.0`                                                                         | PyPI has 0.6.0 and 0.7.0; 0.7.0 is latest. The brief's guess was right.              |
| `grammar_module`                            | `tree_sitter_toml`                                                                                | Imported it and checked — the hyphen-to-underscore swap is correct here.             |
| `grammar_symbol`                            | `language`                                                                                        | The module exports exactly one name, `language`.                                     |
| `reference`                                 | `nix run nixpkgs#taplo -- fmt --no-auto-config -o column_width={width} --stdin-filepath x.toml -` | Run, not read. See "the width knob" below.                                           |
| `reference_version`                         | `taplo 0.10.0`                                                                                    | Observed from `nix run nixpkgs#taplo -- --version`.                                  |
| `reference_width`                           | `"flag"`                                                                                          | Run at 88 and 60 and diffed: a flat array that fits at 88 breaks one-per-line at 60. |
| `widths`                                    | `[88, 60]`                                                                                        | Both honoured by taplo.                                                              |
| `gate3`                                     | `"default"`                                                                                       | `tomllib` is _weaker_ than the generic tree comparison, see below.                   |
| `transparent_wrappers` / `equivalent_kinds` | `[]` / `[]`                                                                                       | taplo moves no parentheses and renames no nodes; the strict end.                     |

### Why `gate3 = "default"`

The brief's rule is "default unless toml has a real semantic checker." Python's
stdlib `tomllib` is a loader, and it is weaker than the generic named-node
comparison in exactly the places a formatter could hide a token rewrite:

- `tomllib.loads("1_000") == tomllib.loads("1000")` — it normalises number
  spelling, so a formatter rewriting `1_000` to `1000` (a real token change)
  passes `tomllib` but fails the generic default.
- `[a.b]` and `[a]` + `[b]` both load to the same nested dict, so the spelling
  of table nesting is invisible to it.
- `nan` compares unequal to itself (`float('nan') != float('nan')`), so a dict
  containing `nan` would make the signature compare unequal even when nothing
  changed.

The generic default — named-node kind plus leaf text — already catches key
reordering and every spelling-preserving change, which is stronger than
`tomllib` for non-destruction and has none of those traps. The universal extras
layer covers comments. So no override file is needed.

## The corpus — 15 files

Five required, nine characteristic, one added by the reviewer. Each is valid,
meaningful TOML and parses with no `ERROR` node (`gen_trees.py` refuses
otherwise).

Required probes:

- `nesting.toml` — tables inside tables, arrays of inline tables, arrays of
  arrays, deep enough that the narrow width breaks the innermost levels first.
- `sequences.toml` — long flat arrays of scalars; the one TOML construct that
  overflows a line, forcing the single-line-vs-broken decision at both widths.
- `comments.toml` — a comment in every position TOML allows: file-leading,
  trailing on a pair, own-line before a pair, after a table header, trailing on
  array elements, own-line inside an array, after the opening bracket, before
  the closing bracket.
- `strings.toml` — basic, literal, multiline-basic and multiline-literal
  strings, plus the escapes each honours; multiline strings must survive
  byte-for-byte.
- `kitchen.toml` — a Cargo-style manifest: tables, arrays of tables, inline
  tables, dotted keys, features and comments interacting.

Characteristic of TOML:

- `tables.toml` — the several spellings of nested tables (`[a.b]` vs
  `[a]`+`[b]`), which a formatter must lay out without collapsing.
- `array_tables.toml` — arrays of tables `[[x]]`, including the legal empty
  element.
- `dotted_keys.toml` — dotted keys on the value side (`a.b.c = 1`), the spelling
  that is not a table header.
- `inline_tables.toml` — `{ key = value }` inline tables, nested and long; the
  construct taplo refuses to break between pairs.
- `values.toml` — every scalar spelling: hex/octal/binary ints, underscores,
  exponent/inf/nan floats, booleans.
- `arrays.toml` — empty, heterogeneous, nested, trailing-comma and
  already-multiline arrays.
- `quoted_keys.toml` — quoted keys (spaces, embedded dots, empty key, unicode
  escape) in both pair and header position.
- `dates.toml` — all four date/time forms, including space-separated local
  date-time and fractional-second precision.
- `blank_lines.toml` — vertical spacing between pairs and before headers, where
  taplo preserves up to two blank lines.

Added by the reviewer:

- `whitespace.toml` — hand-written TOML that nobody formatted: spacing around
  `=`, padding inside `[` and `{`, spacing around `,` and `.`, indented pairs
  under a header, and runs of spaces before a trailing `#`. The other fourteen
  files were all written already in taplo-normal spacing, so **seven of them are
  byte-identical input to output at both widths** and the whole class of
  token-level normalisation went unprobed. See item 10 below.

### How much of the corpus actually moves

| measure                                           | count                                                        |
| ------------------------------------------------- | ------------------------------------------------------------ |
| files where taplo changes nothing at either width | 7 of 15                                                      |
| files whose output differs between 60 and 88      | 4 of 15 (`sequences`, `nesting`, `inline_tables`, `kitchen`) |

Both numbers are honest for TOML rather than lazy — most TOML constructs have no
break opportunity at all, so the width-sensitive surface really is small. But
they say where gate 4's discriminating power lives, and stage C should read the
second row as "eleven of my fifteen files cannot tell 60 from 88".

## What taplo does that surprised me

This is the section that matters. taplo 0.10.0 is a much more opinionated
formatter than its "data" tier suggests.

1. **The width knob is `-o column_width=N`.** Not `--column-width`, not
   `--line-length`. The brief warned exactly this, and it is right: nothing in
   `taplo fmt --help` advertises that width is a `key=value` formatter option,
   not a flag. Discovered by running, not reading.

2. **taplo reads config files from the filesystem even for stdin input**, and
   logs `INFO ... found configuration file` /
   `WARN ... invalid configuration file` to **stderr** when it finds a
   `.taplo.toml` or `taplo.toml`. A stray config in the cwd (or a parent)
   silently changes the formatting. `--no-auto-config` makes the committed
   reference output depend only on the input and the width. This is a
   reproducibility hazard the brief flagged, and it is real.

   **[reviewer] Mechanism corrected.** `-o` does _not_ lose to the config file —
   it wins for the same key. With `column_width = 20` in a found `.taplo.toml`,
   `-o column_width=88` still formats at 88. What the config supplies is every
   option the command line does **not** set: a config carrying `indent_string`
   and `array_trailing_comma` changed a broken array from two-space-indented
   with a trailing comma to eight-space-indented without one. Ancestor search
   confirmed (config in the parent, run from a child). So the flag is
   load-bearing and the conclusion stands — the reason is "the config fills the
   gaps", not "the config overrides `-o`".

   **[reviewer] `--stdin-filepath x.toml` is inert here.** All 30 committed
   reference outputs regenerate byte-identically without it. With
   `--no-auto-config` there is no config whose `include` globs could consult the
   name, and `taplo fmt` parses TOML unconditionally. It is harmless and has
   been left in place, but it is cargo-cult for _this_ reference; prettier
   genuinely needs the equivalent, taplo does not. Do not copy it into a
   manifest without showing it changes something.

3. **Arrays never fill, and a break is inherited by every array inside it.**
   When a flat array does not fit, taplo breaks it one element per line — it
   never fills several elements to a line the way prettier does.
   `ports = [8080, ..., 8089]` fits and stays flat; the string arrays in
   `sequences.toml` break one-per-line.

   **[reviewer] "all-or-nothing", as originally written, understates this and
   `arrays.toml`'s own header comment ("the formatter must decide single-line vs
   one-per-line for each independently") is wrong.** The decision is _not_ per
   array. Once an array breaks, **every array nested inside it also breaks,
   regardless of whether the child would fit**, and the propagation crosses
   inline table boundaries. At width 70:

   ```
   tbl_in_arr = [{ a = [1, 2] }, { b = [3, 4] }, ... ]   # 89 cols, must break
   →
   tbl_in_arr = [
     { a = [
       1,
       2,
     ] },
     ...
   ]
   ```

   `{ a = [1, 2] }` is 14 columns at indent 2 and fits with 54 to spare, yet
   `[1, 2]` still breaks. Same at width 40 for `[[1, 2], [3, 4], ...]`: every
   `[1, 2]` goes to three lines. This is a _contagious_ break, not a fitting
   decision, and a package that models each array as an independent group will
   diverge from taplo on every nested array in `nesting.toml`. This is the
   single most consequential fact in this report for stage C.

4. **The trailing-comma policy is inverted from black.** taplo _adds_ a trailing
   comma to every element when it breaks an array (even when the input had
   none), and _removes_ trailing commas when it collapses to one line.
   `[1, 2, 3,]` → `[1, 2, 3]`; a long flat array → `[\n  1,\n  2,\n  3,\n]`.
   That is `["trail", ",", ...]` with the opposite of black's "magic trailing
   comma" semantics — the comma is a consequence of breaking, never a cause of
   it.

5. **Inline tables are never broken between their key-value pairs.** The grammar
   permits a newline inside an inline table _value_, so taplo will break an
   array inside `{ a = [ ... ] }` — but it will not break
   `{ host = ..., port = ..., ... }` between pairs. `long_inline` (93 chars)
   stays on one line at width 60. This is the clearest case where "the same data
   has several legal spellings" bites: the same settings written as an inline
   table cannot reflow, written as a `[table]` header they can. It means some
   reference lines are unfixably over width, and a package that reflows inline
   tables would _diverge_ from taplo by being correct.

6. **taplo does not normalise between the legal spellings.** `[a.b]` stays
   `[a.b]` (not split into `[a]` + `[b]`), dotted keys stay dotted, inline
   tables stay inline, arrays of tables stay arrays of tables. It is purely a
   layout formatter here, which is exactly what the linearity invariant wants a
   reference to be.

7. **Comment attachment keeps arrays broken.** An array with a trailing comment
   on any element — or a comment right after the opening bracket — is _not_
   collapsed to one line even when it would fit, because collapsing would strand
   the comment. Comments keep their order and their text; taplo only normalises
   the whitespace before a trailing `#` to a single space.

   **[reviewer] Confirmed, and with a second, separate mechanism the report
   missed: a trailing comment counts toward the column width of the line it sits
   on.** `fits = [1, 2, 3] # a somewhat longer trailing comment here` at width
   40 breaks the array — even though `[1, 2, 3]` is 9 columns — and the result
   is still 42 columns wide because the comment moves to the `]` line. taplo
   will destroy a perfectly good flat array in a futile attempt to fit a comment
   it cannot move. A package that measures only the value will keep it flat and
   diverge. Whitespace _after_ the `#` is preserved verbatim (`# a` vs
   `#    a`); only the run _before_ it is collapsed, and a tab before `#` also
   collapses to one space.

8. **Blank lines are preserved up to a cap of two.** A run of one or two blank
   lines survives; three or more collapse to two. This is exactly the
   `["blank", n]` shape in the design, with taplo's cap at 2 (black's depth rule
   is 2 at module level, 1 inside a block — taplo has no depth distinction).

9. **Value spelling is preserved exactly.** Hex case (`0xDEADBEEF`),
   `inf`/`nan`, date/time formats including the space-separated
   `1979-05-27 07:32:00`, and string escapes (`\u00e9` is kept as `\u00e9`, not
   decoded) all survive. So the reference imposes no token rewrites, which is
   what makes gate 3's generic default sufficient.

10. **[reviewer, added] taplo does a full pass of token-level whitespace normalisation,
    and the original 14 files probed none of it** — every one was hand-written already
    in taplo-normal spacing, so seven of them were byte-identical input to output
    at both widths. Verified and now probed by `whitespace.toml`:

    | in                        | out                     |
    | ------------------------- | ----------------------- |
    | `a    =    1` / `b=2`     | `a = 1` / `b = 2`       |
    | `[ 1, 2 ]` / `[1 ,2 , 3]` | `[1, 2]` / `[1, 2, 3]`  |
    | `{x=1,y = 2}`             | `{ x = 1, y = 2 }`      |
    | `[  section  ]`           | `[section]`             |
    | `[ outer . inner ]`       | `[outer.inner]`         |
    | `dotted . key = 1`        | `dotted.key = 1`        |
    | 4-space / tab indent      | column 0                |
    | `#no space after hash`    | unchanged (no space in) |

    Note the two directions: bracket padding is **removed**, brace padding is
    **added**. Pairs under a table header are de-indented to column 0 — taplo
    has no notion of table-body indentation at all. And taplo never inserts a
    blank line before a table header that lacks one.

11. **[reviewer, added] `[[  items  ]]` is legal TOML that taplo 0.10.0 rejects.**
    Whitespace inside the double brackets of an array-of-tables header is permitted
    by the spec and `tree-sitter-toml` parses it with no `ERROR` node, but taplo
    errors with `expected identifier` and exits non-zero. Single-bracket `[  section  ]`
    is accepted and normalised. This is the first grammar/reference disagreement
    found for TOML; it is kept out of the corpus deliberately (an input the reference
    refuses cannot have reference output) and noted in `whitespace.toml`. Stage C
    should refuse or preserve, not "correct", such input.

## Harness changes

None outside the two sanctioned locations. `gen_trees.py`, `gen_reference.py`,
`score.py`, `gate3.py` and `check_gate3.py` all ran unchanged against the
manifest — no grammar listed in any inline `dependencies` block, no `toml`
branch in any shared script.

## Gates

- `./build.sh` — green.
- `./test.sh` — cargo test, clippy `-D warnings`, node test and `check_gate3.py`
  (58 outputs across 3 languages, 92 mutations rejected) all green. The scorer
  then reports `DISQUALIFIED` because **there is no `packages/toml.json` yet** —
  that is stage C's deliverable, not this slice's. See the template delta below.
- `./harness/check_gate3.py --language toml` — green: 30 reference outputs pass,
  60 destructive mutations rejected, 0 generic/override disagreements. (28/56
  before the reviewer added `whitespace.toml`.)
- `./harness/check_width.py . 20 120 --language toml` — green (1515/1515, both
  runtimes refusing identically in the absence of a package). (1414/1414
  before.)
- `./harness/gen_reference.py --language toml --check` — silent, exit 0: the
  committed reference output is reproducible.

**Reviewer verification (stage B).** All 28 original reference files were
regenerated from `corpus/src/` with the manifest's command and matched
byte-for-byte, so the reference output is genuinely taplo's and not hand-edited.
`nix run nixpkgs#taplo -- --version` printed `taplo 0.10.0`, matching
`reference_version`. No `.taplo.toml` or `taplo.toml` exists in the worktree or
any ancestor, so the committed output was not contaminated. No tree contains an
`ERROR` or `MISSING` node.

## Template delta

One real gap, and one piece of noise.

**Gap: a stage-A manifest makes `./test.sh` fail.** `score.py` scores every
language that has a manifest, and it has no notion of "corpus and manifest are
ready but the package is not." A builder who follows the brief's "run the gates
until green" cannot get `./test.sh` green on this slice: the scorer refuses all
28 toml runs with `no package for language toml`. This is the same shared-file
trap the manifest schema was built to avoid, wearing a different hat — the
scorer's language set is now "every manifest," but a manifest arrives a full
stage before its package. The clean fix is a manifest field
(`package_pending = true`, or letting the scorer count a missing package as
_unscored_ rather than _refused_) so stage A can be green without touching
`score.py` and without a `toml` branch. I did not patch `score.py`; the brief
forbids a `toml` branch and this wants a schema field, not a special case.

**Noise:** the brief's `widths` guess (`[88, 60]`) is fine — both are honoured —
but the WORKFLOW doc's worked example uses `[60, 80]` and its reference table
says taplo's own default is 80. Neither number matters because
`-o column_width=N` overrides the default, but a builder reading both files will
second-guess which `widths` to use.
