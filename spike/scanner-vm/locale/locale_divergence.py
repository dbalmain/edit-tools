#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-css==0.25.0"]
# ///
"""Does one pinned tree-sitter grammar produce one tree, or one tree per host?

tree-sitter-css 0.25.0's external scanner calls iswspace()/iswalnum() from
<wctype.h>.  Those are locale-sensitive: in the C locale glibc classifies only
ASCII, and in a UTF-8 locale it classifies the whole Unicode repertoire.  The
grammar version does not pin which one you get -- the *host process* does.

Run twice, once per locale, and diff the trees:

    uv run locale_divergence.py                     # inherits the env locale
    LC_ALL=C LANG=C uv run locale_divergence.py     # C locale

Positive control: an ASCII space must parse identically under both, or the
setup is measuring something other than the locale.
"""

import locale
import sys

import tree_sitter_css as css
from tree_sitter import Language, Parser

CASES = [
    # label, source -- the separator between the two tag names is the variable
    ("control: ASCII space U+0020", "a b { c: d; }"),
    ("EM SPACE U+2003", "a b { c: d; }"),
    ("NO-BREAK SPACE U+00A0", "a b { c: d; }"),
    ("IDEOGRAPHIC SPACE U+3000", "a　b { c: d; }"),
]


def main() -> int:
    parser = Parser(Language(css.language()))
    print(f"LC_CTYPE = {locale.setlocale(locale.LC_CTYPE)}")
    for label, src in CASES:
        tree = parser.parse(src.encode())
        print(f"  {label:32s} -> {tree.root_node}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
