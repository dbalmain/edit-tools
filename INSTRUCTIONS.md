# Spike: replace the alignment modes with a `cell` doc node

You are working in a git worktree of `editor-tools`, on branch
`spike/cell-node-agy`, based on `main`. **Work only in this directory.** Other
worktrees of the same repository are in use by other agents; editing outside
this one will collide with them.

This is a **spike**: the deliverable is a measurement and a recommendation, not
a merge. A spike that comes back *"this does not work, and here is precisely
where"* is a success. Two spikes ran on this project recently — one recommended
declining a capability and gave the price; the other recommended landing one and
corrected three claims the design register had stated too confidently.
Correcting the framing is worth as much as the implementation.

---

## 1. What this project is

`editor-tools` is a syntax highlighter and formatter with **two idiomatic
implementations** — Rust (`rust/`) and JavaScript (`runtime-js/bundle.js`) —
that share a downloadable, **data-only** language package format. It targets
blog editing tools on the web and editing fields in TUIs. It is explicitly not
a drop-in replacement for a project's own formatter.

A **package** (`packages/<lang>.json`) is a table from CST node type to a
Doc-building expression. The Doc IR is Wadler/Oppen: `Text`, `Concat`, `Group`,
`Indent`, `Line`, `Soft`, `Hard`, `IfBreak`, `Suffix`, `BreakParent`. The
opcode set, selectors and predicates are documented in `DESIGN.md`.

**Both runtimes must produce byte-identical output** on every corpus file at
every width. That is gate 1 and it is a hard requirement.

Start by reading, in this order:

- `DESIGN.md` — the IR and the opcode set
- `docs/onboarding/FINDINGS.md` **entry 1** — the alignment capability, its
  full cost decomposition, and its per-policy price table
- `docs/onboarding/FINDINGS.md` **entry 18** — the same question for Rust
- `packages/go.json` — the only package that uses alignment today
- `packages/json.json` — the small worked example of a package

---

## 2. The problem

`alignment` is an **opaque named mode**. `packages/go.json` says
`"alignment": "go"` and gets gofmt's entire policy set. Nothing else can say
anything at all. It costs **2,593 gzip bytes**.

The pass works by reading **rendered text**: after `print()` returns, it
re-lexes the output to find comments and string literals, splits rows into
cells by hard-coded rules, and pads. Roughly:

| part | bytes |
| ---- | ----: |
| scanner / splitter / padder | ~2,000 B |
| eight gofmt policies, together | 555 B |

The re-lexing is the part that does not scale. A Rust version was prototyped at
796 B, of which **270 B is a Rust-specific lexer** — nesting `/* */`,
`r#"…"#`, backslash line continuations. Every further language pays that again,
because the pass re-derives from text what the parser already knew.

**gofmt itself does not work this way.** `go/printer` emits vertical-tab
characters into its output, and `text/tabwriter` aligns on those *markers* —
it never re-lexes. Our implementation reproduced the tabwriter and skipped the
marker.

---

## 3. The proposal

A `cell` doc node. The **package** declares where a column may break, because
the package is the thing building the Doc:

```json
["seq", ["child", "name"], ["tok", ":"], ["sp"], ["child", "type"],
        ["cell"], ["child", "comment"]]
```

`print()` emits a marker rather than measuring anything, and one
language-independent pass aligns runs of rows over markers. No per-language
lexer, ever again.

**This is a sketch, not a specification.** Whether a single node is enough is
the open question (§5). If a different shape is better, build that one and say
why. A correct *"this is actually X"* is worth far more than an implementation
of a guess.

---

## 4. The bar this must clear

**Migrate `packages/go.json` off `alignment: "go"` and hold Go at 12/16
agreement.** If cells cannot reproduce gofmt, this is not a replacement and the
answer is *decline*. That is the whole test.

The sharp check is a committed fixpoint probe, not the 16-file corpus:

```sh
./harness/probe_alignment.py --align-only
```

On unmodified `main` it reports **10 mangled / 4,814 checked (0.21%)** over
`GOROOT/src`. A cell-based Go package must not do materially worse. The corpus
is 16 files; the probe is 4,814, and it is one-sided in the useful direction —
its input is already gofmt's own output, so **any change it detects is a
disagreement by construction**. No expectations are hand-written and there are
no false positives.

---

## 5. The question that decides the shape

An earlier design proposed a general `column` opcode and it was **rejected**,
because it padded a whole block uniformly. What made the Go pass work was the
**run semantics**:

- a run is **contiguous** rows at the same indent;
- a **blank line resets** the run;
- a row with **fewer cells terminates the column**, so the rows below start a
  fresh one — `err error` with no comment splits the comment column in two;
