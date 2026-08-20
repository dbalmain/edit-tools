# HTML corpus report (stage A)

Builder: **grok-4.6 via the grok CLI**.

## Manifest

`harness/languages/html.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                                                   | How it was established                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grammar`              | `tree-sitter-html==0.23.2`                                                              | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_html` guess, but the pin does not. `0.7.0` was the guess; the latest release is `0.23.2` (checked against the live index 2026-08-21).                                                                                                                                         |
| `grammar_module`       | `tree_sitter_html`                                                                      | `uv run --with tree-sitter-html==0.23.2` then `import tree_sitter_html`. The hyphen-to-underscore swap is correct here.                                                                                                                                                                                                                                |
| `grammar_symbol`       | `language`                                                                              | The module exports `language()` (plus `HIGHLIGHTS_QUERY`, `INJECTIONS_QUERY`). It returns a `tree_sitter.Language` capsule. No `language_html()`.                                                                                                                                                                                                      |
| `injection_aliases`    | `["html"]`                                                                              | The only info-string spelling worth vouching for. `htm` is a file extension. `xhtml` is prettier's support-info alias, but it is a different serialisation and would collide with XML onboarding if both claimed it.                                                                                                                                   |
| `reference`            | `npx --yes prettier@3.9.6 --no-config --stdin-filepath x.html --print-width {width}`    | Source on stdin, formatted source on stdout. `--stdin-filepath` **is** required: without it (and without `--parser`) prettier errors `No parser and no file path given`. `--parser html` is an alternative, not a second flag, so it is omitted. Output with either selector is byte-identical on a document that includes script and style. `--no-config` **is** required (below). `--print-width` honours `{width}`: 80 vs 40 differ on 9 of 16 files. |
| `reference_version`    | `3.9.6`                                                                                 | Printed by `npx --yes prettier@3.9.6 --version`. Not assumed. Same pin as CSS / YAML / JavaScript; JSON is still on 3.6.2.                                                                                                                                                                                                                             |
| `reference_width`      | `flag`                                                                                  | Ran the same input at 80 and 40 and diffed. Paragraphs of inline content, attribute lists, hug-closes, and SVG attribute wrapping reflow. `{width}` is therefore real.                                                                                                                                                                                 |
| `widths`               | `[80, 40]`                                                                              | 80 is prettier's own default (below). 40 is the narrow width that actually wraps 3-to-6 short attributes and shows hug-closes. 60 still leaves most of those flat.                                                                                                                                                                                     |
| `gate3`                | `default`                                                                               | See below.                                                                                                                                                                                                                                                                                                                                             |
| `transparent_wrappers` | `[]`                                                                                    | Gate 3 accepted prettier on every comparable run without naming a wrapper.                                                                                                                                                                                                                                                                             |
| `equivalent_kinds`     | `[]`                                                                                    | Same: nothing was renamed on comparable files. `start_tag` / `self_closing_tag` are **not** equivalent (`<div></div>` vs `<div />` is a real difference prettier itself preserves).                                                                                                                                                                    |

No `[[injections]]`. The grammar's script/style shape does not fit the
manifest fields; the missing field is proposed under "Template delta", not
patched into a shared file.

### Default width is 80, by bisection

Three independent observations, not `--help` alone:

1. `prettier --help` and `getSupportInfo()` both say `printWidth` defaults to 80.
2. Unprompted output (no `--print-width`) is byte-identical to `--print-width 80` on every probe tried.
3. A start tag whose `class` value is **60 characters** stays flat unprompted and at `--print-width 80`, and wraps at `--print-width 79`. A 61-character class wraps unprompted and at 80, and stays flat at 81. So 80 is the line length at which the unprompted output starts breaking.

### `--no-config` is load-bearing

prettier searches for `.prettierrc` / `prettier.config.*` / `package.json`
from the `--stdin-filepath` directory **and every ancestor**. A planted
config with `tabWidth: 8` and `htmlWhitespaceSensitivity: "ignore"` (options
the command line does **not** pass) silently re-indented a nested `<p>` from
2 spaces to 8.

`--print-width` **wins** over a planted `printWidth` (default
`config-precedence` is `cli-override`): `--print-width 80` beat a file's
`printWidth: 20` on the wrap decision, but the file still supplied
`tabWidth: 8`. What leaks from a discovered config is every option the
command line does not name. That is why the flag is still load-bearing even
though we pass `{width}`.

`--no-config` also suppresses `.editorconfig` (verified: `indent_size = 8`
applied without the flag and vanished with it). `--no-editorconfig` is
therefore redundant and is omitted.

Leftover channels the disable flag leaves open:

- An explicit `--config path` still applies. `--no-config` and `--config`
  together is an error, so they cannot be combined by accident.
- There is no `PRETTIER_*` environment variable equivalent of `TAPLO_CONFIG`.
  `PRETTIER_CONFIG` is inert.

`--stdin-filepath` itself is the search root: `--stdin-filepath planted/x.html`
loaded `planted/.prettierrc`, while `--parser html` (no filepath) did not.
`--no-config` closes that path too.

`gen_reference.py --check` is silent with that command (exit 0). Two runs of
the same stdin match.

### Why not `gate3 = "html"`

There is no HTML data-model loader that would help. A DOM load would collapse
exactly the spellings a formatter must preserve: entity form (`&nbsp;` vs
`&#160;` vs `&#xA0;`), boolean vs valued attributes (`disabled` vs
`disabled=""`), void slash, quote delimiters. The generic named-node
comparison is the right oracle; extras still cover comments.

