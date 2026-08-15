# Language roster and status board

Orchestrator's source of truth for what is in flight. Update on every stage
transition.

Status: `-` not started · `A` corpus building · `B` corpus review · `C` package
building · `D` package review · `E`/`F` escalated · **merged** · **blocked**

## Board

| Language   | Tier | Round | Builder | Status | Grammar                 | Reference                         |
| ---------- | ---- | ----- | ------- | ------ | ----------------------- | --------------------------------- |
| JSON       | T1   | —     | —       | merged | tree_sitter_json        | prettier                          |
| Python     | T2   | —     | —       | merged | tree_sitter_python      | black                             |
| TOML       | T1   | 1     | all 3   | -      | tree_sitter_toml        | taplo                             |
| YAML       | T1   | 2     | tbd     | -      | tree_sitter_yaml        | prettier                          |
| CSS        | T1   | 2     | tbd     | -      | tree_sitter_css         | prettier                          |
| Go         | T2   | 2     | tbd     | -      | tree_sitter_go          | gofmt                             |
| Rust       | T2   | 3     | tbd     | -      | tree_sitter_rust        | rustfmt                           |
| Kotlin     | T2   | 3     | tbd     | -      | tree_sitter_kotlin      | ktfmt                             |
| JavaScript | T2   | 3     | tbd     | -      | tree_sitter_javascript  | prettier                          |
| TypeScript | T2   | 4     | tbd     | -      | tree_sitter_typescript  | prettier                          |
| XML        | T3   | 4     | tbd     | -      | tree_sitter_xml         | prettier (`@prettier/plugin-xml`) |
| HTML       | T3   | 4     | tbd     | -      | tree_sitter_html        | prettier                          |
| Ruby       | T4   | 5     | tbd     | -      | tree_sitter_ruby        | syntax_tree                       |
| Scheme     | T4   | 5     | tbd     | -      | tree_sitter_scheme      | emacs `scheme-mode`               |
| Haskell    | T4   | 5     | tbd     | -      | tree_sitter_haskell     | ormolu                            |
| Aven       | T4   | 6     | tbd     | -      | **unknown — see below** | `aven fmt`                        |

Grammar package names are the orchestrator's guess from PyPI naming convention.
Stage A confirms or corrects each one and records the pin in the manifest; a
wrong guess here is a template delta, not a failure.

## Known stresses, placed deliberately

Each of these is a case the python-shaped template does not obviously cover.
They are spread across rounds so the template hardens against one class at a
time rather than all at once.

- **Go (R2)** — gofmt has no width knob and does not reflow. First test of
  `gate2 = "waive"` and of a reference with exactly one correct output.
- **YAML (R2)** — whitespace is semantic; block vs flow style; the reference
  makes choices our Doc IR may have no way to express.
- **HTML/XML (R4)** — inline vs block elements, and whitespace significance that
  depends on the element. The clearest test of whether a node-type →
  Doc-expression table is expressive enough for markup.
- **Ruby (R5)** — `do…end` vs `{…}` block forms chosen by context; optional
  parentheses. A formatter here makes decisions no delimiter table encodes.
- **Scheme (R5)** — homoiconic, so layout is driven by the _head_ of a form, not
  the node type. Dispatch is `node.type` today; Scheme is the sharpest possible
  test of that. Expect a runtime-change request; judge it carefully.
- **Haskell (R5)** — layout rule, operator sections, `where` clauses. Ormolu's
  style is fixed, so agreement is all-or-nothing per construct.
- **Aven (R6)** — layout-sensitive _and_ supports user-declared custom operators
  (`aven fmt --operator TOKEN:ANCHOR:ASSOCIATIVITY`). A formatter whose correct
  output depends on a declaration elsewhere in the file is outside anything the
  design has faced. Placed last for that reason.

## Aven — extra stage-A work

Aven is the only language with no assured tree-sitter grammar. Stage A must
first establish which of these is true, and report it before building anything:

1. a grammar exists in `~/w/clex/aven-lang/editors/` and can be built,
2. a grammar exists elsewhere in that repo under another name, or
3. no grammar exists, and one must be written or the language deferred.

If (3), stop and report. Writing a tree-sitter grammar is a different project
and is not in scope for a language-onboarding slice.
