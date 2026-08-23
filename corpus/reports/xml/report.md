# XML package report (stage C)

**Builder:** Claude (Opus 5), orchestrator session.

```
gate 1 idempotence      pass    (30/30 xml pairs; 327/327 corpus-wide)
gate 2 width            pass    19 overflow lines, against the reference's own 19
gate 3 non-destruction  pass    (method: default, plus comment_kinds = ["Comment"])
gate 4 agreement        14/14 @80,  14/14 @40   =  28/28
rust/js parity          identical on every file at every width
refusals                none
size                    package 843 B gzip; runtime 14131 B gzip; delta vs main 0 B
```

`./test.sh` green end to end. The slice is `packages/xml.json` plus this report
and `score.json`. No runtime edit, no harness edit, no shared file touched.

## The number is 28 of 28, and stage D is why it is 28 and not 26

Every comparable pair at both widths, zero divergences to classify, zero
refusals, and an overflow count identical to the reference's. This is the first
language in the project to reach full agreement, and it did it in **847 bytes**
— the smallest package after JSON.

That deserves suspicion rather than celebration, so here is the reason, and it
is a property of the reference rather than a property of the package.

### `@prettier/plugin-xml` does not re-indent content

XML whitespace is significant, and the plugin honours that completely.
`normalisation.xml` is the proof: its source has a child at column 0, one at
column 4, one indented with a tab, and the reference output **keeps all three
exactly where they were**, while normalising everything inside the tags
(`a = "x"` to `a="x"`, `<padded  />` to `<padded />`).

```
source                      reference
<child attr = "z"/>         <child attr="z" />
    <indented/>                 <indented />
<TAB><tabbed a="1"/>        <TAB><tabbed a="1" />
```

So the content whitespace lives in `CharData` leaves, and a leaf is emitted as
its own text — which is precisely the behaviour the reference wants. The package
did not have to solve content indentation because neither side does it.

**What gate 4 measures for XML is therefore tag layout**: attribute wrapping,
where a `>` lands when a tag breaks, the space before `/>`, and prolog layout.
That is a real and non-trivial thing to get right, and it is less than the
number looks like. Recorded so nobody reads 26/26 as "XML is solved".

### The one structural idea in the package

`element` is three lines and it carries the whole nesting model:

```json
"element": ["seq",
  ["opt", "t:EmptyElemTag", ["child", "t:EmptyElemTag"]],
  ["opt", "t:STag", ["seq",
    ["child", "t:STag"],
    ["indent", ["opt", "t:content", ["child", "t:content"]]],
    ["child", "t:ETag"]]]]
```

The `indent` wraps only the **content**, not the tags. That single placement is
what makes a broken tag land at its own nesting depth: the start tag's own break
resolves at the element's level, while every element inside contributes one more
level to the elements below it. It reproduces prettier's hardest case in the
corpus without a special rule —

```
  <book id="2" sku="glued"><chapter n="1"><note
        kind="ok"
      >fits</note></chapter></book>
```

— where `<note`'s attribute sits at 8 and its `>` at 6, because `book` and
`chapter` each contributed a level while staying flat themselves. If the
`indent` had wrapped the whole element instead, every tag break would have been
two columns too deep; if it had been omitted, they would all have collapsed to
the document level.

The break before a `>` is `soft` and the one before a `/>` is `line`, which is
the entire difference between `<root a="1">` and `<br />`.

### `fill` earns its third language

The doctype's external ID packs rather than breaks all:

```
@80   <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"
        "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
@40   <!DOCTYPE html PUBLIC
        "-//W3C//DTD XHTML 1.0 Strict//EN"
        "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
```

A `group` gets one of the two widths wrong whichever way it is written. The rule
is `["indent", ["fill", "*", ["line"]]]` — and note the `*`: the `PUBLIC` keyword
has to be a fill **item**, not a fixed prefix, because at width 40 the first
break falls after it and at 80 it does not. `FINDINGS` 8 was built for CSS and
measured on JSON; this is a third language, on a construct neither of those
resembles, and the whole rule is nine tokens.

