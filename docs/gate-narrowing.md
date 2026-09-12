# The fifth declared narrowing of gate 3

Design proposal, 2026-09-13, Codex. Implementation baseline: `5315208` on
`main`. This document changes no executable behavior.

## Done-note

Choose **one structural-view extension point, with closed, versioned semantic
policies**, not a programmable normalization language. A view replaces only
specified observations of the generic signature and supplies their semantic
replacement. List spelling, list numbering, fence spelling, emphasis spelling,
and eligible prose gaps use that interface. They do not have the same proof:
numbering needs list position; emphasis and prose need an inline parse; container
prose needs a range map. Calling all of these leaf normalization would be wrong.

Reject arbitrary callbacks in manifests, regex replacement declarations,
whitespace collapse, dropping all continuations, a weaker override, and a
whole-document rendered-HTML signature. The formatter's source projection is
still a prerequisite. Reclassifying an inline comment as `html_block` is
**excluded**, because a structural extension cannot make unequal universal
signatures equal. Full Prettier `always` agreement is therefore not promised.

The brief's four-declaration count, token-spelling diagnosis, list probe table,
804/6,341 figures and Markdown 42/40 figures are independently confirmed.
Qualification: override composition is a contract used by the shipped YAML
override, not forced at the dispatch boundary. The brief also inherits stale
wording from DESIGN: its “Two policies” heading describes three enumerated
policies, and “only table invents tokens” overlooks insertion by `trail` and
`paren`. The intended distinction is unrestricted respelling versus narrowly
sanctioned insertion.

Implementation slices: freeze rejection evidence; introduce views with list
spelling; add list numbering; add twin-runtime list rendering; thematic breaks;
fences; inline parse substrate; emphasis; top-level prose gate; formatter prose
projection; container prose gate; container rendering. Each is specified below.
Least confidence: proving container-prefix ownership and stable eligible gaps
across both parse paths. Keep that work separate from initial list support.

Validation so far: standalone gate exit 0, exact baseline counts reproduced.
Full `./test.sh` is in progress. This proposal has no implemented view to test;
its future acceptance and rejection claims are requirements, not measured wins.

## Evidence and verified premises

Read DESIGN, gate3, check_gate3, manifest, Markdown's manifest, the prose proposal
and report, and the ledger. Relevant ledger decisions are rows 19–27, the
YAML source-gap incident, and the instruction to compose stronger overrides.
The prototype and revert exist at `1c5d111` and `3857f81`. The historical
12/40 residual failures (nine continuation, three comment reclassification)
are the report's and orchestrator's measurements; this design has not rerun that
entire prototype.

### What the current code actually does

- Four **per-language structural declarations** narrow the observations being
  compared: `transparent_wrappers`, `equivalent_kinds`, `layout_leaves`,
  `whitespace_nodes`. `_layout` correctly calls itself the third historically.
  This count excludes universal `_tokens` gap handling, injections, and comment
  declarations; it is not a count of every generic equivalence in the code.
- `_canon_map` maps kinds to the lexicographically smallest member of each
  declared group. `_generic` changes the kind only. A true leaf's `_tokens`
  value is its exact decoded source slice. With anonymous children it preserves
  their spelling and non-whitespace gaps. `_layout` trims outside whitespace
  and collapses dash rulers, not list-marker characters or numbers.
- `generic_part_from_root` offers the composition described in its docstring.
  YAML returns `(generic_part, chomp_part)`. But `_signature_from_root` otherwise
  calls the selected override directly. `check_gate3` tests the subset contract
  against generated examples; it does not mathematically enforce it for an
  arbitrary newly written override. No override can legitimately provide this
  widening. Fixing that dispatcher is optional separate work, not this design.
- `_extras` records ordered **trimmed text**, not kind/text pairs, for named
  extras and declared comment kinds, and respects injection boundaries. Thus
  the constraint is the existing sequence, including its existing trimming,
  not newly asserted byte-exact comment payloads. Regions have their own
  recursive signatures; changing HTML classification can change both arms.
- Four incomparable files mean eight of Markdown's 48 reference comparisons
  skip check 1 and reference scoring. They still contribute to parsing,
  destruction checks and gates 0–3. “Dropped measurements” does not mean eight
  removed safety cases.

