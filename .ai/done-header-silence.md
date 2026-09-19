# Header fields fail silently. Opcodes do not.

The reviewer's premise is **true**, for both runtimes, and it is not a
`gap_owner` special case. It is how `et-doc-rules/1` (and
`et-highlight/1`) is loaded.

`DESIGN.md` currently says:

> Both runtimes refuse any value other than `et-doc-rules/1` … so a
> future package cannot be silently misread by an older runtime.

That sentence is true of the **format string** and of **opcodes**. It is
false of **header fields**. A new field is dropped on the floor. The
older runtime then formats the same package with the field's default,
and exits 0.

That already happens to two shipped packages, against runtimes from the
previous day. It is the pattern `gap_owner` belongs to, not a unique
property of it.

No code was changed. Throwaway packages lived under `/tmp/hs-exp`. Old
runtimes were built in detached trees under `/tmp`, not by moving this
worktree.

---

## 1. What the loaders actually do

**Rust.** `RawPackage` in `rust/src/pkg.rs` and `RawPackage` in
`rust/src/hl_pkg.rs` derive `serde::Deserialize` with **no**
`deny_unknown_fields`. Serde's default is to ignore unknown keys. A
repo-wide search for `deny_unknown_fields` is empty.

**JS.** `runtime-js/bundle.js` `buildPackage` reads named keys, then
returns `{ ...pkg, …derived }`. Extra keys survive on the object and
are never consulted. `runtime-js/highlight.js` `loadPackage` does the
same: it copies known keys out of `raw` and does not walk
`Object.keys` for leftovers.

**What *is* loud**, in both runtimes, at load:

| Check | Error |
|---|---|
| `format` ≠ `et-doc-rules/1` (or `et-highlight/1`) | `unknown package format … expected …` |
| Unknown opcode in `rules` / `defs` | `unknown opcode \`<name>\`` |
| Unknown predicate | `unknown predicate …` |
| Unknown key *inside* `flatten_fields` | `` `flatten_fields` has unknown field `<key>` `` |
| Wrong *type* on a *known* header field | type error (Rust serde / JS validator) |

The last two rows are the tell: the project already rejects unknown
keys when it wants to (`flatten_fields`; also `harness/manifest.py`
and `harness/review_ledger.py`). The package header is the place it
does not.

The two runtimes **agree** on ignore-vs-refuse for every shipped
header field. They **disagree** on one related case, listed under
parity at the end of the table.

---

## 2. Empirical tests

Current binaries: `rust/target/debug/docfmt`,
`rust/target/debug/hl-rust`, `runtime-js/bundle.js`,
`runtime-js/highlight.js` at `3c9b95d`.

Old formatter binaries, each a `git archive` of the parent of the
field-adding commit, built under `/tmp`:

| Label | Commit | Date | Missing |
|---|---|---|---|
| pre-gap | `4252a88` | 2026-08-24 | `gap_owner` |
| pre-tabstop | `509f355` | 2026-08-23 | `tab_stop` |
| pre-commentgap | `5553568` | 2026-08-15 | `comment_gap` / `blank_cap` (hardcoded two spaces, `min(2)`) |

### 2.1 Unknown field, current runtimes — ignored

`packages/json.json` plus `"future_knob": true` and
`"also_nested": {"plausibly_named": "deep_measure"}`, formatted
against `corpus/trees/json__basic.tree.json`:

- Rust: exit 0, byte-identical to the unmodified package.
- JS: exit 0, byte-identical.

Same result for `packages/python.highlight.json` plus `future_knob`
on both highlight loaders, against `python__calls.tree.json`.
Omitting the shipped `grammar` object (which neither loader reads)
is also byte-identical. An extra key on a `context` row is also
byte-identical: JS copies only the known selector keys; Rust serde
ignores the rest on `ContextRule`.

### 2.2 Controls that *do* refuse

