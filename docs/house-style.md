# House style: what we optimise for when we differ

Stated by Dave on 2026-08-16. This is a **goals-level** document: it changes
what a stage-C package should do, and it changes what the scorer should count as
a failure.

## The product this is for

Blog editing tools on the web. Editing fields in TUIs. Somewhere a person is
looking at a snippet in a box.

It is **not** a drop-in replacement for the standard formatter a project runs in
CI, and it is not a replacement for the formatter in your editor. Those tools
are judged by whether they leave a clean diff against what the team already
agreed. We are judged by whether the thing in the box is readable.

That difference licenses everything below.

## Matching the reference is a means, not the end

We measure agreement with black, prettier, taplo and the rest because a
canonical formatter is a **cheap, honest, external standard of readability**
that we did not get to invent. A high agreement score means we are producing
something a practitioner would recognise as well-formatted. That is worth a lot,
and it stays the default.

But when we differ, **the tie-break is readability, not fidelity** — and after
readability, **consistency across languages**.

If keeping the runtime small means JavaScript comes out looking a bit more like
Kotlin than a JS developer expects, that is a **good** outcome. A person editing
a snippet in a text box benefits more from one predictable layout discipline
across every language than from fifteen faithful reproductions of fifteen
communities' historical arguments.

This inverts the usual instinct. A divergence is not automatically a defect to
be driven to zero. Some divergences are the design working.

## The first house rule: containers do not share a line

**Never put a data structure on one line with another data structure inside
it.** If a container has a container among its children, it breaks.

The candidate exception, deliberately narrow: **an object whose only container
children are arrays of scalars may stay flat** —
`{"one": [1, 2, 3], "two": [8, 3]}`. Dave's stated position is that he would be
happy to drop even this and break those too, so treat the exception as the thing
to remove first if it ever causes trouble, never as something to widen.

### What that does to the JSON corpus

`nested.json` is the whole picture, and every container in it was classified to
produce this.

Prettier's actual rule — confirmed against its output, not assumed — is narrower
than ours in one way and wider in another. It applies to **arrays only**, needs
**at least two elements**, and needs **every element** to be a multi-element
container. Objects are never broken by kind, only by width.

| Container                                            | Prettier  | House rule           |
| ---------------------------------------------------- | --------- | -------------------- |
| `["primary", "us-east"]` — all scalars               | flat      | flat                 |
| `{ "alpha": "^1.0.0", … }` — all scalars             | flat      | flat                 |
| `[[1,2,3], [4,5,6], [7,8,9]]` — all arrays, 46 chars | **break** | **break**            |
| `[{host…}, {host…}]` — all objects                   | break     | break                |
| `{ "host": …, "tags": [...] }` — holds one array     | flat      | flat _via exception_ |
| `{ "a": { "b": { "c": … } } }` — objects in objects  | **flat**  | **break**            |

So with the exception in place, **the only place the house rule disagrees with
prettier on this corpus is the `deep` chain** — and that is prettier at its
least readable, five levels of nested object on one line:

```json
  "deep": {
    "a": { "b": { "c": { "d": { "e": ["leaf value one", "leaf value two"] } } } }
  },
```

against the house rule's:

```json
  "deep": {
    "a": {
      "b": {
        "c": {
          "d": { "e": ["leaf value one", "leaf value two"] }
        }
      }
    }
  },
```

The house rule also fixes `matrix`, which is one of the two JSON divergences on
record — so adopting it **improves** measured agreement while being stated as a
readability rule rather than a compatibility fix. That is the shape to look for.

### Cost

One predicate. `docs/roadmap.md` point 5 called this "pile A" — a static test on
the children with a static answer, needing no printer change and no layout
backtracking. The house rule is `any child is a container`, where prettier's is
`all children are containers`, so it is the same predicate with a different
quantifier.

## Consequences for the scorer, which are not yet built

This is the part that needs work before round 2, because it changes a merge bar
that thirteen more languages will be judged against.

Today `score.py` reports reference agreement as a single number, and
`review-brief.md` sets a **70% floor** with the instruction to be "suspicious of
a package that beats the reference". Under this document, some divergences are
**intentional**, and the current machinery cannot tell them from mistakes:

- The scorer counts an intentional divergence as a failure, so a package gets
  worse the more it follows the house style.
- A stage-D reviewer, following the brief, would file the house rule as a defect
  and "fix" it back toward the reference.
- Nothing records _why_ a divergence is intended, so the next agent re-litigates
  it.

**What is needed:** intentional divergence must become first-class — declared
per language, with a reason, and reported by the scorer separately from
unexplained divergence. The 70% floor should then apply to the unexplained kind
only.

Until that exists, treat the JSON numbers as provisional and do not let anyone
drive them up by removing house style.

## How to apply this at stage C

- **Default to the reference.** It is right far more often than not, and
  agreement is still the primary signal.
- **When you diverge, say which rule you are following and why it reads
  better.** A divergence with an argument is a finding; a divergence without one
  is a bug.
- **Prefer the rule that generalises across languages** over the one that
  matches this language's reference most exactly. Every language-specific
  special case is a byte in the runtime and a surprise for a reader.
- **Never trade away a safety property for readability.** The linearity
  invariant, refusal-rather-than-guess, and non-destruction are not style. This
  document is about layout only.
