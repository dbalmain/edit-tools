# TypeScript package report (stages C and D)

```
gate 1 idempotence      pass   (30/30)
gate 2 width            pass   (overflow 10; prettier 8)
gate 3 non-destruction  pass   (30/30, method default)
gate 4 agreement        10/15 @80,  5/15 @40   (15/30 overall)
rust/js parity          identical (30/30)
refusals                none
size                    package 4726 B gzip; runtime 14453 B gzip;
                        delta vs current main +237 B JS runtime
```

Stage C was measured with `./test.sh` (exit 0). Stage D independently re-scored
with `./harness/score.py . --language typescript` after the fixes below.
Stage B passed with no corrections; there was no correction commit.

`comment_gap` 1 and `blank_cap` 1, matching prettier (the runtime default).
No second house-style constant.

## What was reused from JavaScript

Unchanged in shape: `list` / `one_list` / `padded_list`, `preserve_object` /
`srcbreak` (objectWrap: preserve), arrays (including array-of-arrays `hard`),
calls, `formal_parameters`, functions, arrow bodies, classes, control flow,
`binary_expression` flatten, `program` / `statement_block` blanks, import
named-lists. TypeScript objects and value-level calls are the same constructs.

Diverged only where TypeScript is actually different:

- type-level nodes (`union_type`, `intersection_type`, `object_type` with `;`,
  `interface_body` always-hard, `enum_body` always-hard, `type_parameters`
  with `trail`, `type_arguments` *without* `trail`)
- extra children on shared JS nodes (`type_annotation` on declarators, type
  arguments on calls, `import type`, decorators, return types)
- `as_expression` / `satisfies_expression` / `type_assertion`

## Divergences (stage C proposal; superseded by the Stage D review below)

Classifications for the stage-D reviewer. None `--approve`d.

