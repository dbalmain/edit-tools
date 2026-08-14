# Formatter model competition

Three models (Claude, Codex, grok) propose and implement formatting-package
designs. Submissions are scored on machine-checkable gates first and judgment
second, then blind-evaluated.

This document is the contract. Every submission is built against it.

## The bounding trick: no parser

**Competitors do not write a parser.** The thing under evaluation is the package
format, the Doc IR, and the dual-runtime agreement — not tokenisation. Feeding
everyone a pre-parsed tree removes roughly 80% of the work and makes submissions
directly comparable, because they are all formatting the _same_ tree.

The harness generates concrete syntax trees once, using real `tree-sitter`
grammars, and checks them into `corpus/`. Every submission reads them.

This also defers the [escape-hatch problem](design.md#the-escape-hatch-problem)
entirely, which is the right call: it is a parsing problem, and it should not be
allowed to sink a formatting experiment.

### Tree format

One `.tree.json` per corpus file. Deliberately boring:

```json
{
  "language": "python",
  "root": {
    "type": "module",
    "start": 0,
    "end": 431,
    "children": [
      {
        "type": "function_definition",
        "start": 0,
        "end": 120,
        "field": null,
        "children": [
          { "type": "def", "start": 0, "end": 3, "text": "def" },
          {
            "type": "identifier",
            "start": 4,
            "end": 7,
            "field": "name",
            "text": "foo"
          }
        ]
      }
    ]
  }
}
```

- Leaf nodes carry `text`; interior nodes carry `children`. A node has one or
  the other, never both.
- `start`/`end` are byte offsets into the original source, retained so a design
  can consult original layout (blank lines, magic trailing comma) if it wants
  to. The original source is available as a sibling `.py` / `.json` file.
- `field` is tree-sitter's field name where one exists, else absent.
- **Comments appear as ordinary nodes in the child list**, exactly as
  tree-sitter emits them. Comment attachment is therefore part of what is being
  evaluated, which is correct — it is a large fraction of any real formatter.

### Languages

**JSON** — the smoke test. Proves the pipeline end to end in hours, not days.
Every submission must pass JSON before Python is scored.

**A frozen subset of Python** — chosen to stress reflow, not coverage. Roughly
15 node types:

- `def` with long parameter lists: defaults, annotations, `*args`, `**kwargs`
- call expressions with long argument lists, including nested calls
- list / dict / set / tuple literals, nested
- boolean and comparison chains (`and` / `or` / `==`)
- binary arithmetic chains
- list and dict comprehensions, with `if` clauses
- chained attribute access and method chains
- `if` / `elif` / `else`, `for`, `while`, `with`, `try` — statement indentation
- `import`, `from ... import (...)`
- decorators, lambda, ternary, subscripts and slices
- `return` with long expressions
- comments: own-line, trailing, and inside bracketed lists
- blank-line runs between top-level definitions

Excluded: `async`, `match`, walrus, `global`/`nonlocal`, `yield`, class bodies
beyond the trivial case. f-strings and all string literals are **opaque leaves**
and must never be reflowed — a deliberate correctness trap.

Widths tested: **88** (black's default) and **60** (to prove width-sensitivity;
a submission that hardcodes breaks will pass 88 and fail 60).

## Submission contract

At the worktree root:

```
submission/
  DESIGN.md        the rule language, explained, with rationale
  build.sh         builds both runtimes; must be hermetic
  fmt-rust         executable: fmt-rust <tree.json> <width> -> formatted text on stdout
  fmt-js           executable: fmt-js   <tree.json> <width> -> formatted text on stdout
  packages/        the language packages, as shipped (data)
  runtime-js/      the JS runtime, with a bundle target for size measurement
```

Non-zero exit means "I refuse to format this", which is a legitimate answer and
is scored separately from producing wrong output.

## Scoring

Gates 1–3 are pass/fail. **Failing any gate disqualifies the submission** — they
are correctness properties, not preferences.

1. **Cross-runtime agreement.** `fmt-rust` and `fmt-js` produce byte-identical
   output on 100% of the corpus at both widths. This is the whole premise of the
   project; a submission that cannot hold it has not demonstrated anything.
2. **Idempotence.** `fmt(fmt(x)) == fmt(x)` for all corpus files at both widths.
3. **Non-destruction.** The output parses, means the same thing as the input,
   and drops no comment. This is the "does not corrupt code" property.

   Meaning is compared via the language's own parser —
   `ast.dump(ast.parse(...))` for Python, ordered `json.loads` for JSON — with
   comments compared separately via `tokenize`, since `ast` cannot see them.

   That choice matters, and an earlier token-stream version of this gate was
   wrong. **Black inserts parentheses when it wraps a long expression**, and
   turns a bare target list into a parenthesised one; comparing tokens or even
   tree shape would have disqualified correct black-style output. Deferring to
   `ast` draws the line where it belongs: **parenthesisation, quote style,
   trailing commas and line breaks are yours to change; anything else is not.**

   `harness/check_gate3.py` pins this by running black over the whole corpus at
   both widths and asserting it passes — if a real formatter would fail the
   gate, the gate is wrong. Re-run it after touching the comparison.

Then, measured:

4. **Width adherence.** Count of lines exceeding the budget that could have been
   broken (a single over-long token is exempt). Lower is better.
5. **Size.** Gzipped bytes: JS runtime bundle + Python package. Against the
   [budget](design.md#size-budget). This is the project's differentiator and
   carries real weight.
6. **Black agreement.** Percentage of Python corpus files whose output at width
   88 matches `black`. Not a requirement — a submission may justify differing —
   but a useful proxy for "reflows the way a human expects".

Then, judged (this is where the blind evaluation earns its keep):

7. **Expressiveness and readability of the rule language.** Could a competent
   contributor add a language without reading the runtime? How much of the
   Python package is escape hatch versus declarative rules?
8. **Honest assessment of what the design cannot do.** A submission that names
   its own limits precisely is worth more than one that hides them.

Gates 1–6 are arithmetic, computed by the harness. That is what makes the blind
evaluation worth running: judgment applies only at the margin, on top of facts.

## Protocol

### Phase 0 — harness (main thread, before anything else)

Build `corpus/` and `harness/score.py` **first**. Without a shared scorer, each
competitor invents its own evaluation and nothing is comparable. Publish the
corpus and scorer to every competitor as read-only inputs.

The corpus is frozen once published. Competitors may add _test_ inputs to
`corpus/contrib/` — shared, visible to all — but the scored corpus does not
change.

### Phase 1 — design (all three, parallel, cheap)

Each model researches and writes one or more proposals to
`proposals/<model>-<n>.md`. No code. A proposal states the package format, the
IR, the runtime split, an estimated size against the budget, and — required —
what the design cannot do.

Per the [offload playbook](~/.claude/agent-playbook.md), A/B on diagnoses is
worth more than A/B on implementations. **This phase is the high-value one.**

### Phase 2 — selection (main thread, with Dave)

Pick **three designs total**, not three per model. Diversity of approach matters
more than provenance: three variations on Query→Doc IR is a waste of three
worktrees. If two models converge on the same design, that is a strong signal —
fund it once and spend the slot elsewhere.

### Phase 3 — implementation (three worktrees, one writer each)

Fresh context per implementation, seeded with the proposal, the contract, and
the harness. Each in its own git worktree — **never two writers in one repo**.

Required of implementers: commit at each green boundary, not once at the end. A
commit boundary survives a cut-off; a dirty tree costs an hour of forensics.

### Phase 4 — withdrawal

Any model may withdraw its own submission. Withdrawal is free and is not held
against it; shipping something known-bad is worse than shipping nothing.

### Phase 5 — blind evaluation

Submissions are anonymised as `sub-a`, `sub-b`, `sub-c` with git history
stripped, plus the harness's computed scores for each. All three models evaluate
all surviving submissions.

**This is weakly blind and we should not pretend otherwise.** A model can often
recognise its own code from style alone. The mitigation is that gates 1–6 are
arithmetic and carry most of the weight; judgment is confined to items 7–8. An
evaluator that ranks a submission above its measured gates must justify it in
writing.

## Budget

The main thread writes the doc, the harness and the final scoring. **All
implementation happens in subagent/CLI contexts against their own budgets**, not
the main thread's — the main thread's 5-hour window is the scarcest resource
here and must not be spent on compile-fix loops.

Rough shape: Phase 0 is the main thread's real work. Phases 1 and 3 are
offloaded. Phase 5 is offloaded with the main thread aggregating.
