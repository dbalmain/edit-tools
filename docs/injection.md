# Injection: one document, several languages

A design note and implementation record. Prompted by the requirement that a
markdown file format and highlight JavaScript inside a ` ```javascript ` fence.

Markdown is not on the roster in `LANGUAGES.md` as an afterthought — it is the
first language whose _defining_ feature is that it contains other languages, and
it is the only one that makes the runtime's single-package assumption visible.
Everything below applies equally to HTML `<script>`/`<style>`, YAML front matter
in markdown, SQL in a heredoc, and template literals in JavaScript.

## The claim

Injection costs **one optional field on a node, one change to the printer, and
no new opcodes**. If that is right, it is much cheaper than it looks, and the
reason is that most of the work lands in the harness, which already owns all
parsing.

## What has to change

### 1. A node may declare its language

Today `TreeDoc` carries one `language` at the root and every node below it is
governed by one package. The change is to let any node carry the same field:

```json
{ "type": "document", "language": "json", "start": …, "children": [ … ] }
```

The **harness splices** — `gen_trees.py` parses the outer document, finds the
injection sites, parses each embedded region with that language's grammar,
rebases the child tree's offsets onto the outer source, and stamps `language` on
the node. The runtime never learns to parse; it continues to only read.
`rust/src/tree.rs` says "The harness owns all parsing; we only read", and that
stays true.

The routing is manifest data in both directions. Every guest declares its exact
`injection_aliases` (the info-string spellings that select it), and a host
declares `[[injections]]` entries naming the injection node and its direct info
and content child types. Alias collisions are a manifest error. There is still
no language list or markdown node name in `gen_trees.py`.

Step 3 proved this with a fixture-only markdown manifest rather than enrolling
markdown in the scored corpus before its package exists. The pinned
`tree-sitter-markdown==0.5.1` Python binding exposes both `language()` (block)
and `inline_language()` (inline). Fences, their `info_string`, and their
`code_fence_content` are all present in the block tree, so the host manifest
selects `language()` and this slice does not need the included-range second
pass.

### 2. The runtime takes a package _map_ — **done**

`format(tree, pkg, width)` becomes `format(tree, packages, width)`, where
`packages` maps a language name to a loaded package. Dispatch is one line in
`Fmt::node`: if the node carries a `language`, format its subtree against that
language's package instead.

A node naming a language with no package in the map is a **refusal**, in the
same voice as an unknown node type. It is not a silent fallback — see below for
why that does not hurt.

Both runtimes now resolve the root through the map and create a formatter bound
to exactly one package for each stamped region. The region formatter shares the
package map and source bytes, but all package policy — rules, indentation,
comment handling, descent, token classification and precedence — comes from its
own package. Returning from the recursive call restores the enclosing formatter
by construction; there is no mutable current-package state to leak.

The formatter and highlighter deliberately have opposite missing-package
policies. The formatter refuses and names the language, because guessing can
change layout bytes. The highlighter walks the same unknown region with empty
tables, because losing colour is recoverable and a nested known region may still
paint. Neither behaviour is a fallback to the enclosing package.

### 3. `indent` carries its own amount — **done**

This was the only real change, and it was worth making regardless of injection.

`Doc::Indent` used to mean "one level deeper", and the printer resolved a level
into columns using a single `tab` passed to `print` — the root package's
`indent`. A markdown document indenting by 2 that contains Python indenting by 4
has no single correct `tab`.

**`Indent` now carries its column count, resolved when the Doc is built**, by
whichever package built it. `print` has no `tab` argument. The amount is
relative (`ind + n`), so a single-package document is unchanged.

It removed an argument rather than adding one. It also buys something unrelated:
a language whose continuation lines indent differently from its block bodies
becomes expressible, which is a `LANGUAGES.md` "known stress" for Haskell.

### 4. The gates cross the same boundary — **done**

Gate 3 cannot treat an injection's host node as ordinary structure. Measured on
the Markdown fixture, `tree-sitter-markdown` represents each content line only
as an empty `block_continuation`; replacing a JSON body with garbage leaves the
generic named-node signature unchanged. The failure is under-strict, so it must
be fixed before a Markdown package can produce trusted goldens.

The non-destruction signature now follows the same manifest routing as tree
generation. It masks the opaque content in the host structure and records an
ordered recursive signature beside it:

- a clean, known region uses the guest manifest, parser, gate-3 override and
  extras policy;
- an unlabelled, unknown, or unparseable region records its exact bytes;
- a nested host repeats the same process, with no language or node names in the
  gate.

The host extras walk stops at the content boundary and the guest signature
collects extras below it. Therefore comments are checked by the grammar that
owns them; they are neither lost between two grammar-specific extras walks nor
interpreted by the host grammar. `check_gate3.py` proves this with a Python
comment inside Markdown, as well as JSON meaning changes, parse failure,
verbatim mutations, legitimate JSON reformatting, and
Markdown-in-Markdown-in-JSON recursion.

The signature is still driven from text, not from a prebuilt spliced tree. Gate
3 judges arbitrary formatter output, and any future override accepts text rather
than the corpus-tree format. Changing that interface would not make the check
tree-native. Instead, `gen_trees.py` and `gate3.py` share the small
region-routing and guest-parse helper, so gate 3 re-derives sites without
duplicating the routing decision.

Gate 2 now calls `gen_trees.parse_doc()` for its second pass. The frozen corpus
and the idempotence reparse therefore have one conversion and splicing path,
including the same `source` field and the same verbatim degradation policy.

### 5. Nothing else in the runtime

Width needs no work. Once the embedded Doc is spliced under the enclosing
`Indent`, the printer measures from the current column exactly as it does for
any other nested group — an embedded block inside a list item wraps at the right
place for free.

**No new opcode.** The markdown package's fence rule is ordinary:

```json
"fenced_code_block": [
  "seq",
  ["child", "t:fenced_code_block_delimiter"],
  ["opt", "t:info_string", ["child", "t:info_string"]],
  ["child", "t:block_continuation"], ["hard"],
  ["child", "*"],
  ["hard"], ["child", "t:fenced_code_block_delimiter"]
]
```

The block grammar gives these children types rather than field names and inserts
a zero-width `block_continuation` after the opening line, so the fixture rule
above records the real shape rather than the earlier pseudocode. At the content
cursor, `["child", "*"]` accepts either the stamped guest root or the original
unstamped `code_fence_content`. The _node_ says which package formats it. The
host package does not mention JSON, and the JSON package does not know it is
inside anything.

## The part that is genuinely new: not refusing

Everywhere else this design refuses rather than guesses, and that is right —
"unknown node type is a refusal, not a guess" is what makes an incomplete
package loud instead of silently wrong.

Markdown breaks that rule's assumption. Fenced blocks routinely contain
fragments, pseudo-code, `…` elisions, shell transcripts, and languages we will
never have a package for. A markdown file with one unparseable snippet must
still format. Refusing the document because of a code sample is absurd.

The resolution keeps the runtime's rule intact by putting the decision one layer
out, where it belongs:

- **The harness** attempts the embedded parse. If the grammar is missing, or the
  parse yields an `ERROR`, it simply **does not stamp `language`** on the node
  and leaves the region as an opaque leaf carrying its text.
- **The package** formats an unstamped fence with `verbatim`, which emits the
  region's source bytes unchanged after the offset checks pass.

So the fallback is _data_, not a new runtime concept. The runtime still refuses
what it cannot do; it simply is never asked. And `verbatim`'s existing
guarantees mean the untouched snippet is provably the source, not a guess.

This is worth stating as a design rule in its own right: **degrading is the
harness's job, refusing is the runtime's.** Every future injection case — an
unsupported language, a broken snippet, a fence with no info string — routes
through the same place.

## What this does _not_ solve

- **Markdown's package and corpus.** The gates can now see the boundary, but no
  scored Markdown language exists yet. Onboarding must still declare the real
  host shape, write the package, and add adversarial corpus cases. In
  particular, it must measure the same guest at two indent depths: a formatter
  can be idempotent at its own width and unstable at the width left by its host.
- **The verbatim-fence newline policy.** The fixture package remains
  deliberately non-idempotent for unspliced content; the probe result below is
  now more precise, but the package-design choice still belongs to Markdown
  onboarding.
- **The reference formatter.** Prettier formats embedded code in markdown, so
  there is ground truth to measure against — but prettier's markdown defaults
  matter enormously here, and one of them is load-bearing (below).
- **Host line prefixes inside a guest region.** A fenced block inside a Markdown
  block quote includes `block_continuation` children (`> `) inside the content
  span. Removing those bytes lets JSON parse, but it makes guest-to-host offsets
  piecewise: the injection probe measures 21 of 23 leaves misread by the current
  additive base. A retained-run offset map would repair the frozen leaf ranges,
  but not formatting. The spliced guest replaces the content node, so the `> `
  nodes disappear, and the JSON package emits newlines without giving the host
  package a seam at which to restore them. Supporting this shape therefore also
  needs a prefix-aware Doc/runtime mechanism or a host-owned wrapper that can
  reinsert excluded runs at guest line breaks. An offset-map-only patch would
  produce a truthful tree that formats into invalid Markdown.

## `proseWrap` decides whether markdown needs `fill`

Markdown was the obvious argument for adding `fill` (paragraph-style wrapping)
to the Doc IR. The original conclusion here was conditional: retain Prettier's
`proseWrap=preserve` default and markdown can ship without prose filling.
**Superseded by the roadmap-step-2 measurement, 2026-09-09:** `fill` now exists
(JSON and CSS use it), and switching the pinned Prettier 3.9.6 reference to
`--prose-wrap always` drops unchanged-corpus agreement **27/32 -> 8/32**.
At width 80 the change is 13/16 -> 7/16; at 40 it is 14/16 -> 1/16. The
reference changes on 7/20 files at 80 and 16/20 at 40. Reflow is worth a real
follow-up; retaining `preserve` is no longer evidence that prose needs no work.

The live pin nevertheless remains `preserve` for now: the measurement rejects
20 reference outputs at gate 3, so changing only the flag cannot be a green
commit. The `always` measurements are retained in the
[measurement and design report](../corpus/reports/markdown/prose-wrap.md).

The runtime cannot express this from the current tree. The block grammar leaves
words in raw gaps or one leaf, and `fill` only selects existing child Docs. A
probe of `inline_language()` confirms that it supplies `emphasis`, `inline_link`
and `code_span`, **but no visible word nodes**. That second pass needs an
additional projection of source ranges into words, protected spans and safe
separators. Long emphasis also breaks internally in Prettier, so named markup
children alone are not the fill sequence.

Existing fence injection supplies routing and package switching; it parses
slices, not upstream included ranges. Markdown inline parsing would additionally
need omitted continuation prefixes mapped back to source, matching Python and
JavaScript parse paths, grammar/scanner artifacts, and the corresponding gate-3
equivalence. The highlighter would share that richer tree and language routing;
the inline parse and word projection do not arrive for free.

No runtime capability was added in this step. A source-range projection in the
parse layer is the preferred direction to investigate. A delimiter-aware raw
splitter inside the runtime is declined as a second, partial markdown parser.
The need for atoms is structural; the choice of projection design versus a new
declared text capability remains an engineering judgment, not a settled spec.

The [2026-09-10 projection proposal](prose-projection.md) narrows that choice:
derive a formatter view containing source-backed atoms and explicit whitespace
leaves, then compose existing `fill`, `verbatim` and `whitespace_nodes`. Keep
the inline syntax tree for highlighting. A mirrored composition probe succeeds,
but deleting an atom from the projected tree exposes a coverage guarantee that
existing source validation does not provide. The proposal calls for generic,
versioned partition validation before any projection ships. It specifies a
top-level words-plus-emphasis first slice; container prefix mapping, safe break
classification and the gate equivalence remain unimplemented.

## The highlighter gets this for free

The same `language` field on the same spliced tree tells a highlighter which
capture table to use for a subtree. Whatever the highlight package format turns
out to be, injection is already solved for it — which is an argument for
designing the two against one tree representation rather than letting the
highlighter invent its own.

## Suggested order

1. `Indent` carries its own amount — **done**. Independent of everything else,
   small, and it removes a printer argument. Done first and alone, so the diff
   is reviewable against a byte-identical corpus.
2. Package map plus the node `language` field — **done**. Covered by
   two-language unit toys in both runtimes; no grammar or corpus work.
3. Harness splicing in `gen_trees.py`, with markdown + JSON as the first real
   pair — **done**. `probe_injection.py` uses a fixture-only markdown manifest
   and package, so this did not add an unformattable scored language.
4. Injection-aware gate 3 and a spliced gate-2 reparse — **done**. The fixture
   adversarially proves guest semantics, guest extras, exact-byte fallback and
   nesting, without adding a scored language.
5. Markdown package and corpus, as an ordinary onboarding round with an
   injection-shaped brief. The round adds the real markdown manifest (including
   its host shape), package and corpus, then exercises the now-capable gates.

Steps 1 and 2 are runtime work and belong to whoever owns the runtime. Steps 3
and 4 are harness work. Step 5 is a language round and can go to a builder.

### What step 3 found that Markdown onboarding must solve

Run the probe fixture through both CLIs and the injected fence is right while
the verbatim ones each gain a blank line before their closing delimiter:

````text
```json
{ "outer": { "items": [1, 2] } }
```

```
no language