## What stage D found, and why the number moved

codex-Sol returned **`escalate`**, and it was right to. The 26/26 was genuine
for the corpus as it stood, and the corpus did not probe the XML declaration's
own variants. Two focused probes against the pinned reference found that **both
runtimes refused input prettier formats**:

```
<?xml version="1.0" standalone="no"?>          both runtimes refuse
<?xml version='1.0' encoding='UTF-8'?>          both runtimes refuse
```

The cause was two hard-coded selectors in `XMLDecl`: `["tok", "\""]` for every
quote, and `["child", "t:yes"]` for the standalone value. Neither is a design
limit — the rule can consume whichever quote and whichever spelling the source
used with the wildcard selector it should have used in the first place. **These
were package bugs, and a refusal on valid input is worse than a divergence**: a
divergence is visible in the score, and a refusal only shows up when someone
formats a real file.

Fixed, and `declaration.xml` now probes all three variants — single-quoted
pseudo-attribute values, `standalone='no'`, and mixed quoting on one element.
It matches byte-for-byte at both widths, which is why the number is 28/28 rather
than 26/26: the corpus got two pairs bigger, not the package luckier.

The reviewer also upheld the three claims this report makes, and tested them
harder than the report did: content preservation reproduced against the pinned
reference, the `element` indent placement verified at **width 12 and nesting
depth six** — deeper and narrower than anything in the corpus — and `fill "*"`
checked against an internal-subset probe to confirm it swallows nothing it
should not.

**The lesson is the one the reviewer put in its template delta, and it is
sharper than mine.** My template delta said a builder reporting full agreement
should have to say what the reference left alone. The reviewer's version is the
one that would have caught this: a 100% report should also say **which
alternatives to every hard-coded token or type selector are absent from the
corpus, and what out-of-corpus probe tested them**. A perfect score is evidence
about the corpus at least as much as about the package.

## The excluded file

`empty_to_self_closing.xml` is declared incomparable in the manifest, and the
package behaves as that declaration predicts: we emit `<root><a></a><b></b></root>`
where prettier emits `<root><a /><b /></root>`. Rewriting an empty pair into a
self-closing tag replaces two named nodes (`STag`, `ETag`) with one
(`EmptyElemTag`), which gate 3 rejects, and no sanctioned token policy deletes a
tag. This is the same class as Ruby's brace-to-`do`/`end` conversion and HTML's
void slash — **three languages now, three references, one limit**: the reference
changes which named node the tree contains, and non-destruction forbids it.
Worth a `FINDINGS` line of its own if it is not already one; it is no longer a
per-language curiosity.

## What was hardest

Nothing was hard, and that is itself the report. The XML grammar hands the
package exactly what it needs: whitespace is a real node, attributes are real
nodes, and every construct has a distinct node type — no `element`-for-everything
problem like HTML's tag names, no `list`-for-everything problem like Scheme's.
The one thing I would have wanted, `fill` over a mixed token-and-node child
list, already existed.

The contrast with the two languages either side of it on the roster is the
useful output. Scheme reaches 2/15 because its grammar deliberately erases the
distinctions its layout depends on; HTML needed three runtime additions because
its grammar omits rendering-significant whitespace; XML needs nothing because its
grammar keeps both. **The IR was never the binding constraint in any of the
three — the grammar's fidelity to the language was.**

## Template delta

**The brief has no advice for a slice that agrees completely**, and the shape of
that gap is real: every instruction about classification, divergence vocabulary,
ledger verdicts and the 70% floor is inapplicable, and the one thing a reviewer
most needs — *why* did this agree, and is the corpus actually probing anything —
is not asked for anywhere. A stage-C builder reporting 26/26 should be required
to answer "what did the reference not do that it does for other languages", which
is what surfaced the content-indentation property above. Without that question,
this report would have been four lines and a table, and stage D would have had
nothing to check.

**Second, the same one Ruby and Scheme both raised:** `DESIGN.md`'s opcode table
is missing seven opcodes the loader accepts. This package uses only documented
ones, so it is not blocked — but the fix is now requested by three consecutive
slices.
