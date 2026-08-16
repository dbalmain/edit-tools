# CSS corpus report (stage A)

## Manifest

`harness/languages/css.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                                                         | How it was established                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grammar`              | `tree-sitter-css==0.25.0`                                                                     | Live PyPI: the distribution name matches the orchestrator's guess, and 0.25.0 is the latest release.                                                                                                                                                                                                                                                   |
| `grammar_module`       | `tree_sitter_css`                                                                             | `uv run --with tree-sitter-css==0.25.0` then `import tree_sitter_css`. The hyphen-to-underscore swap is correct here.                                                                                                                                                                                                                                  |
| `grammar_symbol`       | `language`                                                                                    | The module exports `language()` (and `HIGHLIGHTS_QUERY`). It returns a `tree_sitter.Language` capsule.                                                                                                                                                                                                                                                 |
| `injection_aliases`    | `["css"]`                                                                                     | The only info-string spelling worth vouching for. `scss` and `less` are different languages; `style` is a guess.                                                                                                                                                                                                                                       |
| `reference`            | `npx --yes prettier@3.9.6 --no-config --stdin-filepath x.css --print-width {width}`           | Source on stdin, formatted source on stdout. `--stdin-filepath` **is** required: without it (and without `--parser`) prettier errors `No parser and no file path given`. `--parser css` is an alternative, not a second flag, so it is omitted. `--no-config` **is** required (below). `--print-width` honours `{width}`: 80 vs 40 differ on 12 of 15 files. |
| `reference_version`    | `3.9.6`                                                                                       | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Latest stable as of 2026-08-16 (JSON is still on 3.6.2).                                                                                                                                                                                                                                 |
| `reference_width`      | `flag`                                                                                        | Ran the same input at 80 and 40 and diffed. Value lists, function arguments, `@supports` conditions and some compound selectors reflow. `{width}` is therefore real.                                                                                                                                                                                   |
| `widths`               | `[80, 40]`                                                                                    | 80 is prettier's own default (below). 40 is the narrow width that actually splits `@supports`, `:is()` descendants, and `minmax()`. 60 still leaves most of those flat.                                                                                                                                                                                |
| `gate3`                | `default`                                                                                     | See below.                                                                                                                                                                                                                                                                                                                                             |
| `transparent_wrappers` | `[]`                                                                                          | Gate 3 accepted prettier on 30/30 runs without naming a wrapper.                                                                                                                                                                                                                                                                                       |
| `equivalent_kinds`     | `[]`                                                                                          | Same: nothing was renamed.                                                                                                                                                                                                                                                                                                                             |

### Default width is 80, by bisection

Three independent observations, not `--help` alone:

1. `prettier --help` and `prettier.getSupportInfo()` both say `printWidth` defaults to 80.
2. Unprompted output (no `--print-width`) is byte-identical to `--print-width 80` on every probe tried.
3. A `font-family` list whose filled line is **exactly 80 characters** is produced with no width flag. `--print-width 79` wraps one item earlier; `--print-width 87` fits one more item on the first line. So 80 is the line length at which the unprompted output starts breaking.

### `--no-config` is load-bearing

prettier searches for `.prettierrc` / `prettier.config.*` / `package.json` from
the `--stdin-filepath` directory **and every ancestor**. A planted config with
`tabWidth: 8` and `singleQuote: true` (options the command line does **not**
pass) silently re-indented the file and rewrote `"Arial"` to `'Arial'`.

`--print-width` **wins** over a planted `printWidth` (default
`config-precedence` is `cli-override`): `--print-width 80` beat a file's
`printWidth: 20`. What leaks from a discovered config is every option the
command line does not name — `tabWidth`, `singleQuote`, `useTabs`. That is why
the flag is still load-bearing even though we pass `{width}`.

`--no-config` also suppresses `.editorconfig` (verified: `indent_size = 8`
applied without the flag and vanished with it). `--no-editorconfig` is therefore
redundant and is omitted.

Leftover channels the disable flag leaves open:

- An explicit `--config path` still applies. `--no-config` and `--config`
  together is an error, so they cannot be combined by accident.
- There is no `PRETTIER_*` environment variable equivalent of `TAPLO_CONFIG`.

`--stdin-filepath` itself is the search root: `--stdin-filepath fake/dir/x.css`
loaded `fake/dir/.prettierrc`, while `--parser css` (no filepath) did not.
`--no-config` closes that path too. There is no prettier config in this
worktree or its ancestors today; the committed command includes the flag so
regeneration does not depend on a reviewer's `$HOME`.

`gen_reference.py --check` is silent with that command.

