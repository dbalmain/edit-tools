# Done: ledger reason-vs-diff audit

**Snapshot.** Written on `wt/ledger-audit` at `bff4071`, 2026-08-28. The ledger
held **142** records then and holds **140** now, and the reasons this audit
called bad have since been re-signed. The findings are the durable part; the
counts are not current.

Worktree `ledger-audit` on `wt/ledger-audit`. Report:
`.ai/ledger-audit.md` (force-added; `.ai/` is gitignored). Ledger,
runtime, packages, and corpus were not edited.

## Result

The 142 reasons are in good shape. Seven records fail the bar; **none is
a mislabelled `package-bug`**, so none of them changes a merge decision.

| class | n |
| --- | ---: |
| COVERED | 135 |
| UNDERCOUNTS | 4 |
| WRONG-CAUSE | 3 |
| WRONG-VERDICT | 0 |
| UNVERIFIABLE | 0 |

Built first (`./build.sh`). `./harness/score.py .` matches `main`: 0 stale,
0 unreviewed (scored), 0 package-bug, gates 405/405. The scorer's 133
accepted vs the ledger's 142 is nine records on excluded files.

## Findings, severity order

**WRONG-VERDICT.** None.

**WRONG-CAUSE (3).** Same shape: a capability landed, the file's bytes
did not move, the reason still describes the pre-capability IR.

- `css/custom_properties.css@80` — "the IR lacks fill". Fill shipped;
  `packages/css.json` uses it; the leftover is fill-item granularity,
  which `kitchen.css@80` already states.
- `rust/leading_pipes.rs@100` and `@60` — "no opcode can delete a
  token" / "gate 3 permits". `drop` exists; `rust.toml` already says
  the file is byte-identical *then* gate 3 rejects `| _`. Incomparable
  for a gate hole, not a missing opcode.

**UNDERCOUNTS (4).** Named cause is true; a distinct construct in the
diff is not named.

- `javascript/kitchen.js@40` — FINDINGS 11 chain is true; the
  `process([{...}])` expansion is the shared JS/TS list-hug house
  choice TypeScript already signed. Not a package-bug.
- `yaml/anchors.yaml@80` and `@40` — FINDINGS 10 hanging `&anchor` is
  true; remaining indented section comments are FINDINGS 9. Trailing
  colon comments already match.
- `scheme/normalisation.scm@80` — canonical separators cover packed
  spacing / `( )` / comment-gap; the continuation `c` is first-argument
  alignment (FINDINGS 29a), already proven on `calls.scm`.

Quoted hunks and replacement reasons: `.ai/ledger-audit.md`.
`rust/comments.rs` leads with stale FINDINGS 22 but also names 9 and 7,
which are the remaining hunks — COVERED with a stale lead, not counted
above.

## Bar actually applied

One named root cause covering several hunks is COVERED, not UNDERCOUNTS.
UNDERCOUNTS is a distinct unexplained *construct*. WRONG-CAUSE is a
reason whose only named mechanism the current IR contradicts.
WRONG-VERDICT was reserved for settled labels that should have been
`package-bug`, and required evidence of an existing composition, not an
imagined package edit.

Falsifiable "only/every hunk" claims were checked first and almost all
survived; none of the seven failures is of that shape.

## Where the weakness actually is

The hash covers the right bytes. `state()` is not the bug. The gap is
**reason-rot on a stable hash**. `custom_properties` vs later
`kitchen.css@80`, and `leading_pipes` vs the already-updated
`rust.toml`, are the pairs. A per-hunk coverage checker would have
reported 0 on this 142 and would not have caught either opcode claim.
If this becomes a tool, the cheap check is: does the reason name an
opcode or FINDINGS entry that has since been built, while this hash
did not move?

## Patterns

Re-review follows moved hashes (TS, JS comment-fill, CSS kitchen, Rust
widths). Records whose output did not change were not revisited — that
is `state()` working as specified. House-rule (10) is used honestly,
with a labelling split on FINDINGS 1 (markdown tables `house-rule` vs
TOML comments `design-limit`) that does not move the scorecard.

A second pass wanted `package-bug` on `kitchen.ts` and six YAML
scalar-hang records, on the grounds that `child-count` already peeks
through `flow_node`. I did not take it: the YAML experiment that was
actually run (drop the pair group) regresses flow mappings, and the
proposed subtype split was not. Unrun compositions are not
`package-bug` on this bar. Details in the report.

## Not done

No ledger re-sign. Replacement text is in the report for a reviewer from
a different model family.
