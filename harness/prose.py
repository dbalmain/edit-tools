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
input document; `harness/probe_prose_parity.py` is the gate that says so.

# Why the predicate is a whitelist

A1 has no inline grammar (see the design doc for why the browser path cannot
cheaply have one yet), so it cannot be told whether a `*` opens emphasis or is
a literal asterisk. It therefore admits only paragraphs in which **no character
can begin any inline construct at all**, which makes the question moot rather
than answered.

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
                 `[` or an unbroken scheme inside a single atom.

Everything else -- backtick, asterisk, underscore, bracket, angle, pipe, hash,
tilde, ampersand, backslash, plus, equals, and every non-ASCII byte -- refuses
the paragraph. Emphasis and code spans are A2, and are the reason A2 exists.

The argument above is reasoning, not evidence. The evidence is
`harness/probe_prose_reflow.py`, which reflows every eligible paragraph in the
repository at several widths, reparses, and requires the projection to come
back identical. A character admitted here in error shows up there as a changed
tree, not as a silent rewrite.
"""

from __future__ import annotations

import re

# The run, the content atom, and the whitespace between two atoms. `prose_run`
# is the kind a package declares in `source_partitions`; `prose_gap` is the kind
# it declares in `whitespace_nodes`. The two lists must stay disjoint, which is
# why the gap is not simply an atom of a different shape.
RUN = "prose_run"
ATOM = "prose_atom"
GAP = "prose_gap"

# `prose_atom` is interior rather than a leaf on purpose. `node_current` in both
# runtimes returns a leaf's `text` *before* it looks up a rule, so a `verbatim`
# rule on a leaf would never run and its offsets would never be checked against
# the source. Wrapping the bytes in a leaf child gives `verbatim` a subtree to
# validate. A one-word atom gets the wrapper too; the exception would be the
# only unvalidated path.
TEXT = "prose_text"

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
# Most of these characters are already refused by `SAFE`; `-` and `\d+[.)]` are
# not, and they are why this check exists rather than being folded into it.
_ACQUIRES = re.compile(r"^(?:[-+*>#=|~]|\d+[.)]|```|~~~)")

# A paragraph inside one of these owns a per-line continuation prefix -- a `> `,
# a list indent -- that reflow would have to re-emit on every new line it
# creates. `docs/prose-projection.md` defers that to a later slice, so A1 takes
# only paragraphs that start at column zero.
CONTAINERS = frozenset(
    {"block_quote", "list_item", "list", "fenced_code_block", "html_block"}
)


def package(base: dict) -> dict:
    """`packages/markdown.json`, plus the four rules A1 needs. Derived, not
    committed, so it cannot drift from the package it extends.

    A1 ships no package change. The projection is off in the corpus, so the
    shipped `markdown.json` stays at format 2 with `paragraph: ["verbatim"]`
    and every committed reference and tree is untouched. These edits exist so
    the probes can format a projected document, and so the diff that turns the
    projection on later is these four lines rather than a rewrite.

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
    out["rules"] = {
        **base["rules"],
        "paragraph": [
            "when", ["count", f"t:{RUN}", 1],
            ["seq", ["child", f"t:{RUN}"], ["hard"]],
            ["verbatim"],
        ],
        RUN: ["fill", f"t:{ATOM}", ["line"]],
        ATOM: ["verbatim"],
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
        # to a container. Measured -- deleting this loop is the one edit of
        # thirteen that `probe_prose.py` does not catch. It stays because it is
        # the structural half of the question and the byte check is the lexical
        # half: a grammar that started surfacing a named inline node would slip
        # past the bytes and be caught here. `test_prose.py` covers it directly,
        # since the token check is what fires first for emphasis, code spans and
        # links.
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
        while stop < end and source[stop : stop + 1].decode("ascii") not in GAPS:
            stop += 1
        out.append(
            {
                "type": ATOM,
                "start": at,
                "end": stop,
                "children": [
                    {
                        "type": TEXT,
                        "start": at,
                        "end": stop,
                        "text": source[at:stop].decode("ascii"),
                    }
                ],
            }
        )
        if stop == end:
            break
        out.append(
            {
                "type": GAP,
                "start": stop,
                "end": stop + 1,
                "text": source[stop : stop + 1].decode("ascii"),
            }
        )
        at = stop + 1
    return out


def project(doc: dict) -> int:
    """Rewrite every eligible paragraph in `doc`, in place. Returns how many.

    Top-level only: the walk stops descending the moment it enters a container,
    so a paragraph inside a blockquote is never even offered to `refusal`.
    """
    source = doc["source"].encode("utf-8")
    count = 0
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
            count += 1
            continue
        stack.extend(node.get("children", []))
    return count
