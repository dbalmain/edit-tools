"""Gate 3 structural check for TOML: a normalised tomllib value.

tomllib is independent of tree-sitter and proves the formatted document has
the same decoded TOML value. The universal layer in harness/gate3.py still
compares ordered extras, so comments remain protected even though TOML loaders
do not expose them. TOML's nan is canonicalised because IEEE NaN intentionally
does not compare equal to itself.
"""

import math
import tomllib
from typing import Any


def _normalise(value: Any) -> Any:
    if isinstance(value, dict):
        return tuple(sorted((key, _normalise(item)) for key, item in value.items()))
    if isinstance(value, list):
        return tuple(_normalise(item) for item in value)
    if isinstance(value, float) and math.isnan(value):
        return ("float", "nan")
    return value


def signature(text: str) -> object | None:
    try:
        return _normalise(tomllib.loads(text))
    except tomllib.TOMLDecodeError:
        return None


def describe(before, after) -> str:
    return "decoded TOML value differs"
