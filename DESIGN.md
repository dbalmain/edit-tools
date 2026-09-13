# The package is a Doc program indexed by node type

A language package is a table from **node type** to a **Doc-building
expression**. The runtime is a recursive tree-walker that evaluates the
expression for a node against that node's own children, plus a Wadler/Prettier
printer. There is no query engine and no matching: dispatch is a hash lookup on
`node.type`.

```
packages/python.json      the whole of Python: 77 rules, no code
packages/json.json        the whole of JSON: 5 rules
rust/src/                 the Rust runtime  (~1000 lines with tests)
runtime-js/bundle.js      the JS runtime, one file, no dependencies
```

Adding a language means writing one JSON file. It does not mean touching either
runtime — that is the property the design is built to hold, and the packages
here are the evidence: their rules use the same small Doc language.

```sh
./build.sh          # compiles the Rust runtime; the JS runtime needs no build
./test.sh           # both unit suites, then the harness scorer
./fmt-rust corpus/trees/python__calls.tree.json 88
./fmt-js   corpus/trees/python__calls.tree.json 88
```

## The rule language

An expression is a JSON array whose first element is the opcode. The set is
small and closed — **twenty-nine opcodes**, listed in the tables below — and an
unknown opcode is a load-time refusal in both runtimes. `rust/src/pkg.rs`'s
`Expr` loader and `runtime-js/bundle.js`'s `validateExpr` are the contract;
this document explains it and has drifted behind it before.

Repeated rule shapes can be named in `defs` and instantiated with `use`:

```json
"defs": {
  "bracketed_list": [
    "group", ["tok", ["$", 0]],
    ["indent", ["soft"],
      ["each", "named", ["seq", ["tok", ["$", 1]], ["line"]]],
      ["trail", ["$", 1], "named"]],
    ["soft"], ["tok", ["$", 2]]
  ]
},
"rules": {
  "list": ["use", "bracketed_list", "[", ",", "]"]
}
```

`["$", n]` is a positional hole for an arbitrary JSON value, so it can stand for
a token, a selector or a whole expression. Both runtimes expand `use` on the raw
JSON at package load, before checking the resulting expressions. The evaluator
therefore knows nothing about macros: expansion can only produce the same
checked opcodes it could already evaluate. Definitions may use other
definitions, but cycles and nesting beyond 32 definitions are refused, as are
unknown names, bad argument counts and holes outside a definition body.

### Layout

| Opcode                | Meaning                                                      |
| --------------------- | ------------------------------------------------------------ |
| `["seq", e…]`         | concatenation                                                |
| `["group", e…]`       | one layout decision: all-flat if it fits, else broken        |
| `["indent", e…]`      | one indent level deeper (`indent` in the package header)     |
| `["prefix", sel, e…]` | consume the `sel` child and indent `e…` by *its* source text |
| `["line"]`            | a space when flat, a newline when broken                     |
| `["soft"]`            | nothing when flat, a newline when broken                     |
| `["hard"]`            | always a newline; forces every enclosing group open          |
| `["sp"]`              | a space, never a break                                       |
| `["blank", n]`        | up to `n` blank lines, as the source had them; see below     |
| `["srcgap"]`          | exact horizontal source whitespace flat, newline broken      |
| `["srcline"]`         | a space, or a newline where the source broke the line        |
| `["srcsoft"]`         | nothing, or a newline where the source broke the line        |
| `["srcbreak"]`        | a `line`, or a hard newline where the source broke it        |

`["blank", n]` takes an optional third operand, a list of node types. A gap next
to one of those types opens to exactly `n` — the cap is also a floor, but only
there. `module` passes the definition types at 2, `block` the same list at 1,
which is black's depth rule with no extra concept.

The previous item's contribution to that gap is **not always `node.end`**. A
grammar may let a node swallow the line ending that terminates it — tree-sitter
markdown's `atx_heading` does, and so does tree-sitter-go's `statement_list` —
and measuring from `node.end` then counts one newline too few, so a source blank
line reads as no gap at all. The runtime measures from the node's **content
end**: at most one trailing line terminator (LF, CR or CRLF), plus the
horizontal whitespace on either side of it. The bound is the point. Walking back
to the last non-whitespace byte is wrong, because some grammars swallow the
*following blank run* as well and that run is already visible as trailing blanks
at the end of the node's own rule; peeling it would count the same blank twice.
One terminator is the unique amount that separates the two shapes.

It also takes an optional fourth operand, a list of exact leaf spellings after
which the source gap must not be capped. This is for syntax whose semantic
whitespace lives outside the declaring CST node: tree-sitter-yaml ends a `|+`
block scalar before the trailing newlines that keep-chomping makes part of its
value. The YAML mapping rule names only `|+`, so ordinary inter-pair whitespace
still follows the one-blank layout policy.

### Children

Every opcode that emits a child **consumes** it. See _linearity_ below.

