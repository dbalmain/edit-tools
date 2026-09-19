# Ledger reason-vs-diff audit

**Snapshot.** Written on `wt/ledger-audit` at `bff4071`, against the 142
records the ledger held then. It holds 140 now and the flagged reasons have
been re-signed. Check any row against the live `*.jsonl` before acting on it.

142 records in `harness/reviews/formatter/*.jsonl`. Input is
`./harness/review_formatter.py . --json` against a freshly built
`rust/target/release/docfmt` (mtime 2026-08-28 21:22, after `./build.sh`).
Every ledger hash matches the current `(ours, reference)` pair. `stale: 0`.
This audit is not a hash check. It asks whether the `reason` still accounts
for the diff it is stored against.

**Result.** The 142 reasons are in good shape. Seven records fail the bar
applied below; none of the seven is a mislabelled `package-bug`, so none of
them moves a merge decision. The rest are COVERED.

## The bar actually applied

The prompt's "reason must account for every hunk" is the right *question* and
the wrong *unit*. A unified-diff hunk is a line-range accident. One root
cause routinely produces several hunks, or several constructs inside one
hunk. Treating that as UNDERCOUNTS would have filed dozens of false
positives, which the prompt also asked me not to do.

A record is **COVERED** when every remaining disagreement is produced by a
mechanism the reason names (or by an admitted, correctly-labelled house
choice sitting next to that mechanism). The reason does not have to
enumerate hunks.

**UNDERCOUNTS** is a distinct unexplained construct: a remaining difference
whose cause is not the named mechanism. "One root cause, several hunks" is
not this.

**WRONG-CAUSE** is a named mechanism that is factually false, or that does
not produce this diff. If the reason's *only* mechanism is now false
(the IR grew, the leftover bytes did not), that is WRONG-CAUSE even when
the leftover is still a real design-limit. If it names a false lead *and*
the true leftover, it is COVERED with a stale lead — see
`rust/comments.rs`.

**WRONG-VERDICT** is reserved for a label that does not follow, and in
particular for a settled label (`design-limit` / `house-rule` /
`reference-quirk`) that should have been `package-bug`. That is the only
class that changes a merge decision. I did not file it because a package
*edit* is imaginable; I needed evidence that an existing opcode/predicate
composition would match the reference without a new capability and without
regressing other files. "Would need FINDINGS entry N" is a design-limit, not
a package-bug. A house-rule that honestly says "we could, we chose not to"
is correctly labelled even when the alternative is a one-file special case.

**UNVERIFIABLE** is a claim that cannot be checked from this repo (live
prettier behaviour not in `corpus/reference/`, an uncommitted experiment,
etc.). Claims of the form "tested and reverted; agreement went from A to B"
were treated as COVERED when the current diff is the predicted leftover,
not as UNVERIFIABLE, because the leftover is what we can see.

Falsifiable phrases ("the only hunk is…", "every hunk is…", "sole remaining",
"otherwise identical") were checked first. Almost all of them were true.
The failures that exist are not of that shape.

## Counts

| class | n |
| --- | ---: |
| COVERED | 135 |
| UNDERCOUNTS | 4 |
| WRONG-CAUSE | 3 |
| WRONG-VERDICT | 0 |
| UNVERIFIABLE | 0 |
| **ledger records** | **142** |

Per language, non-COVERED only:

| language | records | COVERED | other |
| --- | ---: | ---: | --- |
| css | 12 | 11 | 1 WRONG-CAUSE |
| go | 4 | 4 | |
| haskell | 3 | 3 | |
| html | 9 | 9 | |
| javascript | 13 | 12 | 1 UNDERCOUNTS |
| kotlin | 1 | 1 | |
| markdown | 9 | 9 | |
| python | 4 | 4 | |
| ruby | 15 | 15 | |
| rust | 16 | 14 | 2 WRONG-CAUSE |
| scheme | 12 | 11 | 1 UNDERCOUNTS |
| toml | 7 | 7 | |
| typescript | 17 | 17 | |
| yaml | 20 | 18 | 2 UNDERCOUNTS |

Verdicts on file: 132 `design limit`, 10 `house rule`, 0 `package bug`,
0 `reference-quirk`. Reviewer hashes all match. `./harness/score.py .`
after the build: 0 stale, 0 unreviewed (among scored pairs), 0 package-bug,
gates passed. That scorecard is the `main` scorecard; this audit did not
edit runtime, packages, corpus, or the ledger.

