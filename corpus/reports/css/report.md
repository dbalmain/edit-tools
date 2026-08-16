# CSS package report (stage C)

```
gate 1 idempotence      pass
gate 2 width            pass   (9 overflow lines; prettier 8)
gate 3 non-destruction  pass   (method: default)
gate 4 agreement        6/15 @ width 80,  3/15 @ width 40
rust/js parity          identical
refusals                none
size                    package 1105 B gzip; runtime 9358 B gzip
                        (+44 opt-else, +149 comment-only block, vs main 9165)
```

Scored 30/30 coverage, 30/30 rust/js, 30/30 idempotence, 30/30 non-destruction.
Agreement is 9/30. Every remaining pair is classified below; none are
unnoticed. Stage D records verdicts with `--approve`.

CSS is the round's control and it mostly fit. Dispatch-by-node-type is the
right shape: rules, blocks, declarations, calls, combinators and at-rules
all fall out of emitting what the tree has. The interesting parts are the
three places it does not.

`comment_gap = 1` and `blank_cap = 1` are what prettier writes. No second
runtime constant turned up.

## Divergences

Twenty-one cases, nine files. None are package bugs I chose to leave.

**No fill.** A group is all-flat or all-broken. prettier fills comma-separated
value lists and space-separated `minmax()` calls to the remaining width.
JSON already named this; CSS is the second prettier language to pay it.

- `css/values.css@80` `23f85b9cefa02c541a6e72ccd328fef0984c8342e315684fab8570f4dd05191c` — **design limit**. `font-family` fill; `box-shadow` and `transition` already match one-per-line.
- `css/values.css@40` `c8a40f326d8548f83bab7e17eea34f4a7cfab90c743f57e57a538418704c877d` — **design limit**. Same fill, tighter.
- `css/nesting.css@80` `fac55aeab7dfb64d5f198b1fa4bb592635928e12b9b704508c0187ea3d097b62` — **design limit**. Only the two `font-family` fills.
- `css/nesting.css@40` `5acfad092aef2c986035fa96cb3460088e82ccecc295212db0b60eb51ef95777` — **design limit**. Same fills at 40.
- `css/nested.css@80` `f38834a1967973b35dbd7f1075b3d440def445dc7f7660e48df28e179d1cf394` — **design limit**. `linear-gradient` matches; only `font-family` fill differs.
- `css/custom_properties.css@80` `d49f9d33f5614488ad6f14110a3874eba56b92f5f6b5d4abb454aae236df81be` — **design limit**. `--list` fill (two shadows on the first continuation line).
- `css/calc.css@80` `ac12c9ad5d96cf7e3fee1a23315525c0af15b3080eba6688fb5d6acc5af72cb6` — **design limit**. `minmax()` list fills the remainder; we one-per-line the three calls.
- `css/calc.css@40` `55e8f69a94a5c2fa32ab8b4aa14ad993d43527a3be9cbfb35ec93112e9358994` — **design limit**. Same fill; clamp arguments already match.

**Same node, two prettier policies.** `@media` and `@supports` both use
`binary_query`. Wrapping it would reflow the 124-character `@media` line
prettier never breaks; not wrapping leaves `@supports` flat at 40. I chose
not to wrap — one rule, and it keeps `at_rules@80`. No ancestor context
(FINDINGS entry 2).

- `css/at_rules.css@40` `05166f0c859dbb097d69cdb2bccf91f4905aba1615e3591a97c723f7365edd9c` — **design limit**. `@supports` stays one line.
- `css/nested.css@40` `010ab77f3dba467962001d05b86e06742397db6963f2c7c7dfe3983786967478` — **design limit**. Same `binary_query`, plus `font-family` fill.
- `css/kitchen.css@40` `c31b2cc24639b07a809df2b79f05fe1998dfbfdd600de554debd5d7c9dcf7a4d` — **design limit**. `@supports` flat, `font-family` fill, `minmax()` fill.

**Comments are runtime-owned. A rule cannot place them.** This is the
confirmation stage B asked for. prettier glues an own-line comment inside
a call onto the next argument, and keeps a selector-list comment before
`{`. Suffix comments flush at the next newline, so `.lead /* after */ {`
comes out `.lead { /* after */`. `BreakParent` on every comment also
opens the value group, so `margin: 1px /* … */ 2px` splits at 80 where
prettier stays flat. No selector on a comment, no "glue to next sibling".

- `css/comments.css@80` `0f3573cc7c352289b7996e4efbbf1e0fc474883831912f7192fb84dea0e30969` — **design limit**. Sibling-aware comment placement is not a rule.
- `css/comments.css@40` `96e69663d5f870336686e215699881678f0326d7d11e9f6db429e5bc96d6297b` — **design limit**. Same attachment, plus the comment-forced group break.

**Linearity forbids quote rewrite; `arguments` cannot special-case `url()`.**
Entry 4. `'single'` stays single-quoted. A long `url("…")` wraps like any
other call; prettier never wraps `url()`.