| Probe | Rust | JS |
|---|---|---|
| `"format": "et-doc-rules/2"` | `unknown package format \`et-doc-rules/2\`; expected \`et-doc-rules/1\`` | same, JSON-quoted |
| `"format": "et-highlight/2"` | same shape for highlight | same |
| rule body `["no_such_op"]` | `unknown opcode \`no_such_op\`` | same |
| `flatten_fields` with extra key `mid` | `` `flatten_fields` has unknown field `mid` `` | same |
| `gap_owner` as an array | `invalid type: sequence, expected a map` | `` `gap_owner` must be an object `` |

Wrong *type* on a **known** field is loud. Wrong type on an
**unknown** field (`"future_knob": ["not","a","real","field"]`) is
silent: both runtimes still format the toy `gap_owner` tree as
`a\n\nb\n`.

### 2.3 `gap_owner` changes layout, and an older runtime does not notice

Toy tree (the unit-test shape in `eval.rs` /
`bundle.test.js`): source `a\n\nb`, blank sitting *inside* the first
item. Current runtimes, agreed:

| `gap_owner` | Output |
|---|---|
| `{}` or omitted | `a\nb\n` |
| `{ "file": ["item"] }` | `a\n\nb\n` |
| `{ "file": ["other"] }` | `a\nb\n` |

The same package with `{ "file": ["item"] }`, on the **pre-gap**
runtime (`4252a88`, both languages): exit 0, output `a\nb\n`. No
error. That is the silent misformat.

Shipped markdown is the same fact, not just the toy. Current
`packages/markdown.json` (`"gap_owner": {"list": ["list_item"]}`)
against `corpus/trees/markdown__lists.tree.json`:

- Current Rust and current JS agree (400 bytes).
- Pre-gap Rust and pre-gap JS agree with each other (398 bytes),
  **and both load the current package with no error**.
- Current runtime with `gap_owner` stripped from a copy of
  `markdown.json` produces exactly the pre-gap output.

The visible difference is the blank that makes the list loose:

```
  - also nested
                    ← this blank is present only with gap_owner
- loose alpha
```

Without the field, or on the older runtime, `- loose alpha` follows
the nested tight items directly. The old runtime does not refuse:
`prefix` (the opcode that *did* refuse a stale binary on 2026-08-26)
already existed at `4252a88`, so today's markdown package is a
header-only delta against that binary.

### 2.4 `tab_stop` is the same pattern, one day older

`packages/scheme.json` has `"tab_stop": 8`. Current runtime on
`scheme__nesting.tree.json` emits tabs. The same package with
`tab_stop` stripped emits spaces. The pre-tabstop runtime
(`509f355`) loads the current package, emits spaces, and matches
the stripped current run. Exit 0 both languages.

### 2.5 `comment_gap` is the same mechanism, with a twist in the old default

Before `dc8130c` the runtime hardcoded two spaces
(`format!("  {text}")`) and `min(2)` on blank runs. After it, the
fields default to **1**, and python opts back into 2.

Toy package with a trailing comment, `comment_gap: 1`:

| Runtime | Output |
|---|---|
| current Rust / current JS | `x=1 #c\n` (one space) |
| pre-commentgap Rust | `x=1  #c\n` (two spaces) |
| pre-commentgap JS (old `format(tree, cols, pkg)` API) | `x=1  #c\n` |

Exit 0. `comment_gap: 2` matches the old hardcoded 2, so python's
shipped values are not a victim of that particular old binary.
A `comment_gap: 1` package is.

`packages/python.json` against `python__comments.tree.json` on the
current runtime: `comment_gap: 2` vs a copy forced to 1 differs at
every trailing comment (`import os  # …` vs `import os # …`).

---

## 3. Per-field table

Loaders: **R** = Rust formatter (`pkg.rs`), **J** = JS formatter
(`bundle.js`), **HR** / **HJ** = highlight. "Absent default"
is what the *current* runtime uses when the key is missing.
"Layout?" is whether present-vs-absent (or present-vs-default)
changes formatter bytes or highlight spans on some input.

### Formatter packages (`et-doc-rules/1`) — 16 files

