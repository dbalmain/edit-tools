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
selects `language()` and this slice does not need the included-range second pass.

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

### 4. Nothing else

Width needs no work. Once the embedded Doc is spliced under the enclosing
`Indent`, the printer measures from the current column exactly as it does for
any other nested group — an embedded block inside a list item wraps at the right
place for free.

**No new opcode.** The markdown package's fence rule is ordinary:

````json
"fenced_code_block": [
  "seq",
  ["child", "t:fenced_code_block_delimiter"],
  ["opt", "t:info_string", ["child", "t:info_string"]],
  ["child", "t:block_continuation"], ["hard"],
  ["child", "*"],
  ["hard"], ["child", "t:fenced_code_block_delimiter"]
]
````

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

- **Gate 3 across a language boundary.** The non-destruction checker compares
  named nodes, and "the grammar's extras" (comments) are per-language. A spliced
  tree has two grammars' extras in it. The generic default probably works
  unchanged; nobody has checked, and given round 1's lesson about gate-3
  overrides certifying themselves, it should be checked adversarially rather
  than assumed.
- **Idempotence across the boundary.** Formatting a markdown file reformats the
  JavaScript inside it. Formatting the result must not change it again — which
  requires the embedded formatter to be idempotent _at the width the fence
  leaves it_, not at its own default width. This is a real new failure mode and
  the corpus must probe it: the same snippet at two indent depths.
- **The reference formatter.** Prettier formats embedded code in markdown, so
  there is ground truth to measure against — but prettier's markdown defaults
  matter enormously here, and one of them is load-bearing (below).

## `proseWrap` decides whether markdown needs `fill`

Markdown was the obvious argument for adding `fill` (paragraph-style wrapping)
to the Doc IR, which `docs/design.md` lists as deliberately deferred.

It may not be. **Prettier's `proseWrap` defaults to `preserve`** — it does not
reflow prose at all by default, only normalises the markup around it. If we
adopt the same default, markdown prose needs no `fill`, and markdown-with-
injection can ship before `fill` exists.

That is worth confirming against the pinned prettier version rather than taken
on trust, because it changes the order of two roadmap items. If it holds, `fill`
is driven by HTML/XML inline content alone, which is round 4.

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
4. Markdown package and corpus, as an ordinary onboarding round with an
   injection-shaped brief. The machinery is now in place; the round adds the
   real markdown manifest (including its host shape), package and corpus, then
   checks gate 3 and idempotence across language boundaries.

Steps 1 and 2 are runtime work and belong to whoever owns the runtime. Steps 3
and 4 are a language round and can go to a builder.

### What step 2 settled that step 3 must obey

**The package switches _before_ the stamped node's own rule is looked up.** The
stamped node is therefore the first node of the new region, and the embedded
package must have a rule for **its** type. Stamping `language: "json"` on a
markdown `code_fence_content` asks the JSON package for a `code_fence_content`
rule, which it does not have, and the runtime refuses.

So `gen_trees.py` should splice the embedded parse's **root** node in as the
child and stamp the language on that — a JSON `document`, which the JSON package
does have a rule for. The alternative, a bridge rule in every embedded package
naming the host's node types, couples each guest to every host that might contain
it and is the wrong shape.

**Comment policy follows the region.** Comments inside a stamped subtree use the
embedded package's `comments`, `comment_gap` and `blank_cap`; a comment sitting
outside the stamped node stays with the enclosing language, even when it is
adjacent to the fence. That is the right split, but it means a fence's
surrounding blank lines are the host's business and its interior blank lines are
the guest's — worth stating in the markdown brief so a builder does not discover
it from a diff.