- `}` and `)` group closers are excluded.

Those must survive somewhere. **Do they fall out of package cell placement, or
must the package express them too?** If the package has to declare all of it,
"a series of opcodes" may cost more than the modes it replaces — and that is a
legitimate finding, not a failure.

The same question applies to gofmt's eight policies: `keepTypeColumn`,
`DiscardEmptyColumns`, merged name lists, the struct-tag slot, tabwriter
blocks, group closers, continuation lines, block comments. Each has a measured
price and probe number in FINDINGS entry 1. Some may fall out for free once the
package decides where cells go. **Say which did and which did not.**

---

## 6. What to produce

Five results, each measured rather than estimated:

1. **Go agreement before and after** — corpus (12/16 today) and probe
   (10/4,814 today). Both numbers.
2. **gzip delta on `runtime-js/bundle.js`** against `main`'s **13,923 B**.
   Removing the alignment pass should *subtract* 2,593 B; the cell machinery
   adds something back. **The net may be negative — say so plainly if it is.**
   Plus the `packages/go.json` delta.
3. **Every other language byte-identical**, verified by re-scoring rather than
   by reading the code. `main` scores **91/138** reference agreement. This
   check is not optional: an earlier spike caught a real problem precisely by
   re-scoring instead of assuming a feature was inert.
4. **Would this reach Rust's alignment cheaply?** rustfmt aligns trailing
   comments on **list items only** (FINDINGS entry 18). With cells available,
   what would `packages/rust.json` have to say, and roughly what would it cost?
   **A sketch and an estimate — do not build the Rust package.**
5. **A Scheme sketch.** Scheme is not yet onboarded. `(let ((a 1) (bcd 2)) …)`
   wants its binding values aligned. Show what the cell expression would look
   like. This is the generalisation the whole idea exists for. **Sketch only.**

---

## 7. Commands

Build both runtimes, then run the gates:

```sh
./build.sh                 # cargo build --release; required before the gates
./test.sh                  # unit tests, tree-interface and injection probes
./harness/score.py .       # the four gates, sizes, and reference agreement
```

Narrower checks:

```sh
./harness/score.py . --language go        # one language
./harness/probe_alignment.py --align-only # the 4,814-file fixpoint probe
./harness/review_formatter.py . --language go   # inspect each differing pair
```

`./test.sh` must exit **0 with zero warnings**, and `./harness/score.py .` must
pass, before any commit. Do not claim a gate you have not run.

---

## 8. Constraints

- **Both runtimes.** `rust/` and `runtime-js/bundle.js` must stay
  byte-identical in output. The old alignment pass was pure text and mirrored
  into JS cheaply; this one touches `print()`, so it may not. **If parity turns
  out to be the expensive part, say so** — that contradicts a standing
  assumption on this project and is worth knowing on its own.
- **Gates 1-3 stay green.** Idempotence, width compliance and non-destruction
  are hard requirements. A capability that breaks one is not a candidate,
  however good its agreement number.
- **Do not edit anything under `harness/`.** If you believe a harness change is
  needed, describe it in the report instead of making it.
- **Do not run `git push` under any circumstances.** Not for any reason.
- **Commit at each green boundary**, not one commit at the end. Runs on this
  project have been ending early; committed work survives and uncommitted work
  does not. A partial spike with commits is far more useful than a complete one
  that was never saved.
- **`git add` named paths. Never `git add -A`** — it commits files you have not
  read, including anything a tool wrote while you were working.
- **Do not print corpus trees.** The files in `corpus/trees/` are thousands of
  lines each, and printing them has ended several runs on this project. Query
  them instead:

  ```sh
  python3 -c "import json;d=json.load(open('corpus/trees/go__structs.tree.json'));\
  s=set()
  def w(n):
      s.add(n['type']); [w(c) for c in n.get('children',[])]
  w(d['root']); print(sorted(s))"
  ```

---

## 9. Refusal is a real answer

If cells cannot hold Go at 12/16, or if reproducing the run semantics inside a
package costs more than the 2,593 B it replaces, **say so and stop**. The design
register exists to record declined capabilities with their price attached, and
the alignment entry is already one of those. An honest *decline* with a number
attached is a better outcome than a *land* that quietly loses Go agreement.

---

## 10. Report

Write `docs/onboarding/cell-spike-agy.md`:

- the shape you built, and why that shape
- the five results in §6
- which gofmt policies fell out for free, and which had to be expressed
- what surprised you
- a plain recommendation: **land**, **decline**, or **land a reduced version**

Prose, not a transcript. Mark numbers you measured as measured, and anything
you estimated as estimated.
