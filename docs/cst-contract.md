# The CST contract, `et-cst/1`

What a parse layer must promise so that both runtimes can consume its trees.

`docs/parse-layer.md` item 3 asks to "promote `docs/tree-interface-probe.md` to
a versioned CST contract with a conformance suite … any parse layer that passes
it feeds both runtimes." This is that contract. The probe document is the
evidence behind it and stays as written; this is the normative half, and it
differs from the probe in three places where **the corpus falsified the prose**
(C-4, U-1, U-2 below).

Run it:

```sh
./harness/parse_conform.py --adapter './harness/adapters/tree_sitter_adapter.py'
./harness/parse_conform.py --adapter './harness/adapters/json_cst_adapter.py' --language json
```

Every clause below is either **traceable to a check** in
`harness/parse_conform.py` or marked **UNCHECKED**, with the reason. Nothing
here is asserted from reading the runtimes; each checked clause was run against
all 234 committed corpus trees before it was written down.

## Status of this version

|                     |                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Version             | `et-cst/1`                                                                                |
| Suite               | `harness/parse_conform.py`                                                                |
| Dirty oracle        | `corpus/trees-edited/`, 242 fixtures                                                      |
| Clean oracle        | `corpus/trees/`, 234 trees (228 in the suite; 6 injected, excluded)                       |
| Positive control    | `harness/adapters/tree_sitter_adapter.py` — 6,044 checks, 0 failures                      |
| Discriminating case | `harness/adapters/json_cst_adapter.py` — see [Is the suite tested?](#is-the-suite-tested) |

## 0. The oracle is not "tree-sitter"

Two clauses below say "matches the frozen oracle", and that phrase needs a
referent, because **tree-sitter's answer for a given source is not a single
value.** Three separate results say so:

- **Scratch versus incremental.** `harness/parse_oracle.py` finds inputs where
  parsing from scratch and reparsing incrementally from an edited tree produce
  different trees — different enough that the root node's _type_ differs. 145
  divergences in 60,480 states, in 8 of 16 languages. See
  [The oracle's own non-determinism](#6-the-oracles-own-non-determinism).
- **Native versus wasm.** The wasm track established that native and wasm
  tree-sitter disagree, because `iswalpha`/`iswalnum` are locale-dependent in a
  native build and fixed in wasm, and six pinned grammars classify identifier
  characters through them.
- **Locale.** Now closed on `main` (`c110638`): `manifest.py` and `gen_trees.py`
  did locale-dependent text IO, one of which decided the bytes of a committed
  artifact. Both fixed, `LC_CTYPE` pinned to UTF-8 in `gen_trees.py`, and all
  234 trees verified to regenerate byte-identically under `LC_ALL=C`. **The
  corpus is locale-invariant.**

So the oracle this contract is written against is, precisely:

> **tree-sitter 0.26.0, native build, at the grammar version pinned in
> `harness/languages/<lang>.toml`, parsing from scratch, under a UTF-8
> `LC_CTYPE`.**

Every fixture in `corpus/trees-edited/` carries that provenance in its own
`oracle` block and records `"parse": "scratch"`. A conformance claim that does
not name a build, a grammar pin and a parse mode is not a claim.

## 1. The tree

A document is JSON:

```text
{ "language": <string>, "source": <string>, "root": <node> }
```

A node is:

```text
{ "type": <string>, "start": <int>, "end": <int>,
  "field"?: <string>, "language"?: <string>,
  "text"?: <string>, "children"?: [<node>], "missing"?: true }
```

`source_file` is harness-only; the runtimes ignore it. Unknown keys are ignored
by both runtimes — `rust/src/tree.rs` deserialises without
`deny_unknown_fields`, and the JS loader reads named properties — which is what
lets `corpus/trees-edited/` carry `edit`, `problems`, `oracle` and `missing`
without any consumer changing.

`missing` is new in this version. tree-sitter renders a MISSING node as a
zero-width leaf whose `type` is the token it wanted, which is not otherwise
distinguishable from a genuine empty leaf — and genuine empty leaves exist (30
`block_continuation` in markdown, 2 `raw_text` in html). Neither runtime reads
it; it is for the oracle.

## 2. Structural clauses — checked, no oracle needed

These hold for any language, including one with no frozen corpus, which is what
makes them the useful half for a new parse layer. All are checked by the
`structure` suite over both corpora.

| ID       | Clause                                           | Check                            |
| -------- | ------------------------------------------------ | -------------------------------- |
| **S-1**  | `source` round-trips the input bytes exactly     | `structure`                      |
| **S-2**  | every node has a non-empty string `type`         | `structure`                      |
| **S-3**  | `start <= end`                                   | `structure`                      |
| **S-4**  | `end <= len(source)`                             | `structure`                      |
| **S-5**  | `start` and `end` are UTF-8 character boundaries | `structure`                      |
| **S-6**  | a node has `text` **xor** `children`, never both | `structure`                      |
| **S-7**  | a leaf's `text` equals `source[start:end]`       | `structure`                      |
| **S-8**  | a child's range sits inside its parent's         | `structure`                      |
| **S-9**  | siblings are ordered and non-overlapping         | `structure`                      |
| **S-10** | the root spans the whole source — **advisory**   | `structure`, reported not failed |

S-5 through S-9 are the invariants `verbatim` enforces at runtime, so a tree
that breaks them is refused by the Rust loader before any package sees it.

**S-10 is advisory on purpose.** It holds on all 234 corpus trees, but the probe
established that the runtime does not require it: a root ending at the last `}`
formats identically. Reported so a divergence is visible; never failed on.

**Gaps between siblings are legal and load-bearing.** Children do not have to
tile the parent — every space and newline in the corpus lives in a gap. S-9
forbids overlap; it does not require coverage.

## 3. Oracle clauses — checked

| ID      | Clause                                                                            | Check                 |
| ------- | --------------------------------------------------------------------------------- | --------------------- |
| **C-1** | the root matches `corpus/trees/` byte for byte                                    | `clean`, 228 trees    |
| **D-1** | the root matches `corpus/trees-edited/` byte for byte, ERROR and MISSING included | `dirty`, 242 fixtures |
| **T-1** | the adapter returns a tree for **any** input, however broken                      | `total`, 338 cases    |

**C-1 is the hardest and least general clause here**, and a parse layer can be
useful without it. It demands the adapter reproduce one grammar's exact node
inventory, which is what makes every merged package portable — but a parse layer
with its own vocabulary (route E, Aven) fails C-1 by construction and can still
satisfy every other clause. Read a C-1 failure as "this is a different
vocabulary", not as "this is broken", and see `docs/parse-layer.md` on the
acceptance-bar choice.

**T-1 is a requirement, not a quality bar.** The highlighter's stated contract
is to degrade gracefully on broken input; a parser that refuses has nothing to
degrade from. This is the clause `json_cst.py` fails and the one no gate in this
repo checked before.

**C-4 (correction).** The probe document says a parser that reifies whitespace
as children is refused. That is true of _the packages_, not of the tree format:
131 whitespace-only leaves exist in `corpus/trees/` today — `CharData` in xml,
`block_continuation` in markdown, `attribute_value` in html, `doc_comment` in
rust, `heredoc_content` in ruby. So "whitespace is never a child" is **not** a
contract clause. Whether a given whitespace child is accepted depends on whether
the package's rule consumes it.

## 4. Unchecked clauses

These are real requirements that this suite **cannot** verify, each for a stated
reason. They are listed because a parse-layer author must honour them anyway,
and because an unchecked clause that is not written down is how a silent
divergence ships.

| ID      | Clause                                                                                         | Why unchecked                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **U-1** | anonymous tokens have `type` equal to their spelling                                           | package-dependent, **and falsified as an invariant** — see below                                      |
| **U-2** | comments arrive as ordinary children, in source order, typed as the package's `comments` lists | requires the package; a parser that attaches trivia loses comments **silently**                       |
| **U-3** | `named` matches a type not in the package's `tokens`; `tok` matches a child's `text`           | requires the package                                                                                  |
| **U-4** | `flatten` needs a left-nested same-`type` spine with `flatten_fields` names                    | requires the package and a language that uses `flatten`                                               |
| **U-5** | the tree formats identically through both runtimes                                             | needs built binaries and a package per language; `probe_tree_interface.py` covers this for JSON       |
| **U-6** | incremental reparse agrees with a scratch parse                                                | a frozen fixture has no old tree to reparse from; `parse_oracle.py` owns it, and it **does not hold** |

**U-1 is the one to read twice.** `docs/tree-interface-probe.md` says "The
existing packages set type equal to spelling for every anonymous token." That is
false, and the corpus says so: **13 counterexamples in the committed trees.**
tree-sitter emits a node typed `)` whose text is `]` (ruby, 3×), typed `"` whose
text is `'` or `%Q[` or `]` (ruby), typed `/` whose text is `/i` (ruby), typed
`|` whose text is `|-`, `|+` or `|2` (yaml block-scalar chomping indicators),
typed `>` whose text is `>-` (yaml), and typed `"` whose text is `b"` (rust byte
strings).

So the `tok`-versus-`named` hazard the probe describes as hypothetical is
**already present in the shipped corpus**. `tok` matches `text` and `named`
consults a list of `type`s, and there are 13 places today where those two
disagree. A parse layer cannot rely on type and spelling being interchangeable,
and neither can a package author.

## 5. What the fixtures cover, and what they do not

`corpus/trees-edited/` — 242 fixtures, 2.4 MiB, four base files per language,
four single-edit states each; 179 carry ERROR or MISSING, 63 are deliberately
clean.

**Covered.** Error recovery on single edits to real corpus files, across all 16
languages, with tree-sitter's exact answer frozen. The clean states are not
filler: a parse layer that _invents_ ERROR on input tree-sitter accepts fails
this contract exactly as hard as one that accepts what tree-sitter rejects.

**Not covered, and each is a place a parse layer can be green here and wrong in
production:**

- **Incremental reparse** (U-6). A frozen fixture has no old tree. Use
  `parse_oracle.py`.
- **Scanner state serialization.** `serialize`/`deserialize` let a reparse
  resume mid-file. Exercised only indirectly, by the fuzzer's incremental arm.
- **Deep breakage.** Every fixture is _one_ edit from a clean file. A buffer
  mangled by twenty edits is a different regime — and, per the finding below,
  the regime where tree-sitter's own two answers stop agreeing.
- **Injections.** Off by construction: a candidate parse layer parses one
  language, so the oracle it owes us is one grammar's own recovery, not a splice
  of two grammars over broken source.
- **Formatting.** 177 of the 179 dirty fixtures are _refused_ by the formatter,
  because no package has a rule for `ERROR` and linearity is total. That is the
  documented design. This corpus belongs to the highlighter and to a future
  parse layer, not to the formatter.

## 6. The oracle's own non-determinism

`harness/parse_oracle.py --known` replays two minimal reproducers of a
**scratch-versus-incremental divergence** in tree-sitter itself:

| Language       | Base  | Edit            | Result                                                    |
| -------------- | ----- | --------------- | --------------------------------------------------------- |
| json (0.24.8)  | 37 B  | insert `{` at 0 | root is `ERROR` incrementally, `document` from scratch    |
| kotlin (1.1.0) | 185 B | insert `)` at 6 | root is `ERROR` incrementally, `source_file` from scratch |

Measured over 12 seeds: 145 divergences in 60,480 states, reproducing in **8 of
16 languages** (haskell, json, kotlin, javascript, rust, typescript, css,
scheme). Eight independent grammars is why this is filed against the incremental
machinery rather than against any one grammar.

**The qualification is the useful part.** Every divergence starts from a buffer
that _was already broken_. Measured, not assumed: 30,240 states over six seeds,
66 divergences, **0 from a buffer that parsed cleanly**. Two controls confirm it
from the other side — a clean base with the same edit shape agrees, and a clean
base with 20 cumulative edits that keep it valid agrees. Verified not to be an
offset artifact by re-running the repro with hand-written literal `tree.edit`
points on a single-line source.

So: **tree-sitter's incremental path is reliable on well-formed buffers and not
on broken ones.** A live editor spends much of its time in the second regime,
which is why this belongs in the contract rather than in a footnote. It also
qualifies `docs/parse-layer.md`'s credit to route A for buying incremental
reparse and error recovery "for free": what route A buys is an incremental path
that agrees with a full parse while the buffer is valid.

The reproducers are stored as **literal bytes, not as a seed**. A seed
reproduces only while the grammar pin and the tree-sitter runtime both hold, and
the runtime is pinned nowhere in this repo — `gen_trees.py` declares a bare
`tree-sitter`, so `uv` resolves whatever is current. That gap is worth closing
independently of this document.

## Is the suite tested?

A conformance runner that passes everything you point it at has not been tested.
Two adapters, and the asymmetry between them is the evidence:

| Suite       | tree-sitter (control) | `json_cst.py` (discriminator) |
| ----------- | --------------------- | ----------------------------- |
| `structure` | 5,236 pass            | 66 pass, **9 fail**           |
| `clean`     | 228 pass              | 3 pass, 0 fail                |
| `dirty`     | 242 pass              | 3 pass, **9 fail**            |
| `total`     | 338 pass              | 3 pass, **15 fail**           |

**The discriminating case, named:** `harness/json_cst.py` parses
`corpus/src/json/basic.json` into a tree byte-identical to the frozen
tree-sitter tree — it passes `clean` 3/3. Delete one byte from that file and it
raises `parse error: byte 3: expected ", got b'i'` and exits non-zero, where
tree-sitter returns a tree containing ERROR. That is fixture
`json__basic__e00.tree.json`, and it fails **T-1**, **D-1** and **S-0** while
real tree-sitter passes all three.

The three dirty fixtures `json_cst` does pass are the deliberately-clean control
states, which is the clean-state design working as intended.

A runner where both columns were identical would prove nothing.

## The next adapter

**Route C3's table-driven parser** (`harness/ts_lr.mjs`, branch
`wt/parse-tables`) is the first realistic non-tree-sitter client of this
contract, and pointing the runner at it is the highest-value next step. Its API
is already the right shape — `parse(blob, sourceBytes)` plus `visibleChildren`,
and its `ts_check_trees.mjs` already emits `gen_trees.convert`'s document — so
the adapter is a few dozen lines of JS. What it needs is a transcoded table blob
per language, which is generated rather than committed; that is the only reason
it is not wired here.

Its author documents that error recovery, incremental reparse and external
scanners **throw**. So the prediction is specific and worth recording before it
is run: it should pass `clean` and most of `structure`, and fail `dirty` and
`total` — the same signature as `json_cst.py`. If it does, that is evidence the
suites carve at the right joint, because two independently-built parsers with
the same missing half fail the same two suites.

That prediction is also the shape of the project's next slice: pricing error
recovery and incremental reparse in that interpreter. `corpus/trees-edited/` is
what the first is measured against, and `harness/parse_oracle.py` is what the
second is measured against — with the caveat from §6 that on already-broken
buffers there is no single right answer to match.

## Cost

The full positive control is **6,044 checks in 28 minutes**, dominated by
process startup: one adapter process per source, each re-execing under `uv`. Use
`--language` or `--limit` while iterating. Not on `test.sh` and not in
`score.py`, the same way `parity_fuzz.py` is not.

## Changes this version makes to `docs/tree-interface-probe.md`

The probe stands; three of its statements are narrowed by measurement.

1. "The existing packages set type equal to spelling for every anonymous token"
   — **false**, 13 counterexamples (U-1).
2. "A parser that reifies whitespace as children is refused" — true of the
   packages, not of the format; 131 whitespace-only leaves are in the corpus
   (C-4).
3. "The root spans the whole buffer … the runtime does not require it" — upheld,
   and now advisory rather than silent (S-10).
