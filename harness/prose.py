"""The A1 prose projection: a paragraph's words, as a source-backed partition.

`docs/prose-projection.md` is the design. This is its first slice: turn an
eligible markdown paragraph's `inline` node into a `prose_run` whose children
alternate `prose_atom` (a contiguous run of source bytes) and `prose_gap` (one
space or one newline), so that the existing `fill` opcode can repack the words.
Nothing here parses. It rewrites the document `gen_trees.py` and `ts_doc.mjs`
already produce, exactly as `ts_inject.mjs` splices injections after conversion
rather than during -- a node's type, its children's types and its byte range are
all this needs, and none of the parser's internals are.

`harness/prose.mjs` is the mirror. The two must agree byte for byte on the same
input document; `harness/probe_prose.py` is the gate that says so.

# Why the predicate is a whitelist

A1 has no inline grammar (see the design doc for why the browser path cannot
cheaply have one yet), so it cannot be told whether a `*` opens emphasis or is
a literal asterisk. It therefore admits only paragraphs in which **no character
can begin an inline construct whose meaning a gap flip could change**, which
makes the question moot rather than answered.

That is deliberately weaker than "no inline syntax at all", which this comment
used to claim and which is false: a GFM extended autolink is inline syntax, and
an eligible paragraph may hold one. It holds no space, so it lies inside a
single atom and no gap flip reaches into it. `harness/probe_prose.py` carries
that argument and the searches behind it.

That has to be a whitelist. An incomplete blacklist does not merely refuse too
much -- it *accepts* the case nobody thought of, and accepting wrongly is how a
formatter loses someone's text.

# What reflow is allowed to do, and the argument for each admitted character

The only edit this projection enables is replacing one gap -- exactly one
space or exactly one newline -- with the other. No byte outside a gap moves,
no byte is inserted, and no atom is ever split. So the question for each
admitted character is narrow: **can flipping an adjacent gap between a space
and a newline change how this character is read?**

    ,  ;  ?      No markdown role, block or inline.
    .            Ordered-list marker only as `1.` at a line start, which
                 `_ACQUIRES` refuses. A GFM autolink literal (`www.x.com`)
                 contains no space, so it lies inside one atom and cannot be
                 split; its left flank must be whitespace, and a space and a
                 newline are both whitespace, so flipping does not change it.
    '  "         Link-title delimiters, but only inside a `(...)` destination
                 that follows a `]`. `[` and `]` are not admitted.
    !            Image marker, but only as `![`. `[` is not admitted.
    (  )         Link destination delimiters, but only after a `]`. Same.
    -            List marker, setext underline and thematic break, all only at
                 a line start; `_ACQUIRES` refuses a word that starts with one.
    :  /         Reference-definition and autolink punctuation. Both need a
                 `[` or an unbroken scheme inside a single atom. A leading `:`
                 also spells a GFM table delimiter row, which needs no pipe when
                 the table has one column -- see `_ACQUIRES`, which refuses it.

Everything else -- backtick, asterisk, underscore, bracket, angle, pipe, hash,
tilde, ampersand, backslash, plus, equals, and every non-ASCII byte -- refuses
the paragraph. Emphasis and code spans are A2, and are the reason A2 exists.

The argument above is reasoning, not evidence, and one character in it was
wrong: `:` also spells a GFM table delimiter row. The evidence is
`harness/probe_prose.py`, and specifically its refusal fixture -- see
`_ACQUIRES` for why a reflow-and-reparse sweep could not have found that one.
"""

from __future__ import annotations

import copy
import re

# The run, the content atom, and the whitespace between two atoms. `prose_run`
# is the kind a package declares in `source_partitions`; `prose_gap` is the kind
# it declares in `whitespace_nodes`. The two lists must stay disjoint, which is
# why the gap is not simply an atom of a different shape.
RUN = "prose_run"
ATOM = "prose_atom"
GAP = "prose_gap"

# An atom is a **leaf**, and the design doc's argument for wrapping it in an
# interior node is wrong. That argument was: `node_current` returns a leaf's
# `text` before it looks up a rule, so a `verbatim` rule on a leaf would never
# run and the bytes would never be checked against the source. True in
# isolation, and moot here -- `source_partitions` on the enclosing `prose_run`
# runs `check_source` over the whole subtree, leaves included, before any Doc is
# built. Measured: a leaf atom carrying `"XXXXX"` where the source says
# `"alpha"` is refused by both runtimes with
#
#     source_partitions `prose_run` has a leaf whose text does not match the source
#
# So the wrapper bought nothing and cost a synthetic node type and a package
# rule, both of which A2 would have inherited.

ALNUM = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
)
SAFE_PUNCTUATION = frozenset(",;.'\"!?()-:/")
SAFE = ALNUM | SAFE_PUNCTUATION

# A gap is exactly one of these. Two spaces before a newline is a hard break and
# a blank line ends the paragraph, so a run of length two is never a gap; a tab
# or a carriage return is not one either, because its width is not this layer's
# to decide.
GAPS = (" ", "\n")

