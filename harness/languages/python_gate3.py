"""Gate 3 structural check for Python: `ast.dump(ast.parse(...))`.

Selected by `gate3 = "python"` in python.toml. Stronger than the generic
tree comparison, and stronger for a principled reason rather than an accidental
one: `ast` already discards exactly what a formatter is entitled to change --
parenthesisation, quote style, trailing commas, line breaks -- and preserves
everything it is not.

Hand-rolled normalisation of a tree-sitter tree was tried first and was
whack-a-mole: stripping `parenthesized_expression` still missed the parens black
adds to an import list, and missed `pattern_list` becoming `tuple_pattern` when a
target list gains parens.

Comments are invisible to `ast`. They are not this module's problem -- gate3.py
compares the grammar's extras for every language, override or not.
"""

import ast


def signature(text: str) -> str | None:
    try:
        return ast.dump(ast.parse(text))
    except (SyntaxError, ValueError):
        return None


def describe(before: str, after: str) -> str:
    for i, (x, y) in enumerate(zip(before, after)):
        if x != y:
            return f"ast differs at char {i}: {before[i:i + 60]!r} vs {after[i:i + 60]!r}"
    return f"ast length {len(before)} vs {len(after)}"
