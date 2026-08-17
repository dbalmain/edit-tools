# CSS package report (fill measurement)

```
coverage                30/30
rust/js parity          30/30 byte-identical
idempotence             30/30
non-destruction         30/30
width                   11 overflow lines; prettier 8
raw agreement           18/30  (10/15 @80, 8/15 @40)
reviewed divergence     12/30 accepted
stale / unreviewed      0 / 0
size                    package 1238 B gzip; runtime 10,680 B gzip
```

Stage E left CSS at 11/30 with `fill` built and unused. This slice applies it
to declaration value lists and measures what it actually buys.

## What was applied

Two existing `count` tests pick the lists where token-level `fill` matches
prettier, and leave the others on `each`:

- Comma-separated values that contain a `string_value` (`font-family`) use
  `["fill", "named", comma_or_space]`. Lists with no string — `box-shadow`,
  `transition`, `--list` — stay all-or-nothing, because filling those at
  token granularity packs the comma-groups and then explodes the last
  `rgba()` when it no longer fits flat.
- Space-separated values that contain a `call_expression` hang after the
  colon and `fill` (`1px solid color-mix(...)`, `minmax() minmax() minmax()`).
  Lists with no call (`grid-template-areas`) keep the old group-and-`each`
  layout, which is what currently matches the source-broken reference.

Blind `fill` on every comma list raised agreement only to 15/30 and made
`values.css` worse. Blind `fill` on every space-separated list regressed
`grid_areas.css`. Function-argument `fill` regressed `vendor.css@40`.

## What it resolved

Seven of the nineteen accepted divergences now agree:

| case | why fill was enough |
| --- | --- |
| `nested.css@80` | `font-family` only |
| `nesting.css@80` | `font-family` only |
| `nesting.css@40` | `font-family` only |
| `normalisation.css@40` | `font-family` only |
| `values.css@80` | `font-family` only, once box-shadow/transition are left on `each` |
| `values.css@40` | same |
| `custom_properties.css@40` | hanging fill keeps `1px solid` together and breaks `color-mix` |

The eighteen agreeing pairs are the previous eleven plus those seven.

## Current accepted divergences

Every remaining divergence is accepted against its current content hash.

| case | hash | classification | remaining reason |
| --- | --- | --- | --- |
| `at_rules.css@40` | `05166f0c859dbb097d69cdb2bccf91f4905aba1615e3591a97c723f7365edd9c` | design limit | `binary_query` is node-local; supports should wrap but media should not. |
| `calc.css@80` | `764963acbdbc45b9efc003134c24696939a2dc030d38df1f6a8aaad312cce136` | design limit | Hanging fill wraps the last `minmax()` flat; prettier starts it broken on the current line. |
| `calc.css@40` | `be275fdb66ff6dd750ac3c102dd9f2496e1c569aab8e491c9effee831323133d` | design limit | Same fill-item limit at the narrower width. |
| `comments.css@80` | `0f3573cc7c352289b7996e4efbbf1e0fc474883831912f7192fb84dea0e30969` | design limit | Runtime-owned comments lack sibling-aware attachment. |
| `comments.css@40` | `96e69663d5f870336686e215699881678f0326d7d11e9f6db429e5bc96d6297b` | design limit | Same attachment limit plus comment-forced group breaks. |
| `custom_properties.css@80` | `d49f9d33f5614488ad6f14110a3874eba56b92f5f6b5d4abb454aae236df81be` | design limit | Mixed comma/space `--list`: token-level fill explodes the last `rgba()`. |
| `kitchen.css@80` | `efc13672d316f46dda0e858442f555e997ff480e7171eb6118c27bef555f5ed4` | design limit | `font-family` now fills; `--shadow`, grid-areas and `minmax()` remain. |
| `kitchen.css@40` | `681fe6d256d072054e6c669a75cf40f9c478bd39df94a1d144c40ce0477ad061` | design limit | `font-family` now fills; `binary_query` and `minmax()` remain. |
| `nested.css@40` | `056f33518d95d887c185ad2de6987679c9a7d1235532bcac786910614cb5dd56` | design limit | `font-family` now fills; only parent-specific `binary_query` remains. |
| `selectors.css@40` | `bc8623406b33626c1995f1e9c636706e6e6123e9a13a84099e3515044bee85ca` | design limit | Anonymous combinator spines cannot be flattened per selector item. |
| `strings.css@80` | `afcb1eb034726d55388dcf181c02634afec675b9538b77131b128d7a4015a2c1` | design limit | `url()` is fixed; anonymous quote tokens cannot be rewritten. |
| `strings.css@40` | `afcb1eb034726d55388dcf181c02634afec675b9538b77131b128d7a4015a2c1` | design limit | Same quote-only difference. |

## Ledger refresh

Seven records were retired because they now agree. Five hashes moved and were
re-judged (`calc` both widths, `kitchen` both widths, `nested@40`). No
previously-agreeing file moved. json / go / python / toml / yaml outputs are
hash-identical to the pre-change baseline (108 files).

## Against the stage-D estimate

Stage D costed `fill` at **13 of 21 contributing, 9 of 21 fully resolving**.
After stage E the accepted set was 19, not 21. The measured result on that
board is **7 of 19 resolved**, agreement **11/30 → 18/30**.

The estimate was optimistic in two places the opcode cannot reach:

- `calc` both widths. Hanging fill packs the first two `minmax()` calls, but
  prettier starts the third *broken* on the current line. Fill decides from
  the next item's flat form, so it wraps and then prints the call flat.
- `custom_properties@80`. prettier fills comma-groups (`0 1px 2px rgba(...)`
  as one item). Our fill items are named CST children, so packing the list
  explodes the last `rgba()` instead of wrapping the last shadow.

`values.css` *was* fully resolvable, but only if `box-shadow` and
`transition` stay on `each`. Filling every comma list — the JSON-shaped
opt-in — fixed `font-family` and spoiled the other two lists in the same
file, leaving it divergent. The `string_value == 0` guard is the existing
predicate that separates those cases; it is not an `["all", sel, kinds]`
test, and an unquoted-only `font-family: Helvetica, Arial, sans-serif`
would not take this branch.

No remaining divergence got worse under the shipped rules. Blind comma
`fill` did make `values.css`, `custom_properties.css` and `kitchen.css`
worse (the `rgba()` explosion); that variant was not kept.

## Runtime and cross-language accounting

Runtime gzip is unchanged at **10,680 B**. The CSS package grew
**1,194 → 1,238 B** (+44 B). json / go / python / toml / yaml did not move.