Two bookkeeping mismatches are worth stating so the 142 and the scorecard
are not used as if they counted the same things:

- The scorer reports **133** accepted divergences, not 142. Nine ledger
  records sit on files the scorer *excludes*: `html/{prose,quotes,void_slash}`
  at both widths (6), `rust/leading_pipes.rs` at both widths (2), and
  `ruby/block_conversion.rb@40` (1). Those nine were still audited. They
  are COVERED.
- `review_formatter.py --json` emits **153** divergences: the 142 plus 11
  *unreviewed* pairs, all on excluded files
  (`haskell/{import_merging,imports}.hs@80`, `kotlin/imports.kt@100`,
  `markdown/{emphasis,list_markers,thematic}.md` at both widths,
  `xml/empty_to_self_closing.xml` at both widths). They are not in the
  ledger and were not classified. The scorer is right to drop them from
  coverage; the review tool is right to show them. Nothing currently says
  they are two different populations.

## Findings, by severity

No WRONG-VERDICT. Then WRONG-CAUSE, then UNDERCOUNTS.

### WRONG-CAUSE `css/custom_properties.css@80`

- **On file:** `design limit`, Codex (CSS stage D reviewer), 2026-08-16T12:51:08Z
- **Claims:** "The IR lacks fill, so a mixed comma and space value list can
  only stay flat or break every comma rather than pack two shadows on a
  continuation line."
- **Diff:** one hunk, and it *is* that packing:

```diff
   --list:
-    0 1px 2px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.08),
+    0 1px 2px rgba(0, 0, 0, 0.1),
+    0 2px 4px rgba(0, 0, 0, 0.08),
     0 4px 8px rgba(0, 0, 0, 0.06);
```

- **Why WRONG-CAUSE, not UNDERCOUNTS.** The leftover is real and is a
  design-limit. The *cause* is not. `fill` shipped the same day (FINDINGS 8,
  LEDGER row 12); `packages/css.json` uses it. This declaration does not,
  because the value is a flat token soup of numbers, `call_expression`
  (`rgba(...)`), and commas: the `all` arm that would `fill` only fires for
  `{property_name, string_value, plain_value, important}`, and the mixed
  arm uses `each`. The later, re-judged sibling `css/kitchen.css@80` (Grok,
  21:52 the same day) states the actual remaining limit: packing a mixed
  comma/space list whose fill items are tokens explodes the last `rgba()`.
  `custom_properties` was never re-signed because the hash did not move —
  fill does not change this file's output.

- **Proposed verdict:** `design-limit` (unchanged)
- **Proposed reason:** "Mixed comma/space shadow lists cannot fill. Named
  children of the declaration are tokens and `rgba()` calls, not shadows, so
  fill either stays unused (`each` on this arm) or packs the last `rgba()`
  open; kitchen.css@80 is the same leftover. The IR has fill; this is a
  fill-item granularity limit, not a missing opcode."

### WRONG-CAUSE `rust/leading_pipes.rs@100` and `@60`

- **On file:** `design limit`, opus-orchestrator (excluded from the
  scorecard; still in the 142)
- **Claims:** "Entry 13: rustfmt deletes the redundant leading pipe in a
  match pattern and no opcode can express deleting a token -- a rule either
  emits it or refuses at the cursor. … Gate 3 permits the deletion."
- **Diff** (width-insensitive, both records):

```diff
     match value {
-        1 => "one",
-        2 | 3 => "two or three",
-        _ => "other",
+        | 1 => "one",
+        | 2 | 3 => "two or three",
+        | _ => "other",
     }
```

- **Why WRONG-CAUSE.** Both named facts are false in this repo. `drop`
  exists (`rust/src/pkg.rs`, FINDINGS 13 "Built"), and
  `harness/languages/rust.toml` already records the move: "the `drop`
  opcode now makes the deletion sayable, and with it this file is
  byte-identical to rustfmt at both widths -- but gate 3 rejects the
  `| _` arm, because an `or_pattern` holding only anonymous tokens
  cannot be declared transparent." The leftover bytes are the same; the
  mechanism is now a gate-skeleton hole, not a missing opcode. Not a
  package-bug: applying `drop` here fails gate 3, so the file stays
  incomparable. The incomparable *comment* was updated; the ledger
  reason was not, because the hash did not move.

- **Proposed verdict:** `design-limit` (unchanged; the file remains
  excluded)
