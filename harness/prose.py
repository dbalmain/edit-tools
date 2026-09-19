"""The A2.1 prose projection: a paragraph's words, as a source-backed partition.

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

# What A2.1 added to A1

A1 had no inline grammar, so it could not be told whether a `*` opened emphasis
or was a literal asterisk, and it admitted only paragraphs in which **no
character can begin an inline construct whose meaning a gap flip could change**.

A2.0 built a secondary inline CST beside the block tree. A2.1 reads it, and
that changes the shape of the answer in two places:

- **`code_span`, `inline_link` and `uri_autolink` are admitted, each protected
  whole.** The construct's whole source range lands inside one atom, so no gap
  inside it is ever layout and its interior bytes are emitted verbatim. A double
  space inside a code span is therefore not a "whitespace run", and a `~` inside
  one is not a refused byte -- neither ever becomes a gap. Every other named
  node the inline grammar produces still refuses the paragraph.
- **Block safety moved from `refusal()` into the partition.** A1 refused a
  paragraph when any atom could open a block. A2.1 instead marks the gaps on
  **both** sides of such an atom non-breakable, so the atom cannot reach a line
  start alone. `_ACQUIRES` is still the classifier; what changed is what is done
  with its verdict.

Refusal did not go away: `_DELIMITER_ROW` and `_FENCE` below are the two hazards
gap protection provably cannot repair, and each carries the case that found it.

# Why the bytes outside a protected range are still a whitelist

The whitelist governs every byte **outside** a protected range, for the same
reason it governed every byte under A1: nothing out there has been parsed. It
has to be a whitelist rather than a blacklist, because an incomplete blacklist
does not merely refuse too much -- it *accepts* the case nobody thought of, and
accepting wrongly is how a formatter loses someone's text.

It is deliberately weaker than "admits no unparsed inline syntax", which this
comment once claimed and which is false: a GFM extended autolink is inline
syntax, and an eligible paragraph may hold one. It holds no space, so it lies
inside a single atom and no gap flip reaches into it. `harness/probe_prose.py`
carries that argument and the searches behind it.

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
                 that follows a `]`. A bare `]` out here is refused, and one
                 inside an `inline_link` is inside the atom.
    !            Image marker, but only as `![`. An `image` is a named node the
                 inline grammar reports, and it refuses the paragraph.
    (  )         Link destination delimiters, but only after a `]`. Same.
    -            List marker, setext underline and thematic break, all only at
                 a line start; `_ACQUIRES` refuses a word that starts with one.
    :  /         Reference-definition and autolink punctuation. Both need a
                 `[` or an unbroken scheme inside a single atom. A leading `:`
                 also spells a GFM table delimiter row, which needs no pipe when
                 the table has one column -- see `_ACQUIRES`, which refuses it.

Everything else -- asterisk, underscore, pipe, hash, tilde, ampersand,
backslash, plus, equals, and every non-ASCII byte -- refuses the paragraph when
it appears outside a protected range. Backtick, bracket and angle are no longer
in that list at the *construct* level: they are admitted when the inline grammar
says they open a `code_span`, `inline_link` or `uri_autolink`, and refused when
it does not. Emphasis is A2.2; non-ASCII atom content is A2.3.

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

# The inline constructs A2.1 admits, each **protected whole**: the construct's
# whole source range becomes part of one atom, so no gap inside it is ever
# layout and its interior bytes are emitted verbatim.
#
# `<` and `[` are deliberately **not** added to `_ACQUIRES`, though an atom may
# now begin with either. The argument is the classification itself: the only
# `[`-initial block is a link reference definition, which needs `]:` -- and a
# range the inline grammar called an `inline_link` is, by construction, not
# that. The only `<`-initial block is HTML, whose opener must be a tag, and a
# `uri_autolink` is disjoint from tag syntax. Checked against the pinned block
# grammar as well: neither construct changes the block tree when moved to a
# line start or isolated on one.
#
# Everything else the inline grammar names -- `emphasis` and `strong_emphasis`
# (A2.2), `image`, `shortcut_link`, `full_reference_link`, `backslash_escape`
# (A2.4) -- refuses the paragraph. All four of the latter occur in this
# corpus's secondary trees, so this is a live refusal and not a hypothetical.
CONSTRUCTS = frozenset({"code_span", "inline_link", "uri_autolink"})

# A **last** atom spelling a GFM one-column delimiter row refuses the whole
# paragraph. Bilateral protection cannot repair this one, and the reason is
# worth stating because it is the boundary of the whole mechanism.
#
# Protecting the gaps either side of a hazardous atom works because it keeps
# that atom's *line context* byte-identical to the source's, and the source
# parsed as a paragraph. A delimiter row does not depend on its own line. It
# turns the **preceding line** into a table header -- and the preceding line's
# content is decided by gaps further left, which are still breakable. So
# `alpha beta gamma\n:-` is a one-column table whose header is the whole first
# line, and reflowing it to `alpha beta\ngamma\n:-` is a table whose header is
# `gamma`. Bilateral protection keeps the `\n:-` and changes the header anyway.
#
# It leaks here and nowhere else because the pinned block grammar **cannot see
# it**: tree-sitter-markdown 0.5.1 does not parse a pipeless table, so this
# input arrives as an ordinary paragraph. Every construct the grammar *does*
# model is ruled out by the precondition instead -- `alpha\n---` is already a
# setext heading in the source and so is never offered as a paragraph.
#
# `-+` with no colon is included, though a bare `---` would have been a setext
# heading and never reached here. Refusing a paragraph whose last atom is all
# dashes costs almost nothing and does not depend on that argument holding.
_DELIMITER_ROW = re.compile(r"^:?-+:?\Z")

# A fence opener at a line start the output can produce. This is the second
# hazard gap protection cannot repair, and it was found by `probe_prose.py`'s
# phase A rather than by argument -- the argument was wrong.
#
# The reasoning that failed: an atom is emitted verbatim, so a line start
# *inside* one was a line start in the source too, and the source parsed as a
# paragraph; therefore the line's prefix is safe. The prefix is. The line is
# not, because **a fence opener's validity depends on the rest of its line**: a
# backtick fence's info string may not contain a backtick. Truncating a line
# can therefore turn a non-opener into an opener, which is the opposite
# direction from every other block construct.
#
# Live, in `corpus/reports/markdown/report.md`: a code span delimited by four
# backticks spans a source newline, so one atom holds
#
#     a ```` ```json\n```` fence
#
# whose second line began, in the source, ```` fence in `comments.md` -- the
# backtick in the info string is what stopped it being a fence. Reflow ends the
# line after `fence`, and it becomes one. Phase A saw 543 nodes become 592.
#
# Every other opener truncation can create -- a setext underline, a thematic
# break, a delimiter row -- needs the line to be *only* the marker, and
# bilateral protection keeps a trailing word on it. The ones that are dangerous
# *with* trailing content -- `#`, `>`, a list marker -- would have made the
# source something other than a paragraph, so they never reach here. The fence
# is the one that is neither, so it is refused rather than protected.
#
# **Leading whitespace is allowed before the run, and the bound is not three.**
# CommonMark permits a fence opener after up to three spaces, which alone would
# argue for `^ {0,3}`. Measured against the pinned grammar, four or more spaces
# corrupts too, by a different route: the same paragraph indented four spaces
# reflows into an `indented_code_block` rather than into a fence. So the refusal
# is on the **backtick or tilde run at an indented line start**, at any indent.
#
# Indentation on its own is *not* the hazard, and the discriminating case says
# so: `a ``qq\n    ww`` rr ss tt uu` has an embedded line start with four
# spaces, is admitted, and holds under all six of phase A's reflow patterns. It
# is the run that matters and not the indent, which is why this is not `^[ \t]`.
#
# Measured indent by indent through the real parser and both runtimes, widths
# 10..60: 0 was already refused; 1, 2 and 3 became `fenced_code_block`; 4, 5
# and 6 became `indented_code_block`. Found by review, not by this corpus -- no
# tracked file holds the shape, which is why phase A stayed green over it.
_FENCE = re.compile(r"^[ \t]*(?:```|~~~)")

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


def legacy_inline_token(paragraph: dict) -> bool:
    """A1's retired `inline token` test, frozen. **Not part of A2.1's predicate.**

    Nothing in this module calls it and nothing should. It exists for
    `harness/probe_secondary_grammar.py`, whose audited range set is a fixed
    sample of 2,553 interesting inline ranges pinned at a fixed commit. That
    probe used to select them with `prose.refusal(...) == "inline token"`,
    which coupled a frozen sample to a predicate that moves on every rung of
    A2 -- so the sample silently re-measured itself, and at A2.1 the verdict
    ceased to exist at all.

    It lives here rather than in the probe only because the probe imports
    tree-sitter at module scope and the harness suites run under a plain
    `python3` that has none, so a test could not otherwise drive the real
    function. The dependency is on this *name*, never on A2.1's policy.

    Character for character the old condition: the paragraph shape check, then
    any `inline` child whose type is outside the safe punctuation set. Nothing
    could preempt it, because it ran first.
    """
    children = paragraph.get("children", [])
    if len(children) != 1 or children[0]["type"] != "inline":
        return False
    return any(
        child["type"] not in SAFE_PUNCTUATION
        for child in children[0].get("children", [])
    )


def secondary_index(doc: dict) -> dict[tuple[int, int], dict]:
    """`doc["secondary"]`'s inline records, keyed by the host range they cover.

    A2.0 made that table **total**: one record per matching host range, clean or
    dirty. So a missing key is a producer bug and not an ordinary dirty parse,
    and the two get different refusals below. Only `within == "inline"` records
    are indexed; a future secondary grammar over some other host node must not
    silently answer for a paragraph.
    """
    return {
        (entry["start"], entry["end"]): entry
        for entry in doc.get("secondary", [])
        if entry.get("within") == "inline"
    }


def _protected(inline: dict, record: dict | None) -> tuple[list[tuple[int, int]] | None, str | None]:
    """The A2.1 construct ranges over `inline`, or the reason it is refused.

    The inline CST is the oracle A1 did not have. A1 asked the *block* grammar
    which punctuation appeared under `inline` and refused anything it could not
    name; that question is subsumed here by a grammar that actually parses the
    inline layer, so a named node is classified rather than guessed at.

    The walk is over the root's **direct children only**, and deliberately does
    not descend. An admitted construct is protected whole -- it becomes source
    bytes inside one atom -- so whatever it contains is emitted verbatim and
    cannot be reached by a gap flip. Emphasis inside a link's text is A2.2's
    problem only when the emphasis is *outside* a protected range.
    """
    if record is None:
        return None, "no inline parse"
    if record.get("outcome") != "clean":
        return None, "dirty inline parse"
    out: list[tuple[int, int]] = []
    for child in record["root"].get("children", []):
        kind = child["type"]
        if kind in CONSTRUCTS:
            out.append((child["start"], child["end"]))
        elif kind not in SAFE_PUNCTUATION:
            # A named node A2.1 does not admit -- `emphasis`, `image`,
            # `shortcut_link`, `full_reference_link`, `backslash_escape` -- or
            # an anonymous token spelling a character the whitelist refuses.
            return None, "inline construct"
    return out, None


def _inside(ranges: list[tuple[int, int]], at: int) -> bool:
    return any(start <= at < end for start, end in ranges)


def _hazardous(text: str) -> bool:
    """Could this atom open a block if reflow put it at a line start?

    `_ACQUIRES` over the atom's own text, which is lexical and reads no CST --
    so the block policy needs no secondary tree even though the inline policy
    is built from one. Applied to the atom stream **before** any merging: the
    pattern is either prefix-matching (a merged atom keeps its leftmost
    constituent's prefix) or `\\Z`-anchored (merging can only stop it matching),
    so a hazard found here cannot be created by the merge it triggers. That is
    what makes one pass enough.
    """
    return _ACQUIRES.match(text) is not None


def analyse(
    paragraph: dict, source: bytes, secondary: dict[tuple[int, int], dict]
) -> tuple[str | None, list[int]]:
    """The verdict for this paragraph, and its breakable gap offsets.

    One function, because `refusal()` and `project()` must not be able to
    disagree about which gaps are breakable. It is **pure** -- dicts, bytes and
    a table in, a verdict and a list of offsets out -- so a test can drive the
    real decision instead of restating it.
    """
    children = paragraph.get("children", [])
    if len(children) != 1 or children[0]["type"] != "inline":
        return "paragraph shape", []
    inline = children[0]
    start, end = inline["start"], inline["end"]

    ranges, why = _protected(inline, secondary.get((start, end)))
    if ranges is None:
        return why, []

    try:
        text = source[start:end].decode("ascii")
    except UnicodeDecodeError:
        # A2.3's rung, not this one. The gaps stay ASCII space and newline
        # either way; what is deferred is non-ASCII *atom content*.
        return "non-ascii", []

    # A leading or trailing gap byte would make `partition` emit a zero-width
    # atom, which both runtimes refuse as `source_partitions ... has a
    # zero-width child`. Refusing the paragraph turns a format-time refusal
    # into an ineligibility.
    if not text or text[0] in GAPS or text[-1] in GAPS:
        return "edge whitespace", []

    # Outside a protected range the A1 whitelist still governs, for exactly the
    # A1 reason: nothing out here has been parsed, so a character that could
    # open an inline construct makes the gap question unanswerable. Inside one,
    # any ASCII byte is fine -- the construct is one atom and is emitted
    # verbatim, so its interior is not a layout question at all. That is also
    # why a double space inside a code span is not a "whitespace run": it never
    # becomes a gap.
    candidates: list[int] = []
    for offset in range(start, end):
        if _inside(ranges, offset):
            continue
        char = text[offset - start]
        if char in GAPS:
            candidates.append(offset)
        elif char not in SAFE:
            return "byte", []

    # `partition` splits on these, so two abutting ones -- or one abutting a
    # protected range's edge in a way that leaves nothing between -- would emit
    # a zero-width atom. Check the invariant the runtime checks, rather than a
    # lexical proxy for it.
    if any(b - a == 1 for a, b in zip(candidates, candidates[1:])):
        return "whitespace run", []

    # The one hazard bilateral protection cannot repair; see `_DELIMITER_ROW`.
    if candidates and _DELIMITER_ROW.match(text[candidates[-1] + 1 - start :]):
        return "delimiter row", []

    breakable = _block_safe(start, end, text, candidates)
    if _fence_hazard(start, end, text, breakable):
        return "fence opener", []
    if not breakable:
        # Every gap is protected, so the run would hold a single atom and
        # reflow to its own source. See the done-note: this is reachable in a
        # way it was not under A1, where the check was lexical.
        return "single atom", []
    return None, breakable


def _block_safe(start: int, end: int, text: str, candidates: list[int]) -> list[int]:
    """`candidates`, less every gap flanking an atom that could open a block.

    **Bilateral, not predecessor-only, and that is the whole of this slice's
    block policy.** Binding a hazardous atom only to the gap *before* it does
    not move the atom off a line start -- when that gap was a source newline it
    *keeps* it there -- and if the resulting item is over-width, `fill` must
    break the separator after it, isolating the marker on its own line and
    completing the construct. Measured at width 80 through both runtimes: an
    over-width code span, a source newline and `--` yields a setext h2 plus a
    paragraph where the source had one paragraph. Protecting the following gap
    too leaves the marker line its trailing word, which no setext underline or
    thematic break may have.

    A hazardous **first** atom has no preceding gap and fails on its own --
    `---` and an over-width word format as a thematic break plus a paragraph.
    The right-gap half of the same rule repairs it, so there is no first-atom
    exception: the rule is "both flanking gaps, where they exist".

    Removing gaps from one **set** is what unions the merges into connected
    components. Adjacent hazards (`alpha -- :- beta`) drop three gaps between
    them and coalesce into one atom; pairwise merging would have produced two
    overlapping pairs and no definition of what they mean together.
    """
    drop: set[int] = set()
    edges = [start, *[g + 1 for g in candidates]]
    stops = [*candidates, end]
    for index, (first, last) in enumerate(zip(edges, stops)):
        if not _hazardous(text[first - start : last - start]):
            continue
        if index > 0:
            drop.add(candidates[index - 1])
        if index < len(candidates):
            drop.add(candidates[index])
    return [gap for gap in candidates if gap not in drop]


def _fence_hazard(start: int, end: int, text: str, breakable: list[int]) -> bool:
    """Can any line start the output produces begin a fence? See `_FENCE`.

    The line starts an output can have are exactly: the first atom's first
    line; every line inside an atom that follows an embedded newline; and an
    atom that follows a breakable gap the formatter chose to break.

    The third needs no check here, and that is worth stating rather than
    leaving as an omission. A final atom after a breakable gap begins with a
    provisional atom `_ACQUIRES` did **not** match -- if it had, `_block_safe`
    would have dropped the gap before it and the two would be one atom -- and
    ```` and `~~~` are both `_ACQUIRES` alternatives. So such an atom cannot
    begin a fence.

    The text checked is the atom-internal line, which is the **shortest** the
    output can make it. That is the conservative direction for a fence: adding
    more of the line can only introduce a backtick and stop it being one.
    """
    edges = [start, *[gap + 1 for gap in breakable]]
    stops = [*breakable, end]
    for index, (first, last) in enumerate(zip(edges, stops)):
        lines = text[first - start : last - start].split("\n")
        for offset, line in enumerate(lines):
            if offset == 0 and index > 0:
                continue
            if _FENCE.match(line):
                return True
    return False


def refusal(
    paragraph: dict, source: bytes, secondary: dict[tuple[int, int], dict]
) -> str | None:
    """Why this paragraph is not eligible, or `None` if it is.

    A reason rather than a bool so that a sweep can report *which* rule does the
    refusing. The counts that justify the admitted character set were read off
    this function, and a change to the set that moves them should be visible the
    same way.
    """
    return analyse(paragraph, source, secondary)[0]


def partition(inline: dict, source: bytes, breakable: list[int]) -> list[dict]:
    """The alternating atom/gap children covering `inline`'s whole range.

    The atoms are the maximal source spans **between the breakable gaps**, so
    every gap not proved safe stays exact text inside an atom. The polarity is
    the point: under a `protected_gaps` argument a hazard nobody classified
    would become layout by default, and under this one it stays text.

    Abutting and non-empty by construction, which is what `source_partitions`
    checks at format time. The two facts are kept separate deliberately: this
    builds the partition, the runtime proves it, and a bug here is meant to
    surface as a refusal rather than as a silent hole.
    """

    def atom(first: int, last: int) -> dict:
        return {
            "type": ATOM,
            "start": first,
            "end": last,
            "text": source[first:last].decode("utf-8"),
        }

    out: list[dict] = []
    at = inline["start"]
    for gap in breakable:
        out.append(atom(at, gap))
        out.append(
            {
                "type": GAP,
                "start": gap,
                "end": gap + 1,
                "text": source[gap : gap + 1].decode("utf-8"),
            }
        )
        at = gap + 1
    out.append(atom(at, inline["end"]))
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
    secondary = secondary_index(doc)
    out: list[tuple[int, str]] = []

    def walk(node: dict) -> None:
        if node["type"] in CONTAINERS or "language" in node:
            return
        if node["type"] == "paragraph":
            out.append((node["start"], refusal(node, source, secondary) or "eligible"))
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
    secondary = secondary_index(doc)
    stack = [doc["root"]]
    while stack:
        node = stack.pop()
        if node["type"] in CONTAINERS or "language" in node:
            continue
        verdict, breakable = (
            analyse(node, source, secondary)
            if node["type"] == "paragraph"
            else ("not a paragraph", [])
        )
        if verdict is None:
            inline = node["children"][0]
            # Key order is `type, start, end, field, children`, the order
            # `convert()` inserts them in. Both producers write documents that
            # are compared as bytes elsewhere in the tree corpus; a projection
            # that reordered keys would be the one node shape that could not be.
            run = {"type": RUN, "start": inline["start"], "end": inline["end"]}
            if "field" in inline:
                run["field"] = inline["field"]
            run["children"] = partition(inline, source, breakable)
            node["children"] = [run]
            continue
        stack.extend(node.get("children", []))
    return doc
