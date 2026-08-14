# Layout kinds

The package is a map from CST node type to a *layout kind*.
A kind is a named, parameterized algorithm the runtime already
knows how to run. The package fills in the parameters — brackets,
separators, whether a trailing comma is magic, whether a chain may
break. It does not describe Doc trees, match queries, or emit
bytecode.

This is not on the A–E menu. It is closest to B (node-schema
templates), inverted. B has the package describe a Doc shape per
node type; the runtime is a renderer. Here the package *names an
algorithm* per node type; the runtime *is* those algorithms. The
line is drawn there because the hard parts of a formatter — magic
trailing commas, comment injection into bracketed lists, flattening
left-associative operator trees, blank-line policy — are algorithms,
not templates. Writing them once in the runtime, in two languages,
is cheaper and less divergent than asking every package to
re-express them.

A generic `template` kind exists as an escape hatch for one-off
nodes. That is B, used where kinds run out — the opposite of E
(B everywhere, bytecode where B runs out).

---

## 0. Conflicts with the given docs

The docs are a hypothesis. Four places they disagree with the
scorer, the reference, or themselves. A design that papers over
these will fail a gate or silently aim at the wrong target.

### 0.1 Gate 3 forbids the thing black (and Prettier) do to reflow

`harness/score.py` `normalise_tokens` drops only a comma immediately
before a closer. The comment says the rest, *including parentheses*,
must survive verbatim. Adding `(` `)` around a long `and`/`or`
chain, a method chain, or a `from … import` list therefore fails
gate 3 and disqualifies the submission.

Python cannot break an unparenthesized infix expression, an
unparenthesized attribute chain, or an unparenthesized import list
without adding either parentheses or a backslash. Black adds
parentheses. We cannot.

Consequence, which this design accepts:

- Break only inside brackets that already exist in the tree
  (calls, lists, dicts, sets, tuples, subscripts, existing parens,
  parenthesized imports, comprehensions).
- Unparenthesized chains overflow. That is scored by measure 4,
  not by a gate. The overflow metric will punish a
  gate-3-correct formatter on `chains.py`, `operators.py`, and
  `imports.py` at width 60. The metric is slightly wrong for this
  constraint; the constraint is the one that is fixed.