| id | hash | classification | why |
| --- | --- | --- | --- |
| `typescript/unions.ts@80` | `f67ccbc3d259903998235b7a100ccd81a308d18da23dff2a8094b968216fdecf` | design-limit | prettier inserts a leading `\|` only when the union group breaks. `trail` / `autoparen` are the only sanctioned additions and neither is leading-and-break-conditional. FINDINGS 13's mirror. Nested conditional also stays flat inside a broken outer (FINDINGS 2). |
| `typescript/unions.ts@40` | `3094377f18c9dfbf7aa6a3caec83f3bd0173997e58f7ae4585ccc84d53bf1307` | design-limit | same leading `\|`; inner unions in generics and constraints too. |
| `typescript/strings.ts@40` | `0ae9586fa861ea2850b0bc48a3060c8bfd18846dec854f33fc193e52d2525fb6` | design-limit | template-literal union grows a leading `\|` at 40. Same missing opcode. |
| `typescript/assertions.ts@80` | `7194a9626d033dfe3d9ad04168fe229e3bb5a29f37c41abf8d290750e0dbb8ff` | design-limit | prettier wraps `(a + b) as number` while the line still fits. `paren` / `autoparen` emit `IfBreak` parens. JS already named this (always-on wrap). |
| `typescript/assertions.ts@40` | `7234213102e08dcdc8da4c646f3db548e62a70e96a6e889e9cc53208fe0c244c` | design-limit | same always-on wrap. |
| `typescript/normalisation.ts@80` | `296a8f6399727322969955bc20f55820fdbae3907a3b4cd11be8c7ae20afa733` | design-limit | `((1 + 2))` is not deleted (FINDINGS 13); `y=1` / trailing-comment statement do not grow a `;` the tree omitted. |
| `typescript/normalisation.ts@40` | `77facb064cd95d67b45d30deae257ab4ddaa6198b543111e3fc33c5b3b87235b` | design-limit | same token mutations, plus `identity<string, number>` wrapping that prettier does at 40. |
| `typescript/sequences.ts@80` | `1130dc9245dad79d931c5556b4714c7a1eed31c24e4aac53fe2a753cec29f5e1` | design-limit | number array: prettier `fill`s. Same `fill`+comment coupling JS parked; this package uses `each`. |
| `typescript/sequences.ts@40` | `1dc2c3bebd0444e4f75a0d0b0cfca8e8e2fe2deeaca08bad96810c67dc789cef` | design-limit | same number packing. |
| `typescript/kitchen.ts@80` | `0a36228c91344f849b2d3d9b617e697e46e3c8e1af3fafe24814122f953ca79e` | design-limit | `records.filter().map().sort()` at the dots. FINDINGS 11. |
| `typescript/kitchen.ts@40` | `fcccfb22b27944694ae9eda962b38d567c1f1b590e07a1f00e3ae453d7cfa295` | design-limit | same chains, plus the assignment hang / generic wrap that FINDINGS 15 / 6 already name. |
| `typescript/comments.ts@80` | `875fd9997021bb1a67a96a88b263947b5cd946a015563fb7ba4e0dfc3b64784d` | design-limit | runtime-owned attachment (FINDINGS 9): `[ //` stays a suffix of `[`; mid-union `/* */` and type-parameter comments force groups prettier keeps flat; leading `\|` on Piped. |
| `typescript/comments.ts@40` | `4a4e8a5c97f66d546eaea2e6e53db601e10c71a78942161f3f81be30302c8158` | design-limit | same attachment, plus FINDINGS 6 (`fits` counts the suffix). |
| `typescript/mapped.ts@80` | `3e4ac3100bc032af1dd92e8281baf4c7bafe0b251efd6d774c750c7849f903be` | design-limit | `Unpacked` hangs the ternary after `=` in prettier and breaks at `?` here. Grouping the alias matches Unpacked and misses `DeepPartial` in the same file (FINDINGS 15). Chose the ternary group. |
| `typescript/mapped.ts@40` | `6d0f77f317356c21b790c58467c48451031c051c41fb32b19d59e9842771d0a5` | design-limit | same assignment-vs-ternary preference. |
| `typescript/nesting.ts@40` | `85f8e694fdc379e2aa61c93d05c1a60f6344deb234197c03df860279ca0b24e9` | design-limit | `fits` counts the array still on the stack, so `Array<{ list: number[] }>` wraps; prettier hangs the value and keeps the generic flat (FINDINGS 6 family). |
| `typescript/overloads.ts@40` | `aa02a8329c9cb1beb56a732b9cc5dec51d6808c2eff13cb9f0b26d7aac773ab3` | design-limit | prettier breaks `load(` params; we break `Promise<string>` because each group is independent and there is no "try two layouts". |
| `typescript/decorators.ts@40` | `842d55de55a1e284530b561f25698f16792ee65a61a1d4a6208d777a56290c9b` | package-bug (declined) | `@logged("debug", {…})` hugs the string and breaks the object. Python's two-group list expresses that; JavaScript's `list` does not. Re-deriving call rules would contradict "reuse JS where the construct is the same". |
| `typescript/annotations.ts@40` | `2420da614b2f7cc748f10df7b3f415c4b6ebb159bf375da497006ccac790e145` | reference-quirk | prettier `trailingComma: all` still omits the comma after `...rest: number[]`. `connect`'s last optional param *does* get one. One rest parameter in one file; encoding it is a bad trade. |

Matching at 80: `annotations`, `decorators`, `enums`, `generics`, `interfaces`,
`nesting`, `overloads`, `strings`. At 40: `enums`, `generics`, `interfaces`.

The leading-`|` miss is a divergence I **chose**. Adding `IfBreak`-as-opcode
(`lead` / `ifbreak`) would win `unions.ts` at both widths and `strings.ts@40`,
and is the capability Kotlin's `when` / rustfmt's parked `drop` sit next to.
I parked it the way FINDINGS 13 parked `drop`: the Doc IR has `IfBreak`, no
opcode exposes a *leading* token that the source does not have, and faking it
with an unconditional `|` changes the flat rendering. Other languages that
would have wanted it: none shipping today; rustfmt wanted the inverse (`drop`).

## Runtime edits

Two, both forced by `union_type`. Gzip of `runtime-js/bundle.js` vs main 13610:

1. **Fieldless `flatten` spine** (+61 B gzip JS; +517 B gzip `eval.rs`).
   tree-sitter-typescript's `union_type` / `intersection_type` are
   `[operand, token, operand]` with **no** `left`/`operator`/`right` fields.
   `flatten` refused that shape. Fallback fires only when *no child has a
   field* — a tree with `lhs`/`op`/`rhs` still uses Field selectors, so the
   tree-interface rename probe still refuses `Field("left")`. Intersection
   matches prettier at 80 with this walk. Unions still miss the leading `|`.