| Field | In packages | Added | R unknown | J unknown | Absent default | Layout if present vs default? | R/J agree? |
|---|---|---|---|---|---|---|---|
| `format` | 16/16 | `b9d43a5` 2026-08-15 | n/a (must equal `/1`) | n/a | **required** — missing is `unknown package format undefined` (JS) / type error (Rust) | identity, not layout | yes on refuse |
| `indent` | 16/16 | original | ignored if extra sibling; this key itself is known | same | **Rust: required** (missing field). **JS: 0** | yes (indent width; JS missing → unindented JSON) | **no — parity** |
| `tokens` | 16/16 | original | ignore extras | ignore extras | `[]` | yes, and often **loud** if emptied (unconsumed children) | yes |
| `comments` | 16/16 | original | ignore | ignore | `[]` | yes; emptying is **loud** (`left child \`comment\` unconsumed`) | yes |
| `descend` | 16/16 | original | ignore | ignore | `[]` | yes (comment placement). python `["block"]` stripped moves a leading comment onto the `def` line | yes |
| `optional_parens` | 11/16 | `347a4ef` 2026-08-14 | ignore | ignore | `[]` | yes. python operators/kitchen differ with the field stripped; calls does not | yes |
| `precedence` | 11/16 | original-ish | ignore | ignore | `{}` (unknown ops tightness 0) | can; stripped python operators file was identical (all-zero happens to agree on that tree) | yes |
| `defs` | 15/16 | original macros | ignore extras | ignore extras | `{}` | only via expansion into `rules`. If an old runtime *ignored* `defs`, `use` would be **loud** (`unknown definition`) | yes |
| `rules` | 16/16 | original | n/a (body is opcodes) | n/a | **required** | the program | yes (missing refuses) |
| `comment_gap` | 14/16 | `dc8130c` 2026-08-15 | ignore | ignore | `1` | yes. python ships `2`; scheme and json omit (→ 1). Old runtime hardcoded `2` | yes on current; old vs current silent |
| `blank_cap` | 15/16 | `dc8130c` 2026-08-15 | ignore | ignore | `1` | yes. python `2`, toml `2`, scheme `0`, json omits (→ 1). Old runtime hardcoded `min(2)` | yes on current |
| `flatten_fields` | **0/16** | `0857067` 2026-08-16 | ignore (top-level) | ignore (top-level) | `{left,operator,right}` | would, if a parser used different field names. Nested *unknown keys inside the object* are **refused** | yes |
| `tab_indent` | 1 (`go`) | `0d5163e` 2026-08-16 | ignore | ignore | `false` (spaces) | yes. go alignment: tabs vs one space. See §4 for why today's `go.json` is not a stale-binary victim | yes |
| `comment_cells` | 2 (`go` true, `rust` `"block"`) | `8a273bc` / `02a20bc` | ignore | ignore | `Off` | yes. go alignment comments lose the column; rust `block` vs `true` vs absent differs on structs/widths | yes |
| `tab_stop` | 1 (`scheme`) | `7ed6942` 2026-08-23 | ignore | ignore | `0` (off) | **yes, and stale-silent.** scheme nesting: tabs vs spaces | yes |
| `gap_owner` | 1 (`markdown`) | `3555eb2` 2026-08-24 | ignore | ignore | `{}` | **yes, and stale-silent.** markdown lists: loses the loose-list blank | yes |

`xml.json` has no `defs`. `json.json` has no `comment_gap` /
`blank_cap`. `scheme.json` has no `comment_gap`. Five packages omit
`optional_parens` / `precedence` (go, markdown, xml, haskell, scheme).

### Highlight packages (`et-highlight/1`) — 2 files, separate loader

