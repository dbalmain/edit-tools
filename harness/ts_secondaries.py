#!/usr/bin/env python3
"""Emit manifest-declared secondary grammar routing for JavaScript."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402


def config(manifests: dict[str, mf.Manifest]) -> dict:
    return {
        "grammars": {
            name: {"source_language": target.source_language}
            for name, target in mf.grammar_targets(manifests).items()
        },
        "sites": {
            name: [
                {
                    "name": grammar.name,
                    "within": grammar.within,
                    "blob": f"{grammar.name}.blob.json",
                }
                for grammar in manifest.secondary_grammars
            ]
            for name, manifest in sorted(manifests.items())
            if manifest.secondary_grammars
        }
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", type=Path)
    args = ap.parse_args()
    text = json.dumps(config(mf.load_all()), indent=1) + "\n"
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
