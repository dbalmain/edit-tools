#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""The injection declarations, as data a JavaScript runtime can read.

    ./harness/ts_injections.py <blob-dir> [-o out.json]

`harness/languages/*.toml` says which node types hold an embedded region,
which child carries the info string, and which carries the content --
everything `harness/injection.py` needs to find a fenced block and route it to
a guest grammar. That is manifest data, not grammar data, so it cannot ride in
a transcoded blob, and node has no TOML parser. Hence one small JSON file.

`blobs` maps a guest language to the parse table that parses it. A guest with
no blob in the directory is simply absent, and `ts_inject.mjs` leaves its
region verbatim -- the same outcome `injection.parse` produces for an unknown
info string, and the reason an unrouted fence is not an error.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402


def config(manifests: dict[str, mf.Manifest], blob_dir: Path) -> dict:
    """The injection config for these languages, given where their blobs are."""
    aliases = {
        alias: guest.name
        for alias, guest in mf.injection_map(manifests).items()
    }
    sites = {
        name: [
            {"node": site.node, "info": site.info,
             "content": site.content, "guest": site.guest,
             "format": site.format}
            for site in m.injections
        ]
        for name, m in sorted(manifests.items())
        if m.injections
    }
    # Only languages something can actually route to need a blob listed.
    wanted = set(aliases.values())
    blobs = {
        name: (blob_dir / f"{name}.blob.json").name
        for name in sorted(wanted)
        if (blob_dir / f"{name}.blob.json").is_file()
    }
    return {"aliases": aliases, "sites": sites, "blobs": blobs}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("blob_dir", type=Path)
    ap.add_argument("-o", "--out", type=Path)
    args = ap.parse_args()
    text = json.dumps(config(mf.load_all(), args.blob_dir), indent=1) + "\n"
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