| Opcode                   | Meaning                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `["child", sel]`         | format the child under the cursor, which must match `sel`                                                          |
| `["each", sel, sep]`     | format every `sel` child in turn, evaluating `sep` between them — `sep` consumes whatever punctuation lies between |
| `["fill", sel, sep]`     | `each`, but each `sep` independently stays flat or breaks according to whether the next content fits               |
| `["tok", "s"]`           | the child under the cursor is the token `s`; emit it                                                               |
| `["opt", sel, e]`        | evaluate `e` only if the child under the cursor matches `sel`                                                      |
| `["verbatim"]`           | take every child and emit the node's original source text, exactly — after the subtree's offsets check out         |
| `["flatten", type, sep]` | collect a left-nested operator chain and join it — see below                                                       |
| `["drop", "s"]`          | consume the token `s` without emitting it, if it is there — the only sanctioned deletion                           |
| `["srctrail", "s"]`      | adopt a source separator and emit it only when what follows starts a fresh line                                    |
| `["table"]`              | take every child and lay the node out as an aligned pipe table — the third sanctioned mutation, see below          |

`fill` has the same cursor and separator-consumption contract as `each`, but
builds an alternating content/separator Doc. At each separator the printer asks
whether the current and next content fit flat on the remaining line. If both
fit it keeps the separator flat; if only the current content fits it breaks the
separator; if the current content itself cannot stay flat it prints that
content broken too. A `Hard` or `BreakParent` still propagates through a fill to
force its enclosing group open; that does not turn the fill back into an
all-or-nothing list. One separator is not free to stay flat, though: **a
separator with a trailing comment queued in front of it breaks.** Every suffix
is emitted with a `BreakParent`, so everywhere else a queued suffix already
means a broken group; the fill separator is the only one that picks its mode
without consulting that, and letting it stay flat flushes the comment after the
next item — inside it, when that item leads with a line comment.

#### Prose needs source atoms before it can use `fill`

`fill` selects direct children; it does not inspect or split a child's text.
Markdown's block grammar leaves words in gaps between anonymous delimiters, or
in one `inline` leaf. `paragraph` and `inline` currently use `verbatim`; a leaf
also emits its `text` before rule dispatch. Neither path can expose word-sized
Docs to `fill`. Selecting the delimiter children would omit the words.

Measured with Prettier 3.9.6 `--prose-wrap always`, the unchanged 20-file corpus
falls from 27/32 to 8/32 comparable cases (13/16 to 7/16 at 80; 14/16 to 1/16
at 40). This is a real design limit, not an unwritten package rule. The inline
grammar adds `emphasis`, `inline_link` and `code_span`, but still hides words;
an included-range second pass alone is insufficient. Emphasis can itself wrap,
so treating every markup subtree as an indivisible atom is insufficient too.

No new opcode or header field is added here: the count stays 29 and the three
sanctioned mutations stay unchanged. A future source-range projection could
expose words and protected spans while keeping `fill`'s contract. Slicing
validated source bytes does not inherently invent tokens, so this need not be
a fourth token mutation, but it is a new capability requiring an explicit
provenance and break-safety contract. A delimiter heuristic inside the runtime
would make the runtime a partial markdown parser; that shape is declined.

The measurement also exposed a prerequisite in the harness: gate 3 rejects 20
of the reflowing reference outputs. Prose gaps, continuation markers and HTML
comment placement need a justified equivalence before the live reference can
switch. `layout_leaves` or blanket whitespace normalization would also relax
code-span or hard-break semantics and cannot stand in for that work. The live
reference remains `preserve`; the measurements and remaining design work are in
[`corpus/reports/markdown/prose-wrap.md`](corpus/reports/markdown/prose-wrap.md).

The follow-up [source-projection proposal](docs/prose-projection.md) describes
an explicit partition into source atoms and whitespace leaves. Existing `fill`,
`verbatim` and `whitespace_nodes` can render that view, including breaks inside
emphasis. A composition probe in both runtimes also exposed the missing
guarantee: source validation checks existing children, not exhaustive coverage
of their parent. The proposal therefore requires generic partition validation
before consumption, with a versioned package declaration. The header that
check needs, `source_partitions`, ships in package format 3. The projection
parser does not; the opcode count and mutation policies above are unchanged.
`harness/prose.py` and its JavaScript mirror now build that view for the **A1**
subset -- plain top-level paragraphs, decided from the block grammar alone --
and `harness/probe_prose.py` gates it. That is a harness capability, not a
runtime or package one: no shipped package declares `source_partitions`, the
markdown package is still format 2, and it still emits paragraphs `verbatim`.
Safe break classification and an independent gate equivalence remain
prerequisites, not consequences of preserving source bytes.

