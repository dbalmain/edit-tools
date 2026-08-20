# XML corpus report (stage A)

Builder: grok-4.6 via the grok CLI.

## Manifest

`harness/languages/xml.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                                                          | How it was established                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grammar`              | `tree-sitter-xml==0.7.0`                                                                       | Live PyPI: the distribution name matches the orchestrator's `tree_sitter_xml` guess, and 0.7.0 is the latest release.                                                                                                                                                                                                                                  |
| `grammar_module`       | `tree_sitter_xml`                                                                              | `uv run --with tree-sitter-xml==0.7.0` then `import tree_sitter_xml`. The hyphen-to-underscore swap is correct here.                                                                                                                                                                                                                                  |
| `grammar_symbol`       | `language_xml`                                                                                 | The module exports `language_xml()` and `language_dtd()`, not `language()`. This corpus is XML documents, not standalone DTD files, so `language_xml` is the one. `language_dtd()` on an XML document produces garbage.                                                                                                                                |
| `injection_aliases`    | `["xml"]`                                                                                      | The only info-string spelling worth vouching for. prettier/plugin-xml also lists linguist aliases `rss`/`xsd`/`wsdl` and a separate SVG language entry; those are vocabularies, not fence names I will stand behind.                                                                                                                                   |
| `reference`            | `npx --yes --package prettier@3.9.6 --package @prettier/plugin-xml@3.4.2 sh -c 'prettier --plugin "$(dirname "$(command -v prettier)")/../@prettier/plugin-xml/src/plugin.js" --parser xml --no-config --print-width {width}'` | See below. The brief's `--plugin @prettier/plugin-xml` does not resolve under prettier 3 + npx.                                                                                                                                                                                                                                                        |
| `reference_version`    | `3.9.6 (@prettier/plugin-xml@3.4.2)`                                                           | `prettier --version` printed `3.9.6`. The plugin's `package.json` in that same npx cache is `3.4.2` (published 2025-07-08; peer `prettier: ^3.0.0`). Both observed, not assumed.                                                                                                                                                                      |
| `reference_width`      | `flag`                                                                                         | Ran the same input at 80 and 40 and diffed. Attribute lists, XML declarations, and DOCTYPE PUBLIC identifiers reflow. `{width}` is therefore real.                                                                                                                                                                                                     |
| `widths`               | `[80, 40]`                                                                                     | 80 is prettier's own default (below). 40 is the narrow width that splits start-tags 80 leaves flat.                                                                                                                                                                                                                                                    |
| `gate3`                | `default`                                                                                      | See below.                                                                                                                                                                                                                                                                                                                                             |
| `transparent_wrappers` | `[]`                                                                                           | Gate 3 accepted prettier on 26/28 comparable runs without naming a wrapper. The other two are the incomparable empty-pair file.                                                                                                                                                                                                                        |
| `equivalent_kinds`     | `[]`                                                                                           | Same: nothing was renamed. `STag`/`ETag` vs `EmptyElemTag` is structural.                                                                                                                                                                                                                                                                              |

### The plugin pin, and why `--plugin @prettier/plugin-xml` is not the command

prettier 3 resolves `--plugin` from CWD (`imported from …/noop.js`). `npx
--package prettier@3.9.6 --package @prettier/plugin-xml@3.4.2 prettier --plugin
@prettier/plugin-xml` therefore fails even though both packages are in the npx
cache. Passing the plugin's `src/plugin.js` relative to the prettier binary
that cache just put on PATH is the invocation that actually formats.

`--plugin` is required: without it, `--parser xml` errors `Couldn't resolve
parser "xml"`. The plugin is maintained, available at the pin, and its
reference output passes gate 3 (with one incomparable file, below). No
authority to switch references was needed.

### `--parser xml` is sufficient; `--stdin-filepath` opens a channel

`--parser xml` and `--stdin-filepath x.xml` produce byte-identical XML on a
clean machine. The filepath is how JSON selects a parser, so it looks
load-bearing. It is not, once the parser is explicit.

A planted `.editorconfig` with `indent_size = 8` changed output only when a
filepath was present **and auto-config remained enabled** (attribute wraps
reindented to 8 spaces). `--parser xml` alone did not read it.
`--stdin-filepath` + `--no-config` also suppressed it. Omitting the filepath
is the smaller command and closes that channel.

### `--no-config` is load-bearing