Backslash continuation would pass gate 3 (`\` is not a tree-sitter
leaf) and would cut overflow. It is ugly, it tanks black
agreement, and it is a style no serious Python formatter uses. We
do not do it.

Black agreement (measure 6) is a proxy, not a requirement. This
design will lose files to black wherever black inserts parens, and
will say so in §6.

### 0.2 The idempotence pass drops the source

`as_tree_doc` rebuilds a tree from formatted text and does not set
`source_file`. Pass 2 of `fmt(fmt(x))` therefore has byte offsets
but no source bytes. Gap *length* between siblings cannot
distinguish two spaces (trailing comment) from two newlines
(own-line comment after one blank). Comment attachment and
blank-line recovery must work from the tree alone on pass 2.

§5 specifies a gap-size encoding that pass 1 emits and pass 2
recovers. The harness would be a better harness if `as_tree_doc`
kept the formatted text or a `source_file`; that is not the
contract we have.

### 0.3 `ifBreak` is in the minimum IR and missing from the reference

`docs/design.md` lists `ifBreak` as required (it is how trailing
commas work). `reference/` implements `text / concat / group /
indent / line / softline / hardline` and no `ifBreak`. The
reference is a CLI-and-printer sketch, not a definition of the IR.
This design includes `ifBreak`.

### 0.4 The two reference printers already disagree on width

The JS reference measures `string.length` (UTF-16 code units). The
Rust reference measures `chars().count()` (Unicode scalar values).
`corpus/src/python/strings.py` contains `café`. It is short enough
not to flip a break, so the reference gets away with it. A longer
line containing non-BMP characters would fail gate 1.

Both runtimes in this design measure **Unicode scalar values**.
JS must not use `.length`.

### 0.5 The scorer gzips all of `packages/`, not Python alone

The budget table splits Python (≤ 15 KB) and JSON (≤ 2 KB). The
scorer reports one number for the directory. Ship both; count
both. The estimates in §4 do.

---

## 1. The package format

A package is one JSON object. Authored readable, shipped minified.
No compiler, no bytecode, no query language. A competent
contributor adds a node type by picking a kind and filling in
brackets.

```json
{
  "language": "python",
  "indent": 4,
  "comment_type": "comment",
  "opaque": ["string"],
  "steal_into_body": [
    "function_definition", "class_definition",
    "if_statement", "elif_clause", "else_clause",
    "for_statement", "while_statement", "with_statement",
    "try_statement", "except_clause", "finally_clause"
  ],
  "blank": {
    "max": 2,
    "before_top": [
      "function_definition",
      "class_definition",
      "decorated_definition"
    ]
  },
  "nodes": { "...": "see below" }
}
```

`opaque` nodes are emitted by concatenating descendant leaf
`text` in order, as a single `text(…)` Doc. They are never
reflowed and never reconstructed from a quote style. This is the
correctness trap in `strings.py`: f-strings, triples, raw
strings, bytes, escapes, and `café` all survive because we do not
touch them. Interpolations are not formatted; for this corpus they
are identifiers.

`steal_into_body` is the tree-sitter-python wart. A comment
between `:` and the following `block` is a sibling of that
`block`, not a child of it — and the `block` is not always a
field named `body` (`except_clause` and `finally_clause` carry
an un-fielded `block`). The runtime hoists any comment that
sits immediately before a `block` child of a listed type.
See §5.

### 1.1 Kinds

| Kind | What it formats | Parameters |
| --- | --- | --- |
| `leaf` | identifiers, numbers, keywords, punctuation | — |
| `fwd` | wrapper with one interesting child (`expression_statement`, `document`) | — |
| `seq` | bracketed comma-lists | `open`, `close`, `sep`, `trailing`, `singleton_comma`, `flat_pad` |
| `body` | `module`, `block` | uses `blank` |
| `infix` | two-sided operators with fixed spacing | `op` *or* `op_field`, `pad` |
| `pfx` | keyword/operator then operand | `kw` or field list, `sp` |
| `wrap` | already-present brackets around one expression | `open`, `close` |
| `chain` | flatten-able operator trees | `flat`, `fill`, `break` |
| `clause` | `keyword header:` + indented body + tails | `keyword`, header fields, `colon`, `body`, `tails` |
| `comp` | list/set/dict/generator comprehensions | `open`, `close` |
| `dot` | `obj.attr` and `dotted_name` | — |
| `sub` | `obj[index]` | — |
| `from_import` | `from … import …`, with or without existing parens | — |
| `template` | escape hatch | a Doc expression with `$` holes |

Default for an unlisted type: if it has `text`, `leaf`; else
`fwd` into its non-punctuation children joined with nothing. A
missing kind is never silent corruption — unknown *interior*
structure with multiple significant children is a refuse
(`exit 1`). That keeps gate 3 from being failed by a half-written
package.

### 1.2 Concrete fragment: a long call

From `corpus/src/python/calls.py`:

```python
value = compute_the_weighted_average(first_operand, second_operand, third_operand, fourth)
```

That line is 90 columns. It must wrap at both 88 and 60.

Package entries that fire:

```json
{
  "assignment": { "kind": "infix", "op": " = " },
  "call":       { "kind": "pfx", "fields": ["function", "arguments"] },
  "argument_list": {
    "kind": "seq",
    "open": "(",
    "close": ")",
    "sep": ",",
    "trailing": "magic"
  }
}
```

`assignment` emits `concat([left, text(" = "), right])` with no
group of its own — the `=` is not a break opportunity, because
turning the RHS into a parenthesized continuation would add
tokens.

`call` concatenates the function Doc and the argument-list Doc.
All the reflow lives in `seq`.

`seq` with `trailing: "magic"` does this, in the runtime, not the
package:

1. Collect *items*: children that are not punctuation and not
   comments. Comments have already been attached (§5). Here:
   `first_operand`, `second_operand`, `third_operand`, `fourth`.
2. Detect a magic comma: walk backward from the closer, skipping
   comments; if the first thing hit is `,`, the group is born
   with `shouldBreak: true`. This call has no such comma.
3. Build, in the IR of §2:

```
group(concat([
  text("("),
  indent(concat([
    softline,
    first,
    concat([text(","), line]),
    second,
    concat([text(","), line]),
    third,
    concat([text(","), line]),
    fourth,
    ifBreak(",", "")
  ])),
  softline,
  text(")")
]))
```

Empty `seq` is `text(open + close)`. `trailing: "none"` (JSON)
suppresses the final `ifBreak(",", "")`. `lambda_parameters` is
*not* a `seq`: there are no brackets to break inside, and
breaking a lambda parameter list would need parens we are
forbidden to add. It is a flat join. The long lambda in
`misc.py` overflows at width 60; that is the same gate-3 limit
as unparenthesized `and` chains.

At width 88 the call does not fit (90 columns), so it prints:

```python
value = compute_the_weighted_average(
    first_operand,
    second_operand,
    third_operand,
    fourth,
)
```

The trailing comma is an `ifBreak`, so it appears only in the
broken layout. On the next pass the comma *is* in the tree, magic
fires, `shouldBreak` is true, and the same layout comes out.
Idempotent. This is also black's rule: a width-forced explode
writes a comma; the comma then makes the explode sticky.

`keyword_argument` is `infix` with `op: "="` and no spaces
(`method="POST"`). `list_splat` / `dictionary_splat` are `pfx`
with `kw: "*"` / `"**"` and `sp: false`. Nested calls are just
`call` inside an item; each `argument_list` is its own group, so
`outer(inner(deeply_nested(a, b, c), other_argument), …)` breaks
from the outside in, which is what Wadler groups do.

### 1.3 Concrete fragment: a dict / list with a magic trailing comma

From `corpus/src/python/collections.py`:

```python
magic_trailing = [
    1,
    2,
]
```

```json
{
  "list": {
    "kind": "seq",
    "open": "[",
    "close": "]",
    "sep": ",",
    "trailing": "magic"
  },
  "dictionary": {
    "kind": "seq",
    "open": "{",
    "close": "}",
    "sep": ",",
    "trailing": "magic"
  },
  "pair": { "kind": "infix", "op": ": " }
}
```

The list's children are `[`, `1`, `,`, `2`, `,`, `]`. Step 2 of
`seq` sees the comma before `]` and sets `shouldBreak` on the
group. The fits-check is never consulted. Output is always

```python
magic_trailing = [
    1,
    2,
]
```

even at width 88, even though `[1, 2]` would fit. That is black's
magic trailing comma
([The Black code style](https://black.readthedocs.io/en/stable/the_black_code_style/current_style.html)).

A dict in the same file without a magic comma,
`{"host": "localhost", "port": 8080, "debug": True, "timeout": 30, "retry": 3}`,
is a `seq` of `pair` items. Flat if it fits; exploded with a
trailing comma if it does not. `pair` is `"host": "localhost"` —
colon-space, no break between key and value. (A pair whose value
is itself a `seq` can break inside the value. The pair does not
insert a line after `:`.)

`tuple` is the same `seq` with `singleton_comma: true`, so `(lonely,)`
keeps the comma that makes it a tuple even when flat. `set` is
`seq` with `{}`. JSON `object` / `array` are `seq` with
`trailing: "none"` — JSON cannot have trailing commas — and
`indent: 2` from the JSON package. JSON `object` sets
`flat_pad: true` so the flat form is `{ "a": 1 }` (the `line`
inside the group becomes a space, including after `{` and before
`}`). Python collections use `softline`, so the flat form is
`[1, 2, 3]` with no spaces inside the brackets.

### 1.4 The rest of the Python package, compressed

Shown as the map a contributor actually writes. Every entry is
one kind plus a few strings.

```json
{
  "module":  { "kind": "body" },
  "block":   { "kind": "body" },

  "parameters": { "kind": "seq", "open": "(", "close": ")", "sep": ",", "trailing": "magic" },
  "default_parameter": { "kind": "infix", "op": "=" },
  "typed_parameter":   { "kind": "infix", "op": ": " },

  "parenthesized_expression": { "kind": "wrap", "open": "(", "close": ")" },

  "binary_operator":     { "kind": "chain", "break": "if_wrapped" },
  "boolean_operator":    { "kind": "chain", "break": "if_wrapped" },
  "comparison_operator": { "kind": "chain", "already_flat": true, "break": "if_wrapped" },

  "not_operator":   { "kind": "pfx", "kw": "not", "sp": true },
  "unary_operator": { "kind": "pfx", "op_field": "operator", "sp": false },
  "attribute":      { "kind": "dot" },
  "subscript":      { "kind": "sub" },
  "dotted_name":    { "kind": "dot" },

  "function_definition": {
    "kind": "clause",
    "keyword": "def",
    "header": ["name", "parameters"],
    "arrow": "return_type",
    "colon": true,
    "body": "body"
  },
  "class_definition": {
    "kind": "clause",
    "keyword": "class",
    "header": ["name", "superclasses"],
    "colon": true,
    "body": "body"
  },
  "if_statement": {
    "kind": "clause",
    "keyword": "if",
    "header": ["condition"],
    "colon": true,
    "body": "consequence",
    "tails": ["elif_clause", "else_clause"]
  },
  "for_statement": {
    "kind": "clause",
    "keyword": "for",
    "header": ["left", "in", "right"],
    "colon": true,
    "body": "body"
  },
  "try_statement": {
    "kind": "clause",
    "keyword": "try",
    "colon": true,
    "body": "body",
    "tails": ["except_clause", "else_clause", "finally_clause"]
  },

  "decorated_definition": { "kind": "body", "tight": true },
  "decorator":            { "kind": "pfx", "kw": "@", "sp": false },

  "list_comprehension":        { "kind": "comp", "open": "[", "close": "]" },
  "set_comprehension":         { "kind": "comp", "open": "{", "close": "}" },
  "dictionary_comprehension":  { "kind": "comp", "open": "{", "close": "}" },
  "generator_expression":      { "kind": "comp", "open": "(", "close": ")" },

  "import_statement":      { "kind": "template", "doc": ["import ", {"join": {"sep": ", ", "items": "$name"}}] },
  "import_from_statement": { "kind": "from_import" },

  "conditional_expression": {
    "kind": "template",
    "doc": ["$0", " if ", "$2", " else ", "$4"]
  },
  "lambda": {
    "kind": "template",
    "doc": ["lambda ", "$parameters", ": ", "$body"]
  },
  "lambda_parameters": {
    "kind": "template",
    "doc": [{"join": {"sep": ", ", "items": "$children"}}]
  },
  "concatenated_string": { "kind": "template", "doc": [{"join": {"sep": " ", "items": "$children"}}] }
}
```

`from_import` is a narrow extra kind. tree-sitter-python does
not wrap a parenthesized import list in its own node: `(` and
`)` are siblings of the `name` children on
`import_from_statement`. The kind looks for those two tokens.
If they are present, the names are a `seq` with
`trailing: "magic"` and reflow inside the parens the author
already wrote. If they are not, the names stay one line. We do
not add parentheses. Long unparenthesized imports overflow.
The parenthesized form in `imports.py` —

```python
from package import (
    alpha,
    beta,
)
```

— has the comma before `)` and explodes, as written.

`clause` emits `keyword` + space + header fields (joined with
their own docs; a header entry that is not a field name, such
as `in` in a `for`, is the literal ` in `) + optional ` -> ` +
return type + `:`. Then `hardline` + `indent(body)`. If the
named body field is absent, the kind takes the `block` child —
`except_clause` and `finally_clause` have one, un-fielded.
Tails are each preceded by a `hardline` and are themselves
clauses. Missing header fields (`superclasses` on a bare
`class Simple`) are skipped. Decorators sit in a `body` with `tight: true`, which
means hardlines between children and no blank-line insertion, so

```python
@decorator_with_arguments(
    option_one=True,
    option_two=False,
    option_three="value",
)
@another_decorator
def multiply_decorated(a, b):
    return a * b
