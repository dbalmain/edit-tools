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

## Stage D review

**Reviewer:** Claude (Opus 5). **Verdict: merge after fixes — fixes applied.**

The lane is unusual and worth recording: codex-Sol built this package, and a
reviewer is never the same family as the builder, so it could not review it.
grok is at a 402. That leaves Claude, which is also the carve-out the ledger
reserves Opus subagents for — this slice edits `DESIGN.md` and both runtimes, so
a wrong call here costs every language.

### The defect: the two runtimes did not mean the same thing by "whitespace"

`srcgap` refuses a gap that is not whitespace. Rust asks
`u8::is_ascii_whitespace`, which excludes **vertical tab** (U+000B) — that is
deliberate in Rust and it happens to match the HTML spec, whose ASCII whitespace
is tab, LF, FF, CR and space. The JS side hand-listed six bytes and included
`0x0b`.

So one vertical tab in a source gap split the runtimes. Demonstrated by patching
a single byte of the `inline.html` tree — one byte for one byte, so every offset
stays valid — after which `fmt-rust` exited 1 with a refusal and `fmt-js` exited
0 with formatted output. **Rust/JS parity is a hard requirement, and no corpus
file contains U+000B**, so no gate could have caught this.

Fixed by removing `0x0b` from the JS set, with a unit test pinning the refusal
in both directions. The condition itself got smaller; the runtime is **+45 B
gzip** against the builder's measurement, and that is the one-line comment
naming the whitespace set. It is kept deliberately: a bare list of five magic
bytes with no explanation is exactly what let the two implementations drift
apart, and 45 B is a cheap fence.

### Runtime edits: all three warranted

- **exact leaf-path `text` predicate (+144 B) — warranted, shape correct.**
  `element` is the node type for both `div` and `span`, and the tag name is a
  leaf inside `start_tag`; no member of the `count` / `child-count` / `all`
  family can read it. The shape is the narrow one: it walks exactly as many
  levels of *direct* children as the path has, so a nested block tag cannot
  classify an inline ancestor. That is the failure mode YAML's semantic-gap
  bypass had, and this predicate does not have it — there is a unit test in both
  runtimes pinning the direct-versus-nested distinction.
- **`srcgap` (+172 B) — warranted, one defect, fixed above.** The dilemma is
  real: `srcsoft` drops the spaces in `<span> world </span>` and `srcline`
  invents one between source-adjacent spans, and in HTML both are rendering
  changes. Refusing a non-whitespace gap is the right guard — an omitted grammar
  token can never be erased through it.
- **exact leaf-path `multiline` predicate (+65 B) — warranted.** The smallest of
  the three and the case is genuine: a multiline `pre` leaf must start on the
  next line while `kitchen.html`'s single-line `pre` stays flat, and the gap
  between `start_tag` and the text is empty, so no `src*` opcode fires.

`srcgap` does widen the linearity invariant — it is the first opcode that emits
a run of source-derived text, bounded to whitespace. That is a real change to
"there is no opcode that emits arbitrary text" and the builder documented it in
`DESIGN.md` rather than leaving it implicit, which is the right call.

### One thing the report did not say, and it is not a blocker

The fallback for the un-huggable start tag **introduces whitespace inside an
inline element**. Prettier's hug-close exists precisely to avoid that: `<span
\n  >outer` renders identically to `<span>outer`, while our `<span>\n  outer`
does not, because HTML collapses that newline to a rendered space. In
`inline.html` the span sits at block level, so nothing visible changes — but the
general case (`foo<span>bar</span>` breaking to `foo<span>\n  bar</span>`) is a
rendering change.

**Gate 3 structurally cannot see it**, because the whitespace is layout emitted
between children, not text inside a leaf, so the named-node comparison is
identical. This is `FINDINGS` 12's class — semantic content living in the
whitespace *between* two nodes — and it is recorded on both `inline.html`
verdicts so it is not rediscovered later as a bug. It does not block the merge:
the package cannot express hug-close on a shared `start_tag` rule, which is the
`child-as` request the report already makes.

### Classifications

All nine records approved as `design limit`, three comparable and six on the
manifest's incomparable files. Two were tested rather than read: the
`normalisation.html` gap claim was reproduced against the reference, and the
`inline.html` disproof (hugging the shared start-tag rule regresses the
adjacent-span line, which currently matches) holds.

Final: **23 agreement, 3 accepted, 0 stale, 0 unreviewed, 0 defect of 26**,
three files excluded, review coverage 100%.

### Template delta

**The stage-C brief tells a builder to measure the gzip delta of each runtime
edit separately, and that is working — but nothing tells a reviewer that their
own fix is scored too.** The obvious fix here was a five-line comment in
`runtime-js/bundle.js` explaining why vertical tab is excluded; it cost **140 B
gzip**, three times the fix itself, in a budget the builder had measured to the
byte. A reviewer editing a scored file should measure the same way a builder
does. The explanation now lives in the test file, which is not scored.

**Second:** the brief's item 4 says to check whether a runtime edit's predicate
is implemented too broadly, and gives YAML's over-wide search as the example.
That is the right instruction and it found nothing here. It does not tell a
reviewer to check the *two implementations against each other* — which is where
this slice's only defect was. Parity is listed as a hard requirement measured by
the corpus, and the corpus can only measure the bytes it contains. Suggest: when
a slice adds a runtime capability with a **refusal condition**, diff the two
refusal conditions by hand and construct one input for each branch.