### Why not `gate3 = "css"`

There is no CSS data-model loader that would help. The spellings prettier
preserves — `0.5` vs a rewritten `.5`, `#fff` vs `#ffffff`, `url("x")` vs
`url(x)`, `"hello"` vs `'hello'` — are exactly what a loader would collapse.
The generic named-node comparison is the right oracle; extras still cover
comments.

Before the round-2 gate fix, an empty-rule case failed the default because an
empty `block` has only anonymous children (`{` and `}`). The old signature
compared the block's raw source span, making whitespace between those tokens
significant. The generic gate now compares the anonymous token spellings and
ignores only the inter-token layout. `normalisation.css` therefore includes
both `.empty {}` and `.spaced-empty { }`; prettier expands both, and the default
gate accepts the rewrite without making `block` transparent.

`check_gate3.py --language css`: 30 reference outputs accepted, 60 destructive
mutations rejected, 0 wrapper kinds needed. The adversarial arm reported 460
useful mutations against the generic default (inert, as designed).

## Corpus

Fifteen files in `corpus/src/css/`. Each is valid CSS: clean under
tree-sitter-css 0.25.0 (no `ERROR` / `MISSING`). Every file carries at least
one comment.

Required probes:

- `nested.css` — `@media` around `@supports` around a rule holding
  `linear-gradient(rgb(), …)` and a long `font-family`. Width 80 breaks the
  gradient and leaves each `rgb()` flat; width 40 also wraps the `@supports`
  condition and the family list.
- `values.css` — the construct that overflows: `font-family`, `box-shadow`,
  `linear-gradient`, `transition`. All four reflow; 80 vs 40 differs on
  `font-family` fill.
- `comments.css` — every legal position: file-level, after a selector, own-line
  inside a block, trailing on a declaration, inside a value list, after `(`,
  between function arguments, before `)`, before `}`, between rules, inside a
  selector list, only-comment block, consecutive own-line, end of file.
- `strings.css` — double and single quotes, a string that must stay
  single-quoted because it contains `"`, `\A` / `\9` / `\\` escapes, a quoted
  url prettier will not wrap, an unquoted url, a font name with spaces.
- `normalisation.css` — input written the way a person writes CSS: missing
  spaces around `{` `}` `:` `;`, padding inside a value, no space around
  combinators, leading indent, a tab, a run of spaces before a trailing
  comment, `1rem!important`, a packed multi-declaration rule, extra blank
  lines, a compact empty rule, and an empty rule with a space between braces.
- `kitchen.css` — `@import`, custom properties, a selector list, a family
  list, `@media` with `grid-template-areas` and native nesting, `@supports`
  with `minmax()`, `!important`, a vendor prefix.

Characteristic of CSS, one line each:

- `selectors.css` — comma lists, combinators, attribute selectors, `:is` /
  `:where` / `:not` / `:has`. Comma lists are always one selector per line;
  a descendant after `:is()` wraps at 40.
- `at_rules.css` — `@import`, `@layer`, a long `@media` condition (never
  wraps), a long `@supports` condition (wraps at 40). The pair is the
  finding.
- `custom_properties.css` — `--vars` whose values are token soup:
  `color-mix`, `var()` fallbacks, a shadow list. Width 40 breaks the soup;
  80 does not.
- `grid_areas.css` — `grid-template-areas` whose internal line breaks *are*
  the layout. Prettier preserves author breaks and will not wrap a
  single-line value at either width. The one file prettier does not rewrite.
- `important.css` — `!important`, including a missing space prettier inserts.
- `vendor.css` — a `-webkit-`/`-moz-`/`-ms-` run plus prefixed and
  unprefixed `linear-gradient`. Functions wrap at 40 the same way.
- `keyframes.css` — percentage selectors and a `from`/`to` pair.
  `translateX(-50%) scale(1.05)` wraps at 40.
- `nesting.css` — native `&:hover`, `& .title`, and a nested `@media`. The
  inner family lists reflow.
- `calc.css` — `calc`, `clamp`, `minmax`. `calc` stays flat at both widths;
  `minmax()` fill-the-line splits at 40 (and already at 80 for the last
  call).

### Two `cmp` counts

From two loops over `corpus/src/css/*.css` against
`corpus/reference/css__<stem>@<width>.txt`:

**How many files the reference changes at all**

| Width | Changed | Identical |
| ----- | ------- | --------- |
| 80    | 10      | 5         |
| 40    | 14      | 1         |

Union: **14 of 15** files differ from their input at at least one width.
The only byte-identical file is `grid_areas.css`, which is the probe of a
construct prettier refuses to rewrite.

