# TOML corpus and harness entry — stage A report

## The manifest

`harness/languages/toml.toml`. Every field that had to be *discovered* rather than
copied, and how:

| Field              | Value                                  | How it was established                                        |
| ------------------ | -------------------------------------- | ------------------------------------------------------------- |
| `grammar`          | `tree-sitter-toml==0.7.0`              | PyPI has 0.6.0 and 0.7.0; 0.7.0 is latest. The brief's guess was right. |
| `grammar_module`   | `tree_sitter_toml`                     | Imported it and checked — the hyphen-to-underscore swap is correct here. |
| `grammar_symbol`   | `language`                             | The module exports exactly one name, `language`.               |
| `reference`        | `nix run nixpkgs#taplo -- fmt --no-auto-config -o column_width={width} --stdin-filepath x.toml -` | Run, not read. See "the width knob" below.                     |
| `reference_version`| `taplo 0.10.0`                         | Observed from `nix run nixpkgs#taplo -- --version`.            |
| `reference_width`  | `"flag"`                               | Run at 88 and 60 and diffed: a flat array that fits at 88 breaks one-per-line at 60. |
| `widths`           | `[88, 60]`                             | Both honoured by taplo.                                        |
| `gate3`            | `"default"`                            | `tomllib` is *weaker* than the generic tree comparison, see below. |
| `transparent_wrappers` / `equivalent_kinds` | `[]` / `[]`          | taplo moves no parentheses and renames no nodes; the strict end. |

### Why `gate3 = "default"`

The brief's rule is "default unless toml has a real semantic checker." Python's
stdlib `tomllib` is a loader, and it is weaker than the generic named-node
comparison in exactly the places a formatter could hide a token rewrite:

- `tomllib.loads("1_000") == tomllib.loads("1000")` — it normalises number
  spelling, so a formatter rewriting `1_000` to `1000` (a real token change)
  passes `tomllib` but fails the generic default.
- `[a.b]` and `[a]` + `[b]` both load to the same nested dict, so the spelling of
  table nesting is invisible to it.
- `nan` compares unequal to itself (`float('nan') != float('nan')`), so a dict
  containing `nan` would make the signature compare unequal even when nothing
  changed.

The generic default — named-node kind plus leaf text — already catches key
reordering and every spelling-preserving change, which is stronger than `tomllib`
for non-destruction and has none of those traps. The universal extras layer
covers comments. So no override file is needed.

## The corpus — 14 files

Five required, nine characteristic. Each is valid, meaningful TOML and parses with
no `ERROR` node (`gen_trees.py` refuses otherwise).

Required probes:

- `nesting.toml` — tables inside tables, arrays of inline tables, arrays of arrays,
  deep enough that the narrow width breaks the innermost levels first.
- `sequences.toml` — long flat arrays of scalars; the one TOML construct that
  overflows a line, forcing the single-line-vs-broken decision at both widths.
- `comments.toml` — a comment in every position TOML allows: file-leading, trailing
  on a pair, own-line before a pair, after a table header, trailing on array
  elements, own-line inside an array, after the opening bracket, before the closing
  bracket.
- `strings.toml` — basic, literal, multiline-basic and multiline-literal strings,
  plus the escapes each honours; multiline strings must survive byte-for-byte.
- `kitchen.toml` — a Cargo-style manifest: tables, arrays of tables, inline tables,
  dotted keys, features and comments interacting.

Characteristic of TOML:

- `tables.toml` — the several spellings of nested tables (`[a.b]` vs `[a]`+`[b]`),
  which a formatter must lay out without collapsing.
- `array_tables.toml` — arrays of tables `[[x]]`, including the legal empty element.
- `dotted_keys.toml` — dotted keys on the value side (`a.b.c = 1`), the spelling
  that is not a table header.
- `inline_tables.toml` — `{ key = value }` inline tables, nested and long; the
  construct taplo refuses to break between pairs.
- `values.toml` — every scalar spelling: hex/octal/binary ints, underscores,
  exponent/inf/nan floats, booleans.
- `arrays.toml` — empty, heterogeneous, nested, trailing-comma and already-multiline
  arrays.
- `quoted_keys.toml` — quoted keys (spaces, embedded dots, empty key, unicode
  escape) in both pair and header position.
- `dates.toml` — all four date/time forms, including space-separated local
  date-time and fractional-second precision.
- `blank_lines.toml` — vertical spacing between pairs and before headers, where
  taplo preserves up to two blank lines.

## What taplo does that surprised me

This is the section that matters. taplo 0.10.0 is a much more opinionated
formatter than its "data" tier suggests.

1. **The width knob is `-o column_width=N`.** Not `--column-width`, not
   `--line-length`. The brief warned exactly this, and it is right: nothing in
   `taplo fmt --help` advertises that width is a `key=value` formatter option, not
   a flag. Discovered by running, not reading.

2. **taplo reads config files from the filesystem even for stdin input**, and
   logs `INFO ... found configuration file` / `WARN ... invalid configuration file`
   to **stderr** when it finds a `.taplo.toml` or `taplo.toml`. A stray config in
   the cwd (or a parent) silently changes the formatting. `--no-auto-config` makes
   the committed reference output depend only on the input and the width. This is
   a reproducibility hazard the brief flagged, and it is real.

