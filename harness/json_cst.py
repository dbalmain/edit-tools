#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""A hand-rolled JSON parser that emits the runtime's corpus tree format.

No tree-sitter, and no JSON library on the input. `json.dumps` is used only
to serialise the tree we built, the same way `gen_trees.py` does.

The node vocabulary (`document`, `pair`, `string_content`, `escape_sequence`,
field names `key`/`value`) is the one `packages/json.json` was written
against. Matching it is the probe: can a bespoke parser feed the unmodified
package?

    ./harness/json_cst.py corpus/src/json/basic.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

WS = frozenset(b" \t\n\r")
HEX = frozenset(b"0123456789abcdefABCDEF")
SIMPLE_ESCAPE = frozenset(b'"\\/bfnrt')


class ParseError(Exception):
    """Input is not JSON. `pos` is a byte offset into the source."""

    def __init__(self, message: str, pos: int) -> None:
        super().__init__(f"byte {pos}: {message}")
        self.pos = pos


def leaf(
    source: bytes, kind: str, start: int, end: int, field: str | None = None
) -> dict:
    out: dict = {"type": kind, "start": start, "end": end}
    if field is not None:
        out["field"] = field
    out["text"] = source[start:end].decode("utf-8")
    return out


def interior(
    kind: str,
    start: int,
    end: int,
    children: list[dict],
    field: str | None = None,
) -> dict:
    out: dict = {"type": kind, "start": start, "end": end}
    if field is not None:
        out["field"] = field
    out["children"] = children
    return out