- `css/strings.css@80` `cb4ce7242a8e5af3f71edbcbceb7a81eab4710de95131ed960dfa1568d33ba72` — **design limit**. Quote style and `url()` share a node type with every other call.
- `css/strings.css@40` `cb4ce7242a8e5af3f71edbcbceb7a81eab4710de95131ed960dfa1568d33ba72` — **design limit**. Same pair, same hash.

**No "always emit this terminator" policy.** `trail` adds a comma on break
and pins the group; it cannot insert a missing `;` on a flat declaration.
prettier always inserts one. One file. Not an opcode.

- `css/normalisation.css@80` `4077a234c3f6a6a44efd81ce183f2f79f485e99461f6637b1f4d5e6e6dfae5ec` — **design limit**. Only the missing semicolons.
- `css/normalisation.css@40` `c1d204a53215546d5e4c8aab105c888b56d1e304aec4082dbb9c2abdec33e213` — **design limit**. Semicolons, plus `font-family` fill.

**Chose the general multi-value colon-break.** A space-separated list of
two or more values breaks after `:` when it does not fit. That wins
`grid_areas` (author breaks happen to be one string per line) and loses
the one hanging-indent case.

- `css/keyframes.css@40` `83d4effdad8681a00a6ed930e721e3b303a3a4ebfe086df9f77acd82843d055d` — **reference quirk**. prettier hangs `scale(1.05)` under `translateX(-50%)`; the colon-break is the same rule that formats every other multi-value declaration. One construct, one width.
- `css/custom_properties.css@40` `99252240e1821af1257f53869129a6d72d75d55c0ff4f6c78ad27f379685fc1b` — **design limit**. `--token-soup` and `margin: var() var()` colon-break; prettier hangs the last item. No fill, and no "break only at some spaces".

**Combinator chains do not flatten.** `child` / `adjacent_sibling` /
`sibling` are nested groups with no field names, so only the outermost
breaks. `:not()` arguments share the `arguments` node with functions, so
the inner group breaks first and the descendant stays flat.

- `css/selectors.css@40` `bc8623406b33626c1995f1e9c636706e6e6123e9a13a84099e3515044bee85ca` — **design limit**. No flatten without fields; no try-two-layouts to prefer the descendant over `:not()`.

**Kitchen is several of the above in one file.**

- `css/kitchen.css@80` `88cb83c9cef539fa56b3337f04f3bf6b8c6d72b550e84c074f5def58e4261ad2` — **design limit**. `font-family` and `--shadow` fill; short `grid-template-areas` fits so we flatten author breaks; `minmax()` fill.

I did not encode prettier's fill, `url()` exception, or `@media`-only
flatness. Each of those is one construct or one ancestor test.

## Runtime edits

Two, each its own commit, gzip of `runtime-js/bundle.js` against main 9165.

1. **`opt` else branch** (`4281242`) — **+44 B** (9165 → 9209).
   CSS declarations and call arguments mix comma and space separators
   under one parent: `0 1px 2px rgba(...), 0 2px 4px rgba(...)`,
   `color-mix(in oklab, var(--fg) 80%, transparent)`, `to right`.
   `when` tests the node, so it cannot pick the separator in front of
   the cursor. `opt` already was the cursor test; the missing else is
   the other half. Tried first: `when count t:, == 0` versus requiring
   a comma between every named child — that refuses every box-shadow
   and every `color-mix`. A package-level workaround does not exist.

2. **Leftover comments on a descend opener** (`51ea32e`) — **+149 B**
   (9209 → 9358).
   A `{ /* only comment */ }` block has no named host, so the comment
   dangled in front of `{` and left the block. Gate 3 rejected that as
   lost leaf text. Parking the leftover on the first token, and letting
   `tok` carry `after` the way `child` already did, lets `indent` flush
   it inside. Tried first: leave it dangling — gate 3 fails on
   `comments.css`. The package cannot see comments.

Python, JSON and TOML scores are unchanged from main (20/24, 4/6, 23/30).

## Harness edits

None outside `harness/languages/css.toml` (and none inside it).

## What was hardest

Flat mixed-separator lists, not the rule table. tree-sitter-css puts
`0`, `1px`, `2px`, `rgba(...)`, `,`, `0`, … under one `declaration` (and
the same shape under `arguments`). `each` assumes a homogeneous
separator. That is why `opt` grew an else, and why a package that has
to special-case selector lists, `@media`, strings, `url()` and
`grid-template-areas` *separately* is telling you the IR has no fill
and no ancestor context — not that CSS needs five one-off rules.

The one thing I would ask of the design: **`fill`**. CSS value lists and
JSON's `long_flat_array` are the same missing opcode. Sibling-aware
comment placement is real (confirmed here) but it is a runtime policy,
not a rule, and I would not put it in the package language.

Sibling-aware comment placement cannot be expressed by a rule. Confirmed.

## Template delta

- Stage-B corrections were already in this worktree (`9b49990`). Not a
  step a stage-C builder still has.
- `score.json` has no schema. I stored the report header plus the
  scorer's `gates` / `measures`.
- The 70% floor is agreement plus accepted reviews. The author
  classifies; stage D `--approve`s. Raw agreement here is 9/30 on
  purpose — fill, `@media`/`@supports`, and comment attachment are the
  findings, not a package left half-finished.
