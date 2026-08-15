# The runtime's tree is a CST, not a tree-sitter costume

A hand-rolled JSON parser — no tree-sitter, no JSON library on the input — feeds
both unmodified runtimes through the unmodified `packages/json.json`. The trees
it emits are byte-identical to the committed tree-sitter trees. The formatted
output is byte-identical to the tree-sitter path, both runtimes, every JSON
corpus file, both scored widths.

That is the headline. The rest of this document is what a parser author has to
promise, which of those promises are tree-sitter leaking, and whether Aven's
route 1 holds.

Re-run the evidence:

```sh
./harness/probe_tree_interface.py
```

It is also on `./test.sh`. The parser itself is `harness/json_cst.py`.

## Did it work?

Yes. Byte-identical, everywhere the probe measures.

| Check                                            | Result                  |
| ------------------------------------------------ | ----------------------- |
| `basic.json` tree vs `json__basic.tree.json`     | identical (16090 bytes) |
| `nested.json` tree vs `json__nested.tree.json`   | identical (44042 bytes) |
| `scalars.json` tree vs `json__scalars.tree.json` | identical (8224 bytes)  |
| `basic` formatted, rust = js = committed, 88     | identical (351 bytes)   |
| `basic` formatted, rust = js = committed, 60     | identical (351 bytes)   |
| `nested` formatted, rust = js = committed, 88    | identical (553 bytes)   |
| `nested` formatted, rust = js = committed, 60    | identical (705 bytes)   |
| `scalars` formatted, rust = js = committed, 88   | identical (231 bytes)   |
| `scalars` formatted, rust = js = committed, 60   | identical (231 bytes)   |

No diffs. No runtime patch. No package patch. If the probe had only worked after
a runtime change, that change is not in this tree — there was nothing to
describe.

JSON cannot ask about `flatten` or comments. Those are the second half of the
probe, not a second parser: hand-built trees, still no tree-sitter, still the
shipped binaries. Recorded under the named cases below.

## What the runtime required that the tree format does not say

`rust/src/tree.rs` is 36 lines and honest as far as it goes: a node is
`{type, start, end, field?, text?, children?}`. Everything below was discovered
by reading the evaluator, the package, and `gen_trees.py`, then confirmed by the
probe. A parser author working from the tree shape alone would not have it.

### The package and the parser share a vocabulary, not just a shape

Dispatch is `node.type`. There is no fallback. `packages/json.json` was written
against tree-sitter-json's names, so the probe had to emit `document`, `object`,
`array`, `pair`, `string`, `string_content`, `escape_sequence`, `number`,
`true`, `false`, `null`, and punctuation whose type is the spelling (`{`, `}`,
`[`, `]`, `,`, `:`, `"`). A node type with no rule is a refusal.

That coupling is between **this package** and **this parser**. It is not a
runtime requirement that every parser speak tree-sitter-json. Aven writes
`packages/aven.json` against Aven's names. The JSON probe had to impersonate
tree-sitter-json only because the slice forbade changing the package.

### `text` short-circuits the rule table

A node that carries `text` is emitted as that text. No rule is looked up. That
is why `json.json` has no rules for `number`, `true`, `false`, `null`, or any
punctuation token: they are leaves. A node that carries both `text` and
`children` is treated as a leaf; the children are dropped on the floor. The
comment in `tree.rs` ("never both") is a convention the evaluator does not
enforce.

### `tok` matches `text`; `named` matches `type`

`["tok", "{"]` accepts any child whose `text` is `{`, regardless of `type`.
`named` (and comment attachment's "is this punctuation?") consult the package's
`tokens` list, which is a set of **types**. The existing packages set type equal
to spelling for every anonymous token. A parser that emits
`type: "lbrace", text: "{"` will satisfy `tok` and then surprise `each named`,
because `lbrace` is not in `tokens` and so is content.

`named` is not tree-sitter's `is_named` flag. The flag is not in the tree. The
package's `tokens` list is the whole definition.

### Punctuation is children; whitespace is gaps; comments are children

The evaluator has no whitespace-skipping. A child whose type is not in
`comments` is an item the rule must consume. The probe inserted a `ws` child
into `{ }` and the runtime refused: `rule for \`object\` wants the token \`}\`
but found \`ws\``.

Comments are the other extra: they must arrive as ordinary children, in source
order, with a `type` listed in the package's `comments` and a `text`. Attachment
is a pre-pass that counts newlines in `source[prev.end : child.start]`. There is
no trivia channel, no leading/trailing list on the node, no side table. The
probe built `aaa\n# c\nbbb\n` two ways: with the `# c` child, the comment is
printed; without it, the same source produces `aaa\nbbb\n`. The bytes are
sitting in `source`. The runtime will not go looking.

### Offsets are UTF-8 bytes, and `source` is load-bearing

`start`/`end` index `tree.source` as bytes. `é` in `basic.json` is two bytes;
`🙂` is four. Character offsets would fail `verbatim`'s leaf-text check (`text`
must equal `source[start..end]`) and would slice the wrong span when `verbatim`
emits.