### Reproduced probes

Scratch scripts live outside the repository at
`/tmp/claude-1000/-home-dave-w-editor-tools/17ade652-c5a4-4631-8144-0a3bf93f47d9/scratchpad/astra-narrowing/`.
`probe.py` imports the real `gate3` and uses tree-sitter-markdown 0.5.1.
It varies the real manifest with `dataclasses.replace`, declaring all five
marker kinds as one equivalence group and/or layout leaves. No gate code is
changed.

| Pair | Bare | Equivalent kinds | Layout leaves | Both |
| --- | --- | --- | --- | --- |
| `* alpha; * beta` → `- alpha; - beta` | differ | differ | differ | differ |
| `3. alpha; 3. beta; 3. gamma` → `3.; 4.; 5.` with same bodies | differ | differ | differ | differ |
| Same list starting at 3 → starting at 1 | differ | differ | differ | differ |
| Delete last item | differ | differ | differ | differ |
| Delete `word` from `alpha word` | differ | differ | differ | differ |

Semicolons in this table denote line boundaries. The exact pairs are in the
scratch script. This reproduces the orchestrator's table independently.

The block grammar produces `(paragraph (inline))` for both `alpha  \nbeta`
and `alpha\nbeta`. The inline grammar produces `hard_line_break` only for the
former; it also recognizes the backslash form. The block grammar's emphasis
is anonymous delimiters plus gaps; the inline grammar supplies an `emphasis`
node with paired `emphasis_delimiter` children.

A further hazard appears directly in `_generic`: when a multiline list or
quote `inline` has named `block_continuation` children, its signature recurses
only into those children and omits surrounding prose gaps. Do not copy this
representation into the new view. Exhaustive text coverage is necessary even
where the baseline happens not to protect the words.

`prettier.py` invokes the installed, version-checked Prettier 3.9.6 directly
with `--no-config --stdin-filepath x.md`. At width 25 with `always`, independently
reproduced: 3,3,3 → 3,4,5; 1,5,2 → 1,2,3; three adjacent bullet lists → `-`,
`*`, `-`; nesting → `-` at all depths; lone `1)` → `1.`; adjacent dot/paren
lists retain different delimiters; blank-separated same-marker items renumber
continuously; items 8,9,10 use continuation indents 3,3,4 respectively.

Semantic authority is [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/),
especially lists, fences, emphasis and hard/soft breaks. It distinguishes list
start from subsequent numbers and preserves hard breaks. Prettier is the style
oracle, not a proof that every rewrite is safe in every dialect. Support here
is restricted to the pinned grammar and explicitly enumerated syntax.

`./harness/check_gate3.py` independently returned:

```text
423 reference outputs checked across 16 language(s)
804 destructive mutations rejected
6341 useful adversarial mutations checked
0 generic/override disagreement(s); 11 injection cases checked
markdown: dropped-comment=42, dropped-token=40
```

The useful-adversarial arm is explicitly inert for `gate3 = "default"`.
Those 6,341 are baseline-differing candidates, not 6,341 independent semantic
proofs. The destructive counter counts attempts before checking their verdict;
a count of 804 without exit 0 is insufficient evidence.

## 1. Manifest surface

Add an optional root table, before `[incomparable]` and array tables:

```toml
[structural_view]
policy = "commonmark/1"
features = ["list-markers", "list-ordinals", "thematic-breaks", "fences",
            "emphasis", "soft-prose"]
prose_scope = "top-level"
```

This is the target configuration, not the initial activation. First activation
uses only `features = ["list-markers"]` and omits `prose_scope`.

Schema:

- Absent means the exact current algorithm. The table allows exactly `policy`,
  `features`, `prose_scope`; reject unknown keys and incorrect types.
- `policy` is a nonempty, registered **versioned enum**, initially only
  `commonmark/1`. It binds the tree-sitter-markdown 0.5.1 block and inline
  grammar symbols. Reject an incompatible grammar pin/module/symbol. There is
  no import path, expression, regex, replacement string or callback in TOML.
- `features` is a nonempty duplicate-free array from the six strings above.
  Unknown or unimplemented features refuse manifest load. Order has no meaning.
  `list-ordinals` requires `list-markers`. `emphasis` and `soft-prose` require
  the inline grammar supplied by this policy, even if the formatter is verbatim.
