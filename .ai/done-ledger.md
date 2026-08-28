# Done: ledger reason-vs-diff audit

Worktree `ledger-audit` on `wt/ledger-audit`. Report:
`.ai/ledger-audit.md` (force-added; `.ai/` is gitignored). Ledger,
runtime, packages, and corpus were not edited.

## Result

The 142 reasons are in good shape. Four records fail the bar; **none is a
mislabelled `package-bug`**, so none of them changes a merge decision.

| class | n |
| --- | ---: |
| COVERED | 138 |
| UNDERCOUNTS | 3 |
| WRONG-CAUSE | 1 |
| WRONG-VERDICT | 0 |
| UNVERIFIABLE | 0 |

Built first (`./build.sh`). `./harness/score.py .` matches `main`: 0 stale,
0 unreviewed (scored), 0 package-bug, gates 405/405. The scorer's 133
accepted vs the ledger's 142 is nine records on excluded files, all COVERED.

## Findings, severity order

**WRONG-VERDICT.** None.

**WRONG-CAUSE (1).** `css/custom_properties.css@80` still says "the IR
lacks fill". Fill shipped the same day; `packages/css.json` uses it; this
file's bytes did not move, so the reason was never re-signed. The leftover
(packing two shadows on a continuation line) is a real fill-item
granularity limit, which `kitchen.css@80` already states correctly.
Proposed verdict unchanged (`design-limit`). Proposed reason in the
report.

**UNDERCOUNTS (3).**

- `javascript/kitchen.js@40` — FINDINGS 11 chain is true; the
  `process([{...}])` expansion is a second construct, the same shared
  list-hug house choice TypeScript already signed. Not a package-bug.
- `yaml/anchors.yaml@80` and `@40` — FINDINGS 10 hanging `&anchor` is
  true; the remaining indented section comments are FINDINGS 9, and
  "colon comments" are not in the leftover (they already match).

Quoted hunks and replacement reasons: `.ai/ledger-audit.md`.

## Bar actually applied

One named root cause covering several hunks is COVERED, not UNDERCOUNTS.
UNDERCOUNTS is a distinct unexplained *construct*. WRONG-VERDICT was
reserved for settled labels that should have been `package-bug`, and
required evidence of an existing composition, not an imagined package
edit. Falsifiable "only/every hunk" claims were checked first and almost
all survived; none of the four failures is of that shape.

## Where the weakness actually is

The hash covers the right bytes. `state()` is not the bug. The gap is
**reason-rot on a stable hash**: a true-at-the-time mechanism claim
survives after the IR grows, if that file's output does not change.
`custom_properties` vs the later `kitchen.css@80` is the pair. A
per-hunk coverage checker would have reported 0 on this 142 and would
not have caught the fill claim. If this becomes a tool, the cheap check
is "does the reason name an opcode or FINDINGS entry that has since been
built, while this hash did not move?"

## Patterns

Re-review follows moved hashes (TS, JS comment-fill, CSS kitchen, Rust
widths). Records whose output did not change were not revisited — that
is `state()` working as specified. House-rule (10) is used honestly,
with a labelling split on FINDINGS 1 (markdown tables `house-rule` vs
TOML comments `design-limit`) that does not move the scorecard.
codex-Sol's TS/Ruby reasons are the most precise; the four failures
are one stale CSS stage-D sentence, one dropped JS kitchen hunk, and
one YAML anchors record that omitted the entry-9 comments its siblings
name.

## Not done

No ledger re-sign. Replacement text is in the report for a reviewer from
a different model family.
