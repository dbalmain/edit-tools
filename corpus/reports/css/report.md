# CSS package report (stage E)

```
coverage                30/30
rust/js parity          30/30 byte-identical
idempotence             30/30
non-destruction         30/30
width                   10 overflow lines; prettier 8
raw agreement           11/30  (7/15 @80, 4/15 @40)
reviewed divergence     19/30 accepted
stale / unreviewed      0 / 0
size                    package 1194 B gzip; runtime 9315 B gzip
```

The package now loads without the reverted three-operand `opt`. The replacement
is the Stage D composition in its specified order: first positive
`opt named -> sp`, then positive `opt comma -> comma+line` (or comma+space in
flat at-rules). It preserves all 30 pre-fix CSS outputs and Rust/JS parity. The
reviewer was right that no runtime extension is needed for mixed separators.

## Stage E package corrections

- A declaration with exactly two direct `call_expression` children uses a
  hanging layout. `keyframes.css@40` now agrees, and the same branch improves
  the two-`var()` margin in `custom_properties.css@40`.
- Declarations end with `trail ";" "*"`. `normalisation.css@80` now agrees;
  `normalisation.css@40` retains only its `font-family` fill difference.
- An argument node with exactly one named child which is a `string_value` stays
  flat. Both `strings.css` widths now differ only in quote normalization.

This raises raw agreement from 9/30 to 11/30. The eleven agreeing pairs are
`at_rules@80`, `grid_areas@80/@40`, `important@80/@40`,
`keyframes@80/@40`, `normalisation@80`, `selectors@80`, and
`vendor@80/@40`.

## Current accepted divergences

Every remaining divergence is accepted against its current content hash.

| case | hash | classification | remaining reason |
| --- | --- | --- | --- |
| `at_rules.css@40` | `05166f0c859dbb097d69cdb2bccf91f4905aba1615e3591a97c723f7365edd9c` | design limit | `binary_query` is node-local; supports should wrap but media should not. |
| `calc.css@80` | `ac12c9ad5d96cf7e3fee1a23315525c0af15b3080eba6688fb5d6acc5af72cb6` | design limit | No fill for space-separated call documents. |
| `calc.css@40` | `55e8f69a94a5c2fa32ab8b4aa14ad993d43527a3be9cbfb35ec93112e9358994` | design limit | No fill for independently breaking `minmax()` groups. |
| `comments.css@80` | `0f3573cc7c352289b7996e4efbbf1e0fc474883831912f7192fb84dea0e30969` | design limit | Runtime-owned comments lack sibling-aware attachment. |
| `comments.css@40` | `96e69663d5f870336686e215699881678f0326d7d11e9f6db429e5bc96d6297b` | design limit | Same attachment limit plus comment-forced group breaks. |
| `custom_properties.css@80` | `d49f9d33f5614488ad6f14110a3874eba56b92f5f6b5d4abb454aae236df81be` | design limit | No fill for mixed comma/space value lists. |
| `custom_properties.css@40` | `5e4a68666703f87bffadbad7b52f16ad86777d49f1e97ded43d80351d6101754` | design limit | The margin is fixed; only fill around `1px solid color-mix(...)` remains. |
| `kitchen.css@80` | `88cb83c9cef539fa56b3337f04f3bf6b8c6d72b550e84c074f5def58e4261ad2` | design limit | Fill plus source-break-sensitive grid areas. |
| `kitchen.css@40` | `c31b2cc24639b07a809df2b79f05fe1998dfbfdd600de554debd5d7c9dcf7a4d` | design limit | Fill plus parent-specific `binary_query` layout. |
| `nested.css@80` | `f38834a1967973b35dbd7f1075b3d440def445dc7f7660e48df28e179d1cf394` | design limit | `font-family` fill. |
| `nested.css@40` | `010ab77f3dba467962001d05b86e06742397db6963f2c7c7dfe3983786967478` | design limit | Fill plus parent-specific `binary_query` layout. |
| `nesting.css@80` | `fac55aeab7dfb64d5f198b1fa4bb592635928e12b9b704508c0187ea3d097b62` | design limit | `font-family` fill. |
| `nesting.css@40` | `5acfad092aef2c986035fa96cb3460088e82ccecc295212db0b60eb51ef95777` | design limit | `font-family` fill. |
| `normalisation.css@40` | `6eba7f9be2d3b3c9da4b01e3da96ffa37db6cdb8c646b2090e1bcb0a14b40f09` | design limit | Semicolons are fixed; only `font-family` fill remains. |
| `selectors.css@40` | `bc8623406b33626c1995f1e9c636706e6e6123e9a13a84099e3515044bee85ca` | design limit | Anonymous combinator spines cannot be flattened per selector item. |
| `strings.css@80` | `afcb1eb034726d55388dcf181c02634afec675b9538b77131b128d7a4015a2c1` | design limit | `url()` is fixed; anonymous quote tokens cannot be rewritten. |
| `strings.css@40` | `afcb1eb034726d55388dcf181c02634afec675b9538b77131b128d7a4015a2c1` | design limit | Same quote-only difference. |
| `values.css@80` | `23f85b9cefa02c541a6e72ccd328fef0984c8342e315684fab8570f4dd05191c` | design limit | `font-family` fill. |
| `values.css@40` | `c8a40f326d8548f83bab7e17eea34f4a7cfab90c743f57e57a538418704c877d` | design limit | `font-family` fill. |

## Ledger refresh

Six entries became stale after the package fixes. `keyframes.css@40` and
`normalisation.css@80` were retired because they now agree. The residual
`normalisation.css@40` and `strings.css@80/@40` pairs were re-judged as design
limits. `custom_properties.css@40` also changed because its two-call margin
improved; its remaining fill-only pair was re-approved. All four current
judgments are recorded under `Codex (CSS stage E corrective agent)`.

## Runtime and cross-language accounting

`4281242` remains reverted by `f2d84b9`; Stage E adds no runtime code.
`51ea32e` remains separate and warranted as a runtime comment-attachment bug
fix exposed by CSS. Its Stage D isolated gzip delta was +149 B, but it is not a
CSS package feature or CSS package cost. The current scorer's standalone
runtime measurement is 9315 B gzip.

JSON, Python, and TOML retain 4/6, 20/24, and 23/30 agreement respectively:
47/60, the same non-CSS total as main. With CSS at 11/30 the full total is
58/90. No `fill` combinator was added; the remaining fill divergences stay
classified for Dave's separate decision.

## Review accuracy

Stage D was correct on every requested construction. Its statement that the
two-call branch changes no currently matching pair also holds: the extra
changed pair, `custom_properties.css@40`, was already divergent and improved.
The superseded Stage C report was wrong about mixed separators, semicolon
insertion, the `url()` case, and the keyframes layout being unavoidable.