Quote rewriting (`'hello'` → `"hello"`) happens to pass the generic default
because the quote characters are anonymous tokens around a named
`attribute_value`, the same shape JavaScript has. That is why `quotes.html`
is incomparable for **agreement**, not because gate 3 fails.

The void slash **does** fail gate 3: `<br>` is a `start_tag` and `<br />` is
a `self_closing_tag`. `void_slash.html` is incomparable for that reason.

Prose wrapping **also** fails gate 3: prettier inserts newlines (and indent)
into `text` leaves. `prose.html` is incomparable for that reason, and every
other file keeps `text` leaves short enough that prettier does not rewrite
them at either scored width. That is not a weakened gate; it is the construct
isolated.

`check_gate3.py --language html`: 32 reference outputs checked, 64
destructive mutations rejected, 395 useful adversarial mutations (arm inert,
as designed), 0 wrapper kinds needed. The three incomparable files skip only
the "reference must itself pass" assertion.

`./harness/check_width.py . 20 120 --language html`: `[PASS] width-sweep
1616/1616 agree`. Both runtimes refuse HTML (no package); shared refusal is
agreement.

## Corpus

Sixteen files in `corpus/src/html/`. Each is valid HTML: clean under
tree-sitter-html 0.23.2 (no `ERROR` / `MISSING`). Every file carries at least
one comment.

Required probes:

- `nesting.html` — `div` / `section` / `article` deep enough that the
  opening tag with a long class wraps. The inner `<div id="fits"><b>x</b></div>`
  stays flat at both widths. Same output at 80 and 40: once the class is over
  80, both widths wrap the tag the same way.
- `attributes.html` — the construct that overflows: a 4-attr tag that stays
  flat at 80 and stacks at 40, plus an `<input>` that stacks at both.
- `comments.html` — every legal position: file-level, own-line before the
  first child, between block children, trailing on text, inside an empty
  element, before a closing tag, after a block sibling, consecutive own-line,
  after an inline element, end of file. HTML comments cannot sit inside a
  start tag.
- `strings.html` — entities (`&amp;`, `&lt;`, `&#160;`, `&nbsp;`, `&#xA0;`),
  already-double-quoted attributes, an empty `""`, spaces inside an attribute
  value. Quote restyling is not in this file.
- `normalisation.html` — input written the way a person writes HTML: spaces
  around `=` and `>`, a tab, packed block children, extra blank lines, a run
  of spaces before a trailing comment, empty `<div></div>` and `<div> </div>`,
  empty `<span></span>` and `<span> </span>`, empty `<ul> </ul>` and
  `<script></script>`.
- `kitchen.html` — doctype, `html`/`head`/`body`, header attrs, nav, a short
  paragraph of inline, a list, `pre`, a void `img`, a `<style>` and a
  `<script>`. The one file allowed to be messy.
- `prose.html` — the required "what the reference rewrites that linearity
  forbids" cousin of quotes: a paragraph whose `text` leaf prettier wraps.

Characteristic of HTML, one line each:

- `inline.html` — a paragraph of `<span>` / `<a>` / `<em>`, packed adjacent
  spans, and a `<span>` wrapping a `<div>`. Whether a break may be inserted
  depends on the element's *name*, not its node type: every one of these is
  an `element`.