- **Proposed reason:** "`drop` deletes the leading `|` and the formatted
  bytes then match rustfmt. Gate 3 still rejects `| _`: an `or_pattern`
  of only anonymous tokens cannot be declared transparent, and eliding
  it changes the parent `match_pattern` skeleton. Incomparable for that
  gate hole, not because deletion is unsayable."

### UNDERCOUNTS `javascript/kitchen.js@40`

- **On file:** `design limit`, deepseek-v4-pro, 2026-08-19T19:48:49Z
- **Claims:** "Same method-chain limit as chains.js, plus the inner
  `tags.filter().map()` chain (FINDINGS 11)."
- **That is true of the first half of the hunk.** The second half is a
  different construct, a one-argument call that prettier hugs and we
  expand:

```diff
   if (i % 2 === 0) {
-    process([
-      { id: i, value: i * 2, tags: [] },
-    ]);
+    process(
+      [
+        {
+          id: i,
+          value: i * 2,
+          tags: [],
+        },
+      ],
+    );
   }
```

- **Why UNDERCOUNTS, not WRONG-VERDICT.** TypeScript's sibling
  `kitchen.ts@40` (codex-Sol) names the same one-argument-call difference
  and keeps it as a cross-language house choice on the shared
  JavaScript/TypeScript `list` rule. `decorators.ts@40` is the same choice
  signed as `house-rule`. So this is not a forgotten package-bug; it is an
  unexplained hunk on a record whose named cause is still the chain. The
  mixed-pair template delta (LEDGER, 2026-08-16: a genuine limit does not
  excuse an avoidable defect until the defect is removed) does not apply —
  the leftover is a house choice, not a defect, and the TS reviewer already
  settled it that way.

- **Proposed verdict:** `design-limit` (unchanged; the chain remains)
- **Proposed reason:** "FINDINGS 11 on `records.filter().map().sort()` and
  the inner `tags.filter().map()`. The `process([{...}])` wrapping is the
  shared JavaScript/TypeScript list rule declining last-collection hugging,
  the same house choice TypeScript signed on kitchen.ts@40 and
  decorators.ts@40; it is not a second design-limit and not a package-bug."

### UNDERCOUNTS `yaml/anchors.yaml@80` and `yaml/anchors.yaml@40`

- **On file:** `design limit`, codex-Sol, 2026-08-16T13:47–13:48
- **Claims:** "Existing entry 10: `block_node` needs call-site-sensitive
  hanging-value layout; same-line construction fixed the anchor but
  destroyed nested indentation, and parent dispatch alone cannot reattach
  colon comments."
- **Hanging layout is in the diff and is COVERED:**

```diff
-defaults: &def
+defaults:
+  &def
   host: localhost
   port: 8080
```

- **The other remaining disagreement is entry 9, not entry 10, and is not
  a colon comment.** Own-line section comments are attached inside the
  preceding mapping and pick up its indent:

```diff
-# Alias as a whole value.
+  # Alias as a whole value.
 copy: *def
```

```diff
-# Anchor on a flow mapping. Fits at 80, breaks at 40 -- prettier keeps
-# the anchor on the key and breaks the mapping, it does not convert to block.
+  # Anchor on a flow mapping. Fits at 80, breaks at 40 -- prettier keeps
+  # the anchor on the key and breaks the mapping, it does not convert to block.
```

  Trailing colon comments in this file (`port: 443 # overrides the merged
  port`) already agree. The "colon comments" clause names a failed
  experiment, not a remaining hunk. The same reviewer, the same day, names
  entry 9 correctly on `block_collections.yaml` and `comments.yaml` for
  this exact leftover.

- **Proposed verdict:** `design-limit` (unchanged)
- **Proposed reason:** "FINDINGS 10 on hanging `&anchor` after the colon
  (same-line construction destroyed nested indent). FINDINGS 9 on the
  section comments after `defaults` and after the merge mapping: they
  attach inside the preceding subtree, so a package cannot outdent them.
  Trailing colon comments in this file already match."

### UNDERCOUNTS `scheme/normalisation.scm@80`

- **On file:** `design limit`, codex-Sol (stage D)
- **Claims:** "Emacs preserves intra-line whitespace and pre-comment
  padding, while the IR canonically emits separators and `comment_gap`
  and exposes no source-whitespace predicate or preservation opcode.
  Verbatim list rendering would also preserve the wrong leading
  indentation."
