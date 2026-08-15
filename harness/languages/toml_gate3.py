"""Semantic gate for TOML, using Python's standard-library TOML loader."""

import math
import tomllib


def _canonical(value):
    """Make TOML's non-reflexive float literals comparable."""
    if isinstance(value, float):
        if math.isnan(value):
            return ("float", "nan")
        if math.isinf(value):
            return ("float", "+inf" if value > 0 else "-inf")
        return value
    if isinstance(value, dict):
        return tuple(sorted((key, _canonical(item)) for key, item in value.items()))
    if isinstance(value, list):
        return tuple(_canonical(item) for item in value)
    return value


def signature(text: str) -> object | None:
    try:
        return _canonical(tomllib.loads(text))
    except tomllib.TOMLDecodeError:
        return None
