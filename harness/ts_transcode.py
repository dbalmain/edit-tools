#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Transcode a tree-sitter generated `parser.c` into a data-only JSON blob.

    ./harness/ts_transcode.py <path/to/parser.c> -o <blob.json>

This is the offline half of route C3 in `docs/parse-layer.md`: take the tables
tree-sitter's own generator emitted, convert them to data, and interpret that
data in both runtimes. Nothing here ships; the blob is the artifact.

The interesting half is `ts_lex`. tree-sitter emits it as a switch-based DFA in
C rather than as a table, so it has to be *recovered*. Each `case N:` is a lexer
state and its body is an ordered sequence of guarded transitions. Every guard is
a boolean expression over the single variable `lookahead` (an int32 codepoint,
0 at EOF, -1 on a UTF-8 decode error), so it can be evaluated symbolically into
a set of int32 intervals -- which is data, and which is exactly as expressive as
the C was.

Unrecognised syntax raises. A silently dropped arm is a lexer that is subtly
wrong on exactly the inputs the corpus does not contain, so there is no
skip-and-continue path anywhere in this file.

The construct set the generator can emit into `ts_lex` is closed and is
enumerated in `docs/parse-survey.md` §3, read out of `render.rs`. Every one of
those shapes is handled below, including the `(!eof && ...)` guard that does not
occur in either grammar this spike parses.

Recovered lexer states are ordered op lists, mirrored by `harness/ts_lr.mjs`:

    [0, sym]                             ACCEPT_TOKEN(sym)
    [1, [char, target, ...]]             ADVANCE_MAP(...)
    [2, eofMode, ranges, act, target]    if (<cond>) <action>
    [3, act, target]                     unconditional <action>
    [4, ranges, eofRanges, act, target]  if (<cond>) <action>, eof-split

`ranges` is a flat inclusive [lo, hi, ...] over int32 -- the domain of
`lookahead`, which is 0 at EOF and -1 on a UTF-8 decode error, so the full int32
line is the honest domain and complements are taken over it. `act` is 0 ADVANCE
/ 1 SKIP / 2 END_STATE / 3 ACCEPT_TOKEN.

A guard is a predicate over (`eof`, `lookahead`), and `eof` is a boolean the
lexer recomputes at every transition, so the general form is *two* interval
sets: one that applies at EOF and one that does not. Op 4 carries both. Op 2 is
the collapsed form for the three cases that cover all but two lex states in the
sixteen pinned grammars, with `eofMode` 0 (both sets equal) / 1 (require eof) /
2 (require !eof).

Note the conditions are recovered as *branch predicates*, not as token character
sets. That sidesteps the is-included flip described in `parse-survey.md` §3d: a
positive character set containing char::MAX is emitted negated, and a recoverer
that reads `&&`-joined `!=` atoms as exclusions inverts every such state.
Evaluating the C expression symbolically cannot make that mistake.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

INT32_MIN = -(2**31)
INT32_MAX = 2**31 - 1


class Unrecognised(Exception):
    """A construct this transcoder does not model. Never swallowed."""


# ---------------------------------------------------------------------------
# C source utilities
# ---------------------------------------------------------------------------


def strip_comments(src: str) -> str:
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            if j < 0:
                raise Unrecognised("unterminated block comment")
            out.append(" " * (j + 2 - i))
            i = j + 2
        elif c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif c in "'\"":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            out.append(src[i : j + 1])
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def brace_body(src: str, start: int) -> tuple[str, int]:
    """Text between the `{` at/after `start` and its matching `}`."""
    i = src.index("{", start)
    depth = 0
    j = i
    n = len(src)
    while j < n:
        c = src[j]
        if c in "'\"":
            k = j + 1
            while k < n and src[k] != c:
                k += 2 if src[k] == "\\" else 1
            j = k + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[i + 1 : j], j + 1
        j += 1
    raise Unrecognised("unbalanced braces")


def find_decl(src: str, pattern: str) -> str | None:
    m = re.search(pattern, src)
    if not m:
        return None
    body, _ = brace_body(src, m.end() - 1)
    return body


def split_items(text: str) -> list[str]:
    """Split on commas at nesting depth zero."""
    items, buf, depth = [], [], 0
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            buf.append(text[i : j + 1])
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            items.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        items.append(tail)
    return [x.strip() for x in items if x.strip()]


DESIGNATOR = re.compile(r"^\[\s*(.*?)\s*\]\s*=\s*(.*)$", re.S)


