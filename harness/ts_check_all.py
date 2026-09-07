#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Transcode every language and check its trees. The goal's own gate.

    ./harness/ts_check_all.py [--language NAME] [--keep DIR]

The goal set on 2026-09-06 was the route-C3 parse layer parsing all sixteen
tree-sitter languages in the corpus (aven is out of scope -- it has no
tree-sitter grammar). Each language's number was measured one at a time as its
scanner landed, from a shell line reconstructed each time. This is that line,
once, for all sixteen, so "all sixteen parse byte-identically" is a command
rather than a claim in a commit message.

Two checks per language, both against committed artifacts:

* `ts_check_trees.mjs <blob> <lang>` against `corpus/trees/`;
* the same `--edited` against `corpus/trees-edited/`, which is what exercises
  error recovery.

Transcoding happens for every language up front, before any checking, because
the first check needs more than its own language's table. `corpus/trees/` is
frozen *with* injection splices -- `gen_trees.py` reparses a fenced region with
the guest grammar and substitutes the guest's tree for the host's
`code_fence_content` leaf -- so checking markdown against those fixtures means
parsing the JavaScript and JSON inside its fences too. `--inject` passes
`ts_check_trees.mjs` the manifest's routing declarations and the directory
holding every blob, and it does the same second pass `injection.py` does.

That is why a `--language markdown` run transcodes more than markdown: it adds
whatever guests markdown can route to. A language with no injection sites
transcodes only itself.

The scanner is passed when the language has a ported one. A language with an
external scanner and no `.svm` is a failure, not a skip -- transcoding with no
scanner puts an ERROR in the first corpus file of every such grammar.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402
import ts_grammars as tg  # noqa: E402
import ts_injections as tj  # noqa: E402
import ts_scanner_record as rec  # noqa: E402

HARNESS = Path(__file__).resolve().parent
ROOT = HARNESS.parent
SCANNERS = HARNESS / "scanners"


def run(*cmd: str) -> tuple[int, str]:
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def transcode(language: str, m, out: Path) -> list[str]:
    """Write `<out>/<language>.blob.json`, or say why it could not be written."""
    src = rec.grammar_src(language, m)
    cmd = [HARNESS / "ts_transcode.py", src / "parser.c",
           "-o", out / f"{language}.blob.json"]
    svm = SCANNERS / f"{language}.svm"
    if tg.scanner_of(src) is not None:
        if not svm.is_file():
            return [f"{language}: has {tg.scanner_of(src).name} but no ported {svm.name}"]
        cmd += ["--scanner", svm]
    code, text = run(*cmd)
    return [] if code == 0 else [f"{language}: transcode failed\n{text}"]


def check(language: str, out: Path, injections: Path) -> list[str]:
    blob = out / f"{language}.blob.json"
    problems = []
    for label, extra in (("clean", ["--inject", injections]), ("edited", ["--edited"])):
        code, text = run(HARNESS / "ts_check_trees.mjs", blob, language, *extra)
        line = text.splitlines()[-1] if text else "(no output)"
        print(f"  {language:<12} {label:<7} {line}")
        if code != 0:
            problems.append(f"{language} {label}: {text}")
    return problems


def guests_of(manifests: dict, known: dict) -> dict:
    """The guest manifests the selected languages can route a fenced region to.

    A host is checked against spliced fixtures, so its guests' tables have to
    exist even when the caller asked for one language.
    """
    if not any(m.injections for m in manifests.values()):
        return {}
    aliases = mf.injection_map(known)
    return {g.name: g for g in aliases.values() if g.name not in manifests}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language", help="check only this language")
    ap.add_argument("--keep", help="write blobs here instead of a temp dir")
    args = ap.parse_args()

    known = mf.bootstrap()
    manifests = mf.selected(known, args.language)
    extra = guests_of(manifests, known)
    ctx = (Path(args.keep) if args.keep else None)
    if ctx:
        ctx.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        out = ctx or Path(tmp)
        problems: list[str] = []
        for name, m in {**manifests, **extra}.items():
            problems += transcode(name, m, out)
        injections = out / "injections.json"
        injections.write_text(
            json.dumps(tj.config(known, out), indent=1) + "\n", encoding="utf-8")
        if not problems:
            for name in manifests:
                problems += check(name, out, injections)

    if problems:
        print("\nFAILURES:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(f"\n{len(manifests)}/{len(manifests)} languages byte-identical")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
