# Language roster and status board

Orchestrator's source of truth for what is in flight. Update on every stage
transition.

Status: `-` not started · `A` corpus building · `B` corpus review · `C` package
building · `D` package review · `E`/`F` escalated · **merged** · **blocked**

## Board

| Language   | Tier | Round | Builder       | Status | Grammar                | Reference                         |
| ---------- | ---- | ----- | ------------- | ------ | ---------------------- | --------------------------------- |
| JSON       | T1   | —     | —             | merged | tree_sitter_json       | prettier                          |
| Python     | T2   | —     | —             | merged | tree_sitter_python     | black                             |
| TOML       | T1   | 1     | grok          | merged | tree-sitter-toml       | taplo 0.10.0                      |
| YAML       | T1   | 2     | DS+grok+Terra | merged | tree_sitter_yaml       | prettier                          |
| CSS        | T1   | 2     | grok          | merged | tree_sitter_css        | prettier                          |
| Go         | T2   | 2     | DS+grok       | merged | tree_sitter_go         | gofmt                             |
| Rust       | T2   | 3     | unrecorded    | merged | tree_sitter_rust       | rustfmt                           |
| Kotlin     | T2   | 3     | unrecorded    | merged | tree_sitter_kotlin     | ktfmt                             |
| JavaScript | T2   | 3     | unrecorded    | merged | tree_sitter_javascript | prettier                          |
| Markdown   | T2   | 4     | grok-4.6      | B      | tree_sitter_markdown   | prettier                          |
| TypeScript | T2   | 4     | grok-4.6      | B      | tree_sitter_typescript | prettier                          |
| XML        | T3   | 4     | grok-4.6      | B      | tree_sitter_xml        | prettier (`@prettier/plugin-xml`) |
| HTML       | T3   | 4     | grok-4.6      | B      | tree_sitter_html       | prettier                          |
| Ruby       | T4   | 5     | grok-4.6      | A      | tree_sitter_ruby       | syntax_tree                       |
| Scheme     | T4   | 5     | grok-4.6      | A      | tree_sitter_scheme     | emacs `scheme-mode`               |
| Haskell    | T4   | 5     | grok-4.6      | A      | tree_sitter_haskell    | ormolu                            |
| Aven       | T4   | 6     | tbd           | -      | **none — see below**   | `aven fmt`                        |

Grammar package names are the orchestrator's guess from PyPI naming convention.
Stage A confirms or corrects each one and records the pin in the manifest; a
wrong guess here is a template delta, not a failure.

**Round 3 stage B is complete and merged, 2026-08-18.** All three passed and all
three are on `main`. Two were cut off by a session limit mid-review and resumed
on DeepSeek; the Opus subagent runs that started them were off-lane — see
`LEDGER.md`, "Reviewer lane".

| Language   | Verdict                   | Reviewer        | Cross-check               |
| ---------- | ------------------------- | --------------- | ------------------------- |
| JavaScript | `pass with fixes applied` | Opus (off-lane) | orchestrator merge review |
| Kotlin     | `pass with fixes applied` | Opus → DeepSeek | grok, then orchestrator   |
| Rust       | `pass with fixes applied` | Opus → DeepSeek | orchestrator merge review |

Each found something the others could not have: JavaScript that prettier's
`objectWrap` defaults to `preserve`, so a width-driven `group` is the wrong
model for objects; Kotlin that ktfmt's `sortedAndDistinctImports` is two
exclusions, sorting _and_ de-duplication, not one; Rust that `FINDINGS` 4 was
already decided and the leading-`|` deletion needed a dedicated `[incomparable]`
probe rather than another deferral to Dave.

**Round 3 is closed. All three merged 2026-08-20** — `c5e90f3`, `bcadfc3`,
`7480e32`. Stage D reviewed every divergence in all three; the nine merged
languages now stand at **0 stale, 0 unreviewed, 0 `package-bug`**, 140 agreement
of 217 pairs, in 25,048 B of a 25,600 B budget.

**The board carried round 3 as `C` for two days after that**, which is the
second time this exact failure has been recorded here — the first was carrying
stage A as `-` for a day. The line below is not advice, it is the thing that
keeps being ignored: **update the board at the transition, not at the merge, and
not when someone next reads it.**

Round 3 also left one branch open rather than merged: `worktree-feat-cell-scope`
carries FINDINGS 22 (comment-cell scoping, LEDGER row 17) and FINDINGS 13
(`drop`, row 18, parked). It is stage-D follow-up work on Rust, not a stage of
its own.

Their builders are recorded as `unrecorded` because none of the three corpus
reports names the agent that wrote it. That is a template gap, not an
attribution dispute — a stage-A report should identify its builder the way the
runtime-change ledger identifies its agent, and `corpus-brief.md` does not ask
for it. Every earlier round's builder is known only because the orchestrator
launched them within one session's memory.