| Field | In packages | HR unknown | HJ unknown | Absent default | Span-affecting if present vs default? | Agree? |
|---|---|---|---|---|---|---|
| `format` | 2/2 | must equal `/1` | must equal `/1` | required | identity | yes |
| `grammar` | 2/2 | **ignored** (not on `RawPackage`) | **ignored** (not read) | n/a | no. Reserved for roadmap point 3; documented as unread in v1 | yes |
| `scopes` | 2/2 | required | required | missing refuses | vocabulary for the others | yes |
| `leaf` | 2/2 | ignore extras | ignore extras | `{}` | yes | yes |
| `context` | 2/2 | ignore extras on the object and on each row | copies only `parent`/`field`/`parent_field`/`type`/`ancestor`/`scope` | `[]` | yes | yes |
| `background` | 1 (`python`) | ignore | ignore | `{}` | yes | yes |
| `keyword` | 1 (`python`) | ignore | ignore | `[]` (sugar into `leaf`) | yes | yes |
| `operator` | 1 (`python`) | ignore | ignore | `[]` | yes | yes |
| `punctuation` | 1 (`python`) | ignore | ignore | `[]` | yes | yes |

Highlight has **no opcodes**. The only loud header check is the
format string (plus scope-vocabulary validation of *values*, not
keys). A new highlight field is as silent as `gap_owner`, with less
surrounding machinery to accidentally make it loud.

### Parity defects found while answering (not the question, but they are real)

1. **Missing `indent`.** Rust refuses (`missing field \`indent\``).
   JS formats with indent 0. Confirmed on `json.json` /
   `json__basic.tree.json`: current JS with indent present emits
   two-space JSON; without, the same tree is unindented. This is a
   load-domain split of the FINDINGS 29b kind.
2. **`indent` as the string `"2"`.** Rust refuses (`invalid type:
   string "2", expected usize`). JS accepts (`" ".repeat("2")`).
3. **`tab_indent` as the string `"true"`.** Rust refuses. JS treats
   it as truthy and emits tabs.

Unknown-field behaviour itself matches.

---

## 4. How many fields are actually exposed

**Layout-affecting header fields** (present vs default changes
bytes, on some input): `indent`, `tokens`, `comments`, `descend`,
`optional_parens`, `precedence` (in principle), `comment_gap`,
`blank_cap`, `flatten_fields` (in principle), `tab_indent`,
`comment_cells`, `tab_stop`, `gap_owner`. That is 13 of the 16
formatter keys, plus the unused-in-packages `flatten_fields`.
`format` / `defs` / `rules` are not "ignored extras": they are
the identity check, the macro table (loud if missing at `use`),
and the program.

**Recently added** (after `et-doc-rules/1` started being refused,
`b9d43a5` 2026-08-15 14:17): `comment_gap`/`blank_cap` that same
afternoon; then `flatten_fields`, `tab_indent`, `comment_cells`,
`tab_stop`, `gap_owner`. Seven additions in nine days, none of
which bumped the format string. The format check is older than
every one of those fields and was never used for them.

**Wild stale-binary exposure** is narrower than "every
layout-affecting field", because a package that also uses a *newer
opcode* will refuse on a binary old enough to lack the field. The
question that matters is: *today's* shipped package, on a runtime
built immediately before that field existed.

| Field | Today's package | Pre-field runtime vs today's package |
|---|---|---|
| `gap_owner` | `markdown.json` | **Silent misformat.** Confirmed. `prefix` already existed, so the package loads. |
| `tab_stop` | `scheme.json` | **Silent misformat.** Confirmed. No newer opcode to hide behind. |
| `tab_indent` | `go.json` | **Not a victim today.** `cell` / `srctrail` arrived *after* `tab_indent`. Any binary that can load today's `go.json` already knows `tab_indent`. Stripping the field on a *current* runtime does change layout (tabs → spaces). |
| `comment_cells` | `go.json` (`true`), `rust.json` (`"block"`) | **Mostly not a victim today.** The field arrived with the `cell` opcode. `"block"` on a boolean-only loader would be a **type error** (loud), not a silent ignore. Stripping on a current runtime does change layout on go alignment and some rust files. |
| `comment_gap` / `blank_cap` | 14–15 packages | Mechanism confirmed on a toy. `python.json` ships 2, which *matches* the old hardcoded 2, so python is not a victim of that binary. Later languages generally cannot load on a pre-`dc8130c` binary (`source-multiline` already refused current `haskell.json`). |
| `flatten_fields` | none | Zero wild exposure. Nested unknown keys already refuse. |
| `optional_parens` / `precedence` / `descend` / `tokens` / `comments` / `indent` | many | Pre-date the format string, or arrived with it. Not "new field, old `/1` runtime". |

