"""Gate 3 structural check for JSON: ordered `json.loads`.

Selected by `gate3 = "json"` in json.toml. `object_pairs_hook=list` keeps key
order significant -- reordering an object's keys is a change a formatter must not
make, and the default dict hook would hide it.

`json.loads` rejects comments, which tree-sitter-json accepts. See the note in
json.toml: a corpus file with comments must use `gate3 = "default"` instead.
"""

import json


def signature(text: str):
    try:
        return json.loads(text, object_pairs_hook=list)
    except ValueError:
        return None


def describe(before, after) -> str:
    return "json value differs (key order is significant)"