def designated(items: list[str]) -> list[tuple[str | None, str]]:
    out = []
    for item in items:
        m = DESIGNATOR.match(item)
        if m:
            out.append((m.group(1), m.group(2).strip()))
        else:
            out.append((None, item))
    return out


CHAR_ESCAPES = {
    "n": 10, "r": 13, "t": 9, "v": 11, "f": 12, "b": 8, "a": 7, "0": 0,
    "\\": 92, "'": 39, '"': 34, "?": 63,
}


def char_literal(text: str) -> int:
    body = text[1:-1]
    if not body.startswith("\\"):
        if len(body) != 1:
            # tree-sitter emits multi-byte chars as hex, so this is unexpected.
            raise Unrecognised(f"multi-character literal {text!r}")
        return ord(body)
    esc = body[1:]
    if esc[:1] in ("x", "u", "U"):
        return int(esc[1:], 16)
    if esc in CHAR_ESCAPES:
        return CHAR_ESCAPES[esc]
    if re.fullmatch(r"[0-7]{1,3}", esc):
        return int(esc, 8)
    raise Unrecognised(f"escape {text!r}")


def c_string(text: str) -> str:
    """Decode a C string literal. JSON's escape set is not C's (`\\'`, `\\v`)."""
    if not (text.startswith('"') and text.endswith('"')):
        raise Unrecognised(f"string literal {text!r}")
    body, out, i, n = text[1:-1], [], 0, len(text) - 2
    while i < n:
        c = body[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        esc = body[i + 1]
        if esc in ("x", "u", "U"):
            width = {"x": 2, "u": 4, "U": 8}[esc]
            out.append(chr(int(body[i + 2 : i + 2 + width], 16)))
            i += 2 + width
        elif esc in CHAR_ESCAPES:
            out.append(chr(CHAR_ESCAPES[esc]))
            i += 2
        else:
            raise Unrecognised(f"string escape \\{esc} in {text!r}")
    # These become `const char *`, and C strings end at the first NUL. So
    # `"\0"` -- which is what tree-sitter-go calls its EOF terminator token --
    # is the *empty* name, not a one-character one. Found by differential
    # testing against real tree-sitter; no corpus file reaches it, because it
    # only appears on a Go file with no trailing newline.
    text = "".join(out)
    return text.split("\0", 1)[0]


class Symbols:
    def __init__(self, src: str):
        m = re.search(r"^#define LARGE_STATE_COUNT (\d+)$", src, re.M)
        self.large_state_count = int(m.group(1)) if m else 0
        self.sym: dict[str, int] = {"ts_builtin_sym_end": 0}
        body = find_decl(src, r"enum ts_symbol_identifiers\s*\{")
        if body is None:
            raise Unrecognised("no ts_symbol_identifiers enum")
        for item in split_items(body):
            name, _, val = item.partition("=")
            self.sym[name.strip()] = int(val.strip())
        self.field: dict[str, int] = {}
        fbody = find_decl(src, r"enum ts_field_identifiers\s*\{")
        if fbody is not None:
            for item in split_items(fbody):
                name, _, val = item.partition("=")
                self.field[name.strip()] = int(val.strip())

    def value(self, text: str) -> int:
        """Evaluate a scalar initializer/designator expression to an int."""
        t = text.strip()
        m = re.fullmatch(r"(ACTIONS|STATE|SMALL_STATE)\s*\(\s*(.*?)\s*\)", t, re.S)
        if m:
            v = self.value(m.group(2))
            # SMALL_STATE(id) is `(id) - LARGE_STATE_COUNT`.
            return v - self.large_state_count if m.group(1) == "SMALL_STATE" else v
        if t.startswith("'"):
            return char_literal(t)
        if re.fullmatch(r"-?0[xX][0-9a-fA-F]+", t):
            return int(t, 16)
        if re.fullmatch(r"-?\d+", t):
            return int(t)
        if t in self.sym:
            return self.sym[t]
        if t in self.field:
            return self.field[t]
        if t == "NULL":
            return 0
        raise Unrecognised(f"scalar {text!r}")


# ---------------------------------------------------------------------------
# Interval sets over int32 (the domain of `lookahead`)
# ---------------------------------------------------------------------------


def norm(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    rs = sorted(r for r in ranges if r[0] <= r[1])
    out: list[tuple[int, int]] = []
    for lo, hi in rs:
        if out and lo <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return out


def complement(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out, cur = [], INT32_MIN
    for lo, hi in norm(ranges):
        if lo > cur:
            out.append((cur, lo - 1))
        cur = max(cur, hi + 1)
    if cur <= INT32_MAX:
        out.append((cur, INT32_MAX))
    return out


def union(a, b):
    return norm(list(a) + list(b))


def intersect(a, b):
    out = []
    for lo1, hi1 in a:
        for lo2, hi2 in b:
            lo, hi = max(lo1, lo2), min(hi1, hi2)
            if lo <= hi:
                out.append((lo, hi))
    return norm(out)


ALL = [(INT32_MIN, INT32_MAX)]


# ---------------------------------------------------------------------------
# ts_lex recovery
# ---------------------------------------------------------------------------

TOKEN_RE = re.compile(
    r"""
      (?P<ws>\s+)
    | (?P<char>'(?:\\.|[^'\\])*')
    | (?P<num>0[xX][0-9a-fA-F]+|\d+)
    | (?P<id>[A-Za-z_]\w*)
    | (?P<op><=|>=|==|!=|&&|\|\||->|[<>();,{}:=!&|\[\]+\-*/])
    """,
    re.X,
)


def tokenize(text: str) -> list[tuple[str, str]]:
    toks, i, n = [], 0, len(text)
    while i < n:
        m = TOKEN_RE.match(text, i)
        if not m:
            raise Unrecognised(f"token at {text[i:i + 40]!r}")
        i = m.end()
        kind = m.lastgroup
        if kind == "ws":
            continue
        toks.append((kind, m.group()))
    return toks


class LexParser:
    """Recursive-descent parser for the body of a generated `ts_lex`."""

    def __init__(self, toks: list[tuple[str, str]], syms: Symbols, charsets: dict):
        self.t = toks
        self.i = 0
        self.syms = syms
        self.charsets = charsets

    # -- token helpers ------------------------------------------------------
    def peek(self, k: int = 0):
        j = self.i + k
        return self.t[j] if j < len(self.t) else ("eof", "")

    def next(self):
        tok = self.peek()
        self.i += 1
        return tok

    def expect(self, val: str):
        kind, got = self.next()
        if got != val:
            raise Unrecognised(f"expected {val!r}, got {got!r} near {self.context()}")

    def at(self, val: str) -> bool:
        return self.peek()[1] == val

    def context(self) -> str:
        return " ".join(v for _, v in self.t[max(0, self.i - 6) : self.i + 6])

    # -- grammar ------------------------------------------------------------
    def parse(self) -> dict[int, dict]:
        # START_LEXER(); eof = lexer->eof(lexer); switch (state) { ... }
        self.expect("START_LEXER")
        self.expect("(")
        self.expect(")")
        self.expect(";")
        # `eof = lexer->eof(lexer);` -- consume up to and including the `;`.
        for word in ("eof", "=", "lexer", "->", "eof", "(", "lexer", ")", ";"):
            self.expect(word)
        self.expect("switch")
        self.expect("(")
        self.expect("state")
        self.expect(")")
        self.expect("{")

        states: dict[int, dict] = {}
        while True:
            if self.at("case"):
                self.next()
                num = self.syms.value(self.next()[1])
                self.expect(":")
                states[num] = self.parse_state_body()
            elif self.at("default"):
                self.next()
                self.expect(":")
                self.expect("return")
                self.expect("false")
                self.expect(";")
                break
            else:
                raise Unrecognised(f"switch body near {self.context()}")
        self.expect("}")
        return states

    def parse_state_body(self) -> dict:
        ops: list[list] = []
        while True:
            if self.at("END_STATE"):
                self.next()
                self.expect("(")
                self.expect(")")
                self.expect(";")
                return {"o": ops}
            if self.at("case") or self.at("default"):
                raise Unrecognised("case fell through without END_STATE()")
            ops.append(self.parse_statement())

    def parse_statement(self) -> list:
        if self.at("if"):
            self.next()
            self.expect("(")
            cond = self.parse_or()
            self.expect(")")
            act = self.parse_action()
            return cond.emit(act[0], act[1])
        return self.parse_action_stmt()

    def parse_action_stmt(self) -> list:
        if self.at("ACCEPT_TOKEN"):
            self.next()
            self.expect("(")
            sym = self.syms.value(self.next()[1])
            self.expect(")")
            self.expect(";")
            return [0, sym]
        if self.at("ADVANCE_MAP"):
            self.next()
            self.expect("(")
            pairs: list[int] = []
            while not self.at(")"):
                pairs.append(self.syms.value(self.next()[1]))
                if self.at(","):
                    self.next()
            self.expect(")")
            self.expect(";")
            if len(pairs) % 2:
                raise Unrecognised("odd ADVANCE_MAP")
            # `ADVANCE_MAP` expands to `static const uint16_t map[]`, so a key
            # above 0xffff would be truncated by the C compiler. Nothing emits
            # one today; find out rather than silently disagree with C.
            for k in pairs[0::2]:
                if not 0 <= k <= 0xFFFF:
                    raise Unrecognised(f"ADVANCE_MAP key {k} does not fit uint16")
            return [1, pairs]
        act = self.parse_action()
        return [3, *act]

    def parse_action(self) -> list:
        kind, name = self.next()
        if name in ("ADVANCE", "SKIP"):
            self.expect("(")
            target = self.syms.value(self.next()[1])
            self.expect(")")
            self.expect(";")
            return [0 if name == "ADVANCE" else 1, target]
        if name == "END_STATE":
            self.expect("(")
            self.expect(")")
            self.expect(";")
            return [2, 0]
        if name == "ACCEPT_TOKEN":
            self.expect("(")
            sym = self.syms.value(self.next()[1])
            self.expect(")")
            self.expect(";")
            return [3, sym]
        if name == "ADVANCE_MAP":
            raise Unrecognised("guarded ADVANCE_MAP is not modelled")
        raise Unrecognised(f"action {name!r} near {self.context()}")

    # -- conditions ---------------------------------------------------------
    # A condition is a `Cond`: an eof requirement plus a set of int32 intervals
    # over `lookahead`. Every atom the generator can emit maps onto one of the
    # two; nothing else is accepted.
    def parse_or(self):
        left = self.parse_and()
        while self.at("||"):
            self.next()
            left = left.union(self.parse_and())
        return left

    def parse_and(self):
        left = self.parse_cmp()
        while self.at("&&"):
            self.next()
            left = left.intersect(self.parse_cmp())
        return left

    def parse_cmp(self):
        if self.at("("):
            self.next()
            inner = self.parse_or()
            self.expect(")")
            return inner
        if self.at("!"):
            # Only `!eof` exists; negating a character condition would need a
            # different representation and the generator never emits one.
            self.next()
            if not self.at("eof"):
                raise Unrecognised(f"negation of non-eof near {self.context()}")
            self.next()
            return Cond([], ALL)
        if self.at("eof"):
            self.next()
            return Cond(ALL, [])
        if self.at("set_contains"):
            self.next()
            self.expect("(")
            name = self.next()[1]
            self.expect(",")
            length = int(self.next()[1], 0)
            self.expect(",")
            self.expect("lookahead")
            self.expect(")")
            if name not in self.charsets:
                raise Unrecognised(f"unknown character set {name!r}")
            rs = self.charsets[name]
            if len(rs) != length:
                raise Unrecognised(f"set_contains length {length} != {len(rs)}")
            return ranges_cond(rs)
        if self.at("lookahead"):
            self.next()
            op = self.peek()[1]
            if op in ("==", "!=", "<", "<=", ">", ">="):
                self.next()
                v = self.syms.value(self.next()[1])
                return ranges_cond(cmp_ranges("lookahead", op, v))
            # bare `lookahead` used as a truth value
            return ranges_cond(complement([(0, 0)]))
        kind, text = self.next()
        if kind not in ("num", "char"):
            raise Unrecognised(f"condition operand {text!r} near {self.context()}")
        v = self.syms.value(text)
        op = self.peek()[1]
        if op not in ("==", "!=", "<", "<=", ">", ">="):
            raise Unrecognised(f"expected comparison after {text!r}")
        self.next()
        self.expect("lookahead")
        return ranges_cond(cmp_ranges(v, op, "lookahead"))


# Emitted eof modes for the collapsible cases, mirrored by the JS interpreter.
ANY_EOF, IS_EOF, NOT_EOF = 0, 1, 2


class Cond:
    """A branch predicate over (`eof`, `lookahead`), as two interval sets.

    `eof` is a plain boolean the lexer recomputes at every state transition, so
    any boolean combination of it with `lookahead` comparisons is exactly a pair
    of interval sets: which lookaheads pass when eof holds, and which pass when
    it does not. Modelling it as one set plus a flag cannot represent
    `(!eof && lookahead == 0) || lookahead == '\n'`, which is what
    tree-sitter-python 0.25.0 emits in two of its lex states.
    """

    __slots__ = ("e", "n")

    def __init__(self, at_eof, not_at_eof):
        self.e = at_eof
        self.n = not_at_eof

    def intersect(self, other):
        return Cond(intersect(self.e, other.e), intersect(self.n, other.n))

    def union(self, other):
        return Cond(union(self.e, other.e), union(self.n, other.n))

    def emit(self, act, target):
        """Collapse to `[2, mode, ranges, ...]` when possible, else `[4, ...]`."""
        if self.e == self.n:
            return [2, ANY_EOF, flatten(self.n), act, target]
        if not self.e:
            return [2, NOT_EOF, flatten(self.n), act, target]
        if not self.n:
            return [2, IS_EOF, flatten(self.e), act, target]
        return [4, flatten(self.n), flatten(self.e), act, target]


def ranges_cond(ranges) -> Cond:
    rs = norm(ranges)
    return Cond(rs, rs)


def cmp_ranges(left, op, right) -> list[tuple[int, int]]:
    """`lookahead OP v` or `v OP lookahead` as an interval set."""
    if left == "lookahead":
        v = right
    else:
        v = left
        op = {"<": ">", ">": "<", "<=": ">=", ">=": "<=", "==": "==", "!=": "!="}[op]
    if op == "==":
        return [(v, v)]
    if op == "!=":
        return complement([(v, v)])
    if op == "<":
        return [(INT32_MIN, v - 1)]
    if op == "<=":
        return [(INT32_MIN, v)]
    if op == ">":
        return [(v + 1, INT32_MAX)]
    if op == ">=":
        return [(v, INT32_MAX)]
    raise Unrecognised(f"comparison {op!r}")


def flatten(ranges) -> list[int]:
    out: list[int] = []
    for lo, hi in ranges:
        out.append(lo)
        out.append(hi)
    return out


def parse_charsets(src: str) -> dict[str, list[tuple[int, int]]]:
    sets = {}
    # tree-sitter 0.25 emits `static const TSCharacterRange`; 0.23/0.24 emit it
    # without `const` (haskell, kotlin, typescript, xml among the pins).
    for m in re.finditer(r"static (?:const )?TSCharacterRange (\w+)\[\]\s*=\s*\{", src):
        body, _ = brace_body(src, m.end() - 1)
        rs = []
        for item in split_items(body):
            if not item.startswith("{"):
                raise Unrecognised(f"character range {item!r}")
            lo, hi = split_items(item[1:-1])
            rs.append((_scalar(lo), _scalar(hi)))
        sets[m.group(1)] = rs
    return sets


def _scalar(t: str) -> int:
    t = t.strip()
    if t.startswith("'"):
        return char_literal(t)
    return int(t, 0)


def parse_lex_fn(src: str, name: str, syms: Symbols, charsets: dict):
    m = re.search(r"static bool %s\(TSLexer \*lexer, TSStateId state\)\s*\{" % name, src)
    if not m:
        return None
    body, _ = brace_body(src, m.end() - 1)
    states = LexParser(tokenize(body), syms, charsets).parse()
    top = max(states) + 1
    missing = [i for i in range(top) if i not in states]
    if missing:
        raise Unrecognised(f"{name}: no case for states {missing[:8]}")
    return [states[i] for i in range(top)]


# ---------------------------------------------------------------------------
# Static tables
# ---------------------------------------------------------------------------


def defines(src: str) -> dict[str, int]:
    out = {}
    for m in re.finditer(r"^#define\s+([A-Z_][A-Z0-9_]*)\s+(\S+)\s*$", src, re.M):
        try:
            out[m.group(1)] = int(m.group(2), 0)
        except ValueError:
            pass
    return out


def sequential(body: str, syms: Symbols, size: int | None = None) -> list[int]:
    """A flat array with optional `[i] =` designators."""
    out: dict[int, int] = {}
    idx = 0
    for des, val in designated(split_items(body)):
        if des is not None:
            idx = syms.value(des)
        out[idx] = syms.value(val)
        idx += 1
    top = size if size is not None else (max(out) + 1 if out else 0)
    return [out.get(i, 0) for i in range(top)]


def struct_fields(text: str) -> dict[str, str]:
    if not (text.startswith("{") and text.endswith("}")):
        raise Unrecognised(f"expected struct, got {text!r}")
    out = {}
    for i, item in enumerate(split_items(text[1:-1])):
        if item.startswith("."):
            key, _, val = item.partition("=")
            out[key.strip().lstrip(".")] = val.strip()
        else:
            out[f"@{i}"] = item
    return out


def lex_only(path: Path) -> dict:
    """Recover just the two lexers, ignoring the external-scanner refusal.

    This is the construct-coverage tool: it answers "does this parser.c contain
    a ts_lex construct the recoverer does not model?" for grammars whose tables
    are otherwise out of scope because they have a scanner.
    """
    src = strip_comments(Path(path).read_text())
    syms = Symbols(src)
    charsets = parse_charsets(src)
    lex = parse_lex_fn(src, "ts_lex", syms, charsets)
    keyword_lex = parse_lex_fn(src, "ts_lex_keywords", syms, charsets)
    return {"lex": lex, "keywordLex": keyword_lex}


def transcode(path: Path) -> dict:
    raw = Path(path).read_text()
    src = strip_comments(raw)
    d = defines(src)
    syms = Symbols(src)
    charsets = parse_charsets(src)

    abi = d["LANGUAGE_VERSION"]
    symbol_count = d["SYMBOL_COUNT"]
    alias_count = d["ALIAS_COUNT"]
    token_count = d["TOKEN_COUNT"]
    state_count = d["STATE_COUNT"]
    large_state_count = d["LARGE_STATE_COUNT"]
    production_id_count = d["PRODUCTION_ID_COUNT"]
    field_count = d["FIELD_COUNT"]
    max_alias_len = d["MAX_ALIAS_SEQUENCE_LENGTH"]
    max_reserved = d.get("MAX_RESERVED_WORD_SET_SIZE", 0)
    total_symbols = symbol_count + alias_count

    if d.get("EXTERNAL_TOKEN_COUNT", 0):
        raise Unrecognised("external scanner: out of scope for this spike")

    # symbol names -----------------------------------------------------------
    names = [""] * total_symbols
    body = find_decl(src, r"static const char \* const ts_symbol_names\[\]\s*=\s*\{")
    for des, val in designated(split_items(body)):
        idx = syms.value(des)
        names[idx] = c_string(val) if val.startswith('"') else None
    # metadata ---------------------------------------------------------------
    meta = [0] * total_symbols
    body = find_decl(src, r"static const TSSymbolMetadata ts_symbol_metadata\[\]\s*=\s*\{")
    for des, val in designated(split_items(body)):
        f = struct_fields(val)
        bits = 0
        if f.get("visible") == "true":
            bits |= 1
        if f.get("named") == "true":
            bits |= 2
        if f.get("supertype") == "true":
            bits |= 4
        meta[syms.value(des)] = bits
    # public symbol map ------------------------------------------------------
    body = find_decl(src, r"static const TSSymbol ts_symbol_map\[\]\s*=\s*\{")
    public_map = sequential(body, syms, total_symbols)
    # field names ------------------------------------------------------------
    field_names: list[str | None] = [None] * (field_count + 1)
    body = find_decl(src, r"static const char \* const ts_field_names\[\]\s*=\s*\{")
    if body:
        for des, val in designated(split_items(body)):
            field_names[syms.value(des)] = None if val == "NULL" else c_string(val)
    # field maps -------------------------------------------------------------
    field_slices = [0] * (2 * production_id_count)
    body = find_decl(
        src, r"static const TS(?:Field)?MapSlice ts_field_map_slices\[PRODUCTION_ID_COUNT\]\s*=\s*\{"
    )
    if body:
        for des, val in designated(split_items(body)):
            pid = syms.value(des)
            f = struct_fields(val)
            field_slices[2 * pid] = syms.value(f["index"])
            field_slices[2 * pid + 1] = syms.value(f["length"])
    field_entries: dict[int, list[int]] = {}
    body = find_decl(src, r"static const TSFieldMapEntry ts_field_map_entries\[\]\s*=\s*\{")
    if body:
        idx = 0
        for des, val in designated(split_items(body)):
            if des is not None:
                idx = syms.value(des)
            f = struct_fields(val)
            fid = syms.value(f["@0"])
            child = syms.value(f["@1"])
            inherited = 1 if f.get("inherited") == "true" else 0
            field_entries[idx] = [fid, child, inherited]
            idx += 1
    fe_top = max(field_entries) + 1 if field_entries else 0
    field_entries_flat: list[int] = []
    for i in range(fe_top):
        field_entries_flat.extend(field_entries.get(i, [0, 0, 0]))
    # alias sequences --------------------------------------------------------
    alias_seq = [0] * (production_id_count * max_alias_len)
    body = find_decl(
        src,
        r"static const TSSymbol ts_alias_sequences\[PRODUCTION_ID_COUNT\]\[MAX_ALIAS_SEQUENCE_LENGTH\]\s*=\s*\{",
    )
    if body:
        for des, val in designated(split_items(body)):
            pid = syms.value(des)
            row = sequential(val[1:-1], syms)
            for i, v in enumerate(row):
                alias_seq[pid * max_alias_len + i] = v
    # non-terminal alias map -------------------------------------------------
    body = find_decl(src, r"static const uint16_t ts_non_terminal_alias_map\[\]\s*=\s*\{")
    alias_map = sequential(body, syms) if body else [0]
    # lex modes --------------------------------------------------------------
    lex_states = [0] * state_count
    ext_lex_states = [0] * state_count
    reserved_ids = [0] * state_count
    body = find_decl(
        src, r"static const TSLex(?:er)?Mode ts_lex_modes\[STATE_COUNT\]\s*=\s*\{"
    )
    for des, val in designated(split_items(body)):
        s = syms.value(des)
        f = struct_fields(val)
        for key in f:
            if key not in ("lex_state", "external_lex_state", "reserved_word_set_id"):
                raise Unrecognised(f"lex mode field {key!r}")
        lex_states[s] = syms.value(f.get("lex_state", "0"))
        ext_lex_states[s] = syms.value(f.get("external_lex_state", "0"))
        reserved_ids[s] = syms.value(f.get("reserved_word_set_id", "0"))
    # reserved words ---------------------------------------------------------
    reserved: list[int] = []
    m = re.search(r"static const TSSymbol ts_reserved_words\[(\d+)\]\[MAX_RESERVED_WORD_SET_SIZE\]\s*=\s*\{", src)
    if m:
        set_count = int(m.group(1))
        reserved = [0] * (set_count * max_reserved)
        body, _ = brace_body(src, m.end() - 1)
        for des, val in designated(split_items(body)):
            sid = syms.value(des)
            row = sequential(val[1:-1], syms)
            for i, v in enumerate(row):
                reserved[sid * max_reserved + i] = v
    # parse table ------------------------------------------------------------
    parse_table = [0] * (large_state_count * symbol_count)
    body = find_decl(
        src, r"static const uint16_t ts_parse_table\[LARGE_STATE_COUNT\]\[SYMBOL_COUNT\]\s*=\s*\{"
    )
    for des, val in designated(split_items(body)):
        state = syms.value(des)
        for sdes, sval in designated(split_items(val[1:-1])):
            parse_table[state * symbol_count + syms.value(sdes)] = syms.value(sval)
    # small parse table ------------------------------------------------------
    body = find_decl(src, r"static const uint16_t ts_small_parse_table\[\]\s*=\s*\{")
    small_table = sequential(body, syms) if body else []
    body = find_decl(src, r"static const uint32_t ts_small_parse_table_map\[\]\s*=\s*\{")
    small_map = sequential(body, syms) if body else []
    if len(small_map) != state_count - large_state_count:
        raise Unrecognised("small_parse_table_map size mismatch")
    # parse actions ----------------------------------------------------------
    body = find_decl(src, r"static const TSParseActionEntry ts_parse_actions\[\]\s*=\s*\{")
    entries: dict[int, dict] = {}
    idx = 0
    cur: dict | None = None
    for des, val in designated(split_items(body)):
        if des is not None:
            idx = syms.value(des)
            f = struct_fields(val)
            inner = struct_fields(f["entry"])
            cur = {
                "c": syms.value(inner["count"]),
                "r": 1 if inner["reusable"] == "true" else 0,
                "a": [],
            }
            entries[idx] = cur
            continue
        if cur is None:
            raise Unrecognised("parse action before its entry header")
        cur["a"].append(parse_action_macro(val, syms))
    for i, e in entries.items():
        if len(e["a"]) != e["c"]:
            raise Unrecognised(f"parse action entry {i}: {len(e['a'])} != {e['c']}")
    top = max(entries) + 1 if entries else 0
    actions = [entries.get(i) for i in range(top + 1)]
    # lexers -----------------------------------------------------------------
    # Cross-checks against `ts_wasm_store_load_language`'s sizing rules
    # (parse-survey.md §1c). The corpus cannot exercise these: JSON has two
    # fields and no aliases, so a mis-sized table would still produce
    # byte-identical JSON trees.
    need = 0
    for pid in range(production_id_count):
        need = max(need, field_slices[2 * pid] + field_slices[2 * pid + 1])
    if fe_top < need:
        raise Unrecognised(
            f"field_map_entries has {fe_top} entries, slices reach {need}"
        )
    if max_alias_len > 0 and production_id_count > 0:
        i = 0
        while True:
            if i >= len(alias_map):
                raise Unrecognised("alias_map is not null-terminated")
            if alias_map[i] == 0:
                break
            i += 2 + alias_map[i + 1]
    if reserved:
        sets = len(reserved) // max_reserved
        if max(reserved_ids, default=0) >= sets:
            raise Unrecognised(
                f"reserved_word_set_id {max(reserved_ids)} >= {sets} sets"
            )
    elif any(reserved_ids):
        raise Unrecognised("lex modes name reserved word sets but none were found")

    lex = parse_lex_fn(src, "ts_lex", syms, charsets)
    keyword_lex = parse_lex_fn(src, "ts_lex_keywords", syms, charsets)
    kw_m = re.search(r"\.keyword_capture_token\s*=\s*(\w+)", src)
    keyword_capture = syms.value(kw_m.group(1)) if kw_m else 0
    name_m = re.search(r"TS_PUBLIC const TSLanguage \*tree_sitter_(\w+)\(void\)", src)

    return {
        "name": name_m.group(1) if name_m else path.stem,
        "abi": abi,
        "symbolCount": symbol_count,
        "aliasCount": alias_count,
        "tokenCount": token_count,
        "stateCount": state_count,
        "largeStateCount": large_state_count,
        "productionIdCount": production_id_count,
        "fieldCount": field_count,
        "maxAliasSequenceLength": max_alias_len,
        "maxReservedWordSetSize": max_reserved,
        "symbolNames": names,
        "symbolMetadata": meta,
        "publicSymbolMap": public_map,
        "fieldNames": field_names,
        "fieldMapSlices": field_slices,
        "fieldMapEntries": field_entries_flat,
        "aliasSequences": alias_seq,
        "aliasMap": alias_map,
        "lexStates": lex_states,
        "externalLexStates": ext_lex_states,
        "reservedWordSetIds": reserved_ids,
        "reservedWords": reserved,
        "parseTable": parse_table,
        "smallParseTable": small_table,
        "smallParseTableMap": small_map,
        "parseActions": actions,
        "lex": lex,
        "keywordLex": keyword_lex,
        "keywordCaptureToken": keyword_capture,
    }


def parse_action_macro(text: str, syms: Symbols) -> list[int]:
    """SHIFT/SHIFT_REPEAT/SHIFT_EXTRA/REDUCE/ACCEPT_INPUT/RECOVER -> ints.

    Encoding mirrors TSParseActionType: 0 shift, 1 reduce, 2 accept,
    3 recover -- plus the two shift flags the union carries.
    """
    m = re.fullmatch(r"(\w+)\s*\(\s*(.*?)\s*\)", text.strip(), re.S)
    if not m:
        raise Unrecognised(f"parse action {text!r}")
    kind, args = m.group(1), [a for a in split_items(m.group(2))]
    if kind == "SHIFT":
        return [0, syms.value(args[0]), 0, 0]
    if kind == "SHIFT_REPEAT":
        return [0, syms.value(args[0]), 0, 1]
    if kind == "SHIFT_EXTRA":
        return [0, 0, 1, 0]
    if kind == "REDUCE":
        sym, count, prec, pid = (syms.value(a) for a in args)
        return [1, sym, count, prec, pid]
    if kind == "ACCEPT_INPUT":
        return [2]
    if kind == "RECOVER":
        return [3]
    raise Unrecognised(f"parse action macro {kind!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("parser_c", type=Path)
    ap.add_argument("-o", "--out", type=Path)
    ap.add_argument(
        "--lex-only",
        action="store_true",
        help="recover only ts_lex/ts_lex_keywords, ignoring external scanners",
    )
    args = ap.parse_args()
    if args.lex_only:
        blob = lex_only(args.parser_c)
        states = len(blob["lex"] or [])
        kw = len(blob["keywordLex"] or [])
        ops = sum(len(st["o"]) for st in (blob["lex"] or []))
        ops += sum(len(st["o"]) for st in (blob["keywordLex"] or []))
        print(f"{args.parser_c}: {states} lex states, {kw} keyword lex states, {ops} ops")
        if args.out:
            args.out.write_text(json.dumps(blob, separators=(",", ":")) + "\n")
        return 0
    if args.out is None:
        ap.error("-o/--out is required unless --lex-only")
    blob = transcode(args.parser_c)
    args.out.write_text(json.dumps(blob, separators=(",", ":")) + "\n")
    print(
        f"{args.parser_c} -> {args.out}: "
        f"{blob['stateCount']} parse states, "
        f"{len(blob['lex'])} lex states, "
        f"{len(blob['keywordLex']) if blob['keywordLex'] else 0} keyword lex states"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Unrecognised as exc:
        print(f"unrecognised construct: {exc}", file=sys.stderr)
        sys.exit(2)