- **That covers packed spacing, `( )` vs `()`, and the comment-gap run.**
  The second hunk also moves the continuation `c` from emacs's
  first-argument column (a tab) to our uniform +2:

```diff
 (define (mixed-padding a b c)
-  (list  a   b
-	 c))
+  (list a b
+    c))
```

  The file's own comment says leading indent is *rewritten*, not
  preserved. That rewrite is FINDINGS 29a (indent to the actual first
  argument), already proven on `calls.scm`. Canonical separators explain
  collapsing `  a   b`; they do not explain the column of `c`.

- **Proposed verdict:** `design-limit` (unchanged)
- **Proposed reason:** "Intra-line padding, empty-list interior space,
  and pre-comment runs have no source-whitespace opcode, and verbatim
  lists would freeze the over/under-indented controls that currently
  match. Separately, `(list a b / c)` wants first-argument alignment
  (FINDINGS 29a), which a fixed +2 cannot produce."

## Labelling notes that are not WRONG-VERDICT

These do not change a merge decision. They are calibration, not defects.

- **Markdown tables vs TOML comments, both FINDINGS 1.**
  `markdown/{tables,kitchen}.md` at both widths are signed `house-rule`
  ("not worth a markdown-only pad opcode"). `toml/{comments,normalisation}`
  at both widths are signed `design-limit` for the same missing sibling-width
  padding, with a house-style sentence attached. Both are settled-accepted.
  The more consistent label for "the IR cannot pad; we also would not add
  an opcode for one language" is `design-limit`, which is how TOML and
  FINDINGS 1 already speak. I am not reclassifying; a later reviewer can.

- **TypeScript `kitchen.ts@40` / `@80` mix a design-limit with an admitted
  expressible special case** (constructor parameter-properties, class-brace,
  one-argument call) and keep `design-limit` at file level. The reasons
  *name* the expressible part and call it a house choice. That is honest
  coverage. The 2026-08-16 mixed-pair rule was written for a leftover
  *defect* (`url()` on `strings.css`), not for a leftover house choice.

- **`rust/comments.rs@100` and `@60` lead with FINDINGS 22**
  ("`comment_cells` is package-wide and unscoped") after the package
  opted into `"comment_cells": "block"`. That lead is stale — the same
  reason-rot as `custom_properties`. I am not counting them WRONG-CAUSE,
  because the same sentences also name FINDINGS 9 and 7, and those are
  exactly the remaining hunks (mid-expression `/* */` moved to a suffix;
  closer-comment indent; at 100, `first, second` packed on one line).
  A reason that names a false mechanism *and* the true leftover is
  COVERED with a stale lead, not WRONG-CAUSE. Replacement text would
  drop the Entry 22 sentence, matching how `widths.rs` was rewritten to
  "Entry 11, alone now."

- **Nine excluded-file records in the ledger** (`html/prose`, `html/quotes`,
  `html/void_slash`, `rust/leading_pipes`, `ruby/block_conversion`) are
  still in the 142. Two of them (`leading_pipes`) are the WRONG-CAUSE
  above; the other seven are COVERED. They make "142 accepted" and
  "133 accepted" two true numbers for two populations.

## Per-language notes (COVERED, in short)

**css (11/12).** `at_rules` / `nested` / `kitchen@40` are the same
node-local `binary_query` limit. `calc` and `kitchen@80` minmax() are the
cannot-start-broken-on-this-line fill limit. `comments` is FINDINGS 9
attachment. `selectors` combinator spine plus `:is() a:not()` descendant
is one grouping decision. `strings` "sole remaining" quote rewrite is
literally the only remaining byte. `custom_properties` is the WRONG-CAUSE
above. `kitchen@80` names three remaining constructs and the diff has
exactly those three.

**go (4/4).** `functions` is `struct{` vs `struct {`. `generics` names both
that space and the `[]` operator tightness. `operators` is parent-position
tightness (FINDINGS 10). `normalisation` names mixed-precedence spacing,
`if` parens, redundant parens, and ASI semicolons; all four are in the
diff.

**haskell (3/3).** Sibling-name blank (functions, signatures, comments
hunk 1) plus runtime attachment of the record own-line comment (comments
hunk 2). The "only" in functions.hs is "the only package-level expression
is enumerating identifiers", not "the only hunk".

**html (9/9).** Three scored (`inline@80`, `inline@40`, `normalisation@80`)
and six excluded. Hug-close is FINDINGS 10; source-gap-forced group is a
missing predicate; prose / quotes / void-slash are linearity and named-node
rewrites. `quotes@40` wrapping the escaped `title` is a consequence of the
named escape rewrite, not a second cause.