- `prose_scope` is required exactly when `soft-prose` is present; values are
  `top-level` and, when implemented, `containers`. The latter includes the
  former. Unsupported scope refuses; it is never silently treated as top-level.
- A closed policy defines its eligible roles and exclusions. The manifest
  cannot expand them to arbitrary kinds. For this first version, reject a
  wrapper, kind-equivalence or layout declaration overlapping an owned role.
  Markdown's existing table leaves and whitespace `section` are disjoint and
  remain legal. Reject comments/injection contents as owned rewrite roles.
  Recognizing continuation *ownership* does not declare that kind disposable
  globally.

Extend `_KNOWN`, the immutable Manifest value, parsing validation and tests.
Old harnesses already refuse unknown root keys. No manifest format bump is
needed to obtain fail-closed loading. A policy version never silently broadens:
new semantic allowances get a new feature or version and their own controls.

**This requires per-language code.** Put the reviewed adapter in a harness
structural-view module, selected by an explicit registry, not dynamic imports
from the manifest. Its job is interpreting grammar roles and building a bounded
view plan. Generic code validates and applies that plan. A new grammar adapter
is a code contribution; this does not claim downloadable data can express an
arbitrary language's semantics. A generalized projection DSL would itself need
conditionals, traversal, captures, arithmetic and parsing. There is no evidence
that adding that second programming language is cheaper or safer.

It is not a gate override: it participates *inside the default*, before the
structural signature is finalized. Overrides must still compose with that new
default. The manifest and formatter package select capabilities independently;
the gate never loads package formatting rules.

## 2. Gate-side algorithm

### The interface and hook

Keep `_reparse`, `_extras`, region routing and `_region_signatures` unchanged.
In `generic_part_from_root`, after resolving aliases, build a view plan from
`(root, source, manifest, aliases)`. The plan is immutable and local to this
parse. It contains exact CST-node identities, replacement observations, and
explicitly covered source ranges. No offsets appear in the final signature.

A plan operation is either:

1. `replace(node, observation)`: emit one tagged immutable value instead of that
   node's generic observation; or
2. `omit(node, owner)`: omit a physical continuation node whose bytes and
   container ownership are represented in an enclosing replacement observation.

This is an internal typed interface, not a manifest instruction set. An owner
has a complete range-accounting record: content, syntax, admitted whitespace,
container prefix, or injection boundary. No byte can disappear as an unexamined
gap. Overlapping replacements, conflicting owners, out-of-range slices,
unsupported grammar shapes, extras, comment nodes and injection content are
not legal plan operations. Ancestor replacements may contain already-computed
child semantic values, but the final plan must have non-overlapping ownership.

`_generic` checks for a replacement before wrapper elision, then runs its
existing four declarations for everything not covered. It filters proven
omissions beside the existing whitespace filter. Recursive calls thread the
plan; they do not use traversal index as a semantic item number. A plan builder
has raw parents, direct siblings, ordered item indices, container stacks,
source ranges, and both trees where needed. Compute these once in a whole-tree
prepass, stopping at every injection boundary. Guest calls build their own
plans with the guest manifest.

Unsupported but valid syntax gets **no operation**, hence the current strict
signature, not an empty signature or `None`. Malformed policy configuration
raises ManifestError. A plan-invariant violation is an explicit gate failure,
not a fallback that might hide a programming defect. Use tagged observations
such as `("view", "commonmark/1", "ordered-marker", value)` to avoid accidental
collisions with old kind/text tuples. Eligibility must be a function of semantic
shape and supported syntax, not width or the desired output.

Do not append the *unmodified* old signature to the view: it would keep rejecting
precisely the changes being admitted. Preserve the old signature everywhere
outside the specifically covered roles, and add semantic guards inside them.
Unrelated old blind spots need not be inherited by a replacement.

### List markers and ordinals

Find each raw `list`, its direct `list_item` children in order, and exactly one
leading marker per item. Validate the marker against the block grammar's role
and ASCII spelling: unordered `-`, `+`, `*`; ordered one through nine decimal
digits followed by `.` or `)`, plus the grammar-owned marker padding. Refuse
projection of ambiguous ownership or mixed unsupported child shapes.