So: **`gap_owner` is not the only one of its kind. It is the
second clean case, after `tab_stop`.** Both are header-only layout
knobs in exactly one package, empirically silent on a runtime from
the previous day. That is a pattern, and `comment_gap` shows it
started the afternoon the format string landed.

`gap_owner` appears in exactly one package today. A `gap_owner`
rework that *adds another header field* (or renames this one)
inherits the same silence unless the format question is decided
first.

### Elsewhere, since you asked

- **`harness/languages/*.toml`:** unknown keys **refuse**
  (`manifest.py`: "Silently ignoring a typo'd field is how a
  builder loses an hour."). Not a hole. The opposite policy of
  the package header.
- **Tree JSON** (`rust/src/tree.rs`): serde, no
  `deny_unknown_fields`. An unknown node key is ignored. Different
  format, same loader shape. The harness owns this; it is not how
  a new *package* field escapes, but it is another silent surface
  if the tree schema grows.
- **`defs`:** not silent-if-ignored, because `use` would refuse.
  Not an exposure of this kind.
- **Highlight `grammar`:** already an unread key in both shipped
  highlight packages. `deny_unknown_fields` added tomorrow would
  have to list it (or drop it from the files) or those two
  packages stop loading.

---

## 5. Options

The question: **how should a layout-affecting header field fail, on
a runtime that does not implement it?**

### A. Bump the format string when such a field is added

New runtime accepts `/1` *and* `/2`. Packages that use the new
field say `/2`. Packages that do not stay on `/1`.

- **Buys:** the only check every runtime since `b9d43a5` already
  performs on the header. A `4252a88` binary given today's
  markdown would print `unknown package format \`et-doc-rules/2\``
  instead of a tight list. Matches what `DESIGN.md` already claims.
  One string per affected package (~20 bytes). Runtime change is
  "accept this token too".
- **Costs:** coordinated runtime + package edit. New runtime must
  keep accepting `/1` or every untouched package breaks. Format
  numbers accumulate if fields keep landing at the current pace
  (seven in nine days). Retroactively bumping *all* post-`/1`
  fields (scheme, go, rust, python, toml, …) is more churn than
  bumping markdown for `gap_owner` alone.
- **Forecloses:** using `/2` for an unrelated break in the same
  breath — you spend the number on this. `/3` is still available.
  Does *not* catch a typo of a field the current runtime *does*
  know.

### B. A `requires` list naming fields the runtime must understand

`"requires": ["gap_owner"]` next to `"format": "et-doc-rules/1"`.

- **Buys:** finer than a monotonic integer; a runtime could
  implement `tab_stop` without `gap_owner`.
- **Costs:** an old runtime **ignores `requires`**, because it is
  itself an unknown header field. Chicken and egg. Only works on
  runtimes built *after* `requires` is wired, which is the same
  population `deny_unknown_fields` can reach.
- **Forecloses:** nothing useful. Encoding the same list in the
  format string (`et-doc-rules/1+gap_owner`) is option A with a
  longer token, and *does* trip the existing check.

### C. Reject unknown header keys (`deny_unknown_fields` / JS allowlist)

- **Buys:** typos (`coment_gap`) become load errors, matching
  manifests and `flatten_fields`. A *future* runtime that lacks
  tomorrow's field will refuse a package that carries it *even if
  someone forgets to bump `format`*. Defence in depth going
  forward.
- **Costs:** **does not reach already-built binaries.** `4252a88`
  and the 2026-08-26 stale `prefix` binary will keep ignoring new
  keys until they are rebuilt. Current highlight packages carry
  unread `grammar`; a naive allowlist breaks them unless `grammar`
  is declared. Adding it now does not make last week's binaries
  start refusing `gap_owner`.
- **Forecloses:** shipping reserved-but-unread keys without listing
  them (the `grammar` move). Reserved keys have to be named in the
  struct even when ignored.

### D. Do nothing; document that header fields are ignored

- **Buys:** zero churn. Packages and runtimes keep shipping as a
  rebuild-from-HEAD pair. Matches "nothing downloads packages yet"
  (roadmap point 3).
- **Costs:** `DESIGN.md` stays wrong. The 2026-08-26 stale-binary
  event already happened for opcodes; the matching event for
  `gap_owner` is silent, so it is worse. Every later header-only
  knob (`gap_owner` rework included) repeats it. When packages
  *are* served to something that did not build them, this becomes
  a format-migration, which is the thing roadmap point 3 wanted
  to avoid.
- **Forecloses:** treating `format` as the compatibility gate it
  is documented to be.

### E. A plus C

Bump `format` for layout-affecting fields (A), and reject unknown
keys on new runtimes (C).

- **Buys:** A closes the stale-binary hole that already exists. C
  closes typos and the "forgot to bump" case on binaries built
  after C lands.
- **Costs:** both of A's and C's. Still the `grammar` allowlist
  footnote. Still a dual-accept format check in both loaders.
- **Forecloses:** the same as A and C.

A dummy unused rule whose opcode is the feature name (`["__gap_owner__"]`)
would also trip old runtimes at load, because unknown opcodes already
refuse. That is a worse spelling of A. Not listed as an option.

---

## 6. Recommendation

**A.** Bump `et-doc-rules/N` when a layout-affecting header field
is added. The new runtime accepts the previous N. Only packages
that *use* the new field move. Do not implement C as a substitute
for A; it cannot see last week's binaries.

Do not retroactively bump every post-`/1` field tonight. The two
clean wild cases are `gap_owner` (markdown) and `tab_stop`
(scheme). Fold markdown's bump into whatever `gap_owner` rework
comes next; scheme is the same one-line change if a stale
`tab_stop` binary is still in play. `comment_gap` does not need a
retroactive bump: the victim set against pre-field binaries is
empty among packages those binaries can load.

C is worth doing later as typo hygiene (and to make the next
forgotten bump loud on *new* binaries). It is not the answer to
this question. B does not work. D leaves a lying sentence in
`DESIGN.md` and a silent path that has already been measured.

**The one fact that would change this:** if packages and runtimes
are always rebuilt and shipped as a pair, so a binary older than a
field is never asked to load a package that uses it. Then A is
ceremony and D (with the `DESIGN.md` sentence struck) is enough.
The 2026-08-26 `unknown opcode prefix` refusal is that fact going
the other way: stale binaries are how this repo is used. Opcodes
protected that day. Header fields would not have.

---

## Evidence index

- Loaders: `rust/src/pkg.rs` (`RawPackage`, no
  `deny_unknown_fields`; `FORMAT = "et-doc-rules/1"`),
  `rust/src/hl_pkg.rs` (same for highlight),
  `runtime-js/bundle.js` (`buildPackage`, `gapOwnerField`,
  `validatePackageFormat`), `runtime-js/highlight.js`
  (`loadPackage`). Nested contrast: `flatten_fields` in both
  loaders. Manifest contrast: `harness/manifest.py` `_KNOWN`.
- Format-string tests already in-tree: `pkg.rs`
  `refuses_an_unknown_package_format` (the `et-doc-rules/2` case
  named in the brief), `hl_pkg.rs` equivalent,
  `bundle.test.js` / `highlight.test.js` mirrors.
- `gap_owner` layout tests already in-tree:
  `eval.rs::a_declared_gap_owner_measures_past_the_childs_own_subtree`,
  `bundle.test.js` "a declared gap owner measures past the child's
  own subtree". The old-runtime run is the same tree against
  `4252a88`.
- Field-addition commits (all under `et-doc-rules/1`):
  `b9d43a5` format check; `dc8130c` `comment_gap`/`blank_cap`;
  `0857067` `flatten_fields`; `0d5163e` `tab_indent`; `8a273bc` /
  `02a20bc` `comment_cells`; `7ed6942` `tab_stop`; `3555eb2`
  `gap_owner`; `d4e4f89` markdown starts using it.
- Experiments: `/tmp/hs-exp/results.json` and the throwaway
  package dirs beside it. Not committed.