`source` is not documentation. `verbatim` emits `source[node.start..node.end]`.
`blank` counts `0x0a` bytes in the gap. Without `source` the field defaults to
`""` and both refuse or silently do the wrong thing. `source_file` is
harness-only; the runtime ignores it.

### The root spans the whole buffer

tree-sitter's `document` node covers the trailing newline; the value child does
not. The probe copied that because the committed trees do. The runtime does not
require it. A root that ends on the last `}` formats the same JSON. What the
runtime does require is that every offset it is asked to slice is in range.

### Children do not have to tile the parent

This is the guess that was wrong. `verbatim` checks:

- no inverted range
- every descendant sits inside its parent
- siblings are ordered and disjoint (overlap refuses; a gap does not)
- every leaf's `text` equals `source[start..end]`

It does **not** check that children cover `[start, end)`. The probe built `"hi"`
as a `quote` node whose only children are the two quotes; the letters sit in the
hole. `verbatim` emitted `"hi"`. JSON already lives this way: every space and
newline in the corpus is a gap, not a child.

Non-`verbatim` rules never look at coverage either. They walk the child list.
Uncovered bytes are simply not tokens.

### `flatten` hardcodes three field names

The opcode walks `field == "left"` to build the spine, then consumes `f:left`,
`f:operator`, `f:right`. Those strings live in `rust/src/eval.rs` and
`runtime-js/bundle.js`. They are not package data. A well-named left-nested
`aaa + bbb + ccc` formats, both runtimes, flat at 80 and broken at 4. The same
tree with the fields renamed `lhs`/`rhs`/`op` is refused: `rule for \`sum\`
wants Field("left") but found \`sum\``.

There is no package rewrite that saves it. The names are in the opcode.

### Field names everywhere else are a package choice

JSON's `pair` rule is `["child", "f:key"]` … `["child", "f:value"]`. Strip every
`field` from a probe tree and the original package refuses: `rule for \`pair\`
wants Field("key") but found \`string\``. Rewrite those two selectors as`named`
and the stripped tree formats byte-identical to the field-bearing path.

So: a parser that produces no field names at all is fine, provided the package
never writes `f:…` and never uses `flatten`. JSON happens to write `f:…`. Python
happens to use `flatten`. Those are package facts, except for the three names
`flatten` will not let the package change.

### Linearity is total

Every non-comment child is consumed, in order, exactly once. Skipping,
revisiting, and reordering are not in the language. A rule that stops early
refuses with `left child … unconsumed`. A parser that emits an extra node the
rule does not mention (whitespace, a wrapping `value`, an `ERROR`) is a refusal,
not a skip.

### `string_content` / `escape_sequence` are costume

Matching the committed trees forced the probe to split strings the way
tree-sitter-json does. Formatting does not need it. `string` is `["verbatim"]`.
A string that is a leaf with `text`, or an interior with no children and a
correct span, emits the same bytes. The three-child quote shape is what
tree-sitter-json looks like, not what the runtime demands.

## Which of those are tree-sitter leaking?

**The runtime does not name a tree-sitter type.** No `is_named`, no `is_extra`,
no `is_missing`, no node id. The JSON costume in `tree.rs` is a CST: kind, span,
optional field, leaf text or children.

The leaks that exist are conventions, and one hardcoded opcode:

| Fact                                                       | Leak or CST?                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Node type is a string the package dispatches on            | CST                                                                           |
| Byte spans into a carried `source`                         | CST                                                                           |
| Children in source order; linearity                        | CST                                                                           |
| `named` = not in `tokens`                                  | CST (and specifically _not_ tree-sitter's flag)                               |
| Punctuation type equals its spelling                       | **leak** — tree-sitter anonymous nodes. `tok` vs `named` make it load-bearing |
| Whitespace is a gap, never a child                         | **leak** — tree-sitter extras. A parser that reifies layout nodes refuses     |
| Comments are in-order children of listed types             | **leak** — tree-sitter named extras. Roslyn-style trivia is silently lost     |
| `flatten` looks up `left` / `right` / `operator`           | **leak** — tree-sitter-python's field names, baked into both runtimes         |
| Other `f:…` selectors                                      | package vocabulary, not a runtime leak                                        |
| `document` / `pair` / `string_content` / `escape_sequence` | package vocabulary. The probe wore it; Aven will not                          |

"None of it leaks" is the wrong verdict. Three things leak, and one of them
(`flatten`'s field names) cannot be papered over in a package. The other two are
conventions a parser can honour without being tree-sitter: emit punctuation with
type == text, keep whitespace out of the child list, reify comments as children.
That is a CST dialect, not a tree-sitter binary interface.

## What would break for a parser that does not work like tree-sitter

**A parser that produces no `field` names.** JSON's current package refuses on
`pair`. A package written with `named` / `t:…` / `*` does not. `flatten` still
refuses, and no package change fixes that. Python onboards onto `flatten`; a
Python-shaped Aven operator chain would have to emit `left` / `right` /
`operator` or give up the opcode and accept staircases.

**A parser whose children do not tile the parent.** Nothing breaks. Gaps are how
this system represents whitespace. `verbatim` allows holes; it refuses overlaps,
inverted ranges, descendants outside the parent, and stale leaf text.

**A parser that reifies whitespace or indent as children.** Refusal. The rule
does not mention those nodes. Layout-sensitive Aven cannot ship its indent
tokens as children unless the package consumes them, and the IR has no opcode
for "skip this". They have to become gaps, the way tree-sitter extras do.

**A parser that attaches comments as trivia.** The comments vanish. The source
still contains them; gate 3 will fail; the runtime will not complain. This is
the dangerous one, because it is silent.

**A parser that uses character offsets, or UTF-16 units.** `verbatim` refuses as
soon as a non-ASCII leaf appears (`é`, `🙂`). `blank` counts the wrong newlines
if a multi-byte character sits in a gap, which is rarer but real.

**A parser that omits punctuation children.** `tok` refuses. A parser that omits
the quotes under `string` is fine, because `verbatim` does not need them.

**A parser whose operator nodes are not left-nested with those three fields.**
`flatten` either does not walk the spine (and then refuses looking for `f:left`)
or walks a different shape than the language's associativity and splits in the
wrong places. The second failure is already documented for tree-sitter-python's
bitwise operators versus CPython. Aven's user-declared operators are a further
problem: the precedence table is package data, loaded once, not per file. That
is outside the tree interface, but it is the next thing route 1 hits.

**`flatten` needs** a left-nested same-`type` spine, each node carrying `left` /
`operator` / `right`, the operator a leaf whose `text` is a key in `precedence`
if tightness should stop the walk, and no comment attached to an operand the
opcode will `skip`. A non-tree-sitter parser that builds a flat `operands[]` +
`operators[]` (comparison operators in Python already look closer to that)
cannot use `flatten` without first reshaping the tree.

## Verdict on Aven's route 1

A bespoke parser can feed this runtime. It has to promise a JSON CST of
`{type, start, end, field?, text xor children}`, UTF-8 byte offsets into a
carried `source`, children in source order with punctuation present and
whitespace absent, comments reified as children of the types the package lists,
and — only if the package uses `flatten` — a left-nested spine labelled `left` /
`operator` / `right`. It does not have to impersonate tree-sitter, tile children
onto parent ranges, or set any named/anonymous flag. Write `packages/aven.json`
against Aven's own node types; do not invent a tree-sitter-json dialect for a
language that will never have that grammar. The tree interface is general. The
one runtime change I would not apply, but would flag before fifteen languages
land on it, is that `flatten`'s three field names belong in the package header
next to `precedence`, not in both evaluators. Aven's custom operators are a
different question and this probe does not answer it.

## Pushback on the probe itself

Matching the committed trees byte-for-byte is a stronger bar than "the runtime
accepts this CST", and it is slightly the wrong bar. It proves we can wear
tree-sitter-json's costume, which Aven will never need to do. The honest test of
route 1 is: emit any well-formed tree plus a package written for it. The JSON
slice forbade changing the package, so the parser had to speak that dialect.
That is why the second half of the probe is hand-built trees against tiny
packages — that is the shape Aven actually is.

A second full-language parser (a hand-rolled fragment of Python, say) would
mostly show we can impersonate a second grammar. It would not change the
flatten/comment/trivia findings, which are already measured. I would not run it.

What I did not determine: whether Aven's live parser can be made to emit this
shape without a lossy adapter; whether its comments are already children or
trivia; whether its operators are a left-nested binary tree or a flat list;
whether a layout-sensitive parse produces indent nodes that would have to be
stripped. Those are questions for `aven-lang`, not for this runtime.

## Done-note

Established: a parser that is not tree-sitter can produce the exact tree this
runtime consumes, and both runtimes will format it identically to the
tree-sitter path. No runtime change was required.

Surprised: how little of tree-sitter-json's CST the runtime actually uses.
`string_content` / `escape_sequence`, the `document` wrapper, and exact root
spans are costume. `verbatim` does not require tiling. Fields are optional if
the package says so. The thing that is _not_ optional, and that I did not expect
to be hardcoded in the opcode, is `flatten`'s three field names.

Could not determine: anything about Aven's own parser. The route is open.
Whether Aven can walk it is a question for that codebase.