# An atom that would start a block construct if reflow moved it to a line start.
# Most of these characters are already refused by `SAFE`; `-`, `\d+[.)]` and the
# GFM delimiter row are not, and they are why this check exists rather than
# being folded into the byte whitelist.
#
# `:-+:?` is a **GFM one-column table delimiter row**, and it is the one entry
# here found by a counterexample rather than by enumeration. GFM requires a pipe
# only *between* cells, so a single-column delimiter row may be written with no
# pipe at all -- `a :- b` is a paragraph, and moving `:-` onto its own line
# makes it a table with header `a` and body `b`. Confirmed against prettier
# 3.9.6 and micromark+GFM. `|` is not admitted, so the familiar `| --- |`
# spelling never arises, and `-:` and `---` are caught by the leading `-`. Only
# the colon-leading spelling slipped through, because the argument for admitting
# `:` reasoned about CommonMark inlines and reference definitions and never
# considered a GFM *block*.
#
# The general shape, worth naming because the next one will look like it: a
# **GFM-only block construct whose opener is an admitted character that is
# neither `-` nor a digit.** Tables are the only such construct today -- task
# lists and footnotes both need `[`, which is refused -- but nothing here would
# have caught a second one either.
#
# The pinned block grammar does not parse a pipeless table, so a reparse cannot
# see this class at all and `probe_prose.py`'s phase A is blind to it. The guard
# is the entry in `harness/fixtures/prose-refused.md`, not the sweep.
#
# Most of this pattern is unreachable and kept as documentation. `+ * > # = | ~`
# and the two fence spellings are not admitted characters, so an atom can never
# begin with one and the `byte` check refuses the paragraph first. Only three
# clauses can actually fire on an admitted atom: the leading `-`, the ordered
# marker, and the colon-leading delimiter row. Exhaustively: over every
# two-character atom the whitelist admits (5,476 of them, 5,381 admitted),
# rendered through micromark+GFM in six gap patterns at three positions,
# **exactly three change meaning** -- `--`, `-:` and `:-`, all three refused
# here. A 295,934-case sweep over delimiter-row spellings found none this
# pattern misses, and 5,329 two-atom openers found no hit at all. Those three
# searches are grok's, from the round-2 review; the fixture is what locks them
# in, since none of them runs in `test.sh`.
_ACQUIRES = re.compile(r"^(?:[-+*>#=|~]|\d+[.)]|```|~~~|:-+:?\Z)")

# A paragraph inside one of these owns a per-line continuation prefix -- a `> `,
# a list indent -- that reflow would have to re-emit on every new line it
# creates. `docs/prose-projection.md` defers that to a later slice, so A1 takes
# only paragraphs that start at column zero.
CONTAINERS = frozenset(
    {"block_quote", "list_item", "list", "fenced_code_block", "html_block"}
)


def package(base: dict) -> dict:
    """`packages/markdown.json`, plus the two rules A1 needs. Derived, not
    committed, so it cannot drift from the package it extends.

    A1 ships no package change. The projection is off in the corpus, so the
    shipped `markdown.json` stays at format 2 with `paragraph: ["verbatim"]`
    and every committed reference and tree is untouched. These edits exist so
    the probes can format a projected document, and so the diff that turns the
    projection on later is these few lines rather than a rewrite.

    `paragraph` keeps `verbatim` for the paragraphs the projection refused,
    which is most of them, and takes the reflowing branch only when a
    `prose_run` is actually present. That guard is what lets one package format
    a document in which some paragraphs are projected and some are not.
    """
    out = dict(base)
    out["format"] = "et-doc-rules/3"
    out["source_partitions"] = [RUN]
    # Disjoint from `source_partitions`, which both runtimes check: the gap is
    # trivia the item view removes, the run is the node whose coverage is
    # proven before that removal happens.
    out["whitespace_nodes"] = [*base.get("whitespace_nodes", []), GAP]
    # Two rules, not three: an atom is a leaf, and a leaf emits its own text
    # before rule dispatch, so `prose_atom` needs no rule at all.
    out["rules"] = {
        **base["rules"],
        "paragraph": [
            "when", ["count", f"t:{RUN}", 1],
            ["seq", ["child", f"t:{RUN}"], ["hard"]],
            ["verbatim"],
        ],
        RUN: ["fill", f"t:{ATOM}", ["line"]],
    }
    return out