Identical at 80 only: `at_rules`, `grid_areas`, `keyframes`, `selectors`,
`vendor` — all written already in prettier's spacing, and all but
`grid_areas` then move at 40.

**How many files differ between the two widths**

**12 of 15.** Same at both widths: `grid_areas`, `important`, `strings`.
Those three cannot break — comments, string interiors, `!important`, and
`grid-template-areas` author breaks. 12/15 is well above a third. The
constructs that *do* respond are value lists, function arguments,
`@supports` conditions, compound selectors, and adjacent function calls
(`translateX() scale()`).

### The reference's own overflow

`score.py` skips a language with no `packages/<name>.json` (`awaiting_package`),
so it does not print `its own overflow: N` for CSS at stage A. The number
below is `score.overflow_lines` run against the committed reference files
and the committed trees — the same function, the same tokens.

**its own overflow: 8**

| File             | Width | Line | Len | Cause                                                                                          |
| ---------------- | ----- | ---- | --- | ---------------------------------------------------------------------------------------------- |
| `at_rules`       | 80    | 14   | 124 | `@media` condition. prettier never wraps one, at any width tried (including 20).               |
| `at_rules`       | 40    | 14   | 124 | Same line.                                                                                     |
| `comments`       | 40    | 5    | 45  | `color: red; /* trailing on a declaration */`. Comment counts; the declaration will not wrap.  |
| `important`      | 40    | 6    | 49  | `font-size: 1rem !important; /* missing space */`. Same shape.                                 |
| `nested`         | 40    | 19   | 41  | A `font-family` fill line one character over.                                                  |
| `selectors`      | 40    | 15   | 52  | Combinator chain after the wrap: `~ a[href=…][target="_blank"] {`.                             |
| `strings`        | 80    | 10   | 88  | `url("https://example.com/…")`. prettier does not wrap a url.                                  |
| `strings`        | 40    | 5    | 54  | `content: "single"; /* prettier double-quotes this */`. Trailing comment again.                |

The `@media` line is the manufactured-looking one: 124 characters at both
scored widths, and prettier has no break opportunity it is willing to take.
A stage-C agent that "fixes" it is fighting the reference.

## What prettier does that surprised me

This is the useful section.

### Prettier *does* reflow CSS — but only some constructs

The brief asked whether prettier reflows anything in CSS at all. Yes:

- comma-separated **value** lists (`font-family`, `box-shadow`, `transition`)
- function arguments (`linear-gradient`, `rgba`, `minmax`, `clamp`,
  `color-mix`, prefixed `-webkit-linear-gradient`)
- `@supports` conditions
- some compound selectors (`:is(…) a:not(…)`, combinator chains) at 40
- adjacent function calls (`translateX(-50%) scale(1.05)`)

It does **not** reflow:

- comma-separated **selector** lists — always one per line, at every width,
  unless a comment sits in the list (then the list stays flat)
- `@media` conditions — not at 80, not at 40, not at 20
- strings, including ones far longer than the budget
- `url(…)`
- `grid-template-areas` (author line breaks are preserved; a single-line
  value stays single-line)
- `@import`, `@layer` name lists
- `calc(…)` on this corpus (the expressions fit; prettier did not split
  them at 40 either)

`reference_width = "flag"` is correct, but a package that treats `{width}`
as "wrap every comma list" will over-break selectors and under-break
nothing else. Selector lists are a hard line, not a width decision.

### When a container breaks, the containers inside it do **not**

Constructed case: `linear-gradient(90deg, rgb(1, 2, 3), rgb(4, 5, 6), …)`.
At width 80 the gradient breaks one argument per line; each `rgb(1, 2, 3)`
stays flat, with room to spare (18 characters of indent + call). At width
20 a *top-level* `rgb(1, 2, 3)` *does* break (`  color: rgb(1, 2, 3);` is
24 characters), but the same call inside the already-broken gradient still
stays flat because it now has the line to itself.

`minmax()` is the sharper picture. At width 40:

```
grid-template-columns: minmax(
    200px,
    1fr
  ) minmax(200px, 1fr) minmax(
    200px,
    1fr
  );
```

The first call breaks, the second stays flat on the remainder of the line,
the third breaks. Independent groups, fill remaining width. The opposite of
taplo's "once the parent breaks, every child breaks".

A package that models each container as an independent group will match
this. A package that opens every nested group when the parent opens will
diverge on every `linear-gradient` of `rgba` and every `minmax` list.

### A trailing comment counts toward its line's width

Established two ways:

