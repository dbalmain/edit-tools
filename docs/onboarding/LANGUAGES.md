# Language roster and status board

Orchestrator's source of truth for what is in flight. Update on every stage
transition.

Status: `-` not started · `A` corpus building · `B` corpus review · `B+` corpus
reviewed and merged, package not started · `C` package building · `D` package
review · `E`/`F` escalated · **merged** · **blocked**

`B+` was added 2026-08-22. The board had carried four languages as `C` for a day
while nothing was building a package, which is the same lie it complains about
twice below in the other direction. There was no token for "stage B passed and
nobody has started stage C", so the board reached for the nearest one and
overstated. A status with no token gets rounded to a wrong token.

## Branches, 2026-08-22 — what is on each, for the backup

Work paused here until Saturday. Nothing has ever been pushed by an agent;
every branch below is local and clean, with `./test.sh` green where it applies.

| Branch | Base | Holds | State |
| --- | --- | --- | --- |
| `worktree-feat-cell-scope` | `fed4974` | The merge. Harness slice + Ruby + Scheme + Haskell corpora, Scheme's `comment_kinds`, the `score.py` tab fix, FINDINGS 24/25/26, board and ledger | **Ready — `git merge --ff-only` from main** |
| `wt/harness-slice` | `fed4974` | Injection relaxation, `comment_kinds`, the quoted-fence refusal | Contained in the above |
| `wt/lang-ruby` | `fed4974` | Stage A + B corpus | Contained in the above |
| `wt/lang-scheme` | `fed4974` | Stage A + B corpus | Contained in the above |
| `wt/lang-haskell` | `fed4974` | Stage A + B corpus | Contained in the above |
| `wt/lang-typescript` | `fed4974` | Stage C package, 4 commits, 11/30 | **Held — needs stage D** |
| `wt/lang-html` | `fed4974` | Stage C package, 2 commits, 23/26 | **Held — needs stage D** |

The two held branches both edit `runtime-js/bundle.js` and `rust/src/eval.rs`,
so whichever merges second needs a real merge rather than a fast-forward. HTML
also adds 25 lines to `DESIGN.md`. That is a stage-D problem and it is written
down here so it is not a surprise later.

**Everything above the two held branches collapses into one fast-forward.** The
merge was done in a worktree rather than on main because the orchestrator
session is worktree-isolated and its git operations against the shared checkout
are refused — so the four merges, the conflict check and the green suite are
already done, and main only has to move.

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
| Markdown   | T2   | 4     | grok-4.6      | B+     | tree_sitter_markdown   | prettier                          |
| TypeScript | T2   | 4     | grok-4.6      | D      | tree_sitter_typescript | prettier                          |
| XML        | T3   | 4     | grok-4.6      | B+     | tree_sitter_xml        | prettier (`@prettier/plugin-xml`) |
| HTML       | T3   | 4     | grok+codex    | D      | tree_sitter_html       | prettier                          |
| Ruby       | T4   | 5     | grok-4.6      | B+     | tree_sitter_ruby       | syntax_tree 6.3.0                 |
| Scheme     | T4   | 5     | grok-4.6      | B+     | tree_sitter_scheme     | emacs `scheme-mode`               |
| Haskell    | T4   | 5     | grok-4.6      | B+     | tree_sitter_haskell    | ormolu 0.8.0.2                    |
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

**Round 5 was started early and did not start** — 2026-08-21. Ruby, Scheme and
Haskell were launched on grok-4.6 in parallel worktrees when round 4's stage A
finished in a morning. All three died on
`status 402 Payment Required: Grok Build usage balance exhausted`, leaving three
clean worktrees and no commits. Scheme got furthest — 22 model calls, 2.19 M
tokens, ten minutes of API time — before hitting the wall mid-run.