class Parser:
    """Recursive-descent JSON parser that keeps every punctuation child.

    Offsets are UTF-8 byte offsets, matching the committed tree-sitter trees.
    Whitespace is skipped, never emitted: the runtime measures gaps from
    `source[prev.end : child.start]`, so a whitespace child would be an
    unconsumed item and a refusal.
    """

    def __init__(self, source: bytes) -> None:
        self.src = source
        self.n = len(source)
        self.i = 0

    def peek(self) -> int | None:
        return self.src[self.i] if self.i < self.n else None

    def skip_ws(self) -> None:
        while self.i < self.n and self.src[self.i] in WS:
            self.i += 1

    def expect(self, byte: int, what: str) -> dict:
        if self.peek() != byte:
            got = "eof" if self.peek() is None else repr(bytes([self.src[self.i]]))
            raise ParseError(f"expected {what}, got {got}", self.i)
        start = self.i
        self.i += 1
        return leaf(self.src, chr(byte), start, self.i)

    def parse_document(self) -> dict:
        self.skip_ws()
        value = self.parse_value()
        self.skip_ws()
        if self.i != self.n:
            raise ParseError("trailing garbage after the value", self.i)
        # The root spans the whole buffer, including a trailing newline the
        # value itself does not cover. That is what tree-sitter's `document`
        # node does, and what the committed trees have.
        return interior("document", 0, self.n, [value])

    def parse_value(self, field: str | None = None) -> dict:
        self.skip_ws()
        c = self.peek()
        if c is None:
            raise ParseError("unexpected end of input", self.i)
        if c == ord("{"):
            return self.parse_object(field)
        if c == ord("["):
            return self.parse_array(field)
        if c == ord('"'):
            return self.parse_string(field)
        if c == ord("t"):
            return self.parse_keyword(b"true", field)
        if c == ord("f"):
            return self.parse_keyword(b"false", field)
        if c == ord("n"):
            return self.parse_keyword(b"null", field)
        if c == ord("-") or (ord("0") <= c <= ord("9")):
            return self.parse_number(field)
        raise ParseError(f"unexpected {bytes([c])!r}", self.i)

    def parse_keyword(self, word: bytes, field: str | None) -> dict:
        start = self.i
        if self.src[self.i : self.i + len(word)] != word:
            raise ParseError(f"expected {word.decode()}", start)
        self.i += len(word)
        return leaf(self.src, word.decode(), start, self.i, field)

    def parse_number(self, field: str | None) -> dict:
        start = self.i
        if self.peek() == ord("-"):
            self.i += 1
        if self.peek() == ord("0"):
            self.i += 1
        elif self.peek() is not None and ord("1") <= self.peek() <= ord("9"):
            self.i += 1
            while self.peek() is not None and ord("0") <= self.peek() <= ord("9"):
                self.i += 1
        else:
            raise ParseError("invalid number", start)
        if self.peek() == ord("."):
            self.i += 1
            if self.peek() is None or not (ord("0") <= self.peek() <= ord("9")):
                raise ParseError("invalid fraction", start)
            while self.peek() is not None and ord("0") <= self.peek() <= ord("9"):
                self.i += 1
        if self.peek() in (ord("e"), ord("E")):
            self.i += 1
            if self.peek() in (ord("+"), ord("-")):
                self.i += 1
            if self.peek() is None or not (ord("0") <= self.peek() <= ord("9")):
                raise ParseError("invalid exponent", start)
            while self.peek() is not None and ord("0") <= self.peek() <= ord("9"):
                self.i += 1
        return leaf(self.src, "number", start, self.i, field)

    def parse_string(self, field: str | None) -> dict:
        start = self.i
        children = [self.expect(ord('"'), '"')]
        chunk = self.i
        while True:
            if self.i >= self.n:
                raise ParseError("unterminated string", start)
            c = self.src[self.i]
            if c == ord('"'):
                if self.i > chunk:
                    children.append(
                        leaf(self.src, "string_content", chunk, self.i)
                    )
                children.append(self.expect(ord('"'), '"'))
                break
            if c == ord("\\"):
                if self.i > chunk:
                    children.append(
                        leaf(self.src, "string_content", chunk, self.i)
                    )
                children.append(self.parse_escape())
                chunk = self.i
                continue
            if c < 0x20:
                raise ParseError("unescaped control character in string", self.i)
            self.i += 1
        return interior("string", start, self.i, children, field)

    def parse_escape(self) -> dict:
        start = self.i
        self.i += 1
        c = self.peek()
        if c is None:
            raise ParseError("unterminated escape", start)
        if c in SIMPLE_ESCAPE:
            self.i += 1
        elif c == ord("u"):
            self.i += 1
            for _ in range(4):
                if self.peek() not in HEX:
                    raise ParseError("invalid \\u escape", start)
                self.i += 1
        else:
            raise ParseError("invalid escape", start)
        return leaf(self.src, "escape_sequence", start, self.i)

    def parse_object(self, field: str | None) -> dict:
        start = self.i
        children = [self.expect(ord("{"), "{")]
        self.skip_ws()
        if self.peek() != ord("}"):
            children.append(self.parse_pair())
            while True:
                self.skip_ws()
                if self.peek() != ord(","):
                    break
                children.append(self.expect(ord(","), ","))
                children.append(self.parse_pair())
            self.skip_ws()
        children.append(self.expect(ord("}"), "}"))
        return interior("object", start, self.i, children, field)

    def parse_pair(self) -> dict:
        self.skip_ws()
        start = self.i
        key = self.parse_string("key")
        self.skip_ws()
        colon = self.expect(ord(":"), ":")
        value = self.parse_value("value")
        return interior("pair", start, value["end"], [key, colon, value])

    def parse_array(self, field: str | None) -> dict:
        start = self.i
        children = [self.expect(ord("["), "[")]
        self.skip_ws()
        if self.peek() != ord("]"):
            children.append(self.parse_value())
            while True:
                self.skip_ws()
                if self.peek() != ord(","):
                    break
                children.append(self.expect(ord(","), ","))
                children.append(self.parse_value())
            self.skip_ws()
        children.append(self.expect(ord("]"), "]"))
        return interior("array", start, self.i, children, field)


def parse(source: bytes) -> dict:
    return Parser(source).parse_document()


def tree_doc(source: bytes, language: str, source_file: str) -> dict:
    return {
        "language": language,
        "source_file": source_file,
        "source": source.decode("utf-8"),
        "root": parse(source),
    }


def dumps(doc: dict) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", type=Path, help="a JSON source file")
    ap.add_argument(
        "--language",
        default="json",
        help="tree.language; the runtime uses this to pick the package",
    )
    args = ap.parse_args()
    source = args.path.read_bytes()
    # Match gen_trees.py's source_file: path relative to the repo root when
    # we can see it, otherwise the path as given.
    root = Path(__file__).resolve().parent.parent
    try:
        rel = str(args.path.resolve().relative_to(root))
    except ValueError:
        rel = str(args.path)
    sys.stdout.write(dumps(tree_doc(source, args.language, rel)))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ParseError as exc:
        raise SystemExit(f"parse error: {exc}") from None
