#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""Sweep the two format runtimes for byte-range parity defects.

    ./harness/parity_fuzz.py [submission-dir] [--json] [--verbose] [--site NAME]

Gate 1 compares the runtimes over corpus trees. Those trees are built by
`gen_trees.py`, which refuses ERROR/MISSING and therefore never emits a range
that is reversed, past the source, or mid-character. This script hand-writes
those trees and classifies what the two CLIs do with them.

Exit 1 if any case is BREAK (one runtime refuses and the other emits, or both
emit and the bytes differ). SOFT (both refuse, different exit codes) is
reported and does not fail. COSMETIC (same exit, different message) is one
summary line.

Covers the 13 format-path source-byte sites plus the tree loader. It cannot
reach the highlighter CLI, printer/aligner IR slices, or cursor/map lookups.

Does not replace or wrap any existing gate.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent.parent
WIDTH = 80
TIMEOUT_S = 10

# "xéy" is 4 bytes (x, C3, A9, y); "éé" is 4 bytes that can split on both edges.
ASCII = "hello"  # 5
UTF8 = "xéy"  # 4
UTF8_PAIR = "éé"  # 4
CRLF = "a\r\nb"  # 4
CR = "a\rb"  # 3
VT = "a\x0bb"  # 3
BLANK = "a\n\nb"  # 4

TOY = {
    "format": "et-doc-rules/1",
    "indent": 2,
    "tokens": [],
    "comments": ["comment"],
    "descend": [],
    "gap_owner": {"owned": ["item"]},
    "rules": {
        "verbatim_root": ["verbatim"],
        "prefix_root": ["prefix", "t:marker", ["hard"], ["child", "named"]],
        "srcgap_root": [
            "group",
            ["child", "t:left"],
            ["srcgap"],
            ["child", "t:right"],
        ],
        "srcgap_open": ["seq", ["srcgap"], ["child", "named"]],
        "srcgap_close": ["seq", ["child", "named"], ["srcgap"]],
        "multi_root": [
            "when",
            ["source-multiline"],
            ["seq", ["child", "named"], ["hard"], ["child", "named"]],
            ["each", "named", ["sp"]],
        ],
        "comment_root": ["each", "named", ["seq"]],
        "blank_root": ["each", "named", ["seq", ["hard"], ["blank", 1]]],
        "owned": ["each", "t:item", ["seq", ["hard"], ["blank", 1]]],
        "item": ["child", "named"],
    },
}

# Separate from TOY so existing v1 cases do not change behaviour. language
# "prose" loads this file from the same temp packages dir.
PROSE = {
    "format": "et-doc-rules/3",
    "indent": 2,
    "tokens": [],
    "whitespace_nodes": ["prose_gap"],
    "source_partitions": ["prose_run"],
    "rules": {
        "prose_run": ["fill", "t:prose_atom", ["line"]],
        "prose_atom": ["verbatim"],
    },
}


def n(
    kind: str,
    start: Any,
    end: Any,
    *,
    text: str | None = None,
    children: list[dict] | None = None,
    **extra: Any,
) -> dict:
    node: dict[str, Any] = {"type": kind, "start": start, "end": end, **extra}
    if text is not None:
        node["text"] = text
    if children is not None:
        node["children"] = children
    return node


def nbytes(source: str) -> int:
    return len(source.encode("utf-8"))


@dataclass(frozen=True)
class Case:
    site: str
    name: str
    source: str
    root: dict
    language: str = "toy"
    shipped: bool = False
    well_formed: bool = False


@dataclass
class Run:
    rc: int
    stdout: bytes
    stderr: str
    error: str = ""


@dataclass
class Result:
    case: Case
    rust: Run
    js: Run
    klass: str
    tree: dict = field(default_factory=dict)


def classify(rust: Run, js: Run) -> str:
    if rust.error or js.error:
        if rust.error == js.error:
            return "MATCH"
        return "BREAK"
    r_ok, j_ok = rust.rc == 0, js.rc == 0
    if r_ok and j_ok:
        return "MATCH" if rust.stdout == js.stdout else "BREAK"
    if r_ok != j_ok:
        return "BREAK"
    if rust.rc != js.rc:
        return "SOFT"
    if rust.stderr == js.stderr:
        return "MATCH"
    return "COSMETIC"