**This is a balance, not a rate limit, so there is nothing to wait out.** It
does not reset at a known hour the way a session limit does, and the failure
mode is a clean exit 1 with a 402 in the log, not a hang — which is worth
knowing, because every _other_ way grok stops looks like a hang. The four
round-4 stage-A slices spent what was left of the allocation; those four are the
price list.

The three worktrees (`wt/lang-ruby`, `wt/lang-scheme`, `wt/lang-haskell`) and
their prompts are cut and waiting, the way `lang-css-agy` and `lang-go-agy` are.
Codex takes round 5 stage A when it returns.

Round 4's four stage-B reviews are unaffected — they run on Opus and Sonnet
subagents; see `LEDGER.md`, "Reviewer lane", for why that lane and not another.

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

**Round 4 stage C is complete on two of four, 2026-08-22. Both built; neither is
reviewed.** HTML on codex-Sol (`77b635b`, `f17d03a`), TypeScript on grok-4.6
(`b043b9c` and three runtime commits). Both worktrees clean, nothing pushed.
Neither is merged: a package merges after stage D, not after stage C.

**HTML built rather than refused, and took the middle door.** Asked whether
per-tag behaviour wants a new selector, package data, or a refusal, it answered
*both of the first two*: generic exact-leaf-path predicates in the runtime, with
the block/inline tag names kept as **package data**. 32/32 coverage,
idempotence, non-destruction and Rust/JS parity all pass; agreement 11/13 @80
and 12/13 @40; width sweep identical across widths 1-120. Every divergence a
design limit, **no `package-bug`, no `reference-quirk`**, no refusals. Runtime
+381 B in three pieces: exact leaf-path text predicate +144 B, source-derived
whitespace gap +172 B, exact leaf-path multiline predicate +65 B. It also added
25 lines to `DESIGN.md`, which is a shared file and needs reading at stage D.

So the answer to the question HTML was on the roster to ask is **"a token inside
the node can drive layout, and the tag names belong in the package rather than
the runtime."** Scheme's stage B reached the same shape from the other end. That
is now two languages agreeing, which is the bar this project uses.

**TypeScript is at 11/30 agreement, and the leading `|` is only 3 of the 19
misses.** It parked the leading-`|` opcode for the same reason `drop` is parked
and classified every divergence: 17 design-limit, 1 reference-quirk, 1
package-bug (declined). Two isolated runtime edits, +188 B: a fieldless
`flatten` fallback (+61 B) that fires only when *no* child has a field, so the
rename probe still refuses `Field("left")`, and suffix-comment emission on a
skipped operand (+127 B) that was breaking `comments.ts` idempotence.

**The one `package-bug` was checked before routing stage D, and the finding is
that the facts are right and the label is wrong.** The divergence is prettier's
last-argument hugging: `@logged("debug", { … })` keeps `"debug"` on the head
line and breaks only the trailing object, while the package breaks every
argument. Reproduced from the committed reference, not taken from the report.

The builder's stated reason for declining it is *"re-deriving call rules would
contradict reuse-JS-where-the-construct-is-the-same"*. **That is a choice, not
an inability**, and the vocabulary is explicit about the difference:
`design-limit` and `package-bug` mean *we could not*; `reference-quirk` and
`house-rule` mean *we chose not to*. A divergence declined because fixing it
would fork a shared rule set is the second kind wearing the first kind's label.

Two things follow, and the second matters more than the first:

- **It is not relabelled here.** The 2026-08-21 decision that made `package-bug`
  a hard failure predicted exactly this pressure — "creates pressure to relabel
  to get through" — and the orchestrator relabelling it to unblock a merge is
  that prediction coming true. **Stage D rules on it**, with this analysis in
  front of it rather than instead of it.
- **JavaScript is the cross-check and it is clean.** Same reference, same reused
  call rules, fourteen divergences, **zero `package-bug`** and nothing of this
  kind among them. So either JavaScript's corpus never exercises a broken call
  with a trailing object literal, or its rules already handle it. Stage D should
  establish which, because "the shared rules have a hole nobody had probed" and
  "TypeScript diverged from the shared rules" are different findings with
  different owners.

