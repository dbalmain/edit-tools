# claude-1: the package is a Doc program indexed by node type

A per-node-type table of Doc-building expressions in a ~14-opcode language,
evaluated by a recursive tree-walker. Design space entry B, with the one
addition (`flatten`) that I think decides whether B works at all.

## The shape

Formatting is a fold: `fmt : Node -> Doc`. So the package is a map from node
type to an expression that builds that node's Doc from its children, and the
runtime is `eval(expr, node) -> Doc` plus the Wadler printer. No query engine,
no matching — dispatch is a hash lookup on `node.type`.

### The language

Expressions, as JSON arrays (opcode first):

| Opcode                           | Meaning                                     |
| -------------------------------- | ------------------------------------------- |
| `["lit", s]`                     | literal text                                |
| `["child", sel]`                 | format one child, recursively               |
| `["each", sel, sep]`             | format every matching child, `sep` between  |
| `["seq", ...]`                   | concatenation                               |
| `["group", ...]`                 | Wadler group                                |
| `["indent", ...]`                | +1 level                                    |
| `["line"]` `["soft"]` `["hard"]` | space/nothing/always at a break             |
| `["blank"]`                      | preserved blank-line run, capped            |
| `["ifbreak", a, b]`              | `a` if the enclosing group broke, else `b`  |
| `["when", pred, a, b]`           | static condition on the node                |
| `["flatten", type, sel, sep]`    | see below — the load-bearing one            |
| `["suffix", ...]`                | trailing content that survives a line break |

Selectors: `f:name` (field), `t:identifier` (type), `named`, `rest`, `i:2`.
Predicates: `trailing-comma`, `count>N`, `child-is t:...`, `blank-before`.

That is the entire language. Fourteen opcodes, five selectors, four predicates.

### A real fragment

Python `argument_list`, with black's magic trailing comma:

```json
[
  "when",
  "trailing-comma",
  [
    "seq",
    ["lit", "("],
    [
      "indent",
      ["hard"],
      ["each", "named", ["seq", ["lit", ","], ["hard"]]],
      ["lit", ","]
    ],
    ["hard"],
    ["lit", ")"]
  ],

  [
    "group",
    ["lit", "("],
    ["indent", ["soft"], ["each", "named", ["seq", ["lit", ","], ["line"]]]],
    ["ifbreak", ["lit", ","], ["lit", ""]],
    ["soft"],
    ["lit", ")"]
  ]
]
```

The first branch is black's rule that a trailing comma in the source forces the
call open permanently; the second is ordinary width-driven reflow that _adds_ a
trailing comma only when it breaks. `dictionary` is the same expression with
different brackets, which is the point — the table has a lot of near-duplicates
and gzip eats them.

## `flatten`, and why B fails without it

This is the part I would get wrong if I hadn't looked at `operators.py`.

`a and b and c and d` parses as a left-nested tree of `boolean_operator`. A
naive fold gives nested groups, so the _innermost_ group breaks first and you
get staircasing:

```python
x = (a
    and b
        and c)
```

Black instead breaks every operator in a chain together, because it treats the
whole chain as one group. A per-node fold structurally cannot see the chain.

`["flatten", "boolean_operator", "named", sep]` collects a maximal run of
same-type left-nested descendants into one flat child list, then joins it. One
opcode, and it covers the whole class: boolean chains, arithmetic chains,
comparison chains, and attribute/method chains — four of the twelve corpus
files. Without it I would rate this design unlikely to beat Topiary-grade
output; with it I think it reaches black.

## Runtime/package split

Runtime: the evaluator, the printer, comment attachment, blank-line capping.
Package: every language-specific decision, including which nodes are
punctuation. The line is "does it mention a node type?" — if yes it belongs in
the package. That keeps a second language additive: no runtime change.

## Comments

Handled by the runtime, not the package, because getting it wrong is
catastrophic and per-language rules would multiply the risk.

A pre-pass walks the tree and attaches each `comment` node to a neighbour by one
language-independent rule: **a comment alone on its line attaches as a leading
item of the following sibling; a comment sharing a line with preceding code
attaches as a `suffix` of that sibling.** Trailing-at-end-of-block attaches to
the block. The evaluator then emits attached comments around each node's Doc
automatically, and packages never mention comments.

This needs `suffix` (Prettier's `lineSuffix`) in the IR — content deferred to
just before the next newline — so `design.md`'s constructor set is one short.
`# trailing comment on a statement` cannot otherwise survive a group that breaks
after it.

## Size

Roughly 40 node types for the Python subset, ~25 tokens each. As JSON with
one-character opcodes: ~7 KB raw, **~2 KB gzipped** — the table is extremely
repetitive. Runtime: evaluator ~150 lines, printer ~120, comments ~80, so ~9 KB
raw and **~3 KB gzipped**.

Against a 25 KB budget that is 5 KB. **The budget is not the binding
constraint** for any design in this space, and I think the competition should
stop treating size as a differentiator — every serious entry will fit. The real
axis is expressiveness, and second is whether the rules stay readable.

## What it cannot do

- **Anything needing to try two layouts and pick one.** Prettier's
  `conditionalGroup` — used for hugging a sole collection argument
  (`foo([1, 2, 3])` breaking the list, not the call) — has no equivalent here.
  `when child-is` approximates the common case and will be wrong at the edges.
  `calls.py` and `kitchen.py` are where this shows.
- **Context-dependent rules.** Dispatch is on node type alone, so "format this
  differently inside a `return`" needs either a duplicated node type or an
  inherited-context mechanism I have deliberately left out. `misc.py` has cases.
- **Reordering.** Not expressible, and I consider that a feature.
- Hardest corpus files, in order: `kitchen.py`, `calls.py`, `operators.py`.

## Riskiest thing, and the experiment

The risk is that `when` grows. Every black special case is a temptation to add a
predicate, and the failure mode is a general expression language wearing a
schema costume — at which point approach C (bytecode) was the honest answer all
along and this design is strictly worse than it.

**Smallest experiment:** implement only `operators.py` and `comments.py`, both
widths, JS only, no Rust. Those two carry `flatten` and the comment pre-pass —
the two mechanisms I am least sure of. If they land in under ~400 lines with no
new predicates, the design holds and the rest is bulk. If `when` has grown three
new cases by then, abandon B and go to C.

## Note on the corpus

Two observations from building the harness that bear on any design here:

1. Gate 3 permits inserting parentheses (validated: black passes it), so
   black-style expression wrapping is available. An earlier token-comparison
   version of the gate forbade it; anyone who read `competition.md` before
   commit `77d05e4` may have designed around a constraint that no longer exists.
2. Magic trailing comma is idempotence-safe — breaking preserves the comma that
   caused the break — but any rule keyed on "was multi-line in the input" is
   not, and also contradicts full reflow. I would forbid such predicates
   outright rather than trust each package to avoid them.
