#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""Run each language's reference formatter over its corpus and commit the result.

    ./harness/gen_reference.py [--language NAME] [--check]

Writes `corpus/reference/<lang>__<stem>@<width>.txt`. `--check` regenerates into
memory and reports drift instead of writing, which is how you notice a reference
formatter changed under you.

**Why these are committed rather than run live.** The scorer used to import
`black` and call it in-process, which worked because black is a Python library
and Python was one language. The other fourteen references are `npx prettier`,
`nix run nixpkgs#taplo`, `gofmt`, `aven fmt`. Running them from the scorer would
put a network fetch and a few hundred process spawns inside `./test.sh`, and
`build.sh` promises to be hermetic. So the slow, networked, non-reproducible step
happens here, once, and its output is ground truth in the tree.

That also makes a reference version bump **visible as a diff** instead of a
silent change in what the harness compares against, and lets a reviewer read what
the reference actually does without installing it.

No grammars are needed here, so this script does not bootstrap them.
"""

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
OUT = ROOT / "corpus" / "reference"

TIMEOUT = 300  # nix run on a cold store is genuinely this slow


def out_path(lang: str, stem: str, width: int) -> Path:
    return OUT / f"{lang}__{stem}@{width}.txt"


def run_reference(m: mf.Manifest, width: int, source: bytes) -> tuple[bool, str]:
    cmd = m.reference_command(width)
    try:
        proc = subprocess.run(
            cmd, shell=True, input=source, capture_output=True, timeout=TIMEOUT
        )
    except subprocess.TimeoutExpired:
        return False, f"timed out after {TIMEOUT}s: {cmd}"
    if proc.returncode != 0:
        return False, proc.stderr.decode("utf-8", "replace").strip()[:400]
    try:
        return True, proc.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return False, "reference output was not valid UTF-8"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language")
    ap.add_argument("--check", action="store_true",
                    help="compare against the committed output, do not write")
    args = ap.parse_args()

    manifests = mf.selected(mf.load_all(), args.language)
    OUT.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []
    drifted: list[str] = []
    written = 0

    for name, m in manifests.items():
        src_dir = SRC / name
        if not src_dir.is_dir():
            print(f"{name}: no corpus at {src_dir.relative_to(ROOT)}, skipped")
            continue
        paths = sorted(p for ext in m.extensions for p in src_dir.glob(f"*{ext}"))
        print(f"{name}: {m.reference_version}  ({len(paths)} files "
              f"x {len(m.widths)} width(s))")
        for path in paths:
            source = path.read_bytes()
            for width in m.widths:
                ok, text = run_reference(m, width, source)
                if not ok:
                    failures.append(f"{name}__{path.stem}@{width}: {text}")
                    continue
                dest = out_path(name, path.stem, width)
                if args.check:
                    have = dest.read_text() if dest.is_file() else None
                    if have != text:
                        drifted.append(
                            f"{dest.name}: "
                            + ("missing" if have is None else "differs")
                        )
                else:
                    dest.write_text(text)
                    written += 1

    for f in failures:
        print(f"  FAIL {f}", file=sys.stderr)
    for d in drifted:
        print(f"  DRIFT {d}", file=sys.stderr)

    if args.check:
        if drifted or failures:
            print(f"\n{len(drifted)} drifted, {len(failures)} failed -- "
                  f"rerun without --check and commit, or pin the reference back")
            return 1
        print("\ncommitted reference output matches the pinned formatters")
        return 0

    if failures:
        print(f"\n{len(failures)} reference run(s) failed", file=sys.stderr)
        return 1
    print(f"\n{written} files written to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    mf.cli(main)