**The number is not a verdict on the package; it is a measurement of the parked
decisions.** Sixteen of the nineteen misses are already-documented findings --
2, 6, 9, 11, 13, 15 and 20 -- landing in one language at once. TypeScript is the
first language to pay all of them together, and gate 4's floor is
**review coverage**, not raw agreement, so stage D approving the classifications
is what clears it. The one `package-bug` cannot be approved: that verdict is a
hard scorer failure by the 2026-08-21 decision, so it must be fixed or
overturned.

**Round 5 stage B is complete, 2026-08-22. All three pass with fixes applied.**
Ruby on Sonnet (`a9784fb`), Scheme on Opus (`e5f49a7`, `ecbcb82`), Haskell on
Opus (`ad73c31`, `924441a`). Every tree clean, nothing pushed, and all three
reviewers reproduced the builder's counts independently rather than taking them
— no mismatch of the round-1 kind in any of the three.

**All four defects found were the same shape, and it is a shape no count can
see: a rewrite the report claimed or implied, which no corpus file forces the
reference to perform.**

- **Ruby** claimed syntax_tree collapses three-or-more blank lines to one. No
  file contained three blank lines. (Verified: two are preserved, three and four
  both collapse to one.)
- **Scheme** described emacs's comment placement as nesting-driven. The real
  rule is **semicolon count** at every depth — `;` to `comment-column` 40, `;;`
  to code indent, `;;;` to column 0 — and `comments.scm` happened to contain
  only the two cells where both rules agree. A stage-C package built on the
  report would have passed while being wrong on **three of six cells**.
- **Haskell** declared `imports.hs` incomparable for sorting and stopped there.
  ormolu also **collapses** repeated imports of one module: an exact duplicate
  is dropped, and two imports of `Data.List` merge into one. That is the ktfmt
  `sortedAndDistinctImports` precedent landing exactly as the stage-B brief
  predicted it would — two exclusions wearing one name — in a second formatter.
  A second dedicated `[incomparable]` file now probes collapsing alone.
- **Haskell** also claimed ormolu inserts a blank line after `module X where`,
  which all fifteen source files already supplied.

**Not one of those four moved any of the four counts.** Every fix was a
width-insensitive rewrite in a file that already changed and already carried a
comment. This is now the third round in which the counts confirmed a corpus that
was not probing what its report said it probed, and it is the argument for the
report-to-corpus check existing at all: **the counts are a floor, not evidence.**

Three results worth carrying beyond round 5:

- **Two claims were tested rather than inherited, and both held.** Haskell
  rejected six different width flags and then generated a 266-character list
  that stays on one line and a trivially-fitting broken list that stays broken —
  line structure is source-driven in both directions, so `widths = [80]` is a
  measurement scale, not black's 88 smuggled in a second time. Scheme did the
  same with `fill-column` 40 versus 200 on a 100-column line: byte-identical.
- **FINDINGS 12 does not reach Haskell, with evidence instead of an argument.**
  The reviewer built eight layout edits that change meaning — a where-clause
  escaping its parent, a `do` statement leaving the block, a `let` binding
  vanishing, a guard becoming a new equation — and gate 3 **rejects all eight**.
  The offside rule is consumed into the tree. That is the expensive call to get
  wrong and it is now measured.
- **Scheme's two "decisions" were already settled precedent, and asking for them
  was an orchestrator error.** `go.toml` already declares
  `reference_width = "fixed"` with nearly the same rationale, and all sixteen
  gofmt reference files are tab-indented — so keep Scheme's tabs, and yes the
  corpus supports stage C, on exactly the terms Go is already accepted on. The
  rule that would have saved the work: **before ruling on a reference-shape
  question, grep the other manifests for the same shape.**