- `whitespace.html` — `<pre>` and `<textarea>` keep internal runs; a `<p>`
  of already-collapsed text; a `<span> world </span>` whose leading/trailing
  spaces prettier keeps; `&nbsp;` which prettier will not collapse. How
  significant whitespace is depends on the element.
- `void.html` — `br`, `hr`, `img`, `input`, `meta`, `link`, already written
  with the `/>` prettier emits, plus boolean attributes (`checked`,
  `disabled`).
- `script_style.html` — `<style>`, inline `<script>`, `src`+`defer`, and
  `type="application/ld+json"`. The injection probe. Already formatted so
  the opaque `raw_text` leaf is stable at both widths (prettier would
  otherwise rewrite it, and without splicing that fails gate 3).
- `lists.html` — packed `ul` / `ol` / `dl`; prettier explodes each item onto
  its own line at both widths.
- `tables.html` — packed `table` / `thead` / `tbody` / `tr` / `th` / `td`;
  prettier indents the grid at both widths.
- `svg.html` — SVG-in-HTML. Same `element` node as everything else;
  attribute wrapping at 40 follows the tag name (`svg`, `circle`, `rect`).
- `quotes.html` — incomparable. prettier re-quotes to prefer double quotes,
  and rewrites `"she said &quot;hi&quot;"` to `'she said "hi"'`.
- `void_slash.html` — incomparable. `<br>` → `<br />`, which renames
  `start_tag` to `self_closing_tag`.

### Two `cmp` loops

From two loops over `corpus/src/html/*.html` against
`corpus/reference/html__<stem>@<width>.txt`, matching
`./harness/corpus_stats.py --language html`:

**How many files the reference changes at all**

| Width | Changed | Identical |
| ----- | ------- | --------- |
| 80    | 10      | 6         |
| 40    | 15      | 1         |

Union: **15 of 16** files differ from their input at at least one width.
The only byte-identical file at every width is `script_style.html`, which is
the injection probe written already in prettier's spacing so the unspliced
`raw_text` leaf is stable.

Identical at 80 only: `comments`, `kitchen`, `strings`, `svg`, `void` — all
written already in prettier's spacing, and all then move at 40.

**How many files differ between the two widths**

**9 of 16.** Same at both widths: `lists`, `nesting`, `normalisation`,
`quotes`, `script_style`, `tables`, `void_slash`. Lists and tables explode
the same way at every width; nesting's class is already over 80 so both
widths wrap the tag identically; quotes and void_slash are token rewrites,
not wrap decisions; normalisation is spacing. 9/16 is well above a third.

The constructs that *do* respond are attribute lists, hug-closes of inline
tags, SVG attribute wrapping, comment-in-empty-element expansion, textarea
breaking, and prose wrapping (`prose.html`, excluded from agreement).

### The reference's own overflow

`score.py` skips a language with no `packages/<name>.json` (`awaiting_package`),
so it does not print `its own overflow: N` for HTML at stage A.
`./harness/corpus_stats.py --language html` prints it:

**its own overflow: 0 at 80, 1 at 40**

| File       | Width | Line | Len | Cause                                                                                                                                                    |
| ---------- | ----- | ---- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comments` | 40    | 3    | 42  | `  <!-- own-line before the first child -->`. The comment token is exactly 40 characters; two spaces of indent push the line over. Comments do not wrap. |

Every other over-long line at either width contains an unbreakable token
(a comment, a long `class` value, a long `href`) and is exempted by
`overflow_lines`. prettier will not wrap a comment or an attribute value.

A stage-C agent that "fixes" the 42-character comment line is fighting the
reference.

## What prettier does that surprised me

This is the useful section.

### Inline versus block is a fact of the *name*, not the node type

Every element is an `element` node. prettier's break policy is a function of
`tag_name`:

- `div` / `section` / `article` / `ul` / `li` / `p` as a child of a block:
  always one per line, at every width.
- `span` / `a` / `em` / `strong` inside a `p`: packed onto the line and
  reflowed as prose (hug-close when a tag itself overflows).
- `<span>outer <div>block inside inline</div> after</span>` uses prettier's
  hug-close, because a block inside an inline is whitespace-sensitive:

```
<span
  >outer
  <div>block inside inline</div>
  after</span