Retain list and item nodes, their order, count, nesting and all bodies. Replace
only each marker's observation. Unordered markers become `bullet`. Ordered
markers become `(ordered, exact_digits)` until `list-ordinals` is enabled.
With that feature, the first becomes `(ordered-start, integer_value)` and each
later marker becomes `ordered-continuation`. Leading zeros of the first number
are then intentionally immaterial; its numeric value is not. Record the index
among direct items before any wrapper filtering; every nested list starts a
new counter. A blank between items does not restart it.

For rewritten padding/continuations, also compare a list semantic guard:
ordered versus unordered, start value when enabled, list tightness, each item's
ordered block kinds and container ownership. Do not erase arbitrary indentation.
An output merging two adjacent lists loses a list node and fails. Alternation
is an emitter concern; the gate accepts any spellings preserving those lists.
List-marker-only activation keeps continuation nodes strict; wider continuation
normalization is enabled only by a proved range map, including for marker-width
changes. Unsupported width-changing lists stay strict until that support lands.

### Thematic breaks and fences

A grammar-confirmed `thematic_break` is one `thematic-break` event regardless of
its allowed character, spacing and count. Its node must still exist in the same
block position. A setext underline is not this role.

A fence owner must have a recognized opening and explicit closing delimiter.
Replace their spelling observations with `fence-open` / `fence-close`. Keep
both nodes, the info string's source spelling, host children, container context,
and injection boundary. Add an exact observation of the entire info payload
because named `language` alone need not exhaust it. The gate's guest or verbatim
signature continues to protect the body. Unclosed fences, unsupported info
syntax and ambiguous prefixes receive no fence operations. If rewriting a fence
causes a premature close, the body boundary, block structure or guest signature
changes and the pair fails. Never mask the whole fence body to normalize two
markers.

### Emphasis and prose

Build an independent block-plus-inline parse of each eligible paragraph's
logical source. This must not use formatter-emitted atom labels as evidence.
For the initial top-level subset, source is contiguous. Enumerate every inline
node and every gap, producing a structured event stream with explicit bytes
for text, escapes, entities, URLs, code, delimiters and unsupported protected
spans. Paired emphasis produces nested open/body/close events preserving
emphasis versus strong and nesting. With `emphasis`, omit only the spelling of
grammar-confirmed paired `*`/`_` delimiter runs; without it keep that spelling.
Unpaired punctuation remains exact text. Never decode entities or escapes.

With `soft-prose`, ordinary breakable gaps become one `soft-gap` event each.
A gap is a maximal interior run of ASCII spaces with at most one logical soft
line ending, classified outside code, escapes, entities, HTML and hard breaks.
Do not drop the event: `alpha beta` must differ from `alphabeta`. Do not admit
blank lines, tabs, nonbreaking spaces, leading/trailing paragraph whitespace,
or multiline protected spans in version 1. Unsupported syntax makes the whole
paragraph ineligible. Hard breaks remain events with exact original spelling;
this deliberately does not equate two spaces with a backslash hard break.
Plain text is retained exactly in ordered spans between these events.

Replace the paragraph's structural observation by its block identity and this
inline stream. Preserve any other paragraph children that are not owned
physical continuations. The event stream may be stronger than the old signature;
that is desirable for the named-continuation gap hole noted above.

Container support adds a logical-to-physical retained-range map. Each physical
line is accounted for as content plus syntax-owned prefix plus line ending.
Prove the prefix belongs to the same list-item/quote ancestry and paragraph;
retain the container graph and list tightness independently of prefix count.
Only then may a covered `block_continuation` disappear from the structural walk.
Empty continuations at blank paragraph boundaries are not soft prose. Lazy
continuations require an explicit supported grammar case; otherwise preserve
the paragraph. Do not join paragraphs across blank lines or HTML blocks.

The replacement has no absolute byte offsets or line counts, so reflow produces
the same events. It retains boundary events, nesting and content, so changed
block syntax, moved words between items and hard-break loss remain visible.
Two distinct consumers can share grammar bindings and range utilities; they must
not share the formatter's gap classifier as the only gate evidence.

## 3. Discriminating controls

