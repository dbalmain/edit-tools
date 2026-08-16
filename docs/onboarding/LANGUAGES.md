# Language roster and status board

Orchestrator's source of truth for what is in flight. Update on every stage
transition.

Status: `-` not started · `A` corpus building · `B` corpus review · `C` package
building · `D` package review · `E`/`F` escalated · **merged** · **blocked**

## Board

| Language   | Tier | Round | Builder | Status | Grammar                | Reference                         |
| ---------- | ---- | ----- | ------- | ------ | ---------------------- | --------------------------------- |
| JSON       | T1   | —     | —       | merged | tree_sitter_json       | prettier                          |
| Python     | T2   | —     | —       | merged | tree_sitter_python     | black                             |
| TOML       | T1   | 1     | grok    | C      | tree-sitter-toml       | taplo 0.10.0                      |
| YAML       | T1   | 2     | tbd     | -      | tree_sitter_yaml       | prettier                          |
| CSS        | T1   | 2     | tbd     | -      | tree_sitter_css        | prettier                          |
| Go         | T2   | 2     | tbd     | -      | tree_sitter_go         | gofmt                             |
| Rust       | T2   | 3     | tbd     | -      | tree_sitter_rust       | rustfmt                           |
| Kotlin     | T2   | 3     | tbd     | -      | tree_sitter_kotlin     | ktfmt                             |
| JavaScript | T2   | 3     | tbd     | -      | tree_sitter_javascript | prettier                          |
| Markdown   | T2   | 4     | tbd     | -      | tree_sitter_markdown   | prettier                          |
| TypeScript | T2   | 4     | tbd     | -      | tree_sitter_typescript | prettier                          |
| XML        | T3   | 4     | tbd     | -      | tree_sitter_xml        | prettier (`@prettier/plugin-xml`) |
| HTML       | T3   | 4     | tbd     | -      | tree_sitter_html       | prettier                          |
| Ruby       | T4   | 5     | tbd     | -      | tree_sitter_ruby       | syntax_tree                       |
| Scheme     | T4   | 5     | tbd     | -      | tree_sitter_scheme     | emacs `scheme-mode`               |
| Haskell    | T4   | 5     | tbd     | -      | tree_sitter_haskell    | ormolu                            |
| Aven       | T4   | 6     | tbd     | -      | **none — see below**   | `aven fmt`                        |

Grammar package names are the orchestrator's guess from PyPI naming convention.
Stage A confirms or corrects each one and records the pin in the manifest; a
wrong guess here is a template delta, not a failure.

## Known stresses, placed deliberately

Each of these is a case the python-shaped template does not obviously cover.
They are spread across rounds so the template hardens against one class at a
time rather than all at once.

- **Go (R2)** — gofmt has no width knob and does not reflow. First test of
  `reference_width = "fixed"` and of a reference with exactly one correct
  output.
- **YAML (R2)** — whitespace is semantic; block vs flow style; the reference
  makes choices our Doc IR may have no way to express.
- **Markdown (R4)** — the only language on the roster whose defining feature is
  that it **contains other languages**. Dave's headline requirement is that
  JavaScript inside a ` ```javascript ` fence is formatted and highlighted as
  JavaScript, which is why it sits with JavaScript in R4 rather than earlier.
  Designed in [../injection.md](../injection.md); `indent` now carries its own
  column count, the package map has landed, and the harness machinery is proved
  before R4 without waiting for JavaScript: `probe_injection.py` formats
  markdown containing ` ```json ` with the JSON package that merged in stage 0.
  Markdown is also the language where refusing is the wrong default: a document
  with one unparseable snippet must still format.
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
- **Aven (R6)** — no tree-sitter grammar, layout-sensitive, and user-declared
  custom operators. Three separate problems at once; it gets its own section
  below.

## Aven — a different shape of slice

**Aven has no tree-sitter grammar.** Confirmed by Dave, so stage A does not need
to go looking. It does have syntax highlighting in
`~/w/clex/aven-lang/editors/`, and **this document used to guess that was a
token-level regex/TextMate definition. That guess was wrong** — checked, and
recorded in [../highlight-design.md](../highlight-design.md). There is no
TextMate grammar. `editors/` holds only `nvim/aven.lua`, which starts
`aven lsp`; the colours are LSP semantic tokens from
`crates/aven-lsp/src/semantic_tokens.rs`, classified by a lexical default and
then overridden from the AST at binder sites and declarations.

That is better news than the guess. It means Aven's own parser already produces
something with tree structure and already survives being asked what contains
what — which is exactly what route 1 below needs, and it is independent evidence
that the route is open.

So Aven's stage A is not "build a corpus against a grammar" but "establish
whether there is a usable CST at all". Two routes, in order of preference:

1. **Emit a CST from the aven project itself.** `aven-lang` has a real parser —
   `aven check`, `aven fmt`, `aven lsp` and `aven layout` all imply a tree and a
   layout pass. If that parser can be made to emit a tree in the shape the
   runtime consumes, Aven onboards without tree-sitter at all. Dave's stated
   fallback: _"we'll develop the package from the aven project."_
2. **Write a tree-sitter grammar.** A separate project, not a
   language-onboarding slice. If route 1 fails, stop and report rather than
   starting this.

Route 1 is the more interesting result either way. It answers a question none of
the other fourteen languages touch: **is the runtime's tree interface actually
independent of tree-sitter, or has tree-sitter's node model leaked into the
design?** If a hand-rolled parser can feed the runtime, that is a real finding
about the architecture. If it cannot, that is a bigger one.

Note also that Aven is layout-sensitive and supports user-declared custom
operators (`aven fmt --operator TOKEN:ANCHOR:ASSOCIATIVITY`), so its correct
output depends on a declaration elsewhere in the file. Nothing in the design
addresses that. Aven is last on the roster for the accumulation of all three
reasons.