**Round 5 started early, 2026-08-21**, because round 4's stage A finished in a
morning. Ruby, Scheme and Haskell are all on grok-4.6 in parallel worktrees,
while round 4's four stage-B reviews run on Opus and Sonnet subagents — see
`LEDGER.md`, "Reviewer lane", for why that lane and not another.

All three round-5 references had to be established rather than assumed, and none
is an `npx` one-liner: **there is no emacs, no ormolu and no `syntax_tree` on
this machine**, though `nix`, `ruby`, `guile` and `scheme` are present. Each
brief names the pinned-runner shape to establish and says that a reference which
cannot be pinned reproducibly is a finding to report, not a reason to switch
references unilaterally. Two of the three are also suspected
`reference_width = "fixed"` languages — emacs `scheme-mode` and ormolu both
indent without reflowing to a column — and both briefs give that as a hypothesis
to test at two widths, explicitly not as a fact, so it cannot be inherited the
way black's 88 was inherited into TOML in round 1.

**Round 4 stage A, 2026-08-21.** All four launched on grok-4.6 in parallel
worktrees, each with the corpus brief plus its own "known stresses" note. All
four are built and awaiting stage-B review, in 10 commits across four worktrees,
every tree clean and every shared-file diff verified empty. **All four corpora
are grok-built, so none of their stage-B reviews may go to grok** — a reviewer
is never the same family as the builder.

Each produced a finding its brief predicted, which is the argument for the
"known stresses" section existing at all:

- **HTML answers the markup question the board asked.** Every element is an
  `element` node, and whether prettier may break between two of them depends on
  the **`tag_name`**, not the node type: `<div>a</div><div>b</div>` always
  stacks, `<span>a</span><span>b</span>` packs and hug-wraps at 40. A node-type
  table cannot express that. Note this is the same limit the board predicts for
  **Scheme** in round 5 — "layout is driven by the head of a form, not the node
  type" — arriving a round early and in a second language.
- **HTML also breaks the injection schema.** `<script>` / `<style>` carry
  `raw_text` and no info-string child: the guest language is a fact of the node
  type, which `[[injections]]` cannot say. An optional `guest` field is proposed
  in the report with exact patch lines, not applied.
- **Gate 3's comment layer is inert in two of the four**, found independently.
  XML's comments are named `Comment` nodes; markdown's are `html_block`. Neither
  grammar marks them as extras, so `corpus_stats` reports 0 comments and
  `drop_a_comment` never fires — the universal extras layer, whose only input is
  comments, does nothing for either language. Same class as FINDINGS 12, and the
  proposed `comment_kinds` manifest field is now paid for twice in one round.
  Proposed with exact patch lines by XML, not applied.
- **Markdown found the first real defect in the injection machinery**, which is
  the machinery it exists to exercise. `injection.region_for` takes the raw byte
  slice of `code_fence_content`, so a fence inside a block quote carries its
  `>` prefixes into the guest parser: JSON fails to parse and the guest
  reformat becomes a verbatim gate-3 miss. List-item fences splice correctly,
  because their continuation is spaces. Patch proposed, not applied; the
  corpus's nested JSON lives in lists rather than quotes so the probe set stays
  honest about what works.
- **TypeScript found the mirror of FINDINGS 13.** prettier _adds_ a leading `|`
  to a broken union — a token the source does not have, inserted conditionally
  on breaking — where rustfmt _deletes_ one. `trail` and `autoparen` are the
  only sanctioned token additions and neither is leading-and-break-conditional.
  The Doc IR has `IfBreak`; no opcode exposes it.

Two numbers stage B should look at rather than take on trust. Markdown's
`proseWrap` defaults to **`preserve`**, so prettier reflows no paragraph, table,
list item or heading: only **5 of 15** files can tell the two widths apart, all
via fenced code, against a bar of one third. It clears the bar exactly and the
builder reported the number instead of padding the corpus, which is what the
brief asks for — but it means markdown's width sensitivity is entirely borrowed
from its guests. Its reference also changes only **9 of 15** files, the lowest
of the four.

**agy (Gemini 3.7 Flash) is not in round 2, and not by choice.** It was
allocated the second CSS and Go seats. In headless mode it auto-denies any tool
needing the `command` permission and exits 0 having done nothing — a 303-byte
log that looks exactly like a launch that worked. The two documented fixes are
`--dangerously-skip-permissions` or a `permissions.allow` list in
`~/.gemini/antigravity-cli/settings.json`; the first is blocked here and the
second is a standing, global widening of what every future agy session may run,
so it is with Dave. `--mode accept-edits` is **not** sufficient — it covers
edits, not commands. The worktrees `lang-css-agy` and `lang-go-agy` are cut and
waiting.

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