2. **`flatten` skip emits suffix/after comments** (+127 B gzip JS; +307 B gzip
   `eval.rs`). A mid-union comment re-parses as a suffix of the nested left.
   `skip` used to refuse any decoration, so `comments.ts` was not idempotent.
   Leading comments still refuse. Isolated test in both runtimes.

A one-line follow-up restricted the positional fallback to fieldless nodes
(probe gzip ~0) after the rename probe failed for the wrong reason.

No `ifbreak` / `lead` opcode. See above.

## Harness edits

None. Nothing under `harness/` was touched, including
`harness/languages/typescript.toml`.

## What was hardest

The leading `|` on a broken union. It is a token the source does not have,
inserted only when that group opens. That is not `trail` (trailing, and
count-gated), not `autoparen` (parens, and `IfBreak`), and not `drop` (the
inverse). Flattening the fieldless spine was the second problem; without it
every 3+ member union staircases. The third was making a mid-union comment
survive `flatten`'s skip so gate 2 does not fail `comments.ts`.

## What I would want from the design

One opcode: emit a declared punctuation token only in the broken branch,
without consuming a child. `["lead", "|"]` next to `trail`. That is the
capability FINDINGS 13 parked on the delete side. TypeScript is the insert
side. Same family, opposite direction.

## Template delta

The brief's "apply corrections first, then start the package" was noise given
stage B `pass` with nothing to correct — one sentence would have been enough.
The FINDINGS 13 mirror and "do not fake an unconditional `|`" were the load-
bearing parts and were right.

## Stage D review

**Reviewer:** codex-Sol. **Verdict: merge after fixes — fixes applied and
re-verified.**

Final score: all four hard gates **30/30**; Rust/JS parity **30/30**; reference
agreement **15/30**; accepted divergence **15/30**; stale **0**; unreviewed
**0**; defect **0**. Review coverage is **100%** at each width: @80 is 10
agreement + 5 accepted, and @40 is 5 agreement + 10 accepted. Current size is
**14,453 B** runtime + **4,726 B** TypeScript package = **19,179 B gzip**.

### Stale classifications recovered

- **`assertions.ts@80` and `@40` now agree.** FINDINGS 20 was built after this
  report: the `as_expression` rule selects its direct `binary_expression` and
  uses `['paren', true, ...]`. The optional flag is exactly the unconditional
  clarifying-paren capability the stage-C reason said did not exist.
- **`sequences.ts@80` now agrees.** The existing `all named [number]` guard now
  selects a `fill` list. The JavaScript-era comment coupling in the report is
  stale: current `fill` carries `BreakParent`, and this array contains no
  comments. @40 remains divergent for a different, measured reason: `fill`
  packs through `170`, then break-only `trail` adds a comma and makes the line
  41 columns. A tail-aware fill/trailing-separator measurement is still absent.
- **`annotations.ts@40` now agrees.** This was not a reference quirk. A trailing
  comma after a rest parameter is invalid TypeScript/ECMAScript syntax. The
  existing `child-count` predicate selects a no-trailing-comma list whenever a
  formal parameter wraps `rest_pattern`. Verified with TypeScript 5.9.3:
  `tsc --noEmit` reports TS1013 on the old output.

`normalisation.ts` was re-tested with `drop`. Both refusal guards pass: `(` and
`)` are declared punctuation and neither is decorated. The redundant pair is
deleted, but so are required control-flow parens (`if (x)` becomes `if x`). A
rule cannot select the deletion by parent position, so this is now recorded as
FINDINGS 10 plus missing unconditional semicolon insertion, not as an unbuilt
FINDINGS 13 opcode. The report's claimed extra generic-call hunk at @40 is also
stale; the current exact diff has only paren deletion and semicolon insertion.

### The contested decorator