`comment_kinds` splits the round: **Scheme wants it** (`["comment",
"block_comment"]`, expect 0/15 to 15/15) and **Haskell does not** — its
`comment`, `haddock` and `pragma` are genuine tree-sitter extras, which the
16/16 comment count confirms. Neither could declare it: `manifest.py` at
`fed4974` rejects the field, because it lives only on the unmerged harness
slice. That is one more thing waiting on the merge.

**Round 5 stage A is complete, 2026-08-22. All three built, on grok-4.6.**
Ruby, Scheme and Haskell, relaunched into the same three worktrees the 402
abandoned the day before, with prompts regenerated so they carried round 4's
seven template deltas rather than the versions that were cut. Eight commits
across three worktrees, every tree clean, every shared-file diff verified empty,
`./test.sh` green in all three, nothing pushed.

Stage B is running now — **Scheme and Haskell on Opus, Ruby on Sonnet**. All
three corpora are grok-built, so none of their reviews may go to grok.

Each hit the thing its brief predicted, and two of the three landed on the same
structural point:

- **Scheme confirms the head-driven layout limit in a second language.**
  `(define ...)`, `(let ...)`, `(cons ...)` and `(list ...)` are all one `list`
  node and indent three different ways, because emacs indents on the **head
  symbol**. That is HTML's `tag_name` limit — a token *inside* the node deciding
  the layout *of* the node — arriving independently in a language with no markup
  in it. The board predicted this for Scheme and HTML found it a round early;
  both are now evidence rather than hypothesis, and HTML's stage C is the slice
  asked to decide what the design does about it.
- **Two of the three references are `fixed`-width, as hypothesised and now
  measured.** ormolu has no column flag at all — a 187-character export list
  stays on one line — and emacs `scheme-mode` indents without reflowing. Neither
  builder inherited that from the brief; both tested it. `widths = [80]` in
  Haskell's manifest is a measurement width, not a target, and that distinction
  needs to survive into stage C.
- **Ruby's reference rewrites tokens, not just layout.** Quotes, `%i`/`%w`, hash
  rockets, `if`->ternary and `while`->modifier all fire under syntax_tree, and
  most fail gate 3. The corpus is written in the reference's own form so they do
  not, which is the markdown policy applied to a much wider blast radius — and
  which stage B has been asked to judge as probing versus avoidance.
  `block_conversion.rb` is `[incomparable]` because `{...}` versus `do...end` is
  chosen by fit and goes **both directions**: there is no source form stable at
  both 80 and 40.
- **Scheme wants `comment_kinds` too** — `extras: []`, so 0/15 comments — which
  is the third language to pay for that field in two rounds. It is no longer a
  proposal; see the harness slice below.

**Round 4 stage C started 2026-08-22, on two of the four.** TypeScript is on
grok-4.6 in `wt/lang-typescript`; **HTML is on codex-Sol** in `wt/lang-html`,
because HTML's slice is the one that asks whether a node-type table is the right
dispatch at all, and a reasoned refusal is a first-class outcome there. Markdown
and XML are held at `B+` deliberately: both want `comment_kinds`, which is on
the unmerged harness slice, and starting them first would mean building against
a moving target.

**The harness slice is built and unmerged.** `wt/harness-slice`, three commits
on `main` at `fed4974`, by codex-Sol: the `[[injections]]` relaxation (`info`
and `content` optional, `info` xor `guest`, missing `content` means the host
node is the region), `comment_kinds` (XML `0/14 -> 13/14`, Markdown
`0/15 -> 15/15`, 26 and 30 dropped-comment mutations now rejected), and a
**reasoned refusal** of the third change. `./test.sh` green, verified
independently rather than trusted. It is the head of the merge queue and
everything else waits behind it.

**Round 4 stage B is complete, 2026-08-21. All four pass.** **TypeScript: `pass`**
(Sonnet) with nothing to correct. **XML: `pass with fixes applied`** (Sonnet),
one commit — the report had covered three of the plugin's four XML options and
never mentioned `xmlSortAttributesByKey`, which is off by default and therefore
free for a naive package, so it changed the record rather than the verdict.