>
```

A node-type → Doc-expression table cannot express this. The smallest case
is `<div>a</div><div>b</div>` (always broken) versus
`<span>a</span><span>b</span>` (packed, then hug-wrapped at 40). Both are
`document / element / element`. Dispatch on `node.type` sees the same rule
twice. **That is the finding this language exists to produce.**

`when` on a child's `tag_name` text would recover it, if the IR grew a
predicate on leaf text. It does not have one today. Ancestor context
("format this `element` differently inside a `p`") is the other missing
piece, already named in DESIGN.md.

### When a container breaks, the containers inside it do **not**

Constructed case, committed as `nesting.html`: an `<article>` whose class
forces the opening tag to wrap, holding `<div id="fits"><b>x</b></div>`.
The inner div is 26 characters and stays flat at both 80 and 40, with room
to spare even after the 6-space indent. prettier does **not** open every
nested group when the parent opens.

The opposite of taplo. A package that models each container as an
independent group matches this (on the *layout* of tags). A package that
opens every nested group when the parent opens will wrap `<b>x</b>` the
moment the article wraps, and diverge on every nested element that still
fits.

Attribute wrapping is all-or-nothing *within one start tag*: if the tag
does not fit, **every** attribute goes on its own line, including short
ones that would fit. That is one group, not fill. A 4-attr tag is flat at
80 and stacked at 40; a 7-attr tag is stacked at both, identically.

### A trailing comment counts toward its line's width — but only on inline

Two different behaviours, established by running prettier, not by reading
docs:

- After a **block** sibling (`</p><!-- trailing -->`): prettier moves the
  comment onto its own line first. It does not count toward the block's
  line, because it is no longer on it.
- After an **inline** element (`<span>inline</span><!-- after -->`): the
  comment stays attached and prettier hug-closes the end tag to make room.
  At width 40, `comments.html` becomes:

```
<span>inline</span
><!-- after an inline element -->
```

  The comment counted; it forced the wrap.

- Trailing on **text** (`there<!-- trailing on text -->`): the comment
  rides with the text node. It does not wrap the comment itself (comments
  never wrap), so a long comment on a short text overruns. That is the
  overflow line in `comments.html` at 40, just with indent rather than
  trailing text.

prettier will not wrap a comment to fit. It will hug-close an inline tag
to make room for one.

### What prettier normalises at token level

Established on `normalisation.html` and the incomparable probes, as opposed
to line-level wrapping:

- Spaces around `=`, `<`, `>`: collapsed to the canonical `name="value"`.
- Tabs and author indent: 2 spaces per level.
- Extra blank lines: collapsed to one.
- Packed block children (`<div class="packed"><p>a</p><p>b</p></div>`):
  exploded, one block per line.
- `<div> </div>` / `<ul> </ul>` / `<script> </script>`: the interior space
  is dropped. `<span> </span>`: the interior space is **kept**. The
  grammar represents none of these spaces as nodes, so gate 3 cannot see
  the difference; agreement is the only check.
- Empty `quoted_attribute_value` (`""`): kept. This is the HTML empty
  container whose children are all anonymous (`"` / `"`). Gate 3 accepted
  prettier's output on it.
- Attribute names and tag names: lowercased (`CLASS` / `<DIV>`). Not in
  the comparable corpus; it is a named-leaf rewrite (`tag_name` text
  `DIV` → `div`) and would fail gate 3.
- Unquoted attributes (`class=a`): quoted. That introduces a
  `quoted_attribute_value` node the source did not have, so it would fail
  gate 3. Not in the corpus; mentioned so a stage-C agent does not add
  one to a comparable file.
- Optional end tags (`<li>a<li>b`): prettier inserts `</li>`. Adding
  `end_tag` nodes fails gate 3. Not in the corpus.
- `<!DOCTYPE html>` → `<!doctype html>`: the anonymous `doctype` token
  changes spelling. Kitchen is already lowercased.
- Void elements: `<br>` → `<br />`. Isolated in `void_slash.html`.
- Attribute quotes: prefer double, minimise escaping. Isolated in
  `quotes.html`.
- Embedded JS/CSS/JSON: prettier formats them (and indents them one HTML
  level). Isolated from the comparable corpus by writing `script_style.html`
  already formatted; without a `guest` injection field the `raw_text` leaf
  would otherwise change and fail gate 3.
- Prose: newlines inserted into `text` leaves. Isolated in `prose.html`.

Internal runs of spaces in a `p` (`Hello    world`) collapse and **do**
change the `text` leaf, so they are not in any comparable file. Internal
runs in `<pre>` and `<textarea>` are preserved and **are** in
`whitespace.html`.

### `fill` over words is what HTML prose needs, and the tree does not have words

A `p`'s visible text is one or more `text` / `entity` leaves, not a list of
words. prettier wraps by rewriting those leaves. `fill` in the IR walks
**child nodes**. There is nothing to fill. A package that `verbatim`s
`text` will overrun; a package that somehow wraps the leaf has rewritten a
token, which linearity forbids.

That is why `prose.html` is incomparable rather than a package problem for
stage C to "fix". The comparable corpus measures everything else: tags,
attributes, between-element breaks, hug-closes, void slashes (excluded),
quotes (excluded).

### tree-sitter-html does not represent the whitespace prettier cares about

Leading and trailing spaces around a `text` node are not in the node:
`<span>  world  </span>` has text `world`. Inter-element whitespace is not
a node at all: `<div> </div>` and `<div></div>` produce identical named
trees. `<pre>  keep   spaces</pre>` has text `keep   spaces` — the leading
spaces after `>` are dropped by the scanner.

prettier's most important HTML behaviour — "do not collapse whitespace
where doing so changes rendering" — is therefore largely invisible to gate
3. A package that emits `<span>world</span>` for `<span> world </span>`
passes non-destruction and fails agreement. That is the honest split, and
it is a fact of this grammar, not of the gate.

## Injections: the schema cannot express HTML

tree-sitter-html's `INJECTIONS_QUERY` is:

```
((script_element (raw_text) @injection.content)
 (#set! injection.language "javascript"))

((style_element (raw_text) @injection.content)
 (#set! injection.language "css"))
```

There is no info-string child. Language is a fact of the host node type.
The current `[[injections]]` entry requires `node`, `info`, and `content`,
all non-empty. Inventing a dummy `info` type would silently fail to splice
(`_direct` returns None, `guest` is None, the region stays verbatim).

**Missing field:** `guest` (string, optional). When set, the region always
routes to that language's manifest without reading an info-string child.
`info` becomes optional when `guest` is present.

Proposed entries, not applied:

```toml
[[injections]]
node = "script_element"
content = "raw_text"
guest = "javascript"

[[injections]]
node = "style_element"
content = "raw_text"
guest = "css"
```

Shared-file lines that would have to change, if this is accepted centrally:

- `harness/manifest.py`, `_injections`: `fields` is currently
  `{"node", "info", "content"}`; `info` is required and must be a non-empty
  string. Add optional `guest: str | None`. Reject a table that has neither
  `info` nor `guest`; reject one that has both if that is ambiguous, or
  define `guest` as taking precedence.
- `harness/injection.py`, `region_for`: today `guest = aliases.get(words[0])`
  from the info child's source. When `site.guest` is set, look up
  `aliases` / the language map by that name instead.

A further wrinkle, not covered by `guest`: `<script type="application/ld+json">`
should inject JSON, not JavaScript. prettier formats that body as JSON
(committed in `script_style.html`). Routing on an attribute value is a
second missing field (`type` attribute → guest), larger than this slice.

The corpus probe is written. Splicing is not. `script_style.html` stays
comparable by being already formatted.

## Everything changed outside `corpus/` and `harness/languages/`

```
git diff --stat 7480e32 -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(no output)

No runtime edits, no shared harness edits, no package.

## Template delta

- The orchestrator's grammar pin `0.7.0` is wrong for HTML; the live
  distribution is `tree-sitter-html==0.23.2`. Same class of miss as
  JavaScript / CSS (guessed 0.7.0, actual 0.25.0).
- The `[[injections]]` schema cannot express HTML `<script>` / `<style>`.
  The brief told builders to say so rather than patch; the missing field
  is `guest` as above.
- Prettier wrapping HTML prose **inserts newlines into `text` leaves**, so
  a naive corpus of wrapping paragraphs fails gate 3 on the reference
  itself. The empty-container-with-space instruction does not catch this:
  `<div> </div>` has no named children to compare, and gate 3 accepts the
  collapse. The prose case is the HTML analogue of YAML's `|+` — semantic
  layout living in a place the named-node tree does not split — and it
  belongs in the brief as a known stress, not as something each builder
  rediscovers by having `check_gate3.py` reject half the corpus.