prettier walks cwd and ancestors for `.prettierrc` / `prettier.config.*` / a
`package.json` `"prettier"` key. A planted config with `tabWidth: 8`,
`xmlQuoteAttributes: "double"`, `xmlSelfClosingSpace: false`, and
`xmlWhitespaceSensitivity: "ignore"` — options the command line does **not**
name — silently pretty-printed the document, reindented, dropped the
self-closing space, and collapsed significant whitespace.

`--print-width` **wins** over a planted `printWidth` under the default
`--config-precedence cli-override`: `--print-width 80` beat a file's
`printWidth: 20`. `--config-precedence file-override` lets the file's
`printWidth` win (checked). What leaks from a discovered config is every
option the command line does not name. That is why the flag is still
load-bearing even though we pass `{width}`.

`--no-config` plus `--config` is refused. There is no `PRETTIER_CONFIG`
environment variable that reopens the search under `--no-config`. Residual
channel: an explicit `--config`, which cannot be combined with `--no-config`.

`gen_reference.py --check` is silent with that command (exit 0, "committed
reference output matches the pinned formatters"). Two runs of the same stdin
match.

### Default width is 80, by bisection

An `<item a="A"*67/>` formats to an **80-character** line unprompted and at
`--print-width 80`; `--print-width 79` wraps it. `<item a="A"*68/>` wraps
unprompted and at 80, and stays flat at 81. Unprompted output is
byte-identical to `--print-width 80` on both sides of that boundary. The
plugin also sets `defaultOptions.printWidth` to 80; the bisection is what
counts. 40 is the first round number at which start-tags that 80 leaves
flat actually split.

### Why not `gate3 = "xml"`

A data-model loader (ElementTree, lxml, xmltodict) collapses the spellings a
formatter must preserve: attribute quote style, empty-pair vs self-closing,
entity vs character vs literal, CDATA vs text, and — fatally — `CharData`
whitespace, which this grammar represents as a named leaf. The generic
named-node comparison is the right oracle.

`check_gate3.py --language xml`: 28 reference outputs checked (the
incomparable file skips only the "reference must pass" assertion), 28
destructive mutations rejected, 353 useful adversarial mutations (the arm is
inert because there is no override), 0 wrapper kinds needed.

The required empty-container-with-a-space probe is in `normalisation.xml` as
`<empty> </empty>`. prettier keeps it (it has a `CharData` child, so it is
not an empty element). Gate 3 accepts the rewrite of that file. If it had
rejected, that would have been a finding and a stop; it did not.

### `[incomparable]`: empty element pairs

prettier rewrites `<a></a>` to `<a />`. That is `STag`+`ETag` to
`EmptyElemTag`, a named-tree change: `gate3.signature` of the source and of
the reference output disagree. Linearity forbids a package from matching it.
One construct, one file, `empty_to_self_closing.xml`. The file contains
nothing else.

Self-closing space (`<a/>` → `<a />`) is *not* incomparable: both parse as
`EmptyElemTag` with anonymous `/>`, and the space is inter-token trivia.
Gate 3 accepts it.

## Corpus

Fourteen files in `corpus/src/xml/`. Each is valid XML: clean under
tree-sitter-xml 0.7.0 (no `ERROR` / `MISSING`) and under prettier 3.9.6 +
plugin-xml 3.4.2. Thirteen files carry at least one `Comment` node. The
fourteenth is the incomparable file, kept pure. `corpus_stats.py` still
prints `carries a comment 0/14` — see the harness finding below.

Required probes:

- `nesting.xml` — nested start-tags. A parent with three long attributes
  wraps at both widths; a child `<book id="1" sku="alpha-01">` that fits
  stays flat. A second book is glued (`><chapter><note>`) so remaining
  width is leftover from ancestors; `<note kind="ok">` wraps even though
  it would fit in isolation.
- `long_attributes.xml` — the construct that overflows: attribute lists.
  Two items stay flat at 80 and explode at 40; one is already long enough
  that 80 wraps too.
- `comments.xml` — every legal position: file-level (no XMLDecl, so a
  comment can lead), after an opening tag, own-line before the first
  child, trailing on a self-closing child, own-line between children,
  inside mixed content, own-line before a closer, comment-only element,
  consecutive own-line, before the root closer, end of file. Comments
  between attributes are not well-formed XML and are not here.
- `literals.xml` — named entities in text and attributes, decimal and hex
  character references, CDATA with markup-looking text. prettier preserves
  every spelling.
- `normalisation.xml` — input written the way a person writes XML: spaces
  around `=`, extra spaces in start-tags, leading indent, a tab, a
  compact self-closing tag, a padded self-closing tag, an empty element
  *with a space in it*, a start-tag split across lines, a packed
  attribute list, and an XML declaration without the space before `?>`.
- `kitchen.xml` — XMLDecl, Atom namespaces, mixed content, CDATA, a
  self-closing empty-with-space, a long `link`/`thumbnail`, several
  comments.

Characteristic of XML, one line each:

- `mixed_content.xml` — text and elements as siblings, glued and spaced,
  including a short tag that wraps at 40 by splitting `>` onto its own
  line. The shape a node-type table finds hardest.
- `whitespace.xml` — `xml:space="preserve"` next to a sibling without it,
  mixed-content spaces, a `<pre>` whose newlines are the document,
  blank-line runs. Under the default `strict` setting `xml:space` is a
  no-op; both children keep their author spacing. The attribute is here
  so a later package cannot pretend otherwise.
- `empty_to_self_closing.xml` — the incomparable rewrite, and only that.
- `namespaces.xml` — default and prefixed xmlns, nested `xmlns:c`,
  `xsi:nil`. Prefixes are part of `Name`, not a separate node.
- `prolog.xml` — XMLDecl with encoding and standalone, an
  `xml-stylesheet` PI, a SYSTEM DOCTYPE, a misc comment before the root.
- `doctype.xml` — PUBLIC identifier long enough to wrap, plus an XHTML
  skeleton. 80 wraps only the system id; 40 also wraps the public id and
  the `<html>` attributes.
- `quotes.xml` — mixed `"` / `'` on one tag, quotes nested inside the
  other delimiter, a URL with `&amp;`. Default `xmlQuoteAttributes` is
  `"preserve"`; prettier does not re-quote.
- `self_closing.xml` — tags already written with `/>`. prettier inserts
  the space and wraps attributes; it does not invent an end tag.

### Two `cmp` counts

From two loops over `corpus/src/xml/*.xml` against
`corpus/reference/xml__<stem>@<width>.txt`, matching
`./harness/corpus_stats.py --language xml`:

**How many files the reference changes at all**

| Width | Changed | Identical |
| ----- | ------- | --------- |
| 80    | 14      | 0         |
| 40    | 14      | 0         |

Union: **14 of 14** files differ from their input at at least one width.
Every file probes token-level normalisation, attribute wrapping, or both.

**How many files differ between the two widths**

**12 of 14.** Same at both widths: `empty_to_self_closing` (the rewrite is
not width-dependent) and `normalisation` (token-level only; the packed
attribute list still fits at 40). 12/14 is well above a third. What
responds to width is attribute lists, XMLDecl attribute wrapping, DOCTYPE
PUBLIC identifiers, and mixed-content start-tags whose `>` drops to the
next line.

### The reference's own overflow

`score.py` skips a language with no `packages/<name>.json`, so it does not
print `its own overflow: N` for XML at stage A.
`./harness/corpus_stats.py --language xml` prints it:

**its own overflow: 0 at 80, 16 at 40**

(`score.overflow_lines` exempts a line that contains a leaf token longer
than the budget, so a 70-character `<!-- comment -->` at width 40 does not
count. What remains is overflow prettier could theoretically have wrapped
and did not.)

| File            | Width | Line | Len | Cause                                                                                          |
| --------------- | ----- | ---- | --- | ---------------------------------------------------------------------------------------------- |
| `comments`      | 40    | 5    | 42  | Own-line comment plus indent; the comment token is not strictly longer than 40.                |
| `comments`      | 40    | 11   | 41  | `text<!-- inside mixed content -->more` — glued mixed content, no break prettier will take.    |
| `comments`      | 40    | 12   | 44  | Own-line comment plus indent, same as L5.                                                      |
| `kitchen`       | 40    | 16   | 45  | `>world</em> from the kitchen.</summary>` after a broken `<em`. Text does not wrap.            |
| `kitchen`       | 40    | 19   | 51  | `><![CDATA[…]]></content>` — CDATA is opaque and does not wrap.                                |
| `kitchen`       | 40    | 21   | 41  | `url="https://example.com/thumb.jpg"` — attribute value is one token.                          |
| `kitchen`       | 40    | 27   | 46  | `href="https://example.com/a?x=1&amp;y=2"` — same.                                             |
| `literals`      | 40    | 18   | 45  | `><![CDATA[  keep   <this>  &amp;  ]]></raw>` — CDATA, same as kitchen.                        |
| `mixed_content` | 40    | 4    | 54  | `>world</em> and a somewhat longer run of text.</p>` — mixed text after a broken `<em`.        |
| `namespaces`    | 40    | 16   | 57  | `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` — URI in an attribute.                 |
| `prolog`        | 40    | 6    | 73  | `<?xml-stylesheet type="text/xsl" href="…"?>` — PIs do not wrap.                               |
| `quotes`        | 40    | 14   | 44  | `href="https://example.com/a?x=1&amp;y=2"` — attribute value.                                  |
| `self_closing`  | 40    | 1–2  | 74, 77 | Source-wrapped comment; the full token is not a substring of either line, so neither is exempt. |
| `whitespace`    | 40    | 1–2  | 77, 75 | Same shape: a source-wrapped file-level comment.                                            |

The manufactured-looking ones are the mixed-content leftovers after a
broken `<em>` or `<content>`: prettier splits `>` onto its own line and
then leaves the rest of the element glued, over budget. A stage-C agent
that "fixes" those lines is fighting the reference. Comments, CDATA, PIs,
and attribute values are unbreakable in this plugin.

## What prettier does that surprised me

This is the useful section.

### The default is `xmlWhitespaceSensitivity: "strict"`

The plugin's README tells most people to use `"ignore"`. The default is
`"strict"`: every whitespace character inside an element is semantic, so
prettier **will not insert or delete newlines between children**. What it
actually reflows is attribute lists, the XML declaration, and some DOCTYPE
PUBLIC identifiers. Element structure stays where the author put it.

`"ignore"` is the pretty-printer people expect (indent every child, collapse
runs, honour `xml:space="preserve"`). It is also incompatible with gate 3:
`CharData` is a named leaf, so inserting `\n  ` between children changes the
signature. An override that ignored `CharData` would be weaker than the
default and cannot be selected. The committed reference is therefore the
plugin default, and a package that models XML as "indent nested elements"
will diverge on every file.

`xml:space="preserve"` is honoured under `"ignore"` (checked: a sibling
without the attribute collapsed `  a   b  ` to `a b`; the preserved child
did not). Under `"strict"` it is a no-op. `whitespace.xml` records that.

### When a container breaks, the containers inside it do **not** — unless they share the line

Constructed case, in `nesting.xml`. Parent start-tag wraps at both widths:

```
<catalog
  alpha="aaaaaaaaaaaaaaaa"
  beta="bbbbbbbbbbbbbbbb"
  gamma="cccccccccccccccc"
>
  <book id="1" sku="alpha-01">
```

`<book id="1" sku="alpha-01">` stays flat at 40, with room to spare. Inner
attribute groups are independent. The opposite of taplo.

The glued book is the other half:

```
  <book id="2" sku="glued"><chapter n="1"><note
        kind="ok"
      >fits</note></chapter></book>
```

No whitespace between tags, so they cannot break apart. Remaining width is
whatever is left on the `>` line, and `<note kind="ok">` wraps even though
it would fit in isolation (~16 characters). A package that models each
start-tag as an independent group matches the first case and diverges on
the second, unless it also preserves author whitespace between tags.

### A trailing comment counts toward its line's width

XML comments cannot sit between attributes. They *can* share a line with a
tag. In `comments.xml` at width 80:

```
  <child b="2" /> <!-- trailing on a self-closing child -->
```

At width 40 the attributes wrap and the comment stays on the `/>` line:

```
  <child
    b="2"
  /> <!-- trailing on a self-closing child -->
```

Without the comment, `  <child b="2" />` is ~20 characters and would stay
flat at 40. The comment is what forced the wrap. At document root, prettier
joins prolog/root/misc fragments with `hardline`, so a comment after the
root element is forced onto its own line and does *not* share width with
it.

### What the reference normalises at token level

As opposed to line level, and established from `normalisation.xml` plus
probes:

- Space before `?>` in the XML declaration (`<?xml version="1.0"?>` →
  `<?xml version="1.0" ?>`). Inter-token trivia; gate 3 accepts it.
- Space before `/>` in self-closing tags (`<r/>` → `<r />`). Same.
- Empty element *pairs* become self-closing (`<a></a>` → `<a />`). Named
  tree changes; incomparable.
- Empty element with a space (`<empty> </empty>`) is kept. It has a
  `CharData` child.
- Spaces around `=` in attributes are removed (`a = "x"` → `a="x"`).
- Extra whitespace inside a start-tag is collapsed; a start-tag split
  across source lines is joined.
- Attribute quote style is preserved (`"` stays `"`, `'` stays `'`).
- Entity references, character references, and CDATA are preserved
  byte-for-byte, including decimal vs hex (`&#65;` vs `&#x42;`).
- File-level XMLDecl / PI / DOCTYPE / root / trailing comment are joined
  by hardlines.
- Tabs in indent are not special; a tab before a tag is author
  `CharData` if it sits in content, and tag-internal whitespace if it
  sits in the start-tag (the latter is collapsed).
- Blank-line runs *inside an element* are `CharData` and are preserved
  under `strict`. prettier does not cap them.

It does **not** reflow text nodes, CDATA, comments, or processing
instructions, at any width tried.

### `>` on its own line is how a start-tag breaks

Default `bracketSameLine` is `true` in the plugin, but a broken attribute
group still parks `>` at the start-tag's indent, not on the last attribute
line:

```
  <title
    type="text"
  >Kitchen sink</title>
```

That is the wrap mixed content uses, and it is how long CharData overruns
at 80 (`<p\n>This is a single text node that is…`). A package that puts
`>` on the last attribute line will look more like HTML-prettier than like
this plugin.

## Changes outside `corpus/` and `harness/languages/`

```
git diff --stat 7480e32 -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

Nothing outside those two trees. No shared harness script, no runtime, no
package.

## Harness finding (not applied)

tree-sitter-xml 0.7.0 represents comments as named `Comment` nodes with
`is_extra = false`. There are no extras in any corpus tree. Consequences:

- Gate 3's universal extras layer is inert for XML. Dropping a comment
  still fails, because `Comment` is in the structural named-tree. That
  half is fine.
- `check_gate3.drop_a_comment` looks for `n.is_extra and n.is_named`,
  finds nothing, and skips. The 28 destructive mutations this run
  rejected are all `drop_a_token`. The dropped-comment arm never fired.
- `corpus_stats.comment_count` uses the same test, so it prints
  `carries a comment 0/14` while 13 of 14 files contain `Comment` nodes.

This does not block a gate — `check_gate3` and `corpus_stats` both exit 0
— but it makes two advertised checks lie for this grammar.

Proposed field, default empty, so existing languages do not change:

```
comment_kinds = []   # extra node types treated as comments
                     # for extras / drop_a_comment / comment_count
                     # default empty = named extras only (today's behaviour)
```

XML would set `comment_kinds = ["Comment"]`.

| File                       | Change                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `harness/manifest.py`      | Add `comment_kinds` to `_KNOWN` (tuple of str, default `()`), onto `Manifest`, parse it.        |
| `harness/check_gate3.py`   | `drop_a_comment` (lines 85–96): treat `n.type in m.comment_kinds` the same as named extras.     |
| `harness/corpus_stats.py`  | `comment_count` (lines 55–65): same. Needs the manifest, which `stats_for` already has.         |
| `harness/gate3.py`         | Optional: `_extras` (line 120) also emit `comment_kinds`. Not required for correctness, because the structural layer already sees `Comment`. Including it would make the extras layer do the job the workflow doc says it does. |

Not applied. Other round-4 builders are in sibling worktrees.

## Template delta

- The brief's `--plugin @prettier/plugin-xml` snippet does not work under
  prettier 3 + `npx --package`. Plugin resolution starts at CWD, not at the
  npx cache. The path-relative-to-the-prettier-binary form is the one that
  formats, and it should be in the brief for any language whose reference
  is prettier plus a plugin.
- "Most files should carry a comment" is the right requirement and this
  corpus meets it, but the *measurement* assumes comments are named extras.
  XML is the first grammar on the roster where they are not. The
  `comment_kinds` field above is the schema gap.
- The orchestrator's `tree_sitter_xml` guess was right. `language()` was
  the wrong default, and the brief already said so.