**`decorators.ts@40`: `house-rule`, not `package-bug`.** Python's two-group
list proves the shape is expressible, so an inability verdict is wrong.
TypeScript and JavaScript use byte-identical `list` and `arguments` rules. The
JavaScript corpus has no multi-argument call whose last argument is an object;
its only trailing-object call has one argument, so it never probed Prettier's
hugging rule. This is a shared rule that deliberately puts every item in a
broken list on its own line. Keeping that cross-language layout avoids a
TypeScript-only last-object special case and is the house-style choice.

### `source-multiline` versus `srcbreak`

Keep **`srcbreak`** in `preserve_object`. A pinned Prettier 3.9.6 probe separated
the predicates: an object with its first property on the opener line collapses
even when a later property starts on a new line, while an object with a break
immediately after `{` stays expanded. Prettier keys `objectWrap: preserve` to
that exact opening break; `source-multiline` would also match the first,
broader case and is therefore the wrong spelling here. FINDINGS 32 names the
same source-driven family, but the older exact-position opcode already
expresses this option more faithfully.

### Runtime edits

- **Fieldless `flatten` fallback — warranted.** This is exactly FINDINGS 23's
  requested option 1: a homogeneous spine with no fields takes its positional
  left operand and declared operator token; any child field keeps the existing
  `flatten_fields` path, and the renamed-field probe still refuses a nonexistent
  `left`. Builder-baseline JS gzip was +61 B for the fallback plus +5 B for the
  fieldless-only guard (**+66 B**). Hand-built branches cover fielded and
  fieldless nodes, a non-spine left child, a same-kind continuation, a
  tightness stop, and a fielded operator with missing text. That last input
  exposed a parity defect: Rust scanned a later token while JS returned
  precedence 0. Rust now stops at the fielded operator, matching JS.
- **Skipped-operand suffix/after comments — warranted after correction.** The
  edit is necessary for `comments.ts` idempotence; a package cannot change the
  runtime-owned attachment on the skipped nested left. Builder-baseline JS gzip
  was **+127 B**. The review correction adds **+37 B** to the current runtime.
  Leading comments still refuse; empty suffix/after paths are inert; suffix and
  after paths emit once. A two-level suffix input exposed a shape defect in
  both runtimes: comments were batched at the end in outer-to-inner order. They
  now emit at their own spine boundary. Current combined TypeScript runtime
  delta is **+237 B** over current main (14,216 -> 14,453); gzip increments are
  not additive across the three merged runtime slices.

The hand branch matrix is mirrored in Rust and JS tests. A parity cross-check on
the unhighlighted `mapped.ts@40` file was byte-identical, and the focused scorer
confirmed the full 30/30 corpus parity afterward.

### Design findings

- **Existing FINDINGS 9:** comment attachment is runtime-owned and cannot see
  the surrounding TypeScript syntax (`comments` at both widths).
- **Existing FINDINGS 11:** method calls and member accesses form an alternating
  spine that homogeneous `flatten` cannot collect (`kitchen` at both widths).
- **Existing FINDINGS 15, with FINDINGS 2 context:** Prettier ranks candidate
  layouts where one fixed Wadler group cannot (`mapped`, `overloads`, and parts
  of `kitchen` / `unions`).
- **Existing FINDINGS 10:** `drop` needs parent-position-sensitive selection to
  remove only redundant expression parens (`normalisation`).
- **Existing FINDINGS 23, now built and called by TypeScript:** the fieldless
  homogeneous flatten fallback is the entry's requested capability.
- **Genuinely new / not yet its own entry:** emit a declared punctuation token
  at the leading edge only when a group breaks (`|` in unions). It is the insert
  mirror of FINDINGS 13, but neither `drop` nor paren-specific FINDINGS 20
  expresses it.
- **Extension at the FINDINGS 8/21 boundary:** `fill` does not reserve a
  break-only trailing separator when packing the last item (`sequences@40`).

### Template delta

Add two checks to `templates/package-brief.md`:

1. A classification reason must account for **every hunk** in the file/width,
   not only the headline hunk. The stage-C reasons omitted the constructor in
   `kitchen@80`, secondary mapped/kitchen hunks, and the union semicolon shape.
2. Before writing `reference-quirk` for omitted punctuation, verify whether the
   reference is enforcing the language grammar. The rest-parameter comma was
   invalid syntax that tree-sitter accepted, so all formatter gates were green
   while the package emitted code the TypeScript compiler rejects.