def refusal(paragraph: dict, source: bytes) -> str | None:
    """Why this paragraph is not eligible, or `None` if it is.

    A reason rather than a bool so that a sweep can report *which* rule does the
    refusing. The counts that justify the admitted character set were read off
    this function, and a change to the set that moves them should be visible the
    same way.
    """
    children = paragraph.get("children", [])
    if len(children) != 1 or children[0]["type"] != "inline":
        return "paragraph shape"
    inline = children[0]
    for child in inline.get("children", []):
        # The block grammar surfaces the punctuation that *could* open an inline
        # construct as anonymous children of `inline`. A named child, or an
        # anonymous one outside the admitted set, means this paragraph holds
        # something A1 cannot reason about.
        #
        # On the pinned grammar this is **subsumed** by the byte check below:
        # every character that produces a child outside the set is also a
        # character outside the set, and a top-level paragraph never gets the
        # one non-punctuation child (`block_continuation`) because that belongs
        # to a container. Measured: deleting it here *and* in `prose.mjs`
        # changes one paragraph's verdict across the tracked corpus and
        # `probe_prose.py` still passes. Deleting it on one side only is caught,
        # but by producer disagreement rather than by the behaviour being wrong.
        #
        # It stays because it is the structural half of the question and the
        # byte check is the lexical half: a grammar that began surfacing a named
        # inline node would slip past the bytes and be caught here.
        # `test_prose.py` covers it directly, since this is what fires first for
        # emphasis, code spans and links.
        if child["type"] not in SAFE_PUNCTUATION:
            return "inline token"
    try:
        text = source[inline["start"] : inline["end"]].decode("ascii")
    except UnicodeDecodeError:
        return "non-ascii"
    # A leading or trailing gap byte would make `partition` emit a zero-width
    # atom, which both runtimes refuse as `source_partitions ... has a
    # zero-width child`. Refusing the paragraph turns a format-time refusal
    # into an ineligibility. The block grammar trims the edges of an `inline`
    # node, so this has not been observed to fire; producing a tree the runtime
    # rejects is not a thing to leave to the grammar's good behaviour.
    if not text or text[0] in GAPS or text[-1] in GAPS:
        return "edge whitespace"
    run = 0
    for char in text:
        if char in GAPS:
            run += 1
            if run > 1:
                return "whitespace run"
            continue
        run = 0
        if char not in SAFE:
            return "byte"
    atoms = re.split(r"[ \n]", text)
    if len(atoms) < 2:
        return "single atom"
    if any(_ACQUIRES.match(atom) for atom in atoms):
        return "block acquisition"
    return None


def partition(inline: dict, source: bytes) -> list[dict]:
    """The alternating atom/gap children covering `inline`'s whole range.

    Abutting and non-empty by construction, which is what `source_partitions`
    checks at format time. The two facts are kept separate deliberately: this
    builds the partition, the runtime proves it, and a bug here is meant to
    surface as a refusal rather than as a silent hole.
    """
    start, end = inline["start"], inline["end"]
    out: list[dict] = []
    at = start
    while at < end:
        stop = at
        while stop < end and chr(source[stop]) not in GAPS:
            stop += 1
        out.append(
            {
                "type": ATOM,
                "start": at,
                "end": stop,
                "text": source[at:stop].decode("utf-8"),
            }
        )
        if stop == end:
            break
        out.append(
            {
                "type": GAP,
                "start": stop,
                "end": stop + 1,
                "text": source[stop : stop + 1].decode("utf-8"),
            }
        )
        at = stop + 1
    return out


def reasons(doc: dict) -> list[tuple[int, str]]:
    """Every paragraph the walk reaches, in document order, with its verdict.

    `project` compares documents, which says nothing about the paragraphs it
    refused -- and it refuses about nine in ten. Two implementations that
    disagreed about *why* a paragraph is ineligible would still produce
    identical documents, so the agreement check would be vacuous exactly where
    the logic is densest. This exposes the verdict itself, so
    `probe_prose.py`'s producer comparison has something to compare on a
    document with no eligible paragraph at all.

    Document order, not the traversal order `project` happens to use, so the
    two implementations cannot agree by accident of stack discipline.
    """
    source = doc["source"].encode("utf-8")
    out: list[tuple[int, str]] = []

    def walk(node: dict) -> None:
        if node["type"] in CONTAINERS or "language" in node:
            return
        if node["type"] == "paragraph":
            out.append((node["start"], refusal(node, source) or "eligible"))
            return
        for child in node.get("children", []):
            walk(child)

    walk(doc["root"])
    return out


def project(doc: dict) -> dict:
    """A copy of `doc` with every eligible paragraph projected. `doc` is untouched.

    A copy rather than an in-place rewrite, because the projection **replaces**
    a paragraph's `inline` child and `docs/prose-projection.md` requires the
    syntax tree to survive for highlighting and syntax-aware editing. A pass
    that mutated the shared document would, the moment it was wired into the
    browser's one `parse()`, discard exactly the inline CST A2 exists to buy.
    Returning a separate formatter view makes that impossible rather than
    merely discouraged.

    Top-level only: the walk stops descending the moment it enters a container,
    so a paragraph inside a blockquote is never even offered to `refusal`.
    """
    doc = copy.deepcopy(doc)
    source = doc["source"].encode("utf-8")
    stack = [doc["root"]]
    while stack:
        node = stack.pop()
        if node["type"] in CONTAINERS or "language" in node:
            continue
        if node["type"] == "paragraph" and refusal(node, source) is None:
            inline = node["children"][0]
            # Key order is `type, start, end, field, children`, the order
            # `convert()` inserts them in. Both producers write documents that
            # are compared as bytes elsewhere in the tree corpus; a projection
            # that reordered keys would be the one node shape that could not be.
            run = {"type": RUN, "start": inline["start"], "end": inline["end"]}
            if "field" in inline:
                run["field"] = inline["field"]
            run["children"] = partition(inline, source)
            node["children"] = [run]
            continue
        stack.extend(node.get("children", []))
    return doc
