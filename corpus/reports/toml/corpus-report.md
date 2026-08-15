# TOML corpus report

## Manifest

- grammar = "tree-sitter-toml==0.7.0": verified the distribution and exact pin
  in an isolated uv run --with environment before generating trees.
- grammar_module = "tree_sitter_toml" and grammar_symbol = "language":
  importing that package exposed exactly the language() accessor, returning the
  capsule accepted by tree_sitter.Language.
- The reference is
  "nix run nixpkgs#taplo -- fmt --no-auto-config -o column_width={width} --stdin-filepath x.toml -".
  It reads stdin and emits stdout; the fake TOML path is recorded with the
  working command. --no-auto-config is deliberate: Taplo otherwise searches
  for taplo.toml / .taplo.toml, which would make frozen output dependent on the
  caller's filesystem.
- reference_version = "taplo 0.10.0" is the exact output observed from
  taplo --version.
- reference_width = "flag" and widths = [88, 60]: a compact eight-item string
  array stayed on one line at 88 and broke to one item per line at 60. This
  establishes actual width control rather than inferring it from help text.
- gate3 = "toml" uses the standard-library tomllib decoder, normalising maps,
  arrays, and NaN before comparison. It is stronger than a tree-only comparison:
  it independently proves that both documents decode to the same TOML value.
  The universal tree-sitter extras layer still compares comments in order.
  check_gate3.py found zero generic/override disagreements across all 28
  reference outputs. No transparent wrappers or equivalent node kinds are needed.

## Corpus

- arrays.toml — long and manually multiline arrays; arrays are TOML's usual
  overflow point and Taplo's main width-sensitive construct.
- array-tables.toml — repeated [[table]] entries and nested array tables; they
  are TOML's representation for a list of records.
- comments.toml — own-line and trailing comments, plus both positions inside an
  array; comment attachment is TOML's important non-structural stress.
- dotted-keys.toml — bare and quoted segments in dotted keys; they create nested
  data without explicit table headers.
- inline-tables.toml — compact records, nested records, and arrays as values;
  inline tables are a distinct TOML spelling with their own layout decisions.
- keys.toml — bare, hyphenated, basic-quoted, literal-quoted, and numeric-looking
  keys; the spelling of keys is visible TOML syntax.
- kitchen.toml — tables, arrays of tables, comments, datetimes, inline tables,
  arrays, and a multiline string interacting; this is the sole deliberately mixed probe.
- literals.toml — basic and literal strings with escaping, plus both multiline
  forms; TOML's four string forms must not be conflated.
- nesting.toml — inline tables and arrays nested deeply enough to force layout
  at the narrow width.
- numbers.toml — decimal, bases, underscores, floats, exponentials, infinity,
  and NaN; TOML keeps these literal spellings distinct.
- table-headers.toml — ordinary and dotted table headers with array values;
  header hierarchy is TOML's canonical document structure.
- table-spellings.toml — the same record shape expressed as a table header and
  an inline table; it probes TOML's deliberately multiple legal spellings.
- temporal.toml — offset and local datetimes, dates, and times; these typed
  literals are a TOML-specific data feature.
- value-types.toml — booleans, strings, heterogeneous arrays, and empty
  containers; this establishes the ordinary scalar/container value surface.

All 14 source files generated clean trees with no ERROR or MISSING node. The
committed ground truth comprises 14 trees and 28 Taplo outputs.

## Reference behavior worth carrying forward

- Taplo preserves table-header, dotted-key, and inline-table spellings; it does
  not normalise a table into an inline table or vice versa.
- An inline table is not necessarily physically one line after formatting. At
  width 60, Taplo expands the ports array inside service = { ... } while
  retaining the surrounding inline-table braces.
- Taplo collapses a manually multiline, trailing-comma array when it fits at 88,
  then expands that same array at 60. Its narrow output also keeps a trailing
  comment after the closing bracket, rather than moving it to the assignment.
- Taplo preserves quote form, escape spelling, multiline-string content, and
  comment text in this corpus. The formatter's output was reproducible with
  --no-auto-config.

## Verification

- ./harness/gen_trees.py --language toml generated 14 clean trees.
- ./harness/gen_reference.py --language toml generated 28 outputs.
- ./harness/gen_reference.py --language toml --check exited 0 with no drift.
- ./harness/check_gate3.py --language toml passed: 28 reference outputs and 32
  destructive mutations rejected, with zero generic/override disagreements.
- ./build.sh passed with no warnings.
- ./harness/check_width.py . 20 120 --language toml reported 1414/1414 runtime
  agreements. At this stage that means both runtimes consistently refuse TOML
  because this slice intentionally has no package; it is not formatter coverage.
- ./test.sh cannot be green in this Stage-A-only slice: its unfiltered scorer
  includes every manifest and therefore reports TOML coverage as 0/28 with
  "no package for language toml". Rust tests, clippy, JavaScript tests, and the
  all-language gate-3 check passed before that expected scorer failure.

No files outside corpus/ and harness/languages/ were changed.

## Template delta

The brief requires both a corpus-only Stage A (explicitly no TOML package) and a
green unfiltered ./test.sh; the current scorer necessarily treats every manifest
as requiring a package, so these requirements conflict. A stage-aware test entry
point or manifest lifecycle field is needed before a corpus-only onboarding slice
can truthfully claim a green full suite. I did not add a TOML exception or a
placeholder package.

The brief also says gen_reference.py --check must be silent, while the current
script prints a formatter summary and a success line on every successful check.
It exits 0 and reports no drift; silence would require a shared harness change.