```
````

That is the fixture package's doing, not the runtime's, and it is a real tension
rather than a typo. **`code_fence_content`'s extent includes the newline that
ends the last content line; an injected region's formatted output does not.** So
a single `fenced_code_block` rule emitting `["hard"]` before the closing
delimiter is correct for a formatted child and one line too generous for a
`verbatim` one.

The fixture package leaves it wrong on purpose — it exists to prove the
machinery, and `probe_injection.py` asserts Rust/JS identity rather than
blessing the bytes. The real markdown package has to resolve it. Whether that is
a `when` on the child, a trailing-newline convention for `verbatim`, or the
harness narrowing the content extent is the Markdown round's call; what that
round must not do is discover it from a corpus diff.

Re-splicing in gate 2 does not remove the tension or turn it into a route
mismatch. The clean JSON fence takes the injected path in both rounds, while the
no-info, unknown-language and malformed-JSON fences remain verbatim in both. The
second format still adds one newline to each of those three regions (`+3` bytes
total). The remaining bug is therefore specifically the fixture package's
trailing-newline contract for verbatim content.

What did change is who notices. **Gate 3 now rejects the fixture's own first
format**, because a verbatim region is compared by exact bytes and this one
gained a newline it was supposed to reproduce unchanged. Before this step no
gate could see it at all. So the markdown round does not get to leave this
undecided: the defect is named by gate 3 on the first run and compounds by one
newline per fence per round under gate 2.

### What step 2 settled that step 3 must obey

**The package switches _before_ the stamped node's own rule is looked up.** The
stamped node is therefore the first node of the new region, and the embedded
package must have a rule for **its** type. Stamping `language: "json"` on a
markdown `code_fence_content` asks the JSON package for a `code_fence_content`
rule, which it does not have, and the runtime refuses.

So `gen_trees.py` should splice the embedded parse's **root** node in as the
child and stamp the language on that — a JSON `document`, which the JSON package
does have a rule for. The alternative, a bridge rule in every embedded package
naming the host's node types, couples each guest to every host that might
contain it and is the wrong shape.

**Comment policy follows the region.** Comments inside a stamped subtree use the
embedded package's `comments`, `comment_gap` and `blank_cap`; a comment sitting
outside the stamped node stays with the enclosing language, even when it is
adjacent to the fence. That is the right split, but it means a fence's
surrounding blank lines are the host's business and its interior blank lines are
the guest's — worth stating in the markdown brief so a builder does not discover
it from a diff.

## Structure without layout

Everything above assumes a spliced region is a region the formatter will lay
out again. Markdown's raw HTML blocks are the case where that assumption breaks,
and the capability they needed is worth stating separately: **an injection site
may hand the guest parse to readers and keep the bytes for the host.**

An injection site declares `format = false`. `gen_trees.py` then stamps `opaque`
beside `language`, and both runtimes emit the region's source slice instead of
dispatching to the guest package — after the same subtree check `verbatim`
makes, so a stale offset refuses rather than emitting the wrong bytes. The
highlighter still routes to the guest, which is the whole point: an editor sees
real HTML structure where the block grammar offered only stray anonymous tokens
(a comment arrived as `-`, `-`, `-`, `.`, `-->`), and the formatter does not
touch a byte. An opaque region's package is never loaded, so a host does not
depend on shipping one.

### Why markdown's html blocks ship opaque

Not caution — measurement. Letting the html package format these regions
corrupts them today. The host `html_block`'s extent includes the line terminator
that ends it and the guest `document` rule does not reproduce it, so comments
glue onto the block below: three sites in `comments.md` alone, including
`<!-- own-line comment inside a list… -->- nested`. That is the same
trailing-newline tension recorded above for `code_fence_content`, in the form
where it destroys rather than pads.

Two further things must be answered before `format = false` can become
`format = true` — the `format_html_blocks` opt-in:

- **prettier does not format html blocks in markdown at all.**
  `<div    class="x"   id="y">` and `<table><tr><td>a</td>…` pass through
  prettier@3.9.6 untouched at width 80. Laying them out could only lose
  agreement against the pinned reference.
- **The ERROR guard does not catch fragment splitting.** Under
  tree-sitter-html 0.23.2 an unbalanced open tag parses as a *complete* element
  whenever it carries an attribute: `<div class="x">` is clean and `<div id=a>`,
  bare `<div>`, `<p>` and `</div>` are all ERRORs. So the `<div>`/blank/`</div>`
  wrapper idiom splices its opener as an element that is not one, and refuses
  its closer, with nothing noticing the two belong together.
  `corpus/src/markdown/html_blocks.md` writes both halves down.

### What whole-node injection costs a host

A site with no `content` replaces the host node with the guest root, and the
host's own separator policy then sees a *guest* node type. Markdown must name
`document` in `blank_owner` beside `html_block`, because a spliced region
inherits the swallowed trailing blank the host node had; without both names the
formatter added a blank line after every html block. A site that splices a
*child* — a fence's `code_fence_content` — leaves the block-level type alone and
needs none of this.

Gate 3 has a matching sharp edge. `_extras` bails out on a whole-node region
(`region.content == node`), so such a site contributes no comments of its own;
markdown's html comments stay visible only because `html_block` is *also* in
`comment_kinds`, which is tested first. `harness/test_gate3.py` pins both halves.
Removing the declaration is loud rather than silent — markdown's dropped-comment
count falls 40 → 0 and `check_gate3.py` prints "arm inert" — but the ordering is
load-bearing and was not written down before.

### The defect this surfaced, which is not about HTML

`html_blocks.md` is the corpus's first non-comment html block, and it exposed a
pre-existing runtime bug: **every `blank_owner` node followed by an ATX heading
gains a newline.** `    code\n\n# H\n` reproduces it on `indented_code_block`,
declared since long before this round. No other successor triggers it — a
thematic break, quote, list or second block after the same node are all
byte-exact. It is blank arithmetic in the runtime, not the injection site, and
is recorded as a design limit on `html_blocks.md` at both widths rather than
fixed here; the fix belongs with a slice that can fix `indented_code_block` too.

**The two owners diverge after the first pass, and the difference matters more
than the shared line does.** On an `html_block` the extra newline is emitted
once and the file is then a fixed point, which is why `html_blocks.md` passes
gate 2. On an `indented_code_block` it is cumulative: the block's own extent
swallows the blank line after it -- the very thing `blank_owner` exists to
subtract -- so the next pass sees a longer block and adds another.
`    code\n\n# H\n` measures 15, 16 and 17 bytes over three passes. That is
the non-idempotence class this project treats as worse than any divergence, so
the slice that fixes this is not cosmetic. Measured across `~/w` (2026-09-10):
of 8,444 markdown files, 65 put an indented block immediately before a heading
and 2 of those actually grow.