A language region may also be spliced **for readers only**. An injection site
declaring `format = false` makes the harness stamp `opaque` beside `language`,
and the formatter then emits the region's source bytes rather than dispatching
to the guest package — after the same subtree check `verbatim` makes, so a stale
offset refuses instead of emitting the wrong bytes. The highlighter is
unaffected and still uses the guest, which is the point: an editor gets real
structure where the host grammar offered none, and the formatter keeps its
hands off. An opaque region's package is never loaded, so a host does not
depend on shipping one. This adds no opcode and no fourth token mutation — the
bytes emitted are exactly the bytes read.

Markdown's `html_block` is the first user, and it records what whole-node
injection costs a host. Replacing the host node with the guest root means the
host's own separator policy now sees a *guest* node type: markdown must name
`document` in `blank_owner` alongside `html_block`, because a spliced region
inherits the swallowed trailing blank the host node had. Splicing a child (a
fence's `code_fence_content`) leaves the block-level type alone and needs no
such thing.

The four `src*` opcodes mirror the **source's own line structure** rather than a
group's fit, and they are what a source-preserving reference needs. `srcline`,
`srcsoft` and `srcbreak` ask only whether the source put a line break before the
child under the cursor; `srcgap` reads the whitespace itself. Go uses three of
them, JavaScript one, Scheme is built almost entirely out of two, and HTML's
`srcgap` is the one that reads bytes rather than a flag. A reference that
reflows — black, prettier, rustfmt — should not reach for these; a reference
that only re-indents cannot be expressed without them.

Source breaks also matter when a subtree ends with the *next* line's marker.
A markdown list item can own the `> ` before the following paragraph. Emitting
that marker in tree order is correct; an unconditional `hard` after the list
would separate the marker from its paragraph. The quote's separator uses
`srcsoft`, which sees no source newline between that marker and the paragraph.
The item's trailing marker also uses `srcsoft` instead of `blank`: it needs the
line terminator before the marker, not a count of blank lines. No cross-sibling
token transfer or Doc inspection is needed (FINDINGS 35).

`["drop", "s"]` is the mirror of the linearity invariant that forbids inventing
token text: it deletes one **declared-punctuation** token, refuses on a named
node, and refuses if the token carries a comment. Ruby uses it to turn
`x = 1; y = 2` into two statements.

`["cell"]` and `["cellblock", e…]` mark column positions for the alignment pass
in `rust/src/align.rs`, which the `comment_cells` header field scopes. They are
not layout in the Wadler sense and a package that does not align uses neither.

`["group", 0.18, e…]` takes an optional leading fraction: the group must fit
within that fraction of the width, not the whole of it. rustfmt's nine widths are
what forced it.

### Choice

| Opcode                       | Meaning                                             |
| ---------------------------- | --------------------------------------------------- |
| `["when", pred, then, else]` | a static test on the node                           |
| `["trail", "s", sel]`        | the trailing-separator policy — see below           |
| `["paren", e…]`              | the balanced-paren policy — see below               |
| `["autoparen", sel]`         | `paren` applied to a child, if its type asks for it |
| `["cell"]`                   | a column marker for the alignment pass              |
| `["cellblock", e…]`          | the region a column of `cell` markers may align in  |

Selectors pick a child: `"f:name"` (tree-sitter field), `"t:identifier"` (node
type), `"named"` (any type not listed in the package's `tokens`), `"*"`. The
direct-child predicate is `["count", sel, n]`;
`["child-count", parent-sel, child-sel, n]` counts the direct children of the
selected child; `["all", sel, [kinds…]]` is true when every `sel` child has a
type in `kinds`, including when there are none — "all" is universal, and a
package that wants "at least one" composes with `count`. All three describe the
node, not the cursor. YAML uses `child-count` to distinguish a value
`block_node` whose direct child is a block scalar from the same wrapper around
a nested mapping or sequence, without making rule selection depend on comment
decoration. JSON uses `all` to apply `fill` only to numeric arrays.

Two path predicates inspect leaf content without turning dispatch into an
unbounded descendant search. `["text", [sel…], [spellings…]]` is true when an
exact direct-child selector path ends at a leaf with one of the listed
spellings; `["multiline", [sel…]]` tests the same path for a leaf containing a
line ending. Paths must be non-empty. HTML uses
`["t:start_tag", "t:tag_name"]` to select block versus inline layout and
`["t:text"]` to preserve multiline `pre` content. An outer inline tag does not
accidentally become block merely because a deeper nested element is block.

### The package header

```json
{
  "format": "et-doc-rules/1",
  "indent": 4,
  "comment_gap": 2,
  "blank_cap": 2,
  "tokens": ["(", ")", ",", ":", "and", "or", "def", …],
  "comments": ["comment"],
  "descend": ["block"],
  "gap_owner": { "list": ["list_item"] },
  "optional_parens": ["binary_operator", "boolean_operator", …],
  "precedence": { "|": 9, "^": 8, "+": 5, "*": 4, … },
  "rules": { … }
}
```

`format` is required. Both runtimes accept `et-doc-rules/1`,
`et-doc-rules/2` and `et-doc-rules/3`, refusing other values by name. Version 2
adds the `whitespace_nodes` declaration below; version 3 adds
`source_partitions`. The 29 opcodes are the same in all three. Packages using
`whitespace_nodes` must say version 2 or later, including an empty list;
packages using `source_partitions` must say version 3, including an empty list.
The markdown package uses version 2; older runtimes refuse it at load instead of
silently ignoring its layout policy. Existing version 1 packages keep their
behaviour.

That protection covers the format string and the opcode set -- an unknown
opcode refuses by name. It does **not** cover header fields. Neither loader
sets `deny_unknown_fields`, so a header field an older runtime does not know
is dropped and the package formats with that field's default, exiting 0.
Measured 2026-08-28: `gap_owner` (markdown) and `tab_stop` (scheme) both
silently mis-format against a runtime built the day before the field landed.
A new layout-affecting header field therefore needs a format-string bump to
be safe; the format check cannot do it on the field's behalf.

`tokens` is the one language fact the runtime cannot guess: which node types are
punctuation and keywords rather than content. `named` is defined as "not one of
these". `comments` and `descend` drive comment attachment; `optional_parens` and
`precedence` drive `autoparen` and `flatten`. The field names `flatten` walks
default to `left` / `operator` / `right`; a package whose parser uses different
ones says so in `flatten_fields`, next to `precedence`.

`gap_owner` names, for one parent type, the child types whose **following**
source gap that parent owns. It exists because a blank line can sit *inside* the
previous sibling's subtree rather than between the siblings: tree-sitter-markdown
keeps the blank that makes a list loose inside the preceding `list_item`, below
where the runtime's one-terminator bound reaches. For a declared pair the gap is
measured to that child's deepest non-empty descendant; every other consumer keeps
the shallow bound.

The reason this is a package fact rather than a runtime constant is measured, not
assumed. Peeling deeper *globally* — at depth 2, 3, or unbounded — is worse than
peeling one terminator, and worse for markdown itself, not merely as a trade
against TOML. One source blank becomes visible to a rule, to its parent's
separator, and to the floor above that, and every one of them renders it. So the
question is never how deep to look; it is which single rule may spend the gap,
and only the package knows, because only the package knows what its rules emit.

The node's own **trailing** blank measure always keeps the shallow bound, which
is what stops a node and its parent claiming the same newline. FINDINGS 30.

`comment_gap` chooses how many spaces precede a trailing comment, and
`blank_cap` limits the source blank lines preserved next to a comment. Both
default to 1 because prettier is the reference for most languages on the roster;
black is the outlier, so Python asks for 2 explicitly. They are bounded counts,
not strings, because packages may choose whitespace quantities but may not emit
arbitrary text. `blank_cap` applies only inside runtime-owned comment
attachment; the `blank` opcode's operand still governs gaps between items
visible to a rule.

`source_partitions` is a version 3 package fact: a list of node types that are
an exact partition of their own source range. Wherever a named type appears,
the first child starts at the node's `start`, each subsequent child starts at
the previous child's `end`, the last child ends at the node's `end`, and every
child is non-empty. A childless declared node is allowed only when `start ==
end`. The check runs on entry to the node, before the leaf return, before
whitespace-trivia consumption, and before any Doc is built, and it is in
addition to the existing source-range walk: a declaration cannot weaken a check
that already exists. Ordinary CST nodes legitimately contain source their
children do not cover, so this is never a global tree invariant. No shipped
package declares it yet.

The declaration must be a list of strings. It must not overlap `comments` or
`whitespace_nodes`. Duplicates are set membership, as with those fields.

`whitespace_nodes` is a version 2 package fact: a list of node types whose
**whitespace-only leaves** are gap trivia. Markdown declares `["section"]`.
The runtime consumes those direct children before comment attachment, without
advancing the previous content end. The next real item therefore measures one
gap spanning their bytes, and `each` puts just one separator in that gap. Leading
trivia has no preceding item and creates no separator. `blank` still decides
the quantity; this field supplies no cap or floor of its own.

The declaration alone cannot delete content: only a leaf with text consisting
entirely of space, tab, LF, CR or FF qualifies. Empty text qualifies too. A
non-whitespace leaf or an interior node of the same type remains an item;
an injected language root is never consumed by the host's declaration. Before
consuming trivia, the runtime checks the containing subtree's ranges, ordering,
and leaf text against the source, using the same validation as `verbatim`.
The declaration must be a list of strings and must not overlap `comments`.
Comments attach across this trivia to real items, preserving their order and gaps.

This is a language fact, like `tokens` or `comments`: a package must not declare
whitespace-bearing syntax whose bytes carry meaning as gap trivia. It is not a
fourth sanctioned token mutation. No non-whitespace token is dropped, invented,
moved or rewritten, and the input tree is unchanged. The runtime's item view
accounts for consumed trivia just as it already accounts for attached comments.
Unlike a Doc-emptiness predicate, this cannot erase a subtree because its rule
happened to emit nothing. FINDINGS 36 needed ownership of source whitespace,
not a separator that inspects Docs already built.

The harness has its own `whitespace_nodes` manifest declaration, independently
checked against reparsed source. Its only new equivalence is inserting or
removing a declared whitespace-only leaf; meaningful nodes and injection
boundaries remain structural, and the universal comment comparison stays on.
This was required because gate 3 rejected Prettier's removal of a leading
empty section in `leading_sections.md`. `layout_leaves` is insufficient:
it normalises a leaf's spelling but still requires the leaf to exist.

`indent` is how many spaces one level writes. Two header fields override that
spelling and they answer different questions, so a package that sets both is
refused rather than reconciled. `tab_indent` makes one **level** a tab, which is
gofmt's house style. `tab_stop` leaves the levels alone and respells the
**column** they add up to, as tabs to the stop plus residual spaces — emacs
`scheme-mode` with `indent-tabs-mode` `t` writes column 8 as one tab and column
9 as a tab and a space, and no per-level unit produces that. Respelling happens
once, where the printer writes an indent after a newline, and only when the
whole column is spaces: a nested language region may have concatenated a tab
unit of its own, and that column is not ours to guess. The measured column never
moves, so nothing the printer already decided changes. `tab_stop` is also
refused alongside `comment_cells`, because the alignment pass counts characters
in the rendered line and a tab is one character spanning several columns. Both
runtimes accept only a non-negative **JSON-safe** integer: `Number.isInteger`
admits values Rust's integer deserialisation rejects, and a package that loads
in one runtime and refuses in the other is a parity break no corpus can see.

`prefix` is the one place a package chooses an indent unit from the *source*
rather than from the header, and it exists because a host construct can own a
per-line marker that the guest inside it has never heard of. A fenced code block
inside a markdown list or block quote carries `    ` or `> ` on every line;
tree-sitter puts that marker in the tree as a `block_continuation` leaf, the host
emits it once, and then an injected guest reflows the body into lines the host
document never contained. `["prefix", sel, e…]` consumes the `sel` child and
indents `e…` by that child's own text, so every line the body emits — including
lines the guest invents after the host has stopped looking — carries the marker.

This is not a new mechanism: `Doc::Indent` has always carried a **string** unit
rather than a column count, which is how a gofmt region nests a tab-indented body
inside a space-indented one. `prefix` picks the string out of the tree instead of
the header. Prefixes concatenate exactly as indent levels do, so a fence inside a
quoted list carries both markers.

Zero matches is an empty prefix that consumes nothing, so one rule serves a fence
at the top of a document and a fence four lists deep without a `when`. Three
things refuse, all because the child is consumed without being emitted: a marker
carrying a comment (the comment would be lost — the same guard `drop` carries),
an interior node rather than a leaf, and a marker spanning a line ending, which
would write a newline the printer never measured. A `verbatim` body cannot be
double-prefixed, because `verbatim` emits one text node holding its own newlines
and the printer only writes an indent at a break it issued itself.

`srcgap` is the safe source-aware exception to fixed whitespace. It reads the
gap between the children on either side of the cursor. An empty gap emits
nothing and offers no break; horizontal whitespace is preserved byte-for-byte
when flat and becomes a newline when its group breaks; a source newline remains
a hard break. A non-whitespace gap is a refusal, so an omitted grammar token can
never be erased through this opcode. HTML needs all three cases because its
grammar omits rendering-significant inter-element spaces.

### A rule, read end to end

Python's argument list:

```json
[
  "group",
  ["tok", "("],
  [
    "indent",
    ["soft"],
    [
      "group",
      ["each", "named", ["seq", ["tok", ","], ["line"]]],
      ["trail", ",", "named"]
    ]
  ],
  ["soft"],
  ["tok", ")"]
]
```

The outer group decides whether the brackets break. The inner group decides,
separately, whether the arguments go one per line. `each` walks the argument
children, and its separator consumes the real `,` children sitting between them.
Nothing here mentions comments, blank lines, or the magic trailing comma — those
are the runtime's or the policies'.

The list, set and dict rules instantiate `bracketed_list` with different
brackets; the tuple definition reuses it behind the one-item arity guard.
`parameters` and `argument_list` share `parenthesized_arguments`, whose extra
inner group is exactly black's rule: a call or a `def` splits its brackets first
and its arguments only if it must, while a collection literal that splits at all
splits one element per line. That the distinction is expressible as "one group
or two" — rather than as a flag — is still the strongest evidence I have that
the IR is at the right altitude. Writing five copies of the one-group expression
was not evidence of anything, though; naming the shape keeps the IR fact visible
without making a contributor diff near-duplicates to discover it.

Macros are deliberately not a size optimisation. Measured as compact JSON, the
Python package moved from 7,994 to 7,409 raw bytes (down 7%), but from 1,603 to
1,693 gzipped bytes (up 6%, or 90 bytes, using the scorer's compressor). gzip's
LZ77 window had already deduplicated the repeated expressions; `defs` adds a
name layer it must also encode. Across the scored JavaScript runtime and both
packages, the change is larger: 8,272 to 10,196 gzipped bytes (up 23%, or 1,924
bytes). The packages account for 93 of those bytes; the other 1,831 are the
JavaScript load-time expander and operand validator that keep its refusals
aligned with Rust's eager parser. The compressed-size cost buys both that
agreement and a package that states its recurring language shapes directly.

Expansion is memoised on the package object, and that is not a
micro-optimisation — it corrects the _shape_ of the cost. Rust expands once in
`Package::load` and formats against a reference, while the JS entry point takes
a raw parsed package, so without memoisation every `format` call re-expanded and
re-validated all 77 rules. That is work proportional to the package, charged per
file: measured, it doubled the per-call cost of the smallest corpus tree (0.060
→ 0.137 ms) and added 63% across the twelve Python trees. Memoised, the same
runs sit at 0.067 ms and +14%, and what remains is the `verbatim` subtree walk
rather than the macro layer. A throw is never cached, so a malformed package
refuses on every call and not only the first.

## The three mechanisms that carry the design

### 1. `flatten`, and why a per-node fold fails without it

`a and b and c and d` parses as a left-nested tree. A naive fold gives nested
groups, so the innermost breaks first and you get a staircase. Black instead
breaks every operator in a chain together.

`["flatten", "boolean_operator", sep]` walks the left-hand spine collecting
same-type nodes into one flat list, then joins them with `sep` — which is itself
an expression, so it emits each node's own operator:

```json
[
  "group",
  [
    "flatten",
    "binary_operator",
    ["seq", ["line"], ["child", "f:operator"], ["sp"]]
  ]
]
```

Two refinements the proposal did not have:

- **It stops when the operator binds tighter.** `((a * b) + c) - d` must split
  at `+` and `-` but not at `*`. The spine walk compares `precedence` and stops
  where it changes. Without this, `long_lambda` in `misc.py` staircases.
- **The chain adds no indent of its own**, so a nested chain of looser
  precedence breaks at the _same_ column as its parent. That single decision is
  what reproduces black's recursive `delimiter_split`: the outer chain breaks,
  the resulting line is still too long, the inner chain breaks into it.

The spine's field names are the other input `flatten` cannot guess, and they
belong next to `precedence`, not in the evaluators. They default to `left` /
`operator` / `right` — tree-sitter-python's names, and what a package that
says nothing already gets. A parser that says `lhs` / `op` / `rhs` writes

```json
"flatten_fields": { "left": "lhs", "operator": "op", "right": "rhs" }
```

and the opcode walks those. They are not operands of `flatten`. Putting them
on the opcode would let one package flatten two differently-labelled spines,
but the construct that looks like a second shape — Python's
`comparison_operator` — is a flat operands/operators list, not a left-nested
spine, and `each` already formats it. The header is the same kind of fact as
`precedence`: one vocabulary per language. Adding three operands to every
`flatten` call would have made the IR louder for a need nobody has.

### 2. Two policies, and nothing else, may touch tokens

The linearity invariant says a rule's consumed children must be a disjoint,
ordered partition of the node's direct children, and that token mutation is
allowed only through enumerated policies. Here that holds **by construction,
because the language cannot express anything else**:

- No opcode emits arbitrary text, and only `table` emits a token the source did
  not contain. `tok` names a token it must find
  under the cursor; `child` recurses into a real child; `verbatim` emits the
  node's own source, but only after walking the subtree and refusing unless
  every range sits inside its parent, siblings are ordered and disjoint, and
  every leaf's `text` equals `source[start..end]`. Stale offsets — the one way
  this opcode can emit bytes the tree does not justify — are a refusal, not a
  silent rewrite. Whitespace opcodes emit no tokens.
- A rule may only ever consume the child **under the cursor**. Skipping,
  revisiting and reordering are unreachable, not merely discouraged.
- At the end of a rule the cursor must be at the end of the children, or the
  runtime refuses the file with a non-zero exit.

The three sanctioned mutations are opcodes:

- **`["trail", ",", sel]`** — if the source already has a trailing separator,
  consume it and pin the layout open (black's magic trailing comma); otherwise
  add one when the group breaks. The `sel` is not decoration: a separator is
  added only when the bracket holds **more than one** `sel` child, because a
  one-item bracket splits without ever reaching a comma and black leaves none
  behind. This is what makes `results.append({…})` come out right.
- **`["paren", e…]`** — adopt the balanced pair the source already has, or add
  one when the region breaks. `import_from_statement` uses it directly (black
  parenthesises a long import list); `autoparen` applies it to any child whose
  type is in `optional_parens`, which is how `x = (\n    a\n    + b\n)` happens.
- **`["table"]`** — pad a grid's cells to their column widths, and redraw the
  ruler row to match. This is the only opcode that writes a token the source
  never held, and it is confined to a shape where the token's spelling *is* the
  layout: the width of a markdown table's `---` is the width of the column
  above it, so `:-` in the source and `:-----` in the output say the same thing
  and there is nothing else they could say. The alignment colons, the cells'
  own text, the cell count and the row count all pass through untouched, and
  gate 3 still compares every one of them — a language declares
  `layout_leaves` to tell it which leaves are the padded ones.

Refusals are honest and specific: _"rule for `parenthesized_expression` wants
Named but found `lambda`"_ was a real bug report from the runtime to me during
development.

Everything else that could destroy code is simply not in the language. There is
no reordering, no quote rewriting, and no way to add one. The one deletion is
`["drop", "s"]`, which consumes a redundant token the source already held and
refuses when that token carries a comment; it cannot remove anything the tree
did not justify.

### 3. Comments belong to the runtime, not the package

Getting comment attachment wrong loses code, so no package decides it. A
pre-pass over each node's children applies one language-independent rule:

- a comment sharing a line with preceding code becomes a **line suffix** of the
  sibling before it — deferred to just before the next newline, so it survives a
  group breaking underneath it;
- a comment alone on its line **leads** the next sibling that is not punctuation
  (punctuation would put it at the wrong indent, outside the bracket it closes);
- a comment with nothing left to lead **trails** the last non-punctuation
  sibling, and a node holding nothing but comments keeps them dangling.

`descend` is the one language-shaped input: a comment leading a suite belongs on
the first line _inside_ it, not stranded after the colon that opens it. Python
lists `"block"`; JSON lists nothing.

Comments are consumed exactly once and in source order, so the partition the
linearity invariant asks for still holds — the package simply never sees them.
Every comment also emits a `BreakParent`, so a group can never flatten a comment
onto the following line.

That attachment is selected by the package's `comments` list. HTML deliberately
leaves its `comment` node out: an HTML comment is inline markup whose exact
position can affect rendered whitespace, not a language trailing comment. It
therefore remains an ordinary leaf consumed by the surrounding element rule.
This keeps `<span>x</span><!-- c -->` adjacent instead of applying a code-style
comment gap or moving the comment to the end of the printed line.

## Two runtimes, written twice

`fits` measures the rest of the printer's stack, not just the group — otherwise
a trailing `)` or a trailing comment costs nothing and the line silently
overflows. Trailing comments **do** count against the budget, which is black's
behaviour and the reason `settings = {…}  # shallow merge is fine` breaks at
width 60.

Width is Unicode scalar values in both runtimes: `s.chars().count()` in Rust,
`[...s].length` in JS. Both runtimes have a test that pins it, because the
failure is invisible until someone writes an emoji.

`["table"]`'s column widths are scalar counts too, so a CJK or emoji cell
occupies its true two display columns but is measured as one, and the ruler
comes out a column narrow per wide character. Considered and declined: zero of
2,157 table rows in this repo need it, and a display-width table is ~15
East-Asian-Width ranges mirrored byte-for-byte in both runtimes, forever, for a
case that has not occurred once. Revisit if a document ever needs it.

Indentation is written lazily, so a blank line is genuinely empty rather than a
run of spaces. Each `Indent` node carries its own column count, resolved from
the package header when the Doc is built, so the printer has no global tab. The
amount is relative — nested indents add — which is what lets a later embedded
language bring a different width without a printer change.

The two implementations are independent, not transliterations. The Rust one
parses the package into a typed `Expr` enum with `TryFrom<Value>`, so a
malformed package fails at load with a message; the JS one interprets the arrays
directly and caches break-propagation on each Doc node at construction, which
Rust computes once from the finished Doc tree before printing. Same algorithm,
different idiom, byte-identical output on all corpus runs.

## What changed from the proposal, and why

- **The opcode set grew where measured cases demanded it.** `suffix` was
  dropped from the language entirely (the runtime owns comments, so no package
  needs it) and `ifbreak` never earned a use, but `sp`, `opt`, `verbatim`,
  `blank`, `trail`, `paren`, `autoparen`, source-mirroring breaks and `fill`
  were all needed. The bytecode approach (design C) was not the honest answer.
- **`flatten` needed precedence and a no-indent rule** (above). The proposal had
  neither and would have staircased.
- **The two-level bracket group replaced `conditionalGroup`.** I said in the
  proposal that "anything needing to try two layouts and pick one" was out of
  reach and that `calls.py` would show it. It doesn't: nesting the item group
  inside the bracket group produces black's two-stage split exactly, and
  `calls.py` matches black at both widths. That was the proposal's biggest wrong
  prediction.
- **`flatten` does not do method chains.** The proposal claimed it covered "four
  of the twelve corpus files" including `chains.py`. It covers three. Black
  splits before a `.` only when the dot follows a closing bracket and there are
  at least two such dots; that needs a predicate on the _previous item_ inside a
  separator, which I judged too much new mechanism for one corpus file.
  `method_chain` therefore breaks into a call's brackets instead of at the dots
  — legal, idempotent, and uglier than black.

## What this design cannot do

Named precisely, because a limit you can name is cheaper than one you can't.

- **Try two layouts and pick the better.** There is no `conditionalGroup`. The
  two-level group covers the common case, but "wrap this in parentheses only if
  wrapping actually makes the line fit" is not expressible. Black wraps a long
  string RHS in parens at width 88 and leaves it bare at 60; I do neither, so
  `strings.py` keeps one over-long line at 88.
- **Context-dependent rules.** Dispatch is on node type alone. "Format this
  differently inside a `return`" needs a duplicated node type or an inherited
  context I deliberately left out.
- **Anything the tree does not say.** `flatten` folds the tree it is given, so
  when a grammar's associativity differs from the language's own, the chain
  splits at the tree's joints. `bitwise` in `operators.py` is the case:
  tree-sitter groups `a | b & c ^ d << e` differently from CPython, so my split
  points differ from black's while meaning is preserved.
- **Method chains at the dots**, as above.
- **Quote normalisation, and every other token rewrite.** `'single quoted'`
  stays single-quoted. This is not an oversight — the linearity invariant
  forbids it, and together with the paren case above it is why `strings.py` is
  the one file that misses black. I think that is the right trade: a formatter
  that can rewrite a token can corrupt one.
- **Unknown node types.** A node type with no rule is a refusal, not a guess.
  This makes an incomplete package loud instead of silently wrong, but it means
  a package must cover its language before it is useful at all.
- **Normalising every blank-line run.** Gaps next to a definition now open to
  the local cap (2 at module level, 1 inside a block), which is black's depth
  rule with no extra concept. Gaps that are not next to a definition are still
  preserved and capped: two assignments with no blank between them stay packed.
  A comment sitting immediately before a `def` gets the blanks before the
  comment, because that is where the gap already lives. A blank the source put
  _between_ the comment and the `def` is not moved — that would need the
  attachment pass to know about definitions, which I judged more mechanism than
  the case is worth.

## Scores, as measured

```
[PASS] 0-coverage       30/30   formatted every corpus file at every width
[PASS] 1-agreement      30/30   rust and js byte-identical
[PASS] 2-idempotence    30/30   fmt(fmt(x)) == fmt(x)
[PASS] 3-nondestruction 30/30   meaning and comments preserved

overflow lines     6
size (gzip)        10441 B = 8312 runtime + 2129 packages
reference agreement 24/30
  json         4/6   vs prettier 3.6.2  (its own overflow: 1)
    diverges on:  nested@88, nested@60
  python      20/24  vs black 25.9.0    (its own overflow: 4)
    diverges on:  chains@60, kitchen@60, operators@60, strings@88
```

JSON is measured against prettier only since Stage 0 generalised the reference
comparison. Both of `nested.json`'s old divergences are now package rules:
`["all", "named", ["number"]]` selects `fill` for `long_flat_array` without
touching mixed `scalars.json`, and `["all", "named", ["array", "object"]]`
with a `count == 1` fallback explodes `matrix` the way prettier does on this
corpus. Prettier also refuses to explode an array-of-arrays whose parent is
itself an array; that needs ancestor context and is not in the IR. CSS
replaced its `string_value` count proxy with the same predicate — every named
child a `property_name`, `string_value`, `plain_value` or `important` — so an
unquoted family list takes `fill` too. No CSS corpus file moved.

The black-agreement figure is worse than this document used to claim, and the
reason is worth keeping. The submission scored it at width 88 only, where
`strings.py` was the single miss and quote style was the whole story. main's
scorer measures both widths, and at 60 three more files diverge. Each one is a
limit already named under "What this design cannot do", and between them they
cover three different ones: `chains` is the method spine breaking inside a
call's brackets rather than at the dots; `operators` is tree-sitter's bitwise
associativity putting the split somewhere black does not; and `kitchen` is the
missing `conditionalGroup` — black breaks into a call's arguments where we
parenthesise the whole condition, and choosing between those two layouts is
exactly the thing this IR cannot do.

Nothing regressed here. A narrower measurement had been flattering the result,
and three of the four documented limits turn out to be reachable from a
twelve-file corpus the moment the second width is scored.

Against the 25 KB budget that is 10.2 KB, and I will repeat the proposal's
claim: **size is not the binding constraint** for any design in this space.
Every serious entry will fit. The axis that matters is whether the rules stay
readable, and the honest test of that is whether you could have written
`packages/python.json` from this document.