**javascript (12/13).** Chains, comments (FINDINGS 9 + comment-barrier fill
+ FINDINGS 6 at 40), control-flow paren deletion, modern FINDINGS 15,
normalisation paren/ASI, operators (pair-sensitive flatten, FINDINGS 2,
FINDINGS 15), sequences tail-aware fill. `kitchen@80` "only remaining
hunks" is true (the chain). `kitchen@40` is the UNDERCOUNTS above.

**kotlin (1/1).** Magic trailing comma vs `short` in the same file.
Overturning a previous `package-bug` is documented and the controlled pair
is in the diff.

**markdown (9/9).** Every "only hunk" / "every hunk" claim matches. Fences
closer blank; kitchen and tables column padding; nesting JSON-array
policy (guest, not splice); normalisation `>  bar` marker padding.

**python (4/4).** Chains (FINDINGS 11, including `call_then_attr` in the
same hunk); kitchen FINDINGS 15(b) boolean vs call; operators grammar
associativity; strings FINDINGS 15(a) autoparen.

**ruby (15/15).** Reasons are the most hunk-accurate in the ledger. Stage D
names what was fixed ("after Stage D fixed the expressible empty-bracket
hunk") and what remains (FINDINGS 6, 1, 8-extension, 2×10, chain flatten
that cannot consume `argument_list`/blocks). `kitchen@40` three hunks are
raise-align, rescue-align, `sort_by.reverse` chain.
`block_conversion.rb@40` (excluded) is the `block` → `do_block` rewrite
gate 3 rejects; the reason matches the whole file.

**rust (14/16).** Chains (FINDINGS 11); comments COVERED with a stale
Entry 22 lead (see labelling notes); generics `trail` pin; kitchen chain
+ ancestor-break braces; opaque-leaf house-rule on `strings` and
`macro_patterns` with a measured regression; FINDINGS 6 array;
or-patterns FINDINGS 23; one-item `trail` on patterns/structs; widths
"comment columns are byte-identical, remaining is the chain" is true of
the current hunk. `leading_pipes` is the WRONG-CAUSE above.

**scheme (11/12).** Head/cadr specform plus first-argument/opener column
(FINDINGS 10 / 29a) covers bindings, calls, control, define, heads,
kitchen, lambda, long_sequences, macros. comments names three distinctions
and has three. `quote.scm@80` is the cleanest house-rule in the ledger: a
child-count branch would make the file exact and they declined it.
`normalisation.scm@80` is the UNDERCOUNTS above.

**toml (7/7).** `trail` pin on arrays (trailing comma *and* source-broken
`already_broken`, same opcode); comment alignment (FINDINGS 1); nested
inline-table arrays not inheriting the outer break (FINDINGS 2);
normalisation "remaining diff is comment alignment" is literally one
column of spaces.

**typescript (17/17).** Reasons were rewritten after `drop`, `fill`, and
comment-fill work, and it shows. `normalisation@40` even calls out a stale
report claim ("additional generic-call hunk") that is no longer in the
diff. `comment_fill` "every hunk has two causes" matches. `decorators`
house-rule is explicit. `kitchen` names both the chain and the expressible
special cases.

**yaml (18/20).** Entry 3 (`trail` pin), 4 (explicit `?`), 6 (suffix in
fit), 9 (section comments), 10 (hanging `block_node`) are used consistently,
except on `anchors` (UNDERCOUNTS above). `kitchen` "keep-chomping is fixed,
remaining is 9 and 10" matches. `flow_sequence` "only" was a scanner hit
on "the only policy", not an only-hunk claim.

## Systemic patterns

1. **Reason-rot on a stable hash is the real gap, and it is not theoretical.**
   `css/custom_properties.css@80` (fill shipped) and
   `rust/leading_pipes.rs` (`drop` shipped; `rust.toml` already says so)
   are the exhibits. A capability landed; those files' bytes did not
   move; the reasons still describe the pre-capability IR. `rust.toml`
   was updated; the ledger was not. The hash is doing its job (the
   *diff* is the same). Nothing re-asks whether the *prose* is still
   true of the current IR. The 2026-08-28 incident the prompt cites — a
   byte-identity claim measured against a runtime that could not load
   the package — is this class, not the "only hunk is the pipe table"
   class. Falsifiable hunk-count claims in this ledger are almost all
   true. Stale *mechanism* claims are the ones that survive.