Each row requires a positive pair and its own negative assertion through the
real public gate. In this table `\n` means a newline. Compare non-None
signatures explicitly; two parse failures are not success.

| Instance | Must accept when supported | Plausible wrong implementation must be caught by |
| --- | --- | --- |
| Bullets | `* a\n* b` ↔ `- a\n- b` | `- a\n\n* b` → `- a\n\n- b` merges two lists; bullet → ordered; delete an item or body word |
| Ordinals | `3. a\n3. b\n3. c` ↔ `3. a\n4. b\n5. c` | Change first 3 to 1; reset a nested list's first number; move a word between items |
| List boundaries | Same-marker blank-separated items renumber continuously | Merge adjacent `.` and `)` lists; turn a loose list into a tight one |
| Thematic | `***\n` ↔ `---\n` at an actual thematic-break site | `title\n---\n` → `title\n***\n` changes heading to paragraph plus break; delete the break |
| Fences | Tilde and backtick delimiters around identical body/info | Delete closer, change info language/attributes, alter unknown body, lose guest comment, shorten fence so a body line closes it |
| Emphasis | `*alpha beta*` ↔ `_alpha beta_`; `__x__` ↔ `**x**` | `*x*` → `**x**`; `a*b*c` → `a_b_c`; delete word, escape, or one delimiter; change code-span backticks |
| Soft prose | `alpha beta` ↔ `alpha\nbeta` | `alpha  \nbeta` → `alpha\nbeta`; backslash hard break → soft; delete gap, word, or blank paragraph boundary |
| Protected bytes | Reflow outside a protected code span | Change a space inside `` `a  b` ``; replace NBSP with space; change a link destination or entity spelling |
| Container prose | Same words rewrapped inside one item/quote | Remove `>` so content exits the quote; move prose to a sibling item; erase a blank that changes list tightness |
| Universal boundary | Comment remains in the same classification and order | `alpha <!-- c --> beta` → `alpha\n<!-- c -->\nbeta`; delete/reorder comments; change injected guest |

Add combined mutations: valid respelling plus dropped word, renumbering plus
lost hard break, fence change plus altered guest, and emphasis respelling plus
paragraph merge. Independent per-feature tests cannot detect an overly broad
combined replacement.

The fixed 804 destructive instances must remain rejected. Freeze their inputs,
mutants and identities before activating any view, including incomparable
files. Replay against both the original source and the unmutated reference;
current check 3 compares a mutated reference against the original source, which
can conceal acceptance of a mutant of an already-incomparable reference.

Freeze the 6,341 useful cases too. Classify any newly accepted case by an exact
new positive equivalence witness; never silently lose it because the new generic
oracle no longer calls it “useful.” Its count may legitimately change when
spelling becomes allowed. The destructive baseline must not lose an identity,
even if newly added tests keep the aggregate above 804. Add the table's new
semantic controls in an arm with explicit expected verdicts, not filtered by
the current generic signature.

## 4. What it stops catching

State these in the eventual policy module's docstring:

- List markers: the author's choice among bullet characters and ordered
  delimiter characters, and supported marker padding, provided list boundaries
  and semantics remain. Nothing about item count, order, nesting or bodies.
- Ordinals: every non-first numeric spelling, including changing the second
  marker from 4 to 99 rather than to the formatter's preferred number; leading
  zeros on the first number. The first numeric value still matters. Equality
  is symmetric and transitive; it cannot permit only a directional 3,3,3 →
  3,4,5 rewrite. Canonical output belongs to agreement and idempotence checks.
- Thematic breaks: character, count and spacing of a parsed thematic break.
  Its presence and block role remain. This is broader than `layout_leaves` only
  at that role, not at every dash-shaped text span.
- Fences: delimiter character and safe opening/closing counts. Info, body,
  explicit closure, container and routing remain. The design does not permit
  dropping an explicit closer just because CommonMark allows EOF closure.
- Emphasis: paired delimiter spelling. Emphasis depth, strong versus ordinary,
  text and all non-emphasis syntax remain. An escaped `*` is content.
- Prose: count of admitted ASCII spaces and locations of admitted soft wraps;
  physical continuation count and padding only in the supported container map.
  It still catches hard-break changes, blank-boundary changes, protected-byte
  edits, content loss and changes in container membership.

