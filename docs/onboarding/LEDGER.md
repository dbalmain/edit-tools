# Ledger

Three running records. The orchestrator writes all of them.

The fourth record, [FINDINGS.md](FINDINGS.md), is the one the others exist to
feed: the capabilities the IR lacks, each paid for by a language that could not
express something without it. This file tracks what we **changed**; that one
tracks what we **chose not to**.

## 1. Runtime changes

Dave's rule: builders may edit `rust/` and `runtime-js/` freely; the reviewer
judges after the fact and may recommend a freeze. Every edit lands here.

| #   | Language | Agent           | Change                                                                                                                    | Case made                                                                                                                                                                                                                                                                      | Reviewer verdict                                                                                                                                                                                                                                                                                        | gzip Δ                                             | Merged                    |
| --- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------- | ---------- |
| 1   | (all)    | codex-Sol       | `comment_gap` + `blank_cap` header fields; runtime reads them, not constants                                              | Trailing-comment spacing (2) and the blank-line ceiling (2) were black's, hardcoded where no package could reach them. 7 of 16 roster languages use prettier, which wants 1 of each.                                                                                           | warranted                                                                                                                                                                                                                                                                                               | +245 B                                             | 2026-08-15                |
| 2   | TOML     | grok            | `blank` reads a node's trailing trivia                                                                                    | tree-sitter-toml puts the gap before the next header _inside_ the previous table, so the parent sees a zero-width gap. A package-level `blank` floor invents blanks where the source had none.                                                                                 | warranted                                                                                                                                                                                                                                                                                               | +63 B                                              | 2026-08-16                |
| 3   | TOML     | codex-Sol       | comments flush before a following token, with `trail` the one exception                                                   | Own-line comments were delayed so `trail` could emit the separator first, and flushed only incidentally at `indent`/`blank`/node end. A legal flat rule reached the closer first and the comment absorbed it, producing invalid source.                                        | warranted (redesign of grok's `needs-redesign` edit)                                                                                                                                                                                                                                                    | +242 B                                             | 2026-08-16                |
| 4   | CSS      | grok            | `opt` gains an else branch, for a declaration mixing comma and space separators                                           | The builder's case: `when` tests the node, not the cursor, and a CSS `declaration` mixes both separators under one parent, so "there is no package-level workaround".                                                                                                          | **unnecessary — retroactively frozen and reverted** (`f2d84b9`)                                                                                                                                                                                                                                         | +44 B (reverted)                                   | —                         |
| 5   | CSS      | grok            | leftover comments attach to a descend opener                                                                              | Comments were escaping a descend node with no named host and failing gate 3. Reclassified by the reviewer as a **runtime bug fix exposed by CSS**, not a CSS feature; extends TOML's pending-comment machinery but has a distinct root cause.                                  | warranted                                                                                                                                                                                                                                                                                               | +149 B                                             | pending stage E           |
| 6   | Go       | grok            | tab indentation                                                                                                           | gofmt indents with tabs; the runtime hardcoded spaces. Same class as row 1 -- a house-style constant hardcoded where no package could reach it.                                                                                                                                | warranted                                                                                                                                                                                                                                                                                               | +39 B                                              | 2026-08-17                |
| 7   | Go       | grok            | source-mirroring breaks (`srcline`, `srcsoft`, `srctrail`, `line_break` on `Item`)                                        | gofmt keeps the author's single-line-versus-broken decision and a fit-driven `group` does the opposite. Reviewer's reframing: **one reusable source-break capability plus a source-driven counterpart to magic trailing commas**, despite appearing as three opcodes.          | warranted                                                                                                                                                                                                                                                                                               | +321 B                                             | 2026-08-17                |
| 8   | Go       | grok            | own-line comments after trailing trivia                                                                                   | tree-sitter-go's `statement_list` range swallows the newline after the last statement, so an own-line comment before `}` attached as a suffix. Third language to need a comment-attachment fix -- see FINDINGS entry 9.                                                        | warranted                                                                                                                                                                                                                                                                                               | +180 B                                             | 2026-08-17                |
| 9   | YAML     | codex-Sol       | `blank` gains a third operand (declaring leaf spellings) plus a `semantic_eof` escape from trailing-newline normalisation | YAML's `| +`keep-chomping newlines live *outside* the`block_scalar`node, in the gap the runtime owns and unconditionally caps. Gate 3 was blind to it (FINDINGS entry 12) while the package silently destroyed data. No package expression reaches an inter-item gap;`blank` is the only opcode that touches one. | warranted — **with a reviewer correction, row 11** | +341 B                    | 2026-08-17 |
| 10  | YAML     | codex-Sol       | `child-count` predicate: tally a selector's children one level down                                                       | tree-sitter-yaml wraps every value in `flow_node`/`block_node`, so a `pair` rule cannot see whether its value is a block scalar. Extends the existing `count` predicate family rather than replacing it.                                                                       | warranted, narrowly — a one-level special case standing in for FINDINGS entry 10, and it should be revisited when that entry is designed rather than grown further                                                                                                                                      | +58 B                                              | 2026-08-17                |
| 11  | YAML     | Opus (reviewer) | scope row 9's bypass to the rightmost spine                                                                               | Reviewer finding, not a builder request. Row 9 tested `contains_leaf_text` over the _whole_ preceding subtree, so a `| +`buried anywhere inside an item uncapped the gap after that item — a gap belonging to the next sibling. Probed and reproduced; the same file with`\|` capped correctly.                                                                                                                                | correction to row 9, committed with it             | −34 B code, +52 B comment | 2026-08-17 |
| 12  | JSON/CSS | codex-Sol       | `fill`: pack alternating content and separators independently per line                                                    | JSON has a long numeric array where group/each emitted one item per line; CSS stage D found fill contributes to 13/21 divergences and fully resolves 9/21. The printer already owns the remaining width, so this stays local: no sibling measurement or ancestor state.        | warranted; JSON's all-array opt-in was reverted (4/6 → 2/6). CSS later opted in: 11/30 → 18/30, 7 of 19 accepted resolved; stage D's 9/21 was optimistic (calc and `--list` need comma-group items / broken-on-this-line, which this fill cannot do)                                                    | +365 B runtime, +44 B CSS package                  | 2026-08-17                |
| 13  | JSON/CSS | grok            | `all` predicate: every selected child has a type in a listed set                                                          | JSON could not opt into fill without telling a numeric array from a mixed one; CSS's `string_value` count was a proxy for the same test. Vacuous-true over zero children, composed with `count` where a package wants a non-empty set. Walk is `count`'s, not `child-count`'s. | JSON 4/6 → 6/6 (fill + matrix arm; parent-is-not-array still missing). CSS proxy replaced, 18/30 unchanged, 0 stale.                                                                                                                                                                                    | +86 B runtime, +133 B JSON, +17 B CSS              | 2026-08-17                |

**Freeze status: open.** Decided by Dave, 2026-08-16, against TOML's stage-D
recommendation. Builders may edit the runtime freely; the reviewer judges after
the fact and **may freeze retroactively for its own run** — reverting the edit
and requiring the package to be expressed without it. The recommendation was
declined on the grounds that a standing freeze pre-judges runtime gaps the
remaining twelve languages have not yet exposed, and the retroactive power costs
one re-scored run where a blanket freeze costs every future one.

The recommendation was not wrong on its facts. It was prompted by TOML's second
runtime edit — delayed own-line comments, verdicted `needs-redesign` — and that
defect was real. What it argued about was risk tolerance, and that is Dave's
call, not the reviewer's.

**The retroactive power was exercised for the first time the same day, on row 4,
and it worked.** CSS's builder extended `opt` with an else branch and argued in
its report that there was "no package-level workaround". The stage-D reviewer
found one — two existing positive `opt` operations composed in a specific order
— verified it preserved Rust/JS parity and every output across all 30 CSS cases,
verdicted the edit `unnecessary`, and reverted it. It did not ask, which is what
the rule now tells it to do.

That is the case for the open freeze in miniature. A standing freeze would have
blocked the edit before anyone knew whether it was necessary; the retroactive
one let the builder make its case, cost one rework, and produced a _proof_ that
the runtime did not need to grow. The rework is real — the reverted edit leaves
`packages/css.json` unable to load until stage E rewrites it — and that is the
price of the policy, paid once rather than every round.

The defect, reproduced independently in both runtimes: with a legal flat `array`
rule, a comment before the closing bracket **absorbs the bracket into its own
text**, so `a = [1,\n  # c\n]` becomes `a = [1,\n# c]` and the array is never
closed. Gate 3 rejects it ("output does not parse"), so it cannot ship silently,
but a legal package producing invalid source is a runtime defect regardless of
which gate notices. Own-line comments after the last sibling are delayed so
`trail` can emit the separator first, and they flush only incidentally — at
`indent`, at `blank`, and at node end. A flat rule reaches the closer before any
of those fire.

**Size, after round 2: 10,315 B runtime + 5,648 B of six packages = 15,963 B**
against the 25 KiB soft budget. The runtime grew 8,080 → 10,315 across the
exercise. **Go alone accounts for +540 B** and **YAML for +460 B as merged** —
the two most expensive languages so far, and the reason the attribution column
exists. CSS cost +149 B. YAML's own branch measured its edits at +399 B; the
extra 61 B is gzip context, since its opcodes now sit beside Go's and share less
dictionary than either did alone. Read the per-row figures as what the builder
measured in isolation and this paragraph as what actually shipped.

Worth noting which kind of edit is expensive. Rows 7 (+321 B) and 9 (+341 B) are
the only ones that bought a genuine _capability_ — source-mirroring breaks, and
a gap the grammar leaves outside the node that owns it. Rows 6, 8, 10 and CSS's
row 5 are a hardcoded house-style constant, two comment-attachment defects and a
one-level dispatch patch: **426 B of the 1,149 spent this round went on fixing
or working around things rather than expressing anything**, and three of those
four were the same architectural gap (FINDINGS entry 9).

**Size after `fill`: 10,680 B runtime + 5,648 B of six packages = 16,328 B.**
The opcode's isolated runtime cost is **+365 B gzip**: package validation and
evaluation build the alternating sequence, and the printer adds the per-line
two-content fit decision. CSS later opted in: the package grew 1,194 → 1,238 B
gzip (+44 B) and agreement moved 11/30 → 18/30. json / go / python / toml / yaml
outputs stayed byte-identical. Runtime gzip did not move.

**Size after `all`: 10,766 B runtime.** JSON 353 → 486 B, CSS 1,238 → 1,255 B.
JSON agreement 4/6 → 6/6; CSS stayed 18/30. go / python / toml / yaml outputs
must stay byte-identical.

Baseline at the start of the exercise: **10,196 B gzip = 8,080 runtime + 2,116
packages** (python + json), against a 25 KiB budget. **Now 10,441 B** after row
1 above — the first entry in this table, and a reminder that it is per-edit and
must name a construct rather than a slice. After any runtime change merges,
re-score every already-merged language before the next round launches.

`score.py` now reports the per-language breakdown this table is filled in from —
**python 1,983 B, json 353 B**, and "runtime + this language's own package" for
each. Note those do not sum to 2,116: gzipping the packages together shares a
dictionary between them, so the combined figure is smaller than the parts. Fill
the `gzip Δ` column from the per-language number, and expect the all-languages
total to drift below the sum as the packages start to look alike.

The 25 KiB figure is **soft**. Dave's rule: if we go over, the question is which
language features cost the bytes — so the `gzip Δ` column above must be per-edit
and attributable to a named construct, never a per-slice lump. That attribution
is the whole value of this table; a row reading "Scheme, +900 B, head-position
dispatch" answers the question, and one reading "Scheme, +900 B, runtime
changes" does not.

**The budget was 20 KB (20,480 B) and is now 25 KiB (25,600 B)** — Dave,
2026-08-17, after the alignment merge took the total to 19,202 B with nine
languages still to onboard. The raise is deliberate headroom, not an amnesty:
the accounting requirement above is unchanged, and the reason it was raised
rather than enforced is that the one thing that pushed hard against it — Go
alignment at +2,627 B — was judged worth its bytes on its merits. Watch it. At
19,202 B the remaining nine languages have roughly 6,400 B, and packages have
run 486–2,200 B each, so package growth alone plausibly consumes most of it
before any further runtime capability is added. If the next raise is proposed
for the same reason, the question stops being "is this feature worth it" and
becomes "is a downloadable-package design with two hand-written runtimes still
the right shape".

### Standing decisions

Recorded here because they bind a stage that has not run yet, and would
otherwise live only in a chat log.

**Match prettier's `objectWrap: preserve`** — Dave, 2026-08-18. JavaScript's
stage B found that prettier's object-literal break decision is
**source-sensitive, not width-driven**: an object whose source has a newline
after `{` stays expanded even when it fits flat. The alternative, `collapse`,
is what a plain width `group` implements, so the naive package is the wrong
one. Dave's call is to match the default rather than declare the divergence.
The runtime already has `srcline` / `srcsoft` / `srctrail` for exactly this, so
this is a stage-C instruction, not a findings entry. What makes it dangerous is
that a preserved break and a width break are the same bytes: a package that
gets it wrong passes the whole corpus and diverges on real input.

**JSX enters the corpus, but not yet** — Dave, 2026-08-18. JavaScript's stage B
established that JSX is reachable rather than excluded: tree-sitter-javascript
0.25.0 parses it, prettier formats it inside `.js` with no flag, and gate 3
accepts the attribute layout (the added parens are the already-transparent
`parenthesized_expression`). Only `jsx_text` refilling rejects. Deferred until
**after HTML and XML** in round 4, on the grounds that JSX is an
attribute-and-element layout problem and those two languages will have settled
that shape first. Revisit at round 4's close, not before.
| 12  | Rust     | grok            | comment text recovered from the source range when a comment node carries no `text`                                       | tree-sitter-rust's `line_comment`/`block_comment` are **interior** nodes — the `//` is a child and the body lives only in the span — while `gen_trees.py` writes `text` on leaves only, so attach emitted empty comment suffixes. A general runtime defect exposed by Rust, not a Rust feature; same class as row 5. | warranted (orchestrator merge review). Cherry-picked to `main` ahead of the Rust slice because a second builder was independently converging on the same bug and would have produced a second design for it. | +299 B | 2026-08-19 |
| 13  | JavaScript | DeepSeek      | `srcbreak` opcode — a break that is `hard` when the source broke and a group `line` when it did not                       | prettier's `objectWrap: preserve` needs both behaviours at once. `srcline`/`srcsoft` fall back to a space or nothing, which **ignore the enclosing group**, so a source-flat object that must break by width strands its first property. No composition reaches it: branching on source-brokenness would need a predicate, and `count`/`child-count`/`all` cannot see line breaks. | warranted (orchestrator merge review). Completes an existing family — one `srcBreak(flat)` helper, three call sites — rather than adding a mechanism. Cheapest runtime change on this table. | +16 B | pending stage D |
| 14  | Rust     | grok            | optional leading fraction on `group`: break unless the flat form fits **both** the remaining columns and `round(max * width)` of the group's own span | FINDINGS 17. rustfmt carries nine width thresholds; a construct that fits the line still breaks if it exceeds its own. Unreachable by our single-width `group` **at any width**. Spike `spike/rust-subwidth` measured it end to end. | warranted (orchestrator merge review). Verified inert when undeclared by re-scoring every language at 91/138 unchanged, not by reading the code. Cheapest of the three local capabilities: `fill` +365 B, alignment +2,627 B. | +228 B | 2026-08-19 |

## 2. Template revisions

Every stage-B and stage-D review ends with a template delta. Applied deltas go
here, so the templates have a history and a repeated complaint is visible as a
pattern.

| Date       | Template                              | Change                                                                                                                                                                                                                                                   | Prompted by                                                                                                                                                                                                     |
| ---------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 2026-08-15 | `WORKFLOW.md`                         | Manifest schema rewritten: `gate2` → `reference_width` (`"flag"`/`"fixed"`), `grammar_pin` → pinned PEP 508 `grammar` plus `grammar_module` and `grammar_symbol`, added `gate3_requires`, `transparent_wrappers`, `equivalent_kinds`                     | Stage 0                                                                                                                                                                                                         |
| 2026-08-15 | `corpus-brief.md`                     | Deliverable 3 no longer asks the builder to extend the tree generator; names `gen_trees.py --language` and `gen_reference.py --check`; adds the "never edit a shared file" list and the gate commands                                                    | Stage 0                                                                                                                                                                                                         |
| 2026-08-15 | `package-brief.md`, `review-brief.md` | `gate2 = "waive"` → `reference_width = "fixed"`                                                                                                                                                                                                          | Stage 0 (name collided with score.py's gate 2, which is idempotence)                                                                                                                                            |
| 2026-08-15 | `WORKFLOW.md` (Launching)             | Strip the template's leading `---` before launching; anchor the branch rewrite; head-to-head worktree naming `lang-<name>-<agent>`                                                                                                                       | R1 launch — opencode printed usage and exited 0, having run nothing                                                                                                                                             |
| 2026-08-15 | `package-brief.md`                    | Set `comment_gap`/`blank_cap` from the reference's observed behaviour rather than defaulting; and report any _second_ runtime constant that turns out to be house style                                                                                  | Design review — two of black's habits were unreachable from a package                                                                                                                                           |
| 2026-08-16 | `review-brief.md`                     | Stage B must run both `cmp` loops itself rather than reading the counts out of the report, and must check `widths` against the reference's bisected default                                                                                              | TOML stage B passed a corpus the reference changed in 6 of 14 files, and `widths = [88, 60]` against taplo's default of 80                                                                                      |
| 2026-08-16 | `corpus-brief.md`                     | Replace reference-output equivalence with the one-way adversarial rule: every useful mutation rejected by the default must also be rejected by an override; zero useful mutations is a failure                                                           | The old check certified `tomllib`, `ast.dump`, and ordered `json.loads` on correct inputs while missing their spelling blindness                                                                                |
| 2026-08-16 | `corpus-brief.md`                     | The normalisation probe must include an **empty container written with a space** (`f( )`, `{ }`, `[ ]`); if the gate rejects the reference's own output on it, report and stop rather than deleting the probe                                            | Round 2 — Go and CSS independently hit a gate-3 defect there that was latent in every merged language                                                                                                           |
| 2026-08-16 | `corpus-brief.md / review-brief.md`   | Both counts come from `./harness/corpus_stats.py`, not from hand-rolled `cmp` loops, and it prints the reference's own overflow that `score.py` cannot give a language without a package                                                                 | CSS stage B — the brief told stage-A builders to read a number `score.py` filters their language out before computing                                                                                           |
| 2026-08-16 | `corpus-brief.md`                     | A fixed-width reference makes the width-difference and reference-overflow reporting explicitly **N/A** rather than zero; `--stdin-filepath` guidance does not apply to every reference                                                                   | Go stage B — first `reference_width = "fixed"` language, and two rules read as failures rather than as inapplicable                                                                                             |
| 2026-08-16 | `corpus-brief.md`                     | `nix shell nixpkgs#…` is **not** a pinned runner: it follows the caller's registry. Where a bundled tool has no version flag, read the version from the executable's own build metadata and say that is what was done                                    | Go stage B — gofmt ships inside the `go` distribution and has no `-version`                                                                                                                                     |
| 2026-08-16 | `corpus-brief.md`                     | The excluded-reference-behaviour inventory must cover token **reordering** as well as token-text rewriting, and must be established by experiment rather than by example                                                                                 | Go stage B — gofmt sorts imports, which linearity forbids for the same reason as a quote rewrite                                                                                                                |
| 2026-08-16 | `corpus-brief.md`                     | Describe `--parser` and `--stdin-filepath` as alternative prettier parser selectors, and warn that a green generic gate is not evidence that grammar source gaps or anonymous tokens are protected                                                       | YAML stage B — two builders drew opposite conclusions about which flag was required, and both read a green gate as protection it did not give                                                                   |
| 2026-08-16 | `package-brief.md`                    | Before extending a conditional opcode, try compositions of the **existing positive selectors, in both orders**                                                                                                                                           | CSS stage D — a two-`opt` composition replaced the `opt` else branch the builder called impossible                                                                                                              |
| 2026-08-16 | `package-brief.md`                    | A divergence pair holding **both** a genuine design limit and an avoidable package defect stays `package bug` until the avoidable part is removed; the real limit does not excuse the whole hash                                                         | CSS stage D — `strings.css` mixed the entry-4 quote limit with a fixable `url()` defect                                                                                                                         |
| 2026-08-16 | `corpus-brief.md`                     | If an override is needed, **extend the default** (`(default_signature(text), extra)`) rather than replace it — that composition cannot be weaker by construction                                                                                         | YAML stage D — `| +` chomping puts semantic newlines between two nodes, where no generic rule can see them |
| 2026-08-16 | `package-brief.md`                    | Require one **language-semantic** source/output comparison wherever meaning can extend into whitespace outside a CST node range; a green generic gate is not sufficient evidence                                                                         | YAML stage D — gate 3 reported 32/32 non-destruction while the package silently dropped a newline from a `| +` scalar                                                                                |
| 2026-08-17 | `package-brief.md`                    | For a **fixed-width** reference, test any package-level workaround at one adversarially narrow width too, even though only one width is scored                                                                                                           | Go stage D — a `group + trail + srcline` composition matched at width 80 and changed source-flat `struct{ … }` at width 1, so it only looked source-sensitive                                                   |
| 2026-08-17 | `review-brief.md`                     | Stage D's runtime-edit step said "state whether you now recommend **freezing** the runtime". Rewritten to the actual policy: `unnecessary` _is_ a retroactive freeze, exercised directly and without asking, and a standing freeze must not be proposed  | Template rot — `WORKFLOW.md` was updated when Dave declined the standing freeze on 2026-08-16 and this template was not, so it invited exactly the recommendation the workflow forbids                          |
| 2026-08-17 | `review-brief.md`                     | Stage D must verdict a runtime edit's **shape**, not only whether it was needed, and must build the smallest input separating the implemented predicate from the intended one                                                                            | YAML stage E — a warranted semantic-gap bypass searched the whole preceding subtree instead of its rightmost spine; every gate passed either way (LEDGER row 11)                                                |
| 2026-08-18 | `corpus-brief.md`                     | The corpus report must name **which agent wrote it** in its first section, next to the reference and grammar pins                                                                                                                                        | Round 3 — all three stage-A reports landed without attribution, so `LANGUAGES.md` cannot record a builder for Rust, Kotlin or JavaScript                                                                        |
| 2026-08-18 | `review-brief.md`                     | Where the reference has a documented option that turns a behaviour **off by default**, stage B must say so explicitly rather than reporting the observed behaviour alone                                                                                 | Rust — `struct_field_align_threshold` and `enum_discrim_align_threshold` default to 0, which is the whole reason `alignment: "go"` does not transfer (FINDINGS 18)                                              |
| 2026-08-18 | `review-brief.md`                     | **Widened the row above the same day it was written.** Also list options that are **on** by default whose _off_ setting is what a naive package implements, and flag any default making layout depend on the input's line breaks rather than width alone | JavaScript stage B — my "off by default" framing was too narrow. `objectWrap` defaults to `preserve`; `collapse` is what a plain width `group` does, so a package can pass the corpus and diverge on real input |
| 2026-08-18 | `review-brief.md`                     | New check: every normalisation the **report claims** must have a corpus file forcing it. The report-to-corpus direction, which nothing else checks                                                                                                       | JavaScript stage B — two missing probes were added and all four `corpus_stats.py` counts stayed identical, because both were width-insensitive rewrites                                                         |

## 3. Model scorecard

The comparison Dave asked for. One row per attempt, not per language — an
escalation adds a row.

| Language | Agent     | Stage | Wall-clock | Verdict               | Shared files | Gates honest?                                  | Done-note        | Notes                                                                                                                                                                                                                                  |
| -------- | --------- | ----- | ---------- | --------------------- | ------------ | ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOML     | grok      | A     | ~13 min    | pass with fixes       | none         | yes                                            | full, structured | 4 commits = 4 green boundaries. Found `--no-auto-config`; found the comment-alignment design limit. Reported the harness defect, refused to fix it.                                                                                    |
| TOML     | DeepSeek  | A     | ~18 min    | pass with fixes       | none         | yes                                            | full, structured | Richest reference-behaviour list. Corpus written pre-formatted, so 7/14 files were a no-op. Proposed the harness fix precisely.                                                                                                        |
| TOML     | Luna      | A     | ~21 min    | **rework**            | 2            | yes, but **misdisclosed**                      | thin             | `tomllib` gate 3, strictly weaker (11/11 adversarial). Edited `manifest.py`+`score.py`, then reported "no changes outside corpus". Dropped after this round.                                                                           |
| TOML     | Terra     | A     | ~15 min    | (not reviewed)        | none         | yes                                            | thin             | Also chose `tomllib`, 32 mutations vs 54/56. Same trap as Luna → treated as a brief defect and fixed in the template.                                                                                                                  |
| TOML     | grok      | C     | ~25 min    | escalate (2 blockers) | none         | yes                                            | full, structured | First stage C in the project. 22/30, all eight divergences classified. Lumped the two runtime edits into one +233 B figure despite the brief asking per-edit. One label was wrong and one runtime edit needed redesign.                |
| TOML     | codex-Sol | D     | ~20 min    | escalate              | none         | yes (re-scored, reproduced the report exactly) | full, structured | Earned the round. Disproved a design-limit label _by experiment_, and found a runtime defect the corpus never triggered. Recommended the freeze. Left the ledger untracked.                                                            |
| TOML     | codex-Sol | E     | ~30 min    | merged                | none         | yes                                            | honest stop      | Fixed both blockers, split the runtime commits, re-verified python/json unchanged. **Stopped and asked** rather than resolving a contradiction in my brief -- the right call, and it exposed a real harness gap (resolved vs changed). |

| CSS | grok | A | ~12 min | pass with fixes | none | yes | full, structured |
Established prettier's default width by bisection unprompted. Hit the
empty-block gate-3 defect and **routed around it rather than weakening the
gate**, saying so in the note. Corpus flatters slightly: 10/15 changed at the
default width. | | YAML | grok | A | ~14 min | (base for rework) | none | yes |
full, structured | Best manifest and broadest construct coverage, and the only
builder that counted comments. Two claims wrong (editorconfig, block-scalar
gate), both corrected at stage B. Normalisation coverage inadequate at 5/15. | |
YAML | Terra | A | ~16 min | not selected | none | yes | thin | Authentic
outputs, but a stale grammar pin (0.7.0 vs 0.7.2) and prettier 3.6.2 where the
others observed 3.9.6. One commit, not per-boundary. Failed to report that its
own `documents.yaml` shows prettier deleting both `...` markers. | | YAML |
DeepSeek | A | ~20 min | corpus adopted | none | yes | full, structured | Much
the best normalisation strategy (13/14 vs 5/15) and found the broader
quote-selection behaviour nobody else did. But **self-reported 14/14 was really
13/14**, `.yml` missing from `extensions`, and its block-scalar gate claim
false. | | Go | DeepSeek | A | cut off | resumed | none | n/a — died mid-run |
none | Killed by a `check_gate3` failure that was **the gate's fault, not the
corpus's**. Left everything uncommitted despite the brief asking for
green-boundary commits, which is the cost the playbook predicts. | | Go |
DeepSeek | A′ | ~22 min | pass with fixes | none | yes | full, structured |
Graded its own previous attempt honestly and rewrote it: comments 4/16 → 16/16,
`operators.go` was a no-op and was replaced, alignment probe sharpened. Kept the
`( )` probe that exposed the gate defect. | | CSS | codex-Sol | B | ~8 min |
pass with fixes | none | yes | full, structured | Verified every count
independently. Reported the `score.py`-cannot-print-overflow-at-stage-A gap as a
template delta, which became `corpus_stats.py`. | | Go | codex-Sol | B | ~12 min
| pass with fixes | none | yes | full, structured | **Priced FINDINGS entry 1**
with a GOROOT proxy scan, and withdrew its cheap `column` partial with a reason.
Caught that `nix shell nixpkgs#…` is not an immutable pin, and that gofmt's
import sorting is an unmeasured exclusion. | | YAML | codex-Sol | B | ~18 min |
**rework** | none | yes | full, structured | The round's best work. Re-measured
all three builders and **caught DeepSeek's 14/14 as 13/14**. Found the
block-scalar source gap — a regression the orchestrator had introduced hours
earlier. Quantified the entry-4 exclusion at 20.3%. | | CSS | grok | C | ~20 min
| escalate | none | yes | full, structured | First package to score badly: 9/30.
Asked for `fill` and named JSON as the other language wanting it — the round's
most useful design request. Claimed "no package-level workaround" for mixed
separators; the reviewer disproved it. | | CSS | codex-Sol | D | ~25 min |
escalate | none | yes (reproduced 6/15 and 3/15 exactly) | full, structured |
**First use of the retroactive freeze**, and it found the workaround the builder
said did not exist. Costed `fill` at 13/21 contributing, 9/21 resolving,
_local_. Separated four new findings from the entries they resembled. | | Go |
DeepSeek | C | cut off | resumed | none | n/a — died mid-run | none | Second
cut-off in two runs, `packages/go.json` left untracked again. Reached 6/16 with
all hard gates green before dying, so the work was real. **Then hung twice on a
later relaunch — 25 min, 14s CPU, zero bytes — and was routed around.** | | Go |
grok | C | ~35 min | merge after fixes | none | yes | full, structured | Picked
up another model's uncommitted package and finished it. Split the combined
runtime commit into two measured deltas as asked, added a third, and reported
the alignment fraction that this whole slice existed to produce. | | Go |
codex-Sol | D | ~22 min | **merged** | none | yes (re-scored; parity checked on
an unhighlighted file) | full, structured | Verified all six alignment cases
hunk-by-hunk rather than the three requested, and produced the ceiling figure:
10/16. Reframed `srcline`/`srcsoft`/`srctrail` as one capability, not three
opcodes. Disproved a tempting workaround with an **adversarial width probe** on
a fixed-width reference — a technique now in the template. | | YAML | grok | C |
~15 min | escalate | none | yes | full, structured | Tried a `parent` predicate,
found it broke comment flushing, reverted it: gzip delta 0. **Refuted FINDINGS
entry 7**, which YAML's own stage B had opened. Returned the `fill` negative
honestly rather than agreeing with CSS. | | YAML | codex-Sol | D | ~20 min |
escalate | none | yes | full, structured | Found the package **destroying data**
while gate 3 reported 32/32 non-destruction — a `|+` scalar losing a newline.
Caught with a real YAML loader, which no gate was doing. | | CSS | codex-Sol | E
| ~18 min | **merged** | none | yes (all four hard gates 90/90) | full,
structured | Took 9/30 to 11/30 exactly as its own stage D predicted, and
finished at 19 accepted / 0 stale / 0 unreviewed -- the first package to reach
100% reviewed. Used `--retire` for the two resolved pairs and re-judged the four
changed ones, which is the ledger working as designed. |

Round 1 was a head-to-head on TOML; round 2 ran three languages at once, with
YAML as its three-way comparison.

### What round 2 says about the models

**The self-reported number is the thing to distrust.** Round 1's lesson was that
a builder may omit a count; round 2's is that it may get one wrong. DeepSeek
reported 14/14 and it was 13/14 — a small error, but it was the number its whole
corpus was being selected on, and only an independent re-measurement found it.
That is now `corpus_stats.py`'s job rather than a reviewer's `cmp` loop.

**Every builder was honest about what it could not do**, and two were honest in
the most useful way: grok and Go's DeepSeek both hit a gate-3 failure and
refused to weaken the gate or delete the probe to get past it. Both were right,
the gate was wrong, and the round's headline defect came from believing them.

**DeepSeek and grok are complementary rather than ranked.** grok writes the
better manifest and the broader construct coverage; DeepSeek writes the corpus
that actually exercises the reference. YAML's merge recommendation is literally
"grok's base, DeepSeek's normalisation strategy" — which suggests pairing them
deliberately rather than picking a winner.

**codex-Sol as reviewer keeps paying for itself.** It has now, across two
rounds, disproved a design-limit label by experiment, found a runtime defect the
corpus never triggered, caught a builder's arithmetic, and found an orchestrator
regression introduced hours earlier. No review has yet been wrong.

**Terra is not earning its seat.** Two rounds, two thin done-notes, a stale pin,
a stale reference version, and one commit where the brief asked for green
boundaries. Nothing dishonest — just consistently the least useful of the three.

**agy has still produced nothing**, blocked on headless command permissions
rather than on capability. See `LANGUAGES.md`.

**The cell node merged (2026-08-19), and the unpriced option was the cheapest.**
FINDINGS 18 offered decline (0 B) / `alignment: "rust"` (796 B) / the `cell`
node (unpriced). The framing implied the unknown was the expensive one. It was
**−1,601 B**: the ~2,000 B of quote-aware scanners every named mode had to
carry are gone, and what replaces them is ~992 B of language-independent
tabwriter. Rust alignment is now a handful of package cells and no runtime at
all.

Two process notes worth more than the number:

- **The A/B never ran.** agy was to build a second implementation head-to-head;
  it hit a quota wall. The substitute was *independent verification of one
  implementation* rather than a second implementation — re-running the
  measurements by hand, and set-diffing the GOROOT probe by path. That is
  cheaper than a second spike and caught what a second spike would not have:
  the builder's own real-world claim rested on a 16-file sample.
- **The committed probe had gone blind.** `--align-only` could only print
  `0 / 4,814` once alignment moved to markers, and merging on the report alone
  would have shipped 2 real regressions unmeasured. It is now retired with an
  error that explains itself. Generalise: when a capability changes shape, ask
  which existing probe silently stopped measuring — a green probe is evidence
  only if it could have gone red.

**Third seat, third nothing (2026-08-19).** Round 3 gave agy the `cell` doc-node
spike — a self-contained brief in `spike/cell-node-agy`, deliberately written to
need no prior project context, run manually by Dave so the permission problem
could not bite. It hit a usage limit that resets in 109 hours, so the head-to-head
with grok never ran.

Note what this does and does not say. Three allocations have produced no
artefact, and the reasons were different every time: a permissions default in
round 2, a quota wall in round 3. **Neither was a capability result**, so there
is still no evidence about whether agy can do this work — which is itself the
finding. A seat that costs a worktree and a brief and returns no signal is not
free, and the brief is the expensive half. The next allocation should be one
where a quota wall costs an hour rather than a round: a bounded review, not an
open-ended spike. The branch and brief stay on disk, valid, for whenever the
quota returns.

**Closed 2026-08-16.** grok's corpus merged; the other three are abandoned in
place on their branches. Two defects survived stage B and were caught only when
the orchestrator audited the artefact before launching stage C — both are
reviewer-template defects rather than builder defects, and both are now in the
stage-B checklist:

- The reference changed **6 of 14** files, so the corpus barely probed
  normalisation. The stage-A brief mandates two `cmp` counts; the report gave
  one and the reviewer read the report. A probe covering all nine of taplo's
  token-level rewrites brings it to 7 of 15.
- `widths = [88, 60]` against taplo's default of **80**, which the builder had
  itself established and written in a manifest comment before setting 88 "to
  match the other languages". That is round 1's own delta recurring one stage
  later, and it is worth noting that finding the right number is not the same as
  using it.

Round 1 also produced no stage C at all, so `package-brief.md` remains unproven
going into TOML's package.

**The single most useful result is that two of four independently chose a
`tomllib` gate-3 override.** Both codex variants did; grok and DeepSeek both
considered it and rejected it in writing. The reviewer then proved the override
accepts 11 of 11 data-preserving document rewrites that the default rejects. It
would be easy to score this as "the codex variants are weaker" — but the brief
never stated that an override must be _strictly stronger_ than the default, and
the harness's own `check_gate3.py` actively certified the weak override as
equivalent. **Two independent agents falling into the same hole is evidence
about the hole.** Scored as a brief defect, fixed in `corpus-brief.md`; the
models are not penalised for it.

What genuinely separates them, on one language and therefore weakly:

- **Disclosure.** Luna's "no changes outside corpus" was false against its own
  diff. That is the only entry here scored against the model rather than the
  brief — it is a candour signal, not a capability one, and it is why the brief
  now requires pasting `git diff --stat` verbatim rather than asserting a
  negative.
- **Done-note quality.** grok and DeepSeek reported their own findings and
  divergences unprompted; both codex variants produced thin notes whose analysis
  _was_ present in the committed report. That is a reporting defect rather than
  an analysis defect, and the milder of the two.
- **Cost.** Luna's log ran to 1 MB and Terra's to 543 KB, against grok's 4.5 KB,
  for comparable or worse artefacts.

### Reviewer lane

From round 2, stage-B and stage-D reviews run on **codex-Sol** (`gpt-5.6-sol`,
effort `high`) rather than Opus subagents. Round 1's three Opus reviews cost
~280 K tokens and the projection over thirteen remaining languages was ~2.5 M,
which does not fit. Reviews are not being cut back — every significant finding
in round 1 came from a reviewer, not a builder — they are moving off Claude
quota.

Opus subagents are now reserved for **central changes to `main`** (a wrong fix
there costs all fifteen languages) and a **final sweep before Fable**.

A reviewer must never be the same family as the builder: Sol does not review
codex-built slices. Terra's work goes to grok or Opus.

**Codex is out until 06:51 Saturday 2026-08-22, so the standing reviewer is
unavailable.** Dave's replacement, 2026-08-18, and it is a structural change
rather than a stopgap:

> **grok and DeepSeek review each other's work, and the orchestrator does the
> merge-into-main review itself.**

Three consequences worth stating, because none of them is obvious:

- **The lanes stop being builder-lane and reviewer-lane.** Both agents do both,
  alternating per slice. The never-the-same-family rule is what makes it safe,
  and it now does real work instead of being a formality — it is the only thing
  stopping an agent reviewing its own corpus.
- **The orchestrator becomes the last gate, not a router.** Everything above
  merged on a reviewer's verdict. Now the merge review is mine, so a bad verdict
  is my failure rather than a reviewer's. That is the point: it puts the
  expensive read at the one place a mistake is unrecoverable, and off the two
  places it is cheap to repeat.
- **The scorecard gains a column it did not have.** Neither grok nor DeepSeek
  has ever reviewed. Their review quality is uncalibrated, and the pairing means
  every slice now produces a data point on it. Record it.

Opus subagents stay off stage B and D — the round-1 token arithmetic below has
not changed — but the orchestrator's own merge review is a deliberate exception
to that, and is bounded by being one read per language rather than three.

Columns worth being precise about:

- **Gates honest?** — did a claimed-green gate turn out to be green. The single
  most important number about a cheap model. One dishonest gate claim changes
  how every later result from that model must be treated.
- **Done-note** — did it describe what actually happened, including its own
  divergences and things it could not do. Grok's proactive self-flagging is the
  benchmark to compare against.
- **Runtime edits** — count, and how many the reviewer called `warranted`. A
  model that reaches for the runtime when a package expression would do is
  telling you something about its judgement.

### Round 3 stage C: DeepSeek could not start, grok could

Recorded because it is the sharpest calibration signal either agent has
produced, and it is about **method**, not knowledge.

**DeepSeek V4 Pro, three runs on Kotlin, three empty worktrees.** Each spent its
whole budget printing corpus trees as JSON — the files are thousands of lines
each — and each process ended before a single file was written. Run 2 was told
explicitly not to print trees and did it anyway. Run 3 was told again, given a
one-line query snippet to use instead, and told the runtime blocker was already
fixed; it also produced nothing. Reassigned to grok after the third.

The same agent had **passed both stage-B reviews it was given**, one of them
overturning a previous reviewer's deferral by checking a document. So this is
not a capability ceiling. Stage B is bounded — read, verify, write a verdict.
Stage C is open-ended, and DeepSeek did not self-limit its exploration.

**grok, on the same brief for Rust, delivered a complete stage C**: a package,
a runtime fix with its own case and a measured +299 B, a report, a `score.json`,
and the entry-17 number the slice existed to produce. It also died twice
mid-run, but each run had **committed** before dying, so the work chained.

Two lessons, both general:

- **"Commit before you are ready" is the instruction that mattered**, not any
  amount of task description. It converts an early exit from total loss into
  partial progress, and it is the difference between grok's nine commits and
  DeepSeek's zero.
- **A model that passes a bounded task can still fail an open-ended one.** Lane
  assignment should follow task *shape*, not a single quality ranking. On this
  evidence DeepSeek is a reviewer and grok is a builder, which happens to match
  the lane table this round tried to replace.

Both are still uncalibrated as reviewers of each other; that experiment is
unaffected.

### Agents under comparison

| Agent           | CLI        | Model                          | Lane                       |
| --------------- | ---------- | ------------------------------ | -------------------------- |
| grok            | `grok`     | `grok-4.6` (default)           | builder                    |
| DeepSeek V4 Pro | `opencode` | `opencode-go/deepseek-v4-pro`  | builder                    |
| codex-Terra     | `codex`    | `gpt-5.6-terra`                | builder (replaced Luna)    |
| agy             | `agy`      | Gemini Flash 3.7, effort `med` | builder (from R2)          |
| codex-Sol       | `codex`    | `gpt-5.6-sol`, effort `high`   | reviewer (B/D), escalation |
| Opus subagent   | Agent tool | Opus                           | central fixes, final sweep |

**Superseded while codex is out** (see "Reviewer lane" above): grok and DeepSeek
both build and both review, never the same slice, and the orchestrator does the
merge review. The table above is the standing arrangement to return to.

`codex-Luna` was dropped after round 1 — not for the `tomllib` gate, which was a
brief defect and is forgiven, but for reporting "no changes outside corpus"
against a diff that edited two shared harness scripts.

Only grok has prior calibration data, and it is on `grok-4.5`, not the `4.6`
default. Everyone else is uncalibrated; agy has not yet built anything. Round 1
was a deliberate head-to-head on TOML precisely because of that.

**A reviewer must never be the same family as the builder.** Sol does not review
codex-built slices; Terra's work goes to grok or Opus.

### Where the findings go at the end

Per the playbook's own split:

- **General lessons about driving cheap models** — prompt shapes that work, ways
  a cheap model fails that an expensive one does not, monitoring surprises →
  `~/.claude/agent-playbook.md`.
- **The per-model table above** — stays here and in project memory. It is
  calibration data, not a general lesson, and it goes stale.

## Round 3, Rust cells: two models tried, neither produced a commit

The slice: close the six `package-bug` divergences with `cell` / `cellblock`
rules. Artefact-first prompt, four ordered deliverables, the disproved approach
named and forbidden, pushback invited. Same prompt file to both, byte-identical,
so the comparison is fair.

| Model | Variant | Elapsed | Log | Commits | Tree change |
| --- | --- | ---: | ---: | ---: | --- |
| `opencode-go/deepseek-v4-pro` | `max` | 35 min | 149 KB | **0** | `comment_cells: true` — the forbidden approach |
| `opencode-go/qwen3.8-max` | `max` | 36 min | 146 KB | **0** | none (wedged) |

**DeepSeek**: `--variant max` did not change its behaviour. It investigated for
35 minutes, produced no done-note, and its only edit was the one header the
prompt named as disproved. Its own idempotence probe had already produced the
evidence against that change, and it made the change anyway. This is its second
run where a *negative* instruction was routed around rather than obeyed (the
first: told not to read the harness scripts, it read the README beside them).
Note the aven-bench results that earned DeepSeek its reputation were on
`deepseek-v4-flash`; `deepseek-v4-pro` appears there zero times.

**qwen3.8-max**: much better judgement — it found the `FMT_PACKAGES` override
and iterated on scratch copies without ever dirtying the worktree, and its first
experiment was the right shape. Then it wedged: log flat 12 min, CPU flat at
6m55s, `do_epoll_wait` with **zero open sockets**, no commit. Not the
"never started" signature (it had written 146 KB); a hang after real work.
Killed at 36 min.

The slice fell through to the orchestrator, which is where it should have gone
first — see FINDINGS 22. The task was mis-specified, not mis-routed: it asked
for rules that cannot exist, and the deliverable was always going to be a
finding. **An agent cannot be graded on a task whose correct answer is "this is
impossible" unless the prompt makes that answer reachable** — ours did, for one
named sub-case (the method chain), and both models chased the other five anyway.