3. **Array breaking is all-or-nothing.** When a flat array does not fit, taplo
   breaks it one element per line — it never fills several elements to a line the
   way prettier does. `ports = [8080, ..., 8089]` fits and stays flat; the
   string arrays in `sequences.toml` break one-per-line. A node-type table can
   express this (a `group` whose break means "one per line"), but it is a real
   choice, not the default.

4. **The trailing-comma policy is inverted from black.** taplo *adds* a trailing
   comma to every element when it breaks an array (even when the input had none),
   and *removes* trailing commas when it collapses to one line. `[1, 2, 3,]` →
   `[1, 2, 3]`; a long flat array → `[\n  1,\n  2,\n  3,\n]`. That is
   `["trail", ",", ...]` with the opposite of black's "magic trailing comma"
   semantics — the comma is a consequence of breaking, never a cause of it.

5. **Inline tables are never broken between their key-value pairs.** The grammar
   permits a newline inside an inline table *value*, so taplo will break an array
   inside `{ a = [ ... ] }` — but it will not break `{ host = ..., port = ..., ... }`
   between pairs. `long_inline` (93 chars) stays on one line at width 60. This is
   the clearest case where "the same data has several legal spellings" bites: the
   same settings written as an inline table cannot reflow, written as a `[table]`
   header they can. It means some reference lines are unfixably over width, and a
   package that reflows inline tables would *diverge* from taplo by being correct.

6. **taplo does not normalise between the legal spellings.** `[a.b]` stays
   `[a.b]` (not split into `[a]` + `[b]`), dotted keys stay dotted, inline tables
   stay inline, arrays of tables stay arrays of tables. It is purely a layout
   formatter here, which is exactly what the linearity invariant wants a reference
   to be.

7. **Comment attachment keeps arrays broken.** An array with a trailing comment on
   any element — or a comment right after the opening bracket — is *not* collapsed
   to one line even when it would fit, because collapsing would strand the comment.
   Comments keep their order and their text; taplo only normalises the whitespace
   before a trailing `#` to a single space.

8. **Blank lines are preserved up to a cap of two.** A run of one or two blank
   lines survives; three or more collapse to two. This is exactly the
   `["blank", n]` shape in the design, with taplo's cap at 2 (black's depth rule
   is 2 at module level, 1 inside a block — taplo has no depth distinction).

9. **Value spelling is preserved exactly.** Hex case (`0xDEADBEEF`), `inf`/`nan`,
   date/time formats including the space-separated `1979-05-27 07:32:00`, and
   string escapes (`\u00e9` is kept as `\u00e9`, not decoded) all survive. So the
   reference imposes no token rewrites, which is what makes gate 3's generic
   default sufficient.

## Harness changes

None outside the two sanctioned locations. `gen_trees.py`, `gen_reference.py`,
`score.py`, `gate3.py` and `check_gate3.py` all ran unchanged against the manifest
— no grammar listed in any inline `dependencies` block, no `toml` branch in any
shared script.

## Gates

- `./build.sh` — green.
- `./test.sh` — cargo test, clippy `-D warnings`, node test and `check_gate3.py`
  (58 outputs across 3 languages, 92 mutations rejected) all green. The scorer
  then reports `DISQUALIFIED` because **there is no `packages/toml.json` yet** —
  that is stage C's deliverable, not this slice's. See the template delta below.
- `./harness/check_gate3.py --language toml` — green: 28 reference outputs pass,
  56 destructive mutations rejected, 0 generic/override disagreements.
- `./harness/check_width.py . 20 120 --language toml` — green (1414/1414, both
  runtimes refusing identically in the absence of a package).
- `./harness/gen_reference.py --language toml --check` — silent, exit 0:
  the committed reference output is reproducible.

## Template delta

One real gap, and one piece of noise.

**Gap: a stage-A manifest makes `./test.sh` fail.** `score.py` scores every
language that has a manifest, and it has no notion of "corpus and manifest are
ready but the package is not." A builder who follows the brief's "run the gates
until green" cannot get `./test.sh` green on this slice: the scorer refuses all 28
toml runs with `no package for language toml`. This is the same shared-file
trap the manifest schema was built to avoid, wearing a different hat — the
scorer's language set is now "every manifest," but a manifest arrives a full stage
before its package. The clean fix is a manifest field (`package_pending = true`,
or letting the scorer count a missing package as *unscored* rather than *refused*)
so stage A can be green without touching `score.py` and without a `toml` branch.
I did not patch `score.py`; the brief forbids a `toml` branch and this wants a
schema field, not a special case.

**Noise:** the brief's `widths` guess (`[88, 60]`) is fine — both are honoured —
but the WORKFLOW doc's worked example uses `[60, 80]` and its reference table says
taplo's own default is 80. Neither number matters because `-o column_width=N`
overrides the default, but a builder reading both files will second-guess which
`widths` to use.