Neither reviewer took a builder number on trust, and both went past the brief.
TypeScript regenerated **all 30** reference outputs rather than the three the
brief asks for, and settled the leading-`|` question empirically by running the
same overflowing union under `--experimental-operator-position start` and `end`
and getting byte-identical output — so the pipe is not that option. It also
proved the `union_type` transparency claim by parsing both forms and dumping the
tree: the leading-pipe form is a **unary** wrapper, every real union is a chain
of **binary** ones, so the elision cannot hide a dropped alternative. XML
regenerated its reference from a genuinely **cold** npm cache rather than the
warm one that produced the committed files, which is the check that would catch
a plugin resolving differently for the next person.

Three template deltas came out of the two reviews and are applied — see table 2.
The first was found **independently by both**: the brief's `x.{{LANG}}` stdin
filename is wrong for five of the ten roster languages.

**Markdown: `pass with fixes applied`** (Opus). **HTML: `pass with fixes
applied`** (Opus). Both re-derived the reference from scratch — 30 and 32
outputs regenerated straight from the manifest command rather than through
`gen_reference.py` — and both found documentation defects rather than corpus
defects. The corpora, pins, trees and reference output needed no change in
either.

Three results from those two are worth carrying forward:

- **A precise proposal is the one thing nobody runs.** Markdown's stage A
  proposed stripping `block_continuation` from `injection.region_for` — right
  diagnosis, wrong shape. `gen_trees.convert` rebases guest offsets with a
  single additive base and reads leaf text from host bytes, so stripping makes
  that mapping piecewise: **16 of 17 leaves** read the wrong host bytes on a
  multi-line quoted fence, and `check_clean` only looks for `ERROR`/`MISSING`.
  This is the propose-don't-apply rule earning its keep, and it is now a
  template delta.
- **HTML's `quotes.html` claim was backwards in the dangerous direction.** The
  report and manifest both said the quote rewrite passes gate 3. It fails — the
  delimiter swap passes, escape minimisation rejects — and describing only the
  passing half is the wrong half to hand to stage C.
- **The options survey was skipped by both builders**, having each plainly seen
  the behaviour in their own output. HTML has two input-sensitive defaults, and
  `--html-whitespace-sensitivity ignore` produces *exactly* what a naive
  width-driven package emits. That is the `objectWrap` shape for the third time.

**The two injection proposals are one change, not two.** HTML's `script_element`
has content and no info string; markdown's front matter has neither — the node
*is* the region. Both relaxations land in the same twelve lines of
`manifest.py::_injections`, so shipping HTML's alone means migrating that
validation twice. Land together: `info` and `content` both optional, require
`info` xor `guest`, and a missing `content` means the host node is the region.
`<script type="application/ld+json">` is correctly scoped out as a genuine third
change — its routing key is an attribute value, not a node type, so `guest`
structurally cannot express it.

**The quoted-fence splice needs more than the proposed offset map.** The map is
necessary: stripping continuation bytes makes guest-to-host offsets piecewise.
It is not sufficient: replacing the content node also removes the semantic `> `
prefixes, and the guest package can introduce new line breaks without a host or
runtime seam that can restore them. The harness slice therefore did not build
the map in isolation. The committed injection probe reproduces both the clean
stripped parse and scalar-offset corruption; `docs/injection.md` records the
additional prefix-emission requirement. This blocks no current gate because the
Markdown corpus deliberately avoids quoted fences.

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
  slice of `code_fence_content`, so a fence inside a block quote carries its `>`
  prefixes into the guest parser: JSON fails to parse and the guest reformat
  becomes a verbatim gate-3 miss. List-item fences splice correctly, because
  their continuation is spaces. Patch proposed, not applied; the corpus's nested
  JSON lives in lists rather than quotes so the probe set stays honest about
  what works.
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