- `font-family: Arial, Helvetica, sans-serif;` stays flat at 80. Add
  `/* trailing comment on the declaration */` and the family list breaks.
- `color: red; /* trailing on a declaration */` is 45 characters. prettier
  will **not** wrap a simple declaration to fit the comment; it overruns
  (comments@40, important@40, strings@40). That is three of the eight
  overflow lines.

prettier will destroy a flat value list to make room for a comment. It will
not destroy a `color: red` to make room for one. The comment stays a line
suffix either way.

### What prettier normalises at token level

Spacing, delimiter padding, indentation — `normalisation.css`, rewritten at
every width:

- declaration blocks always expand; `a{color:red}` becomes a three-line rule
- empty blocks expand too; both `.empty {}` and `.spaced-empty { }` become a
  brace pair on separate lines
- one space after `:`, none before; one space after `;` vanishes because
  the semicolon ends the line
- spaces around combinators (`>`, `+`, `~`)
- leading indent and tabs stripped
- runs of spaces before a trailing comment collapse to one space
- a space is inserted before `!important`
- packed multi-declaration rules become one declaration per line
- blank-line runs collapse to one (`["blank", 1]` if a later package
  wants it)

Token *spelling* prettier also rewrites, established on throwaway probes
and then kept out of the corpus where they would fail gate 3:

- `.5` → `0.5` (`float_value` leaf text; the default rejects it)
- `#FFF` / `#AbC` → `#fff` / `#abc` (`color_value` has no named children,
  so the default compares the full hex)
- `'single'` → `"single"`, unless the string contains `"` (then the other
  way). Quotes are anonymous, so this one **passes** gate 3; `strings.css`
  includes it.

`#ffffff` stays six digits. `+1` stays `+1`. Unquoted `url(x)` stays
unquoted.

### Comments inside a call get pulled onto the next token

`comments.css` is the case. An own-line comment after `(` or between
arguments is rewritten onto the same line as the following argument:

```
background: linear-gradient(
  /* after the opening paren */ 90deg,
  red,
  /* own-line between arguments */ blue /* before the closing paren */
);
```

The extras sequence is unchanged (same comments, same order), so gate 3
accepts it. A package that emits comments where the tree parented them
will put those two back on their own lines and diverge. That is a design
limit, not a package bug — the runtime owns comment attachment, and
prettier's "glue the comment to the next argument" rule is
sibling-aware in a way a node-type table is not.

A comment **in a selector list** does the opposite: it pins the list
closed. `.a, .b, .c {` is always one selector per line; `.a, .b /* keep */`
stays one line at both widths.

### `@media` vs `@supports` is a real split

The same shape of boolean condition. `@supports (display: grid) and
(gap: 1rem) and (not (display: -ms-grid))` wraps at 40. The 124-character
`@media screen and (min-width: 768px) and …` never wraps. A node-type
table can express this only if the two constructs are different node
kinds — they are (`media_statement` / `supports_statement`). Getting
them the same will show up on `at_rules` at every width.

### The generic default has a CSS-shaped hole it does not trip here

`integer_value` with a unit (`1rem`, `10px`) has one named child, `unit`.
The numeric part is not a node. The generic signature is therefore
`("integer_value", (("unit", "rem"),))` and does not see `1` vs `2`.
Changing `1rem` to `2rem` would pass the default. `float_value` without a
unit (`.5`, `0.5`) *is* a leaf, so that spelling is compared. This is
not a reason to write an override — an override that reintroduced the
number would still have to reject every mutation the default rejects,
and the hole is "the default cannot see this", not "the default is too
weak on the mutations it can see". Recorded so stage C does not
discover it as a surprise.

### Neither generator needed a change

`gen_trees.py` and `gen_reference.py` both worked from the manifest as
written. No harness script was edited.

## Files touched outside `corpus/` and `harness/languages/`

```
$ git diff --stat main -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

Empty. No `rust/`, no `runtime-js/`, no shared harness script. The grammar
pin is in the manifest; it is not in anyone's inline `dependencies` block.

## Template delta

`score.py` now skips a language with no package (`awaiting_package`), so
`./test.sh` can go green at stage A. The brief still asks for the
reference overflow as `score.py` prints it (`its own overflow: N`). For
a pending language that line is never printed. The number in this report
is the same function run by hand; a one-line note in the brief that
stage A should compute it that way — or a `score.py --reference-only`
path — would save the next builder an argument with the reviewer.

The JSON manifest, the worked prettier example, does not pass
`--no-config`. The flag is load-bearing for CSS and will be for every
later prettier language. That is a template delta for the JS/TS/HTML
briefs, not a CSS-shaped fact.
