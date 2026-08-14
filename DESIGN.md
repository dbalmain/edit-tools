# Linear layout schemas

This submission implements the Phase 1 proposal's central idea: a language
package is data that maps concrete-syntax node types to local layout schemas.
The JavaScript and Rust runtimes interpret the same package and independently
render the resulting document. Neither runtime contains a parser.

## Package shape

Packages are UTF-8 JSON files in `packages/`. The top-level fields are:

- `format`: currently `et-linear-layout/1`;
- `language`: the tree's language name;
- `style.indent` and `style.finalNewline`; and
- `rules`: a map from concrete-syntax node type to a schema.

Leaves need no rule: their `text` is emitted unchanged. Every interior node
does. An unknown interior node is refused rather than guessed. Version 1 has
five schemas:

- `tight` recursively emits every direct child with no inserted gap. It is for
  lexical containers such as JSON strings.
- `sequence` recursively emits every direct child and inserts its `gaps`
  between them. The gap count must be exactly one less than the child count.
- `delimited` recognizes `open`, alternating items and `separator`, then
  `close`. Empty forms remain compact. Nonempty forms are a group with one
  indentation level and either a `line` or `softline` at each edge.
- `verbatim` emits the node's exact source byte range after recursively
  validating that every descendant range is ordered, non-overlapping, in
  bounds, and that every leaf agrees byte-for-byte with `source`. It must be
  explicitly selected for a node type; it is never an uncovered-node fallback.
- `source` emits the source gaps around each direct child while recursively
  formatting those children. It validates the same range invariants first, so
  it is the bridge from preserved statement structure to local reflow rules.
- `continuationList` recognizes a fixed prefix marker followed by a punctuated
  direct-child list. Its broken branch emits one package-enumerated balanced
  delimiter pair and optional trailing separator; its flat branch omits a
  redundant input pair. The same rule recognizes both CST shapes on pass two.

A gap is `none`, `space`, `line`, `softline`, or `hardline`. `line` becomes one
space when its group fits and a newline when it breaks. `softline` becomes
nothing or a newline. `hardline` always breaks.

For example, the complete JSON pair rule is:

```json
"pair": { "layout": "sequence", "gaps": ["none", "space"] }
```

It consumes the key, colon, and value in that order, inserting no text before
the colon and one space after it. The object rule is:

```json
{
  "layout": "delimited",
  "open": "{",
  "close": "}",
  "separator": ",",
  "edge": "line"
}
```

## Linearity and refusal

Schemas consume children by index. `tight` and `sequence` visit the complete
child array once in order. `sequence` also checks its declared arity.
`delimited` checks both delimiters and every intervening separator while
visiting each item once. It can explicitly preserve an input trailing
separator and use that token as a forced-break signal; it never synthesizes or
removes one. `itemsVerbatim` applies the checked source-range operation to each
item, and `independentItems` gives the item sequence its own fit decision.
`reserveLineSuffix` includes the source text following the closer on that line
in the fit budget; this lets a parameter list account for a return annotation
without searching descendants or moving the suffix into the list rule.
`verbatimWithComments` is an ordered local case: a delimited node with a direct
comment uses checked verbatim output instead of guessing which item owns the
comment. Comment-free nodes continue through the normal delimited schema.
Consequently, successful evaluation is a disjoint,
ordered partition of the node's direct children. A missing, duplicated,
reordered, or structurally unexpected child causes a non-zero exit.

JSON declares no token mutation. Python's `import_from_statement` rule declares
the two sanctioned mutations together: a balanced continuation-parenthesis
pair around the imported-name region, and a trailing comma inside that pair.
No other rule can add, remove, or rewrite a syntax token.

## Document and rendering model

The runtime builds `text`, `concat`, `group`, `indent`, `line`, `softline`,
`hardline`, and `ifBreak` documents. `ifBreak` selects a branch using its
lexically enclosing group's mode and is used only by enumerated continuation
rules. A bounded Wadler-style lookahead decides whether each group fits. A
hardline statically forces every enclosing group to break.

Width means Unicode scalar values. Rust uses `chars().count()`; JavaScript uses
code-point iteration (`[...value].length`). This deliberately does not attempt
terminal display width.

## Adding a language

Start from the grammar's interior node types. Give lexical containers `tight`
rules, fixed-arity nodes `sequence` rules, and homogeneous bracketed lists
`delimited` rules. Run the scorer after each group of rules. A refusal naming an
interior node indicates missing coverage; an arity or delimiter diagnostic
indicates that one node type needs ordered cases or a more specific schema.

Rules see direct children only. If a construct cannot be described without
searching descendants or changing syntax, add a small checked schema operation
rather than smuggling language-specific behavior into either runtime.

## Limits and proposal changes

The implemented core deliberately remains narrower than the proposal. It does
not include general ordered predicates, operator chains, suites,
boundary-comment Docs, or `lineSuffix`; continuation mutation is implemented
only for import lists. Those mechanisms should be added only alongside a
package that uses them and differential fixtures that fix their semantics.

This restriction exposed one useful correction to the proposal: a generic
`verbatim` escape hatch based only on concatenating leaf text cannot reproduce
the whitespace between CST children. Source-backed verbatim must therefore be
an explicit schema consuming one exact byte range, with leaf-order checks; it
cannot be an automatic fallback for an uncovered node.

The local model cannot express alignment across sibling statements, global
layout optimization, embedded-language formatting, string splitting, or
display-width measurement. Comments and Python continuation wrappers are the
hardest extensions because their canonical output must map to the same local
region after reparsing.
