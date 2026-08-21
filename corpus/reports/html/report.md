# HTML formatter report

```
gate 1 idempotence      pass (32/32 runs; no files failing)
gate 2 width            pass (1 overflow line; an indivisible HTML comment)
gate 3 non-destruction  pass (32/32, default named-tree comparison)
gate 4 agreement        11/13 @ width 80, 12/13 @ width 40
rust/js parity          identical (32/32 runs)
refusals                none
size                    package 1144 B gzip; runtime 13991 B gzip; runtime delta vs main +381 B
```

The package has 10 node rules. It keeps the inline/block tag lists as package
data behind exact child-path predicates; neither runtime knows an HTML tag.
`comment_gap = 1` and `blank_cap = 1` are explicit. HTML `comment` nodes are
deliberately not runtime-attached comments: they are inline markup, so the
element rules consume them in place and preserve zero-byte adjacency such as
`</span><!-- comment -->`. Script and style nodes are safe opaque `verbatim`
regions; no injection branch was merged.

The one counted overflow is `comments.html@40`: the 40-column comment token is
indivisible and its two columns of required nesting indent make the line 42.
Prettier has the same overflow. The long prose leaf is also indivisible, but the
scorer correctly exempts a line containing a token that is itself over width.

## Divergences

- `html/inline.html@80` `737ce194eab235747e760d193b9f1980245bf66c5d2d03d21f8114c38148fcbc` — **design limit**: the outer inline element contains a block child, so Prettier hug-breaks inside both tags; the element rule can detect that fact, but cannot apply alternate rules to its `start_tag` and `end_tag` children, and exposing those breaks in the global tag rules regresses adjacent inline spans.
- `html/inline.html@40` `1c7ccc2927f0c9d00d6a8e39cf24b17546b1cad0f322b22d9bf426f38492add5` — **design limit**: the same missing context-specific child rule as width 80; all other inline fill and hug-close output in the file agrees.
- `html/normalisation.html@80` `778b3c82ea082fc1d15baab40cfee1b17c9d6e2e6af40eb63b0966687a05bd28` — **design limit**: Prettier forces a fitting paragraph open because the source put a horizontal run before its trailing HTML comment; `srcgap` can preserve or break that gap but no predicate can ask whether the current source gap is non-empty and force its group.
- `html/prose.html@80` `2d2b28c345094bed8f6d928933f1e04b363819f5ed2b5562a1c855b90eaf0e9a` — **design limit** (excluded): prose is one `text` leaf, so word wrapping would require splitting and rewriting a token, which the linear Doc IR intentionally cannot do.
- `html/prose.html@40` `2135416cc1d05e8bf7db570a38a02a0f6314eb6b984a1741bebfd6a70c7588bc` — **design limit** (excluded): the same indivisible `text` leaf at the narrower width.
- `html/quotes.html@80` `197c8cb648dd72f5068bd3f9979c267481724d32c7e88e2fde45d4620962c32b` — **design limit** (excluded): delimiter replacement is an anonymous-token rewrite, but escape minimisation rewrites the named `attribute_value` leaf and fails gate 3; the package therefore preserves both.
- `html/quotes.html@40` `efb487810553067b81da795026877c489a93f921bc80e7c6fbaf458aa210d7dc` — **design limit** (excluded): the same forbidden quote/value rewrite; the longer preserved source value also makes the start tag wrap.
- `html/void_slash.html@80` `6e2a9218d404ea80bc99c17a7e29680e06abbb99cfc668b02d2ea8adfa03ba34` — **design limit** (excluded): adding ` /` changes `start_tag` to `self_closing_tag`, and no sanctioned token policy inserts a void slash.
- `html/void_slash.html@40` `6e2a9218d404ea80bc99c17a7e29680e06abbb99cfc668b02d2ea8adfa03ba34` — **design limit** (excluded): identical token-insertion limit at width 40.

No divergence is a known package bug, and none is labelled a reference quirk.
The three comparable records remain unreviewed for the stage-D reviewer; this
author did not write ledger approvals.

## Runtime edits

All three changes are in both runtimes and were measured incrementally as gzip
of `runtime-js/bundle.js` before the green implementation commit `77b635b`.

| construct | gzip delta | case and why the package could not do it |
| --- | ---: | --- |
| exact leaf-path `text` predicate | **+144 B** (13610 → 13754) | `element` is the node type for both `div` and `span`. Count/type proxies cannot distinguish them. The predicate follows an exact direct-child path, so a nested block tag cannot accidentally classify its inline ancestor; the block/inline spelling lists remain package data. |
| `srcgap` | **+172 B** (13754 → 13926) | Tree-sitter omits rendering-significant horizontal gaps. `srcsoft` drops `<span> world </span>`'s spaces, while `srcline` invents a space between source-adjacent spans. `srcgap` derives only whitespace from source, refuses a non-whitespace hole, preserves it flat, and makes it a legal break when grouped. |
| exact leaf-path `multiline` predicate | **+65 B** (13926 → 13991) | A multiline `pre` text leaf must start on the next line, while the single-line `pre` in `kitchen.html` must remain flat. A width group sees the embedded newline only as text and making every `pre` hard regresses the single-line case. |

The package-level alternatives above were also exercised at width 1. The final
package remained Rust/JS-identical for every width from 1 through 120
(1920/1920 runs). No second house-style constant was found. The two named
comment fields are package-controlled; HTML's decision not to attach markup
comments is structural, not another hidden whitespace constant.

## Harness edits

None, including none to `harness/languages/html.toml` during this stage.

## Hardest part and requested design shape

The exact path predicate answers the slice's main question: tag behavior should
be selected by a generic predicate, with the tag-name sets stored as package
data. Putting an `inline_elements` registry into the runtime would merely
hardcode HTML under a different name and would not help Scheme's head symbols.

The remaining hard case is one level beyond selection. An outer `span` can see
that it contains a block element, but it cannot make only its own start/end tag
rules expose hug breaks. The smallest next capability I would ask for is a
context-specific child rule, conceptually
`["child-as", "t:start_tag", "hug_start"]`: evaluate a named definition
against the selected child instead of performing global node-type dispatch.
That keeps context explicit and local, and is smaller than inherited mutable
state or ancestor predicates throughout the evaluator.