No universal observation is relaxed. No other language changes unless it opts
into a separately supported policy. Existing four-declaration blind spots stay
as documented. Replacing a lossy paragraph signature can close old holes.

**804 is an acceptance floor, not a forecast from an unbuilt design.** With
unchanged corpus, all 804 fixed cases must still be generated and rejected and
Markdown remains 42/40. New tests add coverage. A feature that accepts even one
of those frozen destructive cases is narrowed or held back, not excused by a
higher new total. This design predicts no loss because content, nodes, comment
sequence and region identity are retained; replay is the required evidence.

## 5. Runtime side

Gate equivalence does not authorize arbitrary emission. The formatter needs
separately sanctioned policies and source ownership. Keep `tok` source-backed.
Do not add `text`, `replace`, a regex emitter, or a package-defined formatter.

Use two new opcodes with closed policy names, **31 opcodes when both land**:

```json
["canonical", "commonmark-thematic/1"]
["canonical", "commonmark-fence/1"]
["canonical", "commonmark-emphasis/1"]
["list-layout", "markdown-lists", item_separator]
```

`canonical` owns the current node, like `table`; policy names are enums compiled
into both runtimes, not executable package data. It does not accept an arbitrary
output string. Its three policies are three separately reviewed sanctioned
mutations even though they share an opcode. `list-layout` is a fourth policy,
responsible for marker spelling, derived ordinals and their indentation. Do not
advertise “one new mutation” merely because an opcode dispatches several.

Package format 4 protects new header and tree-view requirements. Reject these
opcodes and headers under older formats. Existing 1–3 behavior stays identical.
A closed data declaration supplies style, not syntax semantics:

```json
{
  "format": "et-doc-rules/4",
  "list_layouts": {
    "markdown-lists": {
      "policy": "commonmark/1",
      "bullets": ["-", "*"],
      "ordered_delimiters": [".", ")"],
      "adjacent": "alternate",
      "nested": "restart",
      "numbers": "increment-from-first"
    }
  },
  "rules": {
    "list": ["list-layout", "markdown-lists", ["blank", 1]],
    "thematic_break": ["canonical", "commonmark-thematic/1"]
  }
}
```

Require exactly this closed schema initially: two distinct allowed bullets,
both ordered delimiters in a declared order, the three enum modes shown. This
is not a generic sibling predicate. The list algorithm is shared code; the
package chooses the preferred alternating spellings as data.

### List context and emission

Before evaluating rules, establish a read-only parent/direct-sibling map on the
validated formatter tree. For each parent, scan block children in source order.
A run of adjacent same-family lists (only layout whitespace between them) picks
successive entries cyclically from its style array. Any intervening block,
comment, injection or change of list family ends that run. Descending into an
item starts a new parent scan, so nested lists choose the first spelling.
Persist the chosen list style by node identity; recursive dispatch must not
inherit a mutable global “last bullet.” The grammar's list identity determines
renumbering; blank lines within one list do not produce a new run or counter.

`list-layout` owns direct items once in source order and evaluates its separator
with the same cursor/gap semantics as `each`. It creates each item's marker Doc
and delegates that item's body through the normal formatter with an explicit
consumed-marker slot. A version-4 list-item body view excludes that slot; no
rule gets a second opportunity to emit or drop it. Source validation covers the
original item before constructing this view. Comments retain their existing
attachment and consumption paths; a comment attached to a consumed marker is
a refusal, not a reason to move it.

For ordered item index i, emit decimal `start + i` plus the chosen delimiter and
one space. Validate the source start as a 0–999,999,999 integer; refuse an output
exceeding nine digits rather than risking a different block parse or divergent
integer behavior. Use the same bounded integer arithmetic in Rust and JS.
The item's continuation indent is the scalar width of **its emitted marker**,
not the source marker and not the widest item. Thus 8/9/10 use 3/3/4 spaces.
Container prefixes compose outside that indent. Existing `prefix` alone cannot
calculate this value or select a sibling-dependent spelling.

Initial list support handles source-backed bodies with unambiguous ownership;
unsupported tabs, lazy continuation maps or marker-width-sensitive verbatim
multiline bodies refuse the new opcode. The package can use existing verbatim
rules for unsupported syntax through the parser's capability view. Extending
list support to those cases requires the same retained-range ownership work as
container prose; do not silently leave stale indentation inside a verbatim Doc.