```

The decorator's call is an ordinary `seq` and wraps on its own.

`comp` is:

```
group(concat([
  text(open),
  indent(concat([softline, element, line, for_in, line?, if_clause…])),
  softline,
  text(close)
]))
```

so a long comprehension wraps inside the brackets it already has,
which is legal and what black does.

`chain` is the one kind that looks at its parent. See §2.

`template` holes: `$0`, `$1`, … index non-comment children;
`$name` is a field; `$children` is all significant children;
`join` is the obvious. Templates cannot introduce new tokens that
are not string literals in the template — a contributor who
writes `"("` around a chain is choosing to fail gate 3, and the
package review should catch it.

### 1.5 Why not queries, bytecode, or free templates

**A (Query → Doc).** Topiary's front end is the right idea for a
formatter that *preserves* the author's line breaks: a query
captures a node, `@append_hardline` writes an atom, done. Topiary
cannot reflow against a width budget because its IR is a stream
([Topiary tutorial](https://www.tweag.io/blog/2025-01-30-topiary-tutorial-part-1/),
and the argument in `docs/design.md`). Putting a Wadler printer
behind a query engine does not make the query engine small. A
tree-sitter-shaped matcher with captures, anchors, and
alternation will not fit in 7 KB next to a printer. The corpus
has ~70 interesting Python node types and no cross-cutting
"match this shape wherever it appears" problem that kinds do not
already handle by dispatching on `type`.

**B (templates for everything).** A template can say "emit a
group of open, indent, join children with comma-line, close".
It cannot say "and if the last child before the closer is a
comma, force the group to break, and re-attach the comment that
tree-sitter left as a sibling of the comma, and steal the
comment that tree-sitter left between `:` and `block`". Those
sentences are the same for lists, dicts, calls, and parameters.
They belong in one `seq` implementation, not in four templates.

**C (bytecode).** Maximum expressiveness, two VMs that must
agree, and the authoring language *is* the project. The
divergence surface is the thing `docs/design.md` wants to fuzz,
but gate 1 is pass/fail on a frozen corpus, not a fuzzer score.
A VM is the wrong risk to take when the corpus is 15 files.

**D (constraint solver).** "A Pretty Expressive Printer"
(Porncharoenwase, Pombrio, Torlak, OOPSLA 2023) is the right
paper if the goal is *optimal* layout. It is `O(n · w)` with a
cost model, and the runtime is a solver. It will not come in
under 10 KB and it will not make Rust and JS agree more easily
than Wadler. Pombrio's later "twist" on Wadler — exposing `|`
choice plus `flat` instead of `group` — is a better IR for
layouts that differ by more than whitespace (trailing commas).
We get the same power from `ifBreak` without changing the
printer the reference already sketches.

---

## 2. The IR, and how the package drives it

### 2.1 Constructors

The design.md minimum set, plus two that are load-bearing, minus
the ones that are not.

| Constructor | Role |
| --- | --- |
| `text(s)` | literal, never broken |
| `concat([…])` | sequence |
| `group(d, {shouldBreak?})` | flat if it fits and `!shouldBreak` and no forced break inside; else broken |
| `indent(d)` | +1 indent level (width comes from the package) |
| `line` | space when flat, newline+indent when broken |
| `softline` | nothing when flat, newline+indent when broken |
| `hardline` | always newline+indent; forces enclosing groups to break |
| `ifBreak(a, b)` | `a` if the *enclosing* group is broken, else `b` |
| `lineSuffix(d)` | buffer `d` and flush it before the next newline (Prettier) |

`shouldBreak` on `group` is how magic commas force a break
without injecting a `hardline` that would also force *outer*
groups to break. A magic comma on an inner call must explode
that call, not the list that contains it.

Forced-break propagation: a `hardline` anywhere inside a group
makes that group broken. This is Prettier's `breakParent`. The
reference implements it as a `brk` bit computed at Doc
construction. Keep that. `ifBreak` contents are *not* scanned
for `hardline` — Prettier's documented design limitation. We
never put a `hardline` inside an `ifBreak`.

Not included, and why:

- **`fill`.** Prettier's paragraph wrapper. Load-bearing for
  markdown and for long boolean chains *that we are allowed to
  break*. The chains we are allowed to break already live inside
  a `wrap`/`seq` group; all-or-nothing is what black does with
  parenthesized `and`/`or` anyway. Deferred, as design.md
  suggested. Revisit if a later corpus has a 30-term
  parenthesized boolean.
- **`conditionalGroup`.** Exponential when nested. Prettier
  marks it last-resort. We have no "try layout A, then B, then
  C" construct in the corpus once parenthesizing chains is
  forbidden.
- **`align` / `literalline` / `dedent`.** Needed for HTML
  attributes, template-literal interiors, preprocessor
  directives. Strings are opaque. Not needed.
- **`lineSuffixBoundary`.** Needed when a suffix could leak out
  of an embedded language. We have no embeddings.

### 2.2 How a kind produces Doc

The runtime walks the tree after the attach pass. For each node
it looks up `nodes[type]` and runs that kind. Kinds recurse by
calling the same walk on children.

`seq` is §1.2. `body` is: for each (already-attached) child,
emit the child's Doc; between children emit `hardline`, plus
extra `hardline`s to satisfy `blank.before_top` (two blank lines
= three newlines total before a top-level `def`/`class`).
`tight` bodies skip the extra blanks.

`wrap` is `group(concat([text(open), indent(concat([softline, inner])), softline, text(close)]))`.
This is the only thing that makes an existing `parenthesized_expression`
into a break opportunity. `(a + b) * (c - d)` can break *inside*
each pair of parens; it cannot break at `*` unless the whole
product is itself wrapped.

`chain` flattens a left-associative same-operator spine
(`binary_operator`, `boolean_operator`) into a list of operands
and operators. `comparison_operator` is already flat in
tree-sitter (one node, many children, operators in the
`operators` field) and sets `already_flat`. Join with
`concat([text(" "), op, text(" ")])`. Compound operators
(`not in`, `is not`) are interior nodes with no `text` — two
keyword children. Emitting them as concatenated leaves would
print `notin`. The chain kind joins an operator node's
descendant leaves with a single space, so those two survive as
`not in` / `is not`. Then:

- if `break` is `if_wrapped` *and* the parent kind is `wrap` or
  `seq` (the chain is already inside brackets), wrap the join in
  `group` and put `line` on both sides of each operator, so a
  long parenthesized condition can explode;
- otherwise emit the flat join, no group.

That is the gate-3 rule, encoded once.

`dot` and `sub` do not break at `.` or before `[`. A long
attribute chain overflows. A long *index* can break inside the
`[]` because those brackets exist: `sub` is
`concat([obj, group(concat([text("["), indent(concat([softline, index])), softline, text("]")]))])`.

### 2.3 The printer

Wadler 2003 via Lindig's "Strictly Pretty" (the strict-language
formulation), which is what the reference already implements and
what Prettier and `dprint-core` both descend from. Oppen 1980 is
the same algorithm in imperative clothing; we do not need it
separately.

The loop is the reference's loop, with three additions:

1. `ifBreak` — consult the current group's mode.
2. `shouldBreak` — `group` starts in break mode without running
   `fits`, matching Prettier's `group(doc, {shouldBreak: true})`.
3. `lineSuffix` — a side buffer; `hardline` / broken `line` /
   broken `softline` flush it before emitting the newline.

`fits` is the reference's `fits`, plus: `ifBreak` in flat mode
contributes `b`, in break mode contributes `a`; `lineSuffix`
contributes nothing (a trailing comment does not make a short
call explode). That last choice is Prettier's and black's.

Indent width is read from the package (`4` for Python, `2` for
JSON). It is not a constructor argument; `indent` means "one
level".

Width of `text(s)` is the number of Unicode scalar values in
`s`. Both runtimes implement that, not bytes, not UTF-16.

---

## 3. Runtime / package split

| Lives in the runtime (both languages) | Lives in the package |
| --- | --- |
| Wadler printer | indent width |
| Comment classifier and attach/steal | `comment_type`, `steal_into_body` |
| Gap-encoding emit/recover (§5) | — |
| Kind implementations | which kind each node type uses |
| Magic-comma detection (walk to closer) | `trailing: magic \| always-on-break \| none` |
| Operator-spine flattening | which types are `chain`, whether already-flat |
| Blank-line insertion | `blank.before_top`, `blank.max` |
| Opaque leaf concat | which types are opaque |
| Refuse on unknown interior | — |
| | every bracket, separator, keyword, and spacing string |

The test for the line: *if a new language can be added without
reading the printer, the line is in the right place*. JSON is
the test. Its package is four node types and no steal list. If
someone later adds TOML or a CSS-ish language, they write a
package. If they add a language whose layout is not "seq, body,
clause, chain", they either stretch `template` or they add a
kind and accept a runtime change.

That last sentence is the design's real limit, and it is
deliberate. A kind is ~80–150 lines in each runtime. Adding
kinds to chase languages is how this stays small. Putting a VM
in so that kinds can be "just packages" is how this stops
fitting in 10 KB.

What is *not* in the package: any measurement, any "does this
fit", any comment heuristic beyond the steal list. Those are
where two implementations diverge if they are written twice.
They are written once, as algorithms, and gate 1 checks them.

---

## 4. Size estimate

Budgets from `docs/design.md`: printer ≤ 3 KB, interpreter ≤ 7 KB,
Python package ≤ 15 KB, JSON package ≤ 2 KB; all gzipped. The
scorer measures `runtime-js/bundle.js` and the whole `packages/`
directory.

### 4.1 Packages, measured

A complete-enough Python map (69 node entries, steal list, blank
policy, opaque list) minifies to **4108 bytes, 1074 gzipped**.
The JSON package is **249 bytes, 165 gzipped**. Concatenated and
gzipped together: **1124 bytes**.

That is the authored shape, not a sketch. Adding templates for
the half-dozen odd nodes (`lambda`, ternary, `from_import`,
`slice`, `with_item`, `aliased_import`) is perhaps another 800
bytes raw, ~250 gzipped. Headroom against 15 KB is an order of
magnitude. JSON is well under 2 KB.

There is no reason to invent a binary package format.

### 4.2 Runtime, reasoned

The reference bundle — printer plus hardcoded JSON rules,
unminified — is 4301 bytes, **1338 gzipped**. The printer is
roughly half of that.

A minified printer with `ifBreak`, `shouldBreak`, and
`lineSuffix` added is still a tight loop over a tagged union.
design.md's 3 KB cap is comfortable; call it **1.5–2.2 KB
gzipped**.

The interpreter is the risk. Rough line counts, one JS
implementation, before minification:

| Piece | Lines (unminified) |
| --- | --- |
| Tree load, leaf concat, refuse | 60 |
| Comment classify + steal + attach | 120 |
| `seq` (items, magic comma, join, ifBreak) | 80 |
| `body` + blanks | 50 |
| `chain` flatten + wrap test | 50 |
| `clause` + tails | 60 |
| `comp`, `wrap`, `infix`, `pfx`, `dot`, `sub` | 80 |
| `template` evaluator | 80 |
| Dispatch and CLI | 40 |

~620 lines. Minified JS of that density is ~10–14 KB raw.
Gzipped at the ratio the reference actually shows (4301 → 1338,
~3.2×) gives **3.2–4.5 KB**.

Total JS runtime: **5–7 KB gzipped**, against a 10 KB budget
(3 + 7). The interpreter is the thing to watch during
implementation; the package is not.

If the interpreter grows past ~6 KB, the first cut is
`template`. Every corpus node has a dedicated kind in §1.4;
`template` is there for honesty about the escape hatch, not
because the corpus needs it. Deferring `template` to a later
language is a valid implementation tactic.

---

## 5. How comments are attached

This is what most formatter designs get wrong, and it is what
`corpus/src/python/comments.py` is for. Tree-sitter does not
attach comments. It drops them in the child list where they
lexically sat. Trailing comments on statements are *siblings of
the statement*, not children of it. Comments between `:` and
`block` are *siblings of the block*.

Prettier starts from the other end — a flat comment list with
source locations — and attaches each comment as leading,
trailing, or dangling on some AST node
([plugin API](https://github.com/prettier/prettier/blob/master/docs/plugins.md)).
We start from siblings. The destination is the same three
places.

### 5.1 Classification, pass 1 (source available)

`source_file` is on the corpus trees. Read it. For each comment
child `C` of parent `P`:

Let `prev` / `next` be the adjacent non-comment siblings.
Inspect `source[prev.end : C.start]` (or the start of `P` if no
`prev`).

- Zero newlines → **trailing** on `prev`. (`import os  # …`)
- One or more newlines, and there is a `next` → **leading** on
  `next`. (`# Own-line comment before a definition` then `def`)
- One or more newlines, and there is no `next` → **dangling** on
  `P`. (end of a `block`, end of a `list`, end of the file)

Then apply `steal_into_body`: a comment that is a child of a
listed type and sits immediately before a `block` child
(whether or not that child has `field: "body"` — `except_clause`
and `finally_clause` do not) is re-attached as leading on the
first statement of that block, or dangling on the block if the
block is empty. This is how

```python
def documented(a, b):
    # Leading comment inside the body.
    result = a + b
```

becomes a leading comment on `result = a + b` rather than a
sibling of the `block` that kinds would otherwise skip.

### 5.2 Classification, pass 2 (no source)

The harness's second pass has no `source_file`. Recover
attachment from the *gap length* `g = C.start - prev.end`, using
an encoding pass 1 is required to emit:

| What pass 1 prints | `g` | Pass 2 reads |
| --- | --- | --- |
| trailing comment, exactly two spaces | 2 | trailing |
| own-line, indent `i`, no blank | `1+i` | leading / dangling |
| own-line, indent `i`, `N` blank lines | `(N+1)+i` | leading / dangling |

The one collision: trailing (`g = 2`) versus own-line at indent
0 with exactly one blank line (`\n\n`, `g = 2`).

**Rule: never emit exactly one blank line immediately before an
indent-0 comment.** Use zero blanks (`g = 1`) or two (`g = 3`).
At indent 4 and up, own-line gaps include indent spaces and
cannot be 2.

This is a style constraint. It means we will not reproduce
black's occasional single blank before a module-level comment.
We will put two blanks before a top-level `def` (including its
leading comment) and zero blanks between that comment and the
`def`. `comments.py` under this rule:

```python
# Module level comment at the very top of the file.

import os  # trailing comment on an import


# Own-line comment before a definition, separated by a blank line.
def documented(a, b):
    # Leading comment inside the body.
    result = a + b  # trailing comment on a statement
    # Comment before return.
    return result
```

The EOF comment, which in the source has one blank before it,
gets two (the indent-0 rule). That is a named difference from
black, not an attachment failure.

### 5.3 Rendering

After attach, kinds never see comments as children.

- **Leading** comments on a node: each is `concat([text(c), hardline])`
  prefixed to the node's Doc. They force the enclosing group to
  break, which is correct — a list item with a leading comment
  cannot be flat.
- **Trailing** comments: `lineSuffix(concat([text("  "), text(c)]))`
  suffixed to the node's Doc. They do not affect `fits`. A short
  call with a long trailing comment stays a short call; the
  comment may overflow the budget. That is black's behaviour and
  the reason `lineSuffix` is in the IR.
- **Dangling** comments on a `seq`: emitted as own-line items
  in the join, in the position they occupied between items. The
  list in `comments.py` becomes

```python
values = [
    1,  # first
    2,  # second
    # own-line comment inside a bracketed list
    3,
]
```

  The own-line comment is dangling on the `list`. The trailing
  comments on `1` and `2` are `lineSuffix` on those items. The
  comma after `3` is magic, so the list is born broken; the
  own-line comment has a line to sit on.
- **Dangling** on a `body`: treated as a statement-shaped child
  of the body, so end-of-block and end-of-file comments print
  where they belong.

No comment is dropped. That is gate 3. The attach pass's
invariant is: every `comment` node is in exactly one of the
three buckets of exactly one node.

### 5.4 What this does not do

Prettier's `ownLine` / `endOfLine` / `remaining` hooks, used by
plugins to override attachment, are not in the package. The
steal list is the only language-specific override. A language
that needs "comments after `,` bind to the next item, not the
previous" cannot say so without a runtime change. Python and
JSON do not need that.

We also do not reflow comment *text*, wrap long comments, or
align trailing comments into a column. Those are not in the
corpus and they are how comment formatters become large.

---

## 6. What this design cannot do

Required, and specific.

1. **It cannot reflow unparenthesized infix, attribute chains,
   import lists, or lambda parameter lists.** Gate 3. Hardest
   files: `chains.py` (the `attribute_chain`, `method_chain`,
   `mixed_chain` lines), `operators.py` (every chain),
   `imports.py` (the long `from collections.abc import …`
   line), `statements.py` (the `if first_condition and …`
   header), `misc.py` (the long `lambda first, second, third:
   …`). At width 60 these will contribute overflow lines.
   Adding parens would match black and fail the gate.

2. **It cannot add or remove parentheses, quote styles, or
   implied tokens.** `redundant_parens` in `misc.py` is already
   not parenthesized in the source. `single = 'single quoted'`
   stays single-quoted. Black agreement on `strings.py` will
   lose. This is a correctness property, not a miss.

3. **It cannot format expressions inside f-string
   interpolations.** `string` is opaque. The corpus interpolations
   are identifiers, so this is latent. A later file with
   `f"{very_long_call(a, b, c)}"` would leave the call packed.

4. **It cannot express a layout that is not one of the kinds
   and not a template.** Templates cannot measure, cannot look
   at a grandparent, and cannot introduce a new break algorithm.
   A rustfmt-style match-arm aligner, or Prettier's
   `conditionalGroup` dance for JS method chains that *are*
   allowed to break before `.` (JS has ASI rules, not
   indentation), would need a new kind.

5. **It cannot preserve the author's line breaks as a
   preference.** Softlines expand based on width, not on
   whether the input was multiline — except that a magic comma
   *is* an author preference, and we honour it. This is the
   Topiary-shaped thing we are deliberately not. A contributor
   who wants "keep my list multiline because I wrote it that
   way, even without a trailing comma" has no hook. Black
   agrees with us here, not with them.

6. **It cannot put a single blank line immediately before an
   indent-0 own-line comment.** §5.2. `comments.py`'s EOF
   comment will have two blanks, not one. Measure 6 may lose
   that file for this reason alone.

7. **It will not match black on files where black parenthesizes,
   normalizes quotes, or uses a different blank-line count.**
   Expected black agreement: JSON is N/A; Python, perhaps 4–8
   of 12 files at width 88. `calls.py`, `collections.py`,
   `defs.py`, `comprehensions.py` are the likely hits.
   `chains.py`, `operators.py`, `strings.py`, `imports.py`,
   `comments.py` are the likely misses. `kitchen.py` is the
   integration bet.

8. **A new language whose native layout is not seq/body/clause
   /chain needs a runtime change.** Haskell layout, or a
   formatter that aligns table-like structures, is outside the
   kinds. That is the cost of a 5–7 KB runtime.

9. **It does not handle the excluded Python.** `async`, `match`,
   walrus, `yield`, non-trivial class bodies. Adding them is
   package work *if* they fit a kind (`match` is a `clause`
   with `case` tails; walrus is `infix`). That is a claim, not
   a proof.

---

## 7. The riskiest thing, and the smallest experiment

**Risk.** Comment attachment across the harness's source-less
second pass. If the gap encoding is wrong, `fmt(fmt(x))` moves
a comment, gate 2 fails, and the design is dead — not "slightly
off", dead. Everything else (kinds, magic commas, Wadler) has
prior art and a reference printer. This does not.

**Smallest experiment.** Do not build the package. Do not build
kinds. Write, in one language, a stub that:

1. Reads `corpus/trees/python__comments.tree.json`.
2. Reads the source when `source_file` is present.
3. Attaches comments with §5.1.
4. Emits *only* the original tokens plus the whitespace and
   comment placement §5 specifies — no reflow, identity
   otherwise.
5. Hands the output to the harness's exact `as_tree_doc` path
   (or a ten-line copy of it).
6. Attaches again with §5.2 only.
7. Emits again.

If the two emissions differ, the encoding is wrong. The cases
that will tell you first:

- trailing on `import os`
- stolen leading comment inside `documented`
- `# first` / `# second` / own-line inside `values = [`
- dangling end-of-block on `between`
- EOF comment (the indent-0 blank-line collision)

If that loop is green, comments are not the thing that kills
the design. The next experiment is `seq` + magic comma on
`collections.py` and `calls.py` at both widths, in both
runtimes, because that is gate 1 plus the sticky-comma
idempotence story. Those are smaller risks; the reference
already printed JSON this way.

A third, cheap check: measure `café` in both `fits`
implementations against a manufactured line that is exactly
`width` scalar values including `é`. If they disagree, gate 1
is waiting to fail on a future corpus file even if this one
does not.

---

## Appendix. What I considered and did not propose

A second proposal only pays if it is different in kind. These
are not.

- **A, with a tiny query subset.** Still a matcher. Still larger
  than kinds. The corpus does not reward it.
- **B, templates all the way down.** The comment and magic-comma
  logic gets copied into every bracketed node. The package
  grows; the two runtimes still have to implement the same
  implicit conventions to agree. Kinds are that convention,
  named.
- **C.** The interesting fuzz target, the wrong size and
  agreement risk for a 15-file corpus.
- **D.** The interesting optimality result, the wrong runtime.
- **Pombrio choice (`x | y`) as the IR.** Expressively nicer
  for trailing commas (the broken layout can contain a comma
  the flat one lacks without `ifBreak`). Operationally it is
  `ifBreak` plus `shouldBreak`. Not worth making the printer
  differ from the reference.
- **Backslash continuation to dodge gate 3.** Passes the gate,
  produces Python no one wants, still loses black agreement.
- **Shipping Python rules hardcoded and only using a package
  for JSON.** That is the reference. It scores the harness, not
  the design.

The framing is right. A data package can drive width-sensitive
reflow at this size, provided we do not pretend we can
parenthesize. The empty quadrant in `docs/design.md` is empty
because Topiary chose a stream and everyone else chose a
language-specific imperative printer. Kinds are the third
shape: a small catalog of algorithms, parameterized by data,
interpreted twice.
