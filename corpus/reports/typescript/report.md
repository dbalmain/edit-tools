# TypeScript package report (stage C)

```
gate 1 idempotence      pass   (30/30)
gate 2 width            pass   (overflow 9; prettier 8)
gate 3 non-destruction  pass   (30/30, method default)
gate 4 agreement        8/15 @80,  3/15 @40   (11/30 overall)
rust/js parity          identical (30/30)
refusals                none
size                    package 4640 B gzip; runtime 13803 B gzip;
                        delta vs main +193 B JS runtime
```

Measured with `./test.sh` (exit 0) and `./harness/score.py . --language typescript`.
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

## Divergences

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