### Canonical policies

- **Thematic:** validate a parsed thematic-break owner and its complete source
  coverage, emit `---` as the token; the surrounding rule owns its line ending.
  Refuse heading underlines, extra content, stale ranges and comments. A leaf
  currently bypasses rule dispatch: format 4 must explicitly dispatch an
  applicable `canonical` rule before the ordinary leaf fast path, after source
  validation. Preserve all old leaf behavior otherwise.
- **Fence:** validate the whole fence and two delimiter roles. Emit backticks,
  count at least three and greater than any potentially closing backtick run in
  the **rendered** body. Retain info bytes and delegate a routed body normally;
  unknown bodies remain source-exact. Reject unsupported info containing a
  backtick, missing closer, ambiguous prefixes, malformed ownership and lost
  comments. Render the body to a bounded intermediate Doc/string before choosing
  the fence; do not choose count solely from the original guest source. The
  policy may not change guest source or routing. Body rendering occurs once,
  then indentation and fence assembly must agree in both runtimes.
- **Emphasis:** requires an inline formatter view with paired delimiter roles,
  exhaustive source partitions and byte provenance. Ordinary emphasis prefers
  `_`; strong prefers `**`. Emit canonical delimiters only when the syntax
  producer marks the surrounding flanking/nesting context as supported. A
  conservative first subset is isolated simple emphasis without adjacency to
  delimiter runs or intraword boundaries. Unknown contexts preserve their
  original subtree rather than guessing at escaping. Invoking the opcode on an
  unsupported role, unmatched pair, code span or stale view refuses. Body bytes
  come from source atoms or ordinary child Docs, never a reconstructed string.

These runtime policies contain syntax-specific code, as `table` already does.
The cost must be reported per policy in the ledger. A policy registry saves
integration plumbing; it does not make the semantic implementations generic.
Formatter eligibility annotations are trusted parser facts checked for range
and shape at runtime, not semantic proofs. The independent gate is essential.

All new checks have a shared documented refusal order: package schema/version,
source/range/coverage, role/shape, comment ownership, unsupported context,
numeric/fence bounds. Use identical stable messages, e.g.
`commonmark list: ordinal exceeds 9 digits`, in both implementations. Fixtures
must compare exit status, stdout and stderr byte-for-byte. No opcode or policy
lands on one side first. Gate-side code does not call either emitter.

Prose itself adds no arbitrary-token opcode. Implement the source partition
proposal with `fill`, `line`, source-backed atoms and explicit hard breaks.
New quote-prefix emission and dynamic list indentation require reviewed
container ownership, not blanket source-whitespace deletion. `srcgap` remains
strict: it cannot consume `>` or meaningful hard-break whitespace as a gap.

## 6. Whether prose actually fits

**Yes at the structural-view boundary; no as the same leaf operation.** All
instances replace surface observations with typed invariants. But top-level
prose needs a second parse and exhaustive gap classification; container prose
needs logical ranges; formatter reflow needs atoms and break-safe Docs. Neither
an item index nor a generic string normalizer supplies those prerequisites.

Implement [prose-projection.md](prose-projection.md)'s parse-layer partition;
its `source_partitions` runtime protection already ships in format 3. Keep the
syntax tree for readers and derive a separate formatter tree. Both native tree
generation and JavaScript parsing must expose equivalent views. Never embed
another ad hoc Markdown tokenizer in the Doc evaluators.

Start with top-level ordinary prose and supported emphasis; preserve whole
paragraphs containing HTML/comments, tabs, unsupported inline syntax or uncertain
breaks. Classify boundaries that could introduce headings, lists, quotes,
fences or setext/thematic syntax as unbreakable, coalescing adjacent atoms.
If safety depends on adding an escape, preserve the paragraph. Reparse and
compare events after rendering; stable eligibility and idempotence are required.

The three historical HTML-comment cases remain a hard boundary. This proposal
never changes `_extras`, removes `html_block` from `comment_kinds`, masks its
injection, or merges through it. The independently probed pair
`alpha <!-- keep --> beta` / `alpha\n<!-- keep -->\nbeta` changes extras from
empty to one comment and adds a region. Even a perfect structural view cannot
accept it. An implementation that claims all `always` reference cases are green
by this mechanism has changed scope or lost a check.

