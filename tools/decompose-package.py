#!/usr/bin/env python3
"""Break a compiled package's gzip into its JSON parts.

Gzip is not additive, so this prints two views and does not sum them:

* isolated — gzip of a compact ``{key: value}`` (or a group of keys) alone
* ablation — gzip(whole) − gzip(whole with those keys emptied)

Empty means ``[]`` / ``{}`` / ``""`` / ``0`` as appropriate. Serialization
is ``json.dumps(..., separators=(",", ":"))``. Gzip is
``gzip.compress(bytes, 9)``, the same call as ``harness/score.py`` and as
``gzip -9 -c`` (no filename in the header).

The published table's 3049 for ``packages/python.json`` is ``gzip -9`` of
the named file, which stores ``python.json\\0`` in the header (+12).
Content-only gzip of that file is 3037. Ablation deltas are identical
either way; this script reports content-only sizes.

Usage: ``python3 tools/decompose-package.py [packages/python.json]``
"""

from __future__ import annotations

import gzip
import json
import sys
from copy import deepcopy
from pathlib import Path

EMPTY = {
    "language": "",
    "indent": 0,
    "comment_type": "",
    "opaque": [],
    "steal_into_body": [],
    "blank": {},
    "consts": [],
    "entry": {},
    "args": {},
    "kinds": {},
    "defaults": {},
    "code": [],
}

GROUPS = [
    ("header/config", ["language", "indent", "comment_type", "opaque", "steal_into_body", "blank"]),
    ("const pool", ["consts"]),
    ("per-type maps", ["entry", "args", "kinds", "defaults"]),
    ("  entry", ["entry"]),
    ("  args", ["args"]),
    ("  kinds", ["kinds"]),
    ("  defaults", ["defaults"]),
    ("code array", ["code"]),
]


def dump(obj: object) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()


def gz(data: bytes) -> int:
    return len(gzip.compress(data, 9))


def empty_of(key: str, value: object) -> object:
    if key in EMPTY:
        return deepcopy(EMPTY[key])
    if isinstance(value, list):
        return []
    if isinstance(value, dict):
        return {}
    if isinstance(value, str):
        return ""
    if isinstance(value, (int, float)):
        return 0
    return None


def report(path: Path) -> None:
    raw = path.read_bytes()
    obj = json.loads(raw)
    whole_raw = len(raw)
    whole_gz = gz(raw)
    print(f"# {path}")
    print(f"file raw={whole_raw}  gzip-9 content={whole_gz}")
    print()
    print("method: isolated = gzip({key: value} or the listed keys);")
    print("        ablation = gzip(whole) - gzip(those keys emptied).")
    print("parts do not sum to the whole.")
    print()
    hdr = f"{'part':22} {'raw':>7} {'iso_gz':>7} {'abl_raw':>8} {'abl_gz':>7}"
    print(hdr)
    print("-" * len(hdr))

    def line(name: str, keys: list[str]) -> None:
        isolated = {k: obj[k] for k in keys if k in obj}
        iso_raw = len(dump(isolated))
        iso_gz = gz(dump(isolated))
        ablated = deepcopy(obj)
        for k in keys:
            if k in ablated:
                ablated[k] = empty_of(k, ablated[k])
        abl_raw = whole_raw - len(dump(ablated))
        abl_gz = whole_gz - gz(dump(ablated))
        print(f"{name:22} {iso_raw:7} {iso_gz:7} {abl_raw:8} {abl_gz:7}")

    for name, keys in GROUPS:
        line(name, keys)

    # Single fields not in a named group already printed.
    grouped = {k for _, keys in GROUPS for k in keys}
    extras = [k for k in obj if k not in grouped]
    for k in extras:
        line(k, [k])

    emptied = deepcopy(obj)
    emptied["code"] = []
    no_code = dump(emptied)
    print()
    print(f"whole with code emptied: raw={len(no_code)} gzip={gz(no_code)}")
    authored = path.parent.parent / "authored" / path.name
    if authored.is_file():
        a = authored.read_bytes()
        print(f"authored/{path.name} (schema): raw={len(a)} gzip={gz(a)}")


def main() -> None:
    paths = [Path(p) for p in sys.argv[1:]]
    if not paths:
        root = Path(__file__).resolve().parent.parent
        paths = [root / "packages" / "python.json"]
    for i, p in enumerate(paths):
        if i:
            print()
        report(p)


if __name__ == "__main__":
    main()
