# JavaScript package report (stage C)

```
gate 0 coverage         pass   28/28
gate 1 rust/js parity   pass   28/28 byte-identical
gate 2 idempotence      pass   28/28
gate 3 non-destruction  pass   28/28  (generic named-node + extras)
gate 4 agreement        7/14 @80,  6/14 @40   (13/28 overall)
refusals                none
size                    package 2585 B gzip; runtime 13412 B gzip
overflow lines          11 (prettier 6)
```

No runtime edits. No harness edits. `comment_gap` / `blank_cap` left at the
prettier default of 1.

Objects use `srcbreak` so a source line-break after `{` stays expanded
(`objectWrap: preserve`). Arrays stay width-driven (`collapse`).
`objects.js` agrees at both widths; the diagnostic pair is the reason.

`trail` refuses to add a comma on a 1-item list (black's rule). prettier's
`trailingComma: all` does add one. The package works around it with a 1-item
branch that calls `trail` on `*`, whose tally is always > 1 once the brackets
are children. That is a package-level encoding of a policy the opcode still
treats as black-shaped.

## What agrees

`classes`, `functions`, `modules`, `nesting`, `objects`, `strings` at both
widths; `control_flow` at 80 only.

`nesting.js` includes the array-of-arrays `matrix`. `["all", "named",
["array"]]` plus a `hard` list reproduces prettier's explode-when-every-child-
is-an-array rule. The stage-A note that the IR cannot express this was wrong:
JSON already does it, and so does this package. Independent groups match
prettier on nested objects and mixed arrays (`fits`, `mixed` at 80).

## Divergences

Classifications below are for the stage-D reviewer. None have been `--approve`d.

### design-limit — the IR could not

- `javascript/chains.js@80` `c91ba8e70a4f296d35009f6372f8cfe9d83169c3ea5185ff68691a1989e5b206` — **design-limit**. Method chains at the dots. FINDINGS 11 / DESIGN.md. The `.` is anonymous; `flatten` needs a same-type spine.
- `javascript/chains.js@40` `cf80d95416e5f6d1561a217b51989de017dca023be74b3357fdedd944e3a5bc7` — **design-limit**. Same chains.
- `javascript/kitchen.js@80` `91075f61c5fa7467e067575578bb4a49d1369c74d6ac001e8ccfeb616763ab3f` — **design-limit**. The only remaining hunks are the `records.filter().map().sort()` chain, the same construct as `chains.js`.
- `javascript/kitchen.js@40` `0933338aea18b93a98fb699a5797e06871409f500fbb46b471d67dc91bf68026` — **design-limit**. Same chain, plus the inner `tags.filter().map()`.
- `javascript/operators.js@80` `0c3bd4a0a03e5cd803c10a2d290d56f59132c47879d56db2f3d0b43872aadcdf` — **design-limit**. Single hunk: prettier inserts `(mask & value)` and `(other << shift)` on a line that still fits. `paren` / `autoparen` emit parens only as `IfBreak`. There is no always-on wrap. Flatten of `|` / `^` / `&` already stops at the tightness boundaries the tree has; the missing piece is the parentheses, not the split points.
- `javascript/operators.js@40` `d9a01bcada7c909abf3ff4e16b84b69cf393d0ba209b68427bd1af69c162fc23` — **design-limit**. Bitwise parens (same as @80) plus a nested ternary that prettier breaks because the outer ternary broke (FINDINGS 2) and a `const longTernary =` hang after `=` that is the opposite of the @80 preference (FINDINGS 15). Grouping the assignment matches @40 and misses @80; not grouping does the reverse. One layout per group.
- `javascript/modern.js@80` `f0ab81c7b6fcb66a5336d4f502c74066ab1c13e99237408cb1b9303e069f0a01` — **design-limit**. prettier wraps `config ??= defaults` (and `&&=` / `||=`) in parens on a line that fits. Same always-on wrap as bitwise. The rest of the file matches.
- `javascript/modern.js@40` `c8010a1a367ccc41e6ecef52a09663bb8b204266c8031e623e7cfae2d6cfad14` — **design-limit**. Same `??=` wrap. Extra hunks (regex / bigint hanging after `=`, `import()` args) are reachable in the package and would not save the file.
- `javascript/normalisation.js@80` `687d606954d36c7dbd689ddb06c7c7bc776c0ee3cebc90c0312bddd34d42f02f` — **design-limit**. Three token mutations: `((1 + 2))` is not deleted (FINDINGS 13); `y = 1` and `const trailingSpaces = 1` do not grow a semicolon the tree does not have. `trail` / `paren` are the only add-token policies, and neither is a statement terminator.
- `javascript/normalisation.js@40` `687d606954d36c7dbd689ddb06c7c7bc776c0ee3cebc90c0312bddd34d42f02f` — **design-limit**. Same hash: the file is width-independent.
- `javascript/control_flow.js@40` `1a66bc944d954dde8608a823b718fb05382107856f2d7e98dc08cf245dee11cb` — **design-limit**. prettier *removes* the parens around the nested ternary once the outer ternary breaks. FINDINGS 13. At 80 those parens stay and the file agrees.
- `javascript/comments.js@80` `b1c412dac262fea81953794649416ca0634cb9041f02f71b68b465c91cc38c2c` — **design-limit**. Two runtime-owned attachments (FINDINGS 9): a same-line leading `/* … */` is emitted with a hardline rather than glued to `3`, and `[ // comment` stays a suffix of `[` instead of moving onto the next line. The rest of the file matches, including trailing `//` on items.
- `javascript/comments.js@40` `b175d9fea3e0522fcd0581df66f26c7c9ac06aa6f25338cc5ff65e1392f016fa` — **design-limit**. The @80 attachment pair, plus `const result = a + b; // trailing` breaking after `=` because `fits` counts the suffix (FINDINGS 6). prettier ignores the comment for width and keeps the statement flat.
- `javascript/sequences.js@80` `f591d12696763cf8b1be87e5237b8a659f50a6f7ae439b46bb991823cc6cee43` — **design-limit**. Identifiers and strings already one-per-line; the only hunk is the number array, which prettier `fill`s. `fill` on that array matches sequences byte-for-byte, but on `comments.js` (also an all-number array) the fill printer concatenates suffix comments onto the wrong items and fails gate 3. The package therefore uses `each`. Entry 8 exists; it does not yet carry comments.
- `javascript/sequences.js@40` `e14faf764ad170e89a4ec82f56317c1451591d0eca717c925c8067ff22cac47e` — **design-limit**. Same number packing, same fill/comment coupling.

No package-bug left on purpose, no reference-quirk, no house-rule. The 1-item `trail *` workaround is ugly but it wins files; it is not a classified divergence.

## Runtime edits

None. Two that would be warranted, not made, because another builder is in
`rust/` / `runtime-js/`:

1. **`fill` + line suffixes.** Fill packs prettier's number arrays, then
   reorders `// trailing on the first item` onto the next item. Isolated
   gzip delta not measured; the construct is `comments.js`'s number array.
2. **Always-on wrap**, sibling of `paren` that emits `(` `)` even when the
   group stays flat. Would win `operators.js@80` (one hunk) and
   `modern.js@80` (three assignment wraps). `paren` is the wrong opcode:
   those parens are precedence, not layout.

A third, smaller: `trail` adding a comma for a 1-item broken list, behind a
package flag so Python stays on `> 1`. The `*` workaround works and costs
rules, not runtime.

## Harness edits

None. Proposed, not made: `trail`'s singleton skip is a black fact living in
the opcode. A package header (`trail_min: 1`) would make prettier's
`trailingComma: all` a one-line header instead of a 1-item / n-item split
in every list rule.

## What the IR could not express

Three capabilities, in the order they cost files:

1. **Always-on clarifying parentheses** (bitwise mixed ops, `??=` as a
   value). `paren` is break-driven. This is not FINDINGS 13 (deletion) and
   not FINDINGS 15 (layout preference). It is a third sanctioned *addition*
   that does not wait for a break.
2. **Method chains at the dots** — already named.
3. **Adding a statement terminator the tree omitted** (ASI). Same family as
   13, the other direction: no opcode inserts `;` except `trail` in a broken
   list.

`fill` with comments is a runtime defect of an existing opcode, not a missing
one.

The one thing I would ask of the design is (1). It is local — emit two tokens
the tree does not have, unconditionally, around one child — and it is the
difference between 7/14 and 9/14 at width 80. Chains still cap the rest.

## Template delta

- `when` + `all` *can* force-break an array-of-arrays. The corpus report's
  "IR cannot express" line for `matrix` is false; JSON already had the
  encoding. Keep the `objectWrap: preserve` warning — that one is real and
  `srcbreak` is the match.
- `trail`'s `> 1` guard is black-specific. prettier JS (and the corpus
  `trailingComma: all` note) includes 1-arg calls and 1-key objects. The
  brief should say so, or the opcode should take a minimum.
- Always-on wrap is the JS analogue of the bitwise-parens sentence in the
  corpus report. `paren` is not that.