Keep the live reference at `preserve` during these slices. Exercise `always`
with a separate explicit fixture/reference arm and publish a coverage matrix.
Do not add these comment cases to incomparable just to flip the global flag.
A later reference-policy decision may choose a semantics-preserving subset;
full Prettier `always` behavior including reclassification is incompatible with
the fixed universal layer in this brief. That is an explicit limit, not a
request to shelve useful prose reflow.

## 7. Slice decomposition

Costs are engineering estimates including tests/review, not measured execution
times. Half a day means one bounded implementation unit, not a promise that an
agent session can finish it. Each slice runs `./test.sh`, exit 0, zero warnings;
no reference-policy flip is bundled with infrastructure. Runtime slices always
contain both implementations and matching refusal tests.

| Order | Reviewable unit | Rough cost | Evidence needed for a green boundary |
| --- | --- | --- | --- |
| 1 | Freeze baseline rejection identities; explicit expected-verdict test arm | 0.5 day | Replay 804 and 6,341; pin Markdown 42/40; test mutated references against themselves as well as source; no view yet |
| 2 | Manifest/view-plan interface plus bullet and ordered-delimiter roles | 1 day | Undeclared behavior unchanged; bad schema refuses; bullet positive; merged-list/word-loss negatives; fixed 804 retained |
| 3 | Position-aware ordered-number projection and list semantic guard | 0.5–1 day | 3,3,3 and 1,5,2 positives; first/nested start controls; loose lists; boundary arithmetic; no runtime output change |
| 4 | Format 4 and twin-runtime `list-layout` for supported bodies | 1–2 days | Both style arrays, three adjacent lists, nesting restart, same-list blank runs; ordinal overflow and marker-comment parity; widths 80/40/25; double format; leave unsupported width-sensitive multiline bodies verbatim |
| 5 | Thematic view plus twin-runtime canonical policy | 0.5 day | Thematic/setext control; leaf dispatch compatibility; remove thematic exclusion only after every case is covered |
| 6 | Fence view plus twin-runtime canonical policy | 1–2 days | Long body backtick runs, rendered guests, info preservation, missing closer, nested injection mutations; retire exclusion only with complete evidence |
| 7 | Inline parse and exhaustive range substrate, behavior off | 1–2 days | Native/JS tree parity; offsets around Unicode; gap coverage; hard-break and protected-span classification; highlighting tree unchanged |
| 8 | Emphasis view and twin-runtime emission on supported contexts | 1–2 days | Ordinary/strong/nested/intraword controls; unsupported contexts preserved; no blanket delimiter removal; retire emphasis exclusion only when justified |
| 9 | Top-level soft-prose gate feature, renderer still preserve | 1 day | True parser-derived positive and negative pairs; hard-break, code, NBSP, entity, block-boundary controls; 804 replay |
| 10 | Top-level formatter projection using existing partition/fill machinery | 1–2 days | Real parse → both runtimes → reparse → both runtimes at 80/40/12; byte-identical output/refusals; stable eligibility; selected always fixtures |
| 11 | Container range map and gate observations, formatter still unchanged | 1–2 days | Prefix coverage, tightness, item/quote membership, lazy-continuation refusals, exact words with named continuation children; universal comment controls stay negative |
| 12 | Container formatting and derived continuation indentation | 1–2 days | 8/9/10 marker-width changes, nested quotes/lists, fences, blanks, new quote lines; parity and double format; report residual always mismatches explicitly |

Slice 4 may remove `list_markers.md` from incomparable only if its actual two
widths are now comparable and all controls pass; otherwise retain it until
slice 12 closes the missing shapes. Each other exclusion is similarly earned
per file, never deleted because a feature flag exists. Refresh affected review
records and attribution when output changes; no stale divergence records.

For every runtime slice, report per-policy gzip deltas, all-language scores,
new fixture names, both runtimes and widths, double-format results, exact
refusal parity, frozen destructive identities retained, and any useful mutation
whose classification changed. A green total without those identities cannot
establish non-regression under a widening.