2. **Re-review concentrates on hashes that moved.** TypeScript, JavaScript
   comment-fill, CSS kitchen/calc/nested, Rust widths/structs: all
   re-signed after a capability landed, and those reasons name the new
   leftover. Records whose output did not change were not revisited.
   That is exactly what `state()` implements.

3. **Reviewer quality is not uniform, but it is not a scorecard problem.**
   codex-Sol's TypeScript and Ruby reasons are the most precise (named
   failed experiments, "after Stage D fixed X, remaining is Y").
   deepseek-v4-pro's JavaScript `kitchen@40` dropped a hunk. CSS stage D
   (Codex, morning) was accurate on comments/selectors/at_rules and then
   went stale on fill the same afternoon. grok-4.6 markdown "only hunk"
   claims all survived. gpt-5.6-luna's seven Rust records are short and
   still match; the later opus-orchestrator Rust records are longer and
   also match. I would not re-rank the reviewer table off four records.

4. **House-rule is rare (10) and used correctly** except for the markdown
   tables / TOML comments labelling split on FINDINGS 1. The three
   "we could, we chose not to" records that matter for calibration —
   `scheme/quote.scm@80`, `typescript/decorators.ts@40`,
   `rust/{strings,macro_patterns}.rs@60` — all describe a real alternative
   and a real cost.

5. **"Only hunk" / "every hunk" / "sole remaining" did not concentrate
   failures.** 29 records flagged by those phrases; 0 of the 7 non-COVERED
   records are in that set. The prompt's concentration hypothesis is
   wrong on this ledger. The failures are omitted sibling causes
   (kitchen.js, yaml/anchors, scheme/normalisation) and stale opcode
   claims (fill, `drop`).

## Pushback on the criterion, and on where the weakness actually is

The hash covers the right bytes. `state()` comparing `ours+reference` is
not the bug. A reason-check that demanded per-hunk accounting would also
not have caught `custom_properties`: that record has one hunk, and the
hunk is the phenomenon the reason describes. What it gets wrong is the
*mechanism*, which is a fact about the IR, not about the diff.

If this audit is turned into a tool, the cheap check that would have
caught the actual failure is not "does the reason mention every hunk".
It is closer to:

- Does the reason name an opcode or FINDINGS entry that has since been
  built, while this hash did not move?
- Does a sibling record signed later, on the same construct, give a
  different cause?

`custom_properties` (12:51, "IR lacks fill") vs `kitchen.css@80` (21:52,
"fill items are tokens") is that pair sitting in one language file.

A per-hunk coverage checker would still be worth running on *new*
reviews, as a lint, because "the only hunk is the pipe table" on a
three-hunk diff is cheap to catch and was the shape that motivated the
prompt. On this 142 it would have reported 0. Do not build it as the
merge bar.

I do not think `package-bug` is being avoided by wording here. The ten
house-rules that admit an expressible alternative say so in the reason.
The design-limits that claim a failed package experiment usually name
the experiment. The one place a mixed pair is still in the hash
(TypeScript kitchen, JavaScript kitchen) treats the expressible part as
a house choice, which is the opposite of sneaking a defect through.

A second pass argued the opposite: `kitchen.ts@80/@40` and six YAML
scalar-hang records (`strings` both widths, `keys@40`, and the scalar
slices of `comments@40` / `kitchen@40` / `tags@40`) should be
`package-bug` under the 2026-08-16 mixed-pair rule, because
`child-count` already peeks through `flow_node` (YAML uses it for
`block_scalar`) and a TypeScript `child-count` of
`accessibility_modifier` would break parameter-property constructors.
I did not take that. The YAML reviewer's experiment was "remove the
group", which does regress flow mappings; the proposed *split* was not
run. FINDINGS 10 already names growing that peephole as the failure
mode. Filing `package-bug` on an unrun composition would be the thing
this bar forbids: an imagined package edit. If someone runs the
`child-count f:value t:flow_mapping` split and it matches without
regression, that is a new fact and those records should be re-judged.
It is not a fact this audit has.

## Scorecard

Unchanged from `main`. After `./build.sh` and `./harness/score.py .`:

- gates 0–3: 405/405
- accepted divergence 133/384 (scored); 142 ledger records
- stale 0, unreviewed 0 (scored), package-bug 0
- reference agreement 251/384

No runtime, package, corpus, or ledger bytes were changed. No harness
Python was added.