def invoke(exe: Path, tree: Path, width: int, packages: Path | None) -> Run:
    env = os.environ.copy()
    if packages is not None:
        env["FMT_PACKAGES"] = str(packages)
    try:
        proc = subprocess.run(
            [str(exe), str(tree), str(width)],
            capture_output=True,
            timeout=TIMEOUT_S,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return Run(rc=-1, stdout=b"", stderr="", error=f"timeout after {TIMEOUT_S}s")
    except OSError as exc:
        return Run(rc=-1, stdout=b"", stderr="", error=f"could not execute: {exc}")
    return Run(
        rc=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr.decode("utf-8", "replace").strip(),
    )


# --------------------------------------------------------------------------
# cases: one generator per reachable site


def prefix_cases() -> Iterator[Case]:
    """Site 5: prefix marker is sliced, not check_verbatim'd."""
    source = ASCII
    nlen = nbytes(source)
    payload = n("word", 0, nlen, text=source)

    def root(start: Any, end: Any) -> dict:
        return n(
            "prefix_root",
            0,
            nlen,
            children=[n("marker", start, end), payload],
        )

    yield Case("prefix", "well_formed", source, root(0, 2), well_formed=True)
    yield Case("prefix", "reversed", source, root(4, 2))
    yield Case("prefix", "end_past", source, root(0, nlen + 10))
    yield Case("prefix", "start_past", source, root(nlen + 3, 2))
    yield Case("prefix", "both_past", source, root(nlen + 3, nlen + 8))
    yield Case("prefix", "empty_0", source, root(0, 0))
    yield Case("prefix", "empty_mid", source, root(2, 2))
    yield Case("prefix", "empty_len", source, root(nlen, nlen))
    yield Case("prefix", "empty_past", source, root(nlen + 1, nlen + 1))
    u = UTF8
    un = nbytes(u)
    upayload = n("word", 0, un, text="y")
    yield Case(
        "prefix",
        "utf8_split_first_edge",
        u,
        n("prefix_root", 0, un, children=[n("marker", 0, 2), upayload]),
    )
    yield Case(
        "prefix",
        "utf8_split_second_edge",
        u,
        n("prefix_root", 0, un, children=[n("marker", 2, un), upayload]),
    )
    p = UTF8_PAIR
    pn = nbytes(p)
    yield Case(
        "prefix",
        "utf8_split_both_edges",
        p,
        n(
            "prefix_root",
            0,
            pn,
            children=[n("marker", 1, 3), n("word", 0, pn, text="x")],
        ),
    )
    yield Case(
        "prefix",
        "utf8_well_formed",
        u,
        n(
            "prefix_root",
            0,
            un,
            children=[n("marker", 1, 3), upayload],
        ),
        well_formed=True,
    )
    for label, src in (("crlf", CRLF), ("cr", CR)):
        slen = nbytes(src)
        yield Case(
            "prefix",
            f"{label}_range",
            src,
            n(
                "prefix_root",
                0,
                slen,
                children=[
                    n("marker", 1, slen - 1),
                    n("word", 0, slen, text="x"),
                ],
            ),
        )


def slice_cases() -> Iterator[Case]:
    """Site 1, driven through verbatim. Sites 2–4 are the check_verbatim walk."""
    source = ASCII
    nlen = nbytes(source)

    def root(start: Any, end: Any, children: list[dict] | None = None) -> dict:
        return n("verbatim_root", start, end, children=children)

    yield Case("slice", "well_formed", source, root(0, nlen), well_formed=True)
    yield Case("slice", "reversed", source, root(4, 2))
    yield Case("slice", "end_past", source, root(0, nlen + 10))
    yield Case("slice", "start_past", source, root(nlen + 3, 2))
    yield Case("slice", "both_past", source, root(nlen + 3, nlen + 8))
    yield Case("slice", "empty_0", source, root(0, 0))
    yield Case("slice", "empty_mid", source, root(2, 2))
    yield Case("slice", "empty_len", source, root(nlen, nlen))
    yield Case("slice", "empty_past", source, root(nlen + 1, nlen + 1))
    u = UTF8
    un = nbytes(u)
    yield Case("slice", "utf8_split_first_edge", u, root(0, 2))
    yield Case("slice", "utf8_split_second_edge", u, root(2, un))
    p = UTF8_PAIR
    yield Case("slice", "utf8_split_both_edges", p, root(1, 3))
    yield Case("slice", "utf8_well_formed", u, root(0, un), well_formed=True)
    # A well-formed child under a splitting parent: check_verbatim passes,
    # then slice decodes the parent range.
    yield Case(
        "slice",
        "utf8_split_parent_valid_child",
        u,
        root(0, 2, children=[n("word", 0, 1, text="x")]),
    )
    # Leaf-text compare (site 4): range in bounds but bytes ≠ text.
    yield Case(
        "slice",
        "leaf_text_mismatch",
        source,
        root(0, nlen, children=[n("word", 0, nlen, text="other")]),
    )
    for label, src, start, end in (
        ("crlf_whole", CRLF, 0, nbytes(CRLF)),
        ("crlf_around", CRLF, 1, 3),
        ("cr_whole", CR, 0, nbytes(CR)),
        ("cr_around", CR, 1, 2),
    ):
        yield Case("slice", label, src, root(start, end), well_formed=label.endswith("whole"))


def srcgap_cases() -> Iterator[Case]:
    """Site 6: from/to come from sibling (or parent) offsets."""
    source = "a  b"
    nlen = nbytes(source)

    def root(left_end: Any, right_start: Any, start: Any = 0, end: Any | None = None) -> dict:
        stop = nlen if end is None else end
        return n(
            "srcgap_root",
            start,
            stop,
            children=[
                n("left", 0, left_end, text="a"),
                n("right", right_start, nlen, text="b"),
            ],
        )

    yield Case("srcgap", "well_formed", source, root(1, 3), well_formed=True)
    yield Case("srcgap", "reversed", source, root(3, 1))
    yield Case("srcgap", "end_past", source, root(nlen + 10, 3))
    yield Case("srcgap", "start_past", source, root(1, nlen + 3))
    yield Case("srcgap", "both_past", source, root(nlen + 3, nlen + 8))
    yield Case("srcgap", "empty_mid", source, root(2, 2))
    yield Case("srcgap", "empty_len", source, root(nlen, nlen))
    # from in-bounds, to past, remaining bytes are whitespace: JS clamps and
    # emits the spaces, Rust's get returns None.
    ws = "a  "
    yield Case(
        "srcgap",
        "to_past_whitespace",
        ws,
        n(
            "srcgap_root",
            0,
            nbytes(ws),
            children=[
                n("left", 0, 1, text="a"),
                n("right", nbytes(ws) + 5, nbytes(ws) + 6, text="b"),
            ],
        ),
    )
    # Parent-start → first child (no previous item).
    yield Case(
        "srcgap",
        "open_reversed",
        source,
        n(
            "srcgap_open",
            3,
            1,
            children=[n("word", 0, 1, text="a")],
        ),
    )
    yield Case(
        "srcgap",
        "open_end_past",
        source,
        n(
            "srcgap_open",
            0,
            nlen,
            children=[n("word", nlen + 5, nlen + 6, text="a")],
        ),
    )
    yield Case(
        "srcgap",
        "close_end_past",
        source,
        n(
            "srcgap_close",
            0,
            nlen + 10,
            children=[n("word", 0, 1, text="a")],
        ),
    )
    u = UTF8
    un = nbytes(u)
    yield Case(
        "srcgap",
        "utf8_split_gap",
        u,
        n(
            "srcgap_root",
            0,
            un,
            children=[
                n("left", 0, 1, text="x"),
                n("right", 2, un, text="y"),
            ],
        ),
    )
    yield Case(
        "srcgap",
        "crlf_gap",
        CRLF,
        n(
            "srcgap_root",
            0,
            nbytes(CRLF),
            children=[
                n("left", 0, 1, text="a"),
                n("right", 3, nbytes(CRLF), text="b"),
            ],
        ),
        well_formed=True,
    )
    yield Case(
        "srcgap",
        "cr_gap",
        CR,
        n(
            "srcgap_root",
            0,
            nbytes(CR),
            children=[
                n("left", 0, 1, text="a"),
                n("right", 2, nbytes(CR), text="b"),
            ],
        ),
        well_formed=True,
    )
    yield Case(
        "srcgap",
        "vertical_tab",
        VT,
        n(
            "srcgap_root",
            0,
            nbytes(VT),
            children=[
                n("left", 0, 1, text="a"),
                n("right", 2, nbytes(VT), text="b"),
            ],
        ),
    )


def multiline_cases() -> Iterator[Case]:
    """Site 7: already clamps end. Regression check."""
    source = "a\nb"
    nlen = nbytes(source)
    kids = [
        n("word", 0, 1, text="a"),
        n("word", 2, 3, text="b"),
    ]

    def root(start: Any, end: Any) -> dict:
        return n("multi_root", start, end, children=kids)

    yield Case("source-multiline", "well_formed_broken", source, root(0, nlen), well_formed=True)
    yield Case(
        "source-multiline",
        "well_formed_flat",
        "a b",
        n(
            "multi_root",
            0,
            3,
            children=[n("word", 0, 1, text="a"), n("word", 2, 3, text="b")],
        ),
        well_formed=True,
    )
    yield Case("source-multiline", "reversed", source, root(4, 2))
    yield Case("source-multiline", "end_past", source, root(0, nlen + 10))
    yield Case("source-multiline", "start_past", source, root(nlen + 3, 2))
    yield Case("source-multiline", "both_past", source, root(nlen + 3, nlen + 8))
    yield Case("source-multiline", "empty_0", source, root(0, 0))
    yield Case("source-multiline", "empty_len", source, root(nlen, nlen))
    u = UTF8
    yield Case(
        "source-multiline",
        "utf8_split",
        u,
        n(
            "multi_root",
            0,
            2,
            children=[n("word", 0, 1, text="x"), n("word", 3, 4, text="y")],
        ),
    )
    yield Case(
        "source-multiline",
        "crlf",
        CRLF,
        n(
            "multi_root",
            0,
            nbytes(CRLF),
            children=[
                n("word", 0, 1, text="a"),
                n("word", 3, nbytes(CRLF), text="b"),
            ],
        ),
        well_formed=True,
    )
    yield Case(
        "source-multiline",
        "cr",
        CR,
        n(
            "multi_root",
            0,
            nbytes(CR),
            children=[
                n("word", 0, 1, text="a"),
                n("word", 2, nbytes(CR), text="b"),
            ],
        ),
        well_formed=True,
    )


def comment_cases() -> Iterator[Case]:
    """Sites 8–9: comment without `text` is sliced; Rust swallows errors as ""."""
    source = ASCII
    nlen = nbytes(source)
    host = n("word", 0, nlen, text=source)

    def root(start: Any, end: Any) -> dict:
        return n(
            "comment_root",
            0,
            nlen,
            children=[n("comment", start, end), host],
        )

    yield Case("comment_text", "well_formed", source, root(0, 2), well_formed=True)
    yield Case("comment_text", "reversed", source, root(4, 2))
    yield Case("comment_text", "end_past", source, root(0, nlen + 10))
    yield Case("comment_text", "start_past", source, root(nlen + 3, 2))
    yield Case("comment_text", "both_past", source, root(nlen + 3, nlen + 8))
    yield Case("comment_text", "empty_0", source, root(0, 0))
    yield Case("comment_text", "empty_mid", source, root(2, 2))
    yield Case("comment_text", "empty_len", source, root(nlen, nlen))
    yield Case("comment_text", "empty_past", source, root(nlen + 1, nlen + 1))
    # Trailing newline stripping: Rust clamps end then peels CR/LF; JS does not
    # clamp, so a past-end range keeps the terminator.
    nl = "x\n"
    yield Case(
        "comment_text",
        "end_past_trailing_nl",
        nl,
        n(
            "comment_root",
            0,
            nbytes(nl),
            children=[
                n("comment", 0, 50),
                n("word", 0, 1, text="x"),
            ],
        ),
    )
    cr = "x\r"
    yield Case(
        "comment_text",
        "end_past_trailing_cr",
        cr,
        n(
            "comment_root",
            0,
            nbytes(cr),
            children=[
                n("comment", 0, 50),
                n("word", 0, 1, text="x"),
            ],
        ),
    )
    u = UTF8
    un = nbytes(u)
    yield Case(
        "comment_text",
        "utf8_split_first_edge",
        u,
        n(
            "comment_root",
            0,
            un,
            children=[n("comment", 0, 2), n("word", 3, un, text="y")],
        ),
    )
    yield Case(
        "comment_text",
        "utf8_split_second_edge",
        u,
        n(
            "comment_root",
            0,
            un,
            children=[n("comment", 2, un), n("word", 0, 1, text="x")],
        ),
    )
    p = UTF8_PAIR
    yield Case(
        "comment_text",
        "utf8_split_both_edges",
        p,
        n(
            "comment_root",
            0,
            nbytes(p),
            children=[
                n("comment", 1, 3),
                n("word", 0, 1, text="x"),
            ],
        ),
    )
    crlf_n = nbytes(CRLF)
    yield Case(
        "comment_text",
        "crlf_body",
        CRLF,
        n(
            "comment_root",
            0,
            crlf_n,
            children=[
                n("comment", 0, crlf_n),
                n("word", 0, 1, text="a"),
            ],
        ),
    )
    cr_n = nbytes(CR)
    yield Case(
        "comment_text",
        "cr_body",
        CR,
        n(
            "comment_root",
            0,
            cr_n,
            children=[
                n("comment", 0, cr_n),
                n("word", 0, 1, text="a"),
            ],
        ),
    )


def newlines_cases() -> Iterator[Case]:
    """Sites 10–12: content_end / deep_end / newlines. Already clamp."""
    source = BLANK
    nlen = nbytes(source)

    def blank_root(first_end: Any, second_start: Any = 3) -> dict:
        return n(
            "blank_root",
            0,
            nlen,
            children=[
                n("word", 0, first_end, text="a"),
                n("word", second_start, nlen, text="b"),
            ],
        )

    yield Case("newlines", "well_formed", source, blank_root(1), well_formed=True)
    yield Case("newlines", "reversed_gap", source, blank_root(3, 1))
    yield Case("newlines", "end_past", source, blank_root(nlen + 10))
    yield Case("newlines", "start_past", source, blank_root(1, nlen + 3))
    yield Case("newlines", "both_past", source, blank_root(nlen + 3, nlen + 8))
    yield Case("newlines", "empty_len", source, blank_root(nlen, nlen))
    yield Case(
        "newlines",
        "crlf_gap",
        CRLF,
        n(
            "blank_root",
            0,
            nbytes(CRLF),
            children=[
                n("word", 0, 1, text="a"),
                n("word", 3, nbytes(CRLF), text="b"),
            ],
        ),
        well_formed=True,
    )
    yield Case(
        "newlines",
        "cr_gap",
        CR,
        n(
            "blank_root",
            0,
            nbytes(CR),
            children=[
                n("word", 0, 1, text="a"),
                n("word", 2, nbytes(CR), text="b"),
            ],
        ),
        well_formed=True,
    )

    def owned(first_end: Any) -> dict:
        return n(
            "owned",
            0,
            nlen,
            children=[
                n(
                    "item",
                    0,
                    first_end,
                    children=[n("word", 0, first_end, text="a")],
                ),
                n(
                    "item",
                    3,
                    nlen,
                    children=[n("word", 3, nlen, text="b")],
                ),
            ],
        )

    yield Case("deep_end", "well_formed", source, owned(1), well_formed=True)
    yield Case("deep_end", "end_past", source, owned(nlen + 10))
    yield Case("deep_end", "reversed", source, owned(0))  # empty deepest leaf


def partition_cases() -> Iterator[Case]:
    """Site 13: source_partitions walks child ranges at node entry."""
    source = "alpha beta gamma"
    nlen = nbytes(source)

    def atom(start: int, end: int, text: str) -> dict:
        return n(
            "prose_atom",
            start,
            end,
            children=[n("word", start, end, text=text)],
        )

    def gap(start: int, end: int, text: str = " ") -> dict:
        return n("prose_gap", start, end, text=text)

    def run(*children: dict, start: int = 0, end: int | None = None) -> dict:
        stop = nlen if end is None else end
        return n("prose_run", start, stop, children=list(children))

    def case(name: str, root: dict, src: str = source, *, well_formed: bool = False) -> Case:
        return Case(
            "partition",
            name,
            src,
            root,
            language="prose",
            well_formed=well_formed,
        )

    yield case(
        "well_formed",
        run(
            atom(0, 5, "alpha"),
            gap(5, 6),
            atom(6, 10, "beta"),
            gap(10, 11),
            atom(11, 16, "gamma"),
        ),
        well_formed=True,
    )
    yield case(
        "leading_gap",
        run(
            atom(6, 10, "beta"),
            gap(10, 11),
            atom(11, 16, "gamma"),
        ),
    )
    yield case(
        "interior_gap",
        run(
            atom(0, 5, "alpha"),
            gap(5, 6),
            atom(11, 16, "gamma"),
        ),
    )
    yield case(
        "trailing_gap",
        run(
            atom(0, 5, "alpha"),
            gap(5, 6),
            atom(6, 10, "beta"),
            gap(10, 11),
        ),
    )
    yield case(
        "zero_width",
        run(
            atom(0, 5, "alpha"),
            gap(5, 5, ""),
            gap(5, 6),
            atom(6, 10, "beta"),
            gap(10, 11),
            atom(11, 16, "gamma"),
        ),
    )
    yield case("childless_nonempty", run())
    yield case(
        "childless_empty",
        n("prose_run", 0, 0, children=[]),
        "",
        well_formed=True,
    )
    yield case(
        "child_past_parent",
        run(atom(0, nlen, source), end=10),
    )


def loader_cases() -> Iterator[Case]:
    """JSON start/end that Rust usize rejects and JS ToInteger / subarray accept."""
    source = ASCII
    nlen = nbytes(source)
    payload = n("word", 0, nlen, text=source)

    def prefix_root(start: Any, end: Any) -> dict:
        return n(
            "prefix_root",
            0,
            nlen,
            children=[n("marker", start, end), payload],
        )

    yield Case("loader", "negative_start", source, prefix_root(-1, 2))
    yield Case("loader", "negative_end", source, prefix_root(0, -1))
    yield Case("loader", "negative_both", source, prefix_root(-2, -1))
    yield Case("loader", "float_start", source, prefix_root(1.5, 3))
    yield Case("loader", "float_end", source, prefix_root(0, 2.9))
    yield Case("loader", "null_start", source, prefix_root(None, 2))
    yield Case("loader", "true_start", source, prefix_root(True, 2))
    missing = n(
        "prefix_root",
        0,
        nlen,
        children=[{"type": "marker", "end": 2}, payload],
    )
    yield Case("loader", "missing_start", source, missing)
    missing_end = n(
        "prefix_root",
        0,
        nlen,
        children=[{"type": "marker", "start": 0}, payload],
    )
    yield Case("loader", "missing_end", source, missing_end)
    yield Case("loader", "string_start", source, prefix_root("0", 2))
    # 2**64 does not fit usize; JS stores it as a float.
    yield Case("loader", "u64_overflow", source, prefix_root(2**64, 2**64 + 1))
    verbatim_neg = n("verbatim_root", -1, nlen)
    yield Case("loader", "verbatim_negative_start", source, verbatim_neg)


def shipped_cases() -> Iterator[Case]:
    """The same class through packages that already ship, not a toy language."""
    u = UTF8
    un = nbytes(u)
    yield Case(
        "slice",
        "shipped_json_utf8_split",
        u,
        n("string", 0, 2),
        language="json",
        shipped=True,
    )
    yield Case(
        "slice",
        "shipped_json_reversed",
        ASCII,
        n("string", 4, 2),
        language="json",
        shipped=True,
    )
    # markdown fenced_code_block else-branch is prefix of t:block_continuation.
    source = ASCII
    nlen = nbytes(source)
    fence = n(
        "fenced_code_block",
        0,
        nlen,
        children=[
            n("fenced_code_block_delimiter", 0, 1, text="`"),
            n("block_continuation", 4, 2),
            n("fenced_code_block_delimiter", nlen - 1, nlen, text="`"),
        ],
    )
    yield Case(
        "prefix",
        "shipped_markdown_reversed",
        source,
        n("document", 0, nlen, children=[fence]),
        language="markdown",
        shipped=True,
    )
    u_fence = n(
        "fenced_code_block",
        0,
        un,
        children=[
            n("fenced_code_block_delimiter", 0, 1, text="`"),
            n("block_continuation", 0, 2),
            n("fenced_code_block_delimiter", un - 1, un, text="y"),
        ],
    )
    yield Case(
        "prefix",
        "shipped_markdown_utf8_split",
        u,
        n("document", 0, un, children=[u_fence]),
        language="markdown",
        shipped=True,
    )


def all_cases() -> list[Case]:
    out: list[Case] = []
    for gen in (
        prefix_cases,
        slice_cases,
        srcgap_cases,
        multiline_cases,
        comment_cases,
        newlines_cases,
        partition_cases,
        loader_cases,
        shipped_cases,
    ):
        out.extend(gen())
    return out


# --------------------------------------------------------------------------
# running


def tree_doc(case: Case) -> dict:
    return {
        "language": case.language,
        "source": case.source,
        "root": case.root,
    }


def preview_run(run: Run) -> str:
    if run.error:
        return run.error
    if run.rc == 0:
        text = run.stdout.decode("utf-8", "replace")
        shown = text.replace("\n", "\\n")
        if len(shown) > 80:
            shown = shown[:77] + "..."
        return f"emit {len(run.stdout)} B {shown!r}"
    msg = run.stderr.replace("\n", " ")
    if len(msg) > 100:
        msg = msg[:97] + "..."
    return f"refuse({run.rc}) {msg}"


def preview_range(root: dict) -> str:
    """The first interesting start/end pair, for the BREAK table."""
    kind = root.get("type")
    kids = root.get("children") or []
    if kind == "srcgap_root" and len(kids) >= 2:
        return (
            f"gap {kids[0].get('type')}.end={kids[0].get('end')!r} .. "
            f"{kids[1].get('type')}.start={kids[1].get('start')!r}"
        )
    if kind in {"srcgap_open", "srcgap_close", "multi_root", "prose_run"}:
        return f"{kind} start={root.get('start')!r} end={root.get('end')!r}"
    stack = [root]
    while stack:
        node = stack.pop(0)
        node_kind = node.get("type")
        if node_kind in {
            "marker",
            "comment",
            "block_continuation",
            "verbatim_root",
            "string",
        }:
            return f"{node_kind} start={node.get('start')!r} end={node.get('end')!r}"
        stack.extend(node.get("children") or [])
    return f"{kind} start={root.get('start')!r} end={root.get('end')!r}"


def write_tree(directory: Path, case: Case, index: int) -> Path:
    path = directory / f"{index:03d}__{case.site}__{case.name}.tree.json"
    path.write_text(json.dumps(tree_doc(case), ensure_ascii=False), encoding="utf-8")
    return path


def run_case(
    case: Case,
    tree: Path,
    rust_exe: Path,
    js_exe: Path,
    toy_packages: Path,
) -> Result:
    packages = None if case.shipped else toy_packages
    rust = invoke(rust_exe, tree, WIDTH, packages)
    js = invoke(js_exe, tree, WIDTH, packages)
    return Result(
        case=case,
        rust=rust,
        js=js,
        klass=classify(rust, js),
        tree=tree_doc(case),
    )


def print_break(result: Result) -> None:
    case = result.case
    print(f"  {case.site}/{case.name}")
    print(f"    source: {case.source!r} ({nbytes(case.source)} bytes)")
    print(f"    range:  {preview_range(case.root)}")
    print(f"    rust:   {preview_run(result.rust)}")
    print(f"    js:     {preview_run(result.js)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "submission",
        nargs="?",
        default=str(ROOT),
        help="directory holding fmt-rust and fmt-js (default: repo root)",
    )
    ap.add_argument("--json", action="store_true", help="machine-readable summary")
    ap.add_argument("--verbose", action="store_true", help="print every case, not only BREAK")
    ap.add_argument("--site", help="run one site (prefix, slice, srcgap, ...)")
    args = ap.parse_args()

    submission = Path(args.submission).resolve()
    rust_exe = submission / "fmt-rust"
    js_exe = submission / "fmt-js"
    if not rust_exe.is_file() or not js_exe.is_file():
        print(f"no fmt-rust/fmt-js in {submission}", file=sys.stderr)
        return 2

    cases = all_cases()
    if args.site:
        cases = [c for c in cases if c.site == args.site]
        if not cases:
            known = sorted({c.site for c in all_cases()})
            print(f"unknown site {args.site!r}; have {', '.join(known)}", file=sys.stderr)
            return 2

    results: list[Result] = []
    with tempfile.TemporaryDirectory(prefix="parity-fuzz-") as tmp:
        tmp_path = Path(tmp)
        packages = tmp_path / "packages"
        packages.mkdir()
        (packages / "toy.json").write_text(json.dumps(TOY), encoding="utf-8")
        (packages / "prose.json").write_text(json.dumps(PROSE), encoding="utf-8")
        trees = tmp_path / "trees"
        trees.mkdir()
        for i, case in enumerate(cases):
            path = write_tree(trees, case, i)
            results.append(run_case(case, path, rust_exe, js_exe, packages))

    counts = {"BREAK": 0, "SOFT": 0, "COSMETIC": 0, "MATCH": 0}
    for result in results:
        counts[result.klass] += 1

    sanity_fail = [
        r
        for r in results
        if r.case.well_formed and not (r.klass == "MATCH" and r.rust.rc == 0)
    ]

    breaks = [r for r in results if r.klass == "BREAK"]
    softs = [r for r in results if r.klass == "SOFT"]
    cosmetics = [r for r in results if r.klass == "COSMETIC"]

    if args.json:
        payload = {
            "cases": len(results),
            "counts": counts,
            "sanity_fail": [f"{r.case.site}/{r.case.name}" for r in sanity_fail],
            "break": [
                {
                    "id": f"{r.case.site}/{r.case.name}",
                    "source": r.case.source,
                    "range": preview_range(r.case.root),
                    "rust": preview_run(r.rust),
                    "js": preview_run(r.js),
                    "tree": r.tree,
                }
                for r in breaks
            ],
            "soft": [
                {
                    "id": f"{r.case.site}/{r.case.name}",
                    "rust": preview_run(r.rust),
                    "js": preview_run(r.js),
                }
                for r in softs
            ],
            "cosmetic": len(cosmetics),
        }
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        status = "FAIL" if breaks or sanity_fail else "PASS"
        print(
            f"[{status}] parity-fuzz  "
            f"{counts['BREAK']} BREAK  {counts['SOFT']} SOFT  "
            f"{counts['COSMETIC']} COSMETIC  {counts['MATCH']} MATCH  "
            f"({len(results)} cases)"
        )
        if sanity_fail:
            print("SANITY (well-formed driver did not MATCH-emit; fuzzer bug)")
            for result in sanity_fail:
                print_break(result)
        if breaks:
            print("BREAK")
            for result in breaks:
                print_break(result)
        if softs:
            print("SOFT")
            for result in softs:
                print_break(result)
        if cosmetics:
            print(
                f"COSMETIC: {len(cosmetics)} cases, same exit, different message text "
                "(not a parity defect)"
            )
            if args.verbose:
                for result in cosmetics:
                    print_break(result)
        if args.verbose:
            print("ALL")
            for result in results:
                case = result.case
                print(
                    f"  {result.klass:8} {case.site}/{case.name}  "
                    f"rust={preview_run(result.rust)}  js={preview_run(result.js)}"
                )

    if sanity_fail:
        return 2
    return 1 if breaks else 0


if __name__ == "__main__":
    sys.exit(main())
