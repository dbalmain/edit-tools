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
runtime — that is the property the design is built to hold, and the two packages
here are the evidence: JSON's five rules use the same eighteen opcodes Python's
seventy-seven do.

```sh
./build.sh          # compiles the Rust runtime; the JS runtime needs no build
./test.sh           # both unit suites, then the harness scorer
./fmt-rust corpus/trees/python__calls.tree.json 88
./fmt-js   corpus/trees/python__calls.tree.json 88
```

## The rule language

An expression is a JSON array whose first element is the opcode. Eighteen
opcodes, four selectors, one predicate. That is all of it.

### Layout

| Opcode           | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `["seq", e…]`    | concatenation                                            |
| `["group", e…]`  | one layout decision: all-flat if it fits, else broken    |
| `["indent", e…]` | one indent level deeper (`indent` in the package header) |
| `["line"]`       | a space when flat, a newline when broken                 |
| `["soft"]`       | nothing when flat, a newline when broken                 |
| `["hard"]`       | always a newline; forces every enclosing group open      |
| `["sp"]`         | a space, never a break                                   |
| `["blank", n]`   | up to `n` blank lines, as the source had them            |

### Children

Every opcode that emits a child **consumes** it. See _linearity_ below.

| Opcode                   | Meaning                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `["child", sel]`         | format the child under the cursor, which must match `sel`                                                          |
| `["each", sel, sep]`     | format every `sel` child in turn, evaluating `sep` between them — `sep` consumes whatever punctuation lies between |
| `["tok", "s"]`           | the child under the cursor is the token `s`; emit it                                                               |
| `["opt", sel, e]`        | evaluate `e` only if the child under the cursor matches `sel`                                                      |
| `["verbatim"]`           | take every child and emit the node's original source text, exactly                                                 |
| `["flatten", type, sep]` | collect a left-nested operator chain and join it — see below                                                       |

### Choice

| Opcode                       | Meaning                                             |
| ---------------------------- | --------------------------------------------------- |
| `["when", pred, then, else]` | a static test on the node                           |
| `["trail", "s", sel]`        | the trailing-separator policy — see below           |
| `["paren", e…]`              | the balanced-paren policy — see below               |
| `["autoparen", sel]`         | `paren` applied to a child, if its type asks for it |

Selectors pick a child: `"f:name"` (tree-sitter field), `"t:identifier"` (node
type), `"named"` (any type not listed in the package's `tokens`), `"*"`.
The one predicate is `["count", sel, n]`, which describes the node, not the
cursor. I wrote two more while building this and deleted them: neither package
ever needed anything but arity.

### The package header

```json
{
  "indent": 4,
  "tokens": ["(", ")", ",", ":", "and", "or", "def", …],
  "comments": ["comment"],
  "descend": ["block"],
  "optional_parens": ["binary_operator", "boolean_operator", …],
  "precedence": { "|": 9, "^": 8, "+": 5, "*": 4, … },
  "rules": { … }
}
```

`tokens` is the one language fact the runtime cannot guess: which node types are
punctuation and keywords rather than content. `named` is defined as "not one of
these". `comments` and `descend` drive comment attachment; `optional_parens` and
`precedence` drive `autoparen` and `flatten`.

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

The list, set, dict and tuple rules are the same expression with different
brackets and **one group instead of two**, which is exactly black's rule: a call
or a `def` splits its brackets first and its arguments only if it must; a
collection literal that splits at all splits one element per line. That the
distinction is expressible as "one group or two" — rather than as a flag — is
the strongest evidence I have that the IR is at the right altitude.

## The three mechanisms that carry the design

### 1. `flatten`, and why a per-node fold fails without it

`a and b and c and d` parses as a left-nested tree. A naive fold gives nested
groups, so the innermost breaks first and you get a staircase. Black instead
breaks every operator in a chain together.

`["flatten", "boolean_operator", sep]` walks the `left` spine collecting
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

### 2. Two policies, and nothing else, may touch tokens

The linearity invariant says a rule's consumed children must be a disjoint,
ordered partition of the node's direct children, and that token mutation is
allowed only through enumerated policies. Here that holds **by construction,
because the language cannot express anything else**:

- There is no opcode that emits arbitrary text. `tok` names a token it must find
  under the cursor; `child` recurses into a real child; `verbatim` emits the
  node's own source. Whitespace opcodes emit no tokens.
- A rule may only ever consume the child **under the cursor**. Skipping,
  revisiting and reordering are unreachable, not merely discouraged.
- At the end of a rule the cursor must be at the end of the children, or the
  runtime refuses the file with a non-zero exit.

The two sanctioned mutations are opcodes:

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

Refusals are honest and specific: _"rule for `parenthesized_expression` wants
Named but found `lambda`"_ was a real bug report from the runtime to me during
development.

Everything else that could destroy code is simply not in the language. There is
no reordering, no deletion, no quote rewriting, and no way to add one.

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

## Two runtimes, written twice

`fits` measures the rest of the printer's stack, not just the group — otherwise
a trailing `)` or a trailing comment costs nothing and the line silently
overflows. Trailing comments **do** count against the budget, which is black's
behaviour and the reason `settings = {…}  # shallow merge is fine` breaks at
width 60.

Width is Unicode scalar values in both runtimes: `s.chars().count()` in Rust,
`[...s].length` in JS. Both runtimes have a test that pins it, because the
failure is invisible until someone writes an emoji.

Indentation is written lazily, so a blank line is genuinely empty rather than a
run of spaces.

The two implementations are independent, not transliterations. The Rust one
parses the package into a typed `Expr` enum with `TryFrom<Value>`, so a
malformed package fails at load with a message; the JS one interprets the arrays
directly and caches break-propagation on each Doc node at construction, which
the Rust one recomputes. Same algorithm, different idiom, byte-identical output
on 30/30 corpus runs.

## What changed from the proposal, and why

- **Eighteen opcodes, not fourteen.** `suffix` was dropped from the language
  entirely (the runtime owns comments, so no package needs it) and `ifbreak`
  never earned a use, but `sp`, `opt`, `verbatim`, `blank`, `trail`, `paren` and
  `autoparen` were all needed. The growth is in _policies_, not in `when` —
  which is what the proposal named as the risk. `when` ended up with a single
  predicate and appears twice in the whole of Python, both times an arity check.
  The bytecode approach (design C) was not the honest answer.
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
- **Blank lines are preserved and capped (2 at module level, 1 inside a block),
  not normalised.** Black enforces two blank lines around top-level definitions;
  I do not. On this corpus, whose sources are already black-clean, the two agree
  — a corpus with sloppy blank lines would show the difference.

## Scores, as measured

```
[PASS] 0-coverage       30/30   formatted every corpus file at every width
[PASS] 1-agreement      30/30   rust and js byte-identical
[PASS] 2-idempotence    30/30   fmt(fmt(x)) == fmt(x)
[PASS] 3-nondestruction 30/30   meaning and comments preserved

overflow lines     6            (black's own, at 88: 0)
size (gzip)        7571 B = 5563 runtime + 2008 packages
black agreement    11/12        (strings.py, on quote style alone)
```

Against the 25 KB budget that is 7.6 KB, and I will repeat the proposal's claim:
**size is not the binding constraint** for any design in this space. Every
serious entry will fit. The axis that matters is whether the rules stay
readable, and the honest test of that is whether you could have written
`packages/python.json` from this document.
