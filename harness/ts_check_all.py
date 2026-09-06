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

Three checks per language, and the third only where it is needed:

* `ts_check_trees.mjs <blob> <lang>` against `corpus/trees/`;
* the same `--edited` against `corpus/trees-edited/`, which is what exercises
  error recovery;
* `ts_check_hostonly.py`'s comparison *instead of* the first, for a language
  whose frozen clean trees carry an injection splice. markdown is the only
  one: `gen_trees.py` substitutes a guest tree for the host's
  `code_fence_content` leaf, and a single parse cannot reproduce that, so the
  clean fixtures cannot judge the port. The host-only comparison covers all
  fifteen of its files rather than the nine that happen not to be spliced, so
  it is a replacement rather than an addition. See that script's docstring,
  and D6 on the parse-layer board for whether it should stay the bar.

The scanner is passed when the language has a ported one. A language with an
external scanner and no `.svm` is a failure, not a skip -- transcoding with no
scanner puts an ERROR in the first corpus file of every such grammar.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402
import gen_trees as gt_trees  # noqa: E402
import ts_check_hostonly as hostonly  # noqa: E402
import ts_grammars as tg  # noqa: E402
import ts_scanner_record as rec  # noqa: E402

HARNESS = Path(__file__).resolve().parent
ROOT = HARNESS.parent
SCANNERS = HARNESS / "scanners"
INJECTED = {"markdown"}


def run(*cmd: str) -> tuple[int, str]:
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def check(language: str, m, out: Path, parsers: dict) -> list[str]:
    src = rec.grammar_src(language, m)
    blob = out / f"{language}.blob.json"
    cmd = [HARNESS / "ts_transcode.py", src / "parser.c", "-o", blob]
    svm = SCANNERS / f"{language}.svm"
    if tg.scanner_of(src) is not None:
        if not svm.is_file():
            return [f"{language}: has {tg.scanner_of(src).name} but no ported {svm.name}"]
        cmd += ["--scanner", svm]
    code, text = run(*cmd)
    if code != 0:
        return [f"{language}: transcode failed\n{text}"]

    problems = []
    if language in INJECTED:
        # --write-dir writes every tree *and* compares, so its exit status is
        # the frozen-fixture verdict this branch exists to replace. Discard it
        # and its diagnostics; the host-only comparison below is the check.
        ours = out / f"{language}-ours"
        run(HARNESS / "ts_check_trees.mjs", blob, language, "--write-dir", ours)
        total = len(list(gt_trees.sources(m)))
        written = len(list(ours.glob(f"{language}__*.tree.json")))
        if written != total:
            problems.append(f"{language} write-dir: wrote {written} of {total} trees")
        else:
            bad = hostonly.compare(m, ours, parsers, verbose=False)
            print(f"  {language:<12} {'clean*':<7} "
                  f"{total - len(bad)}/{total} byte-identical, injections off")
            if bad:
                problems.append(f"{language} hostonly: {', '.join(bad)}")
    else:
        code, text = run(HARNESS / "ts_check_trees.mjs", blob, language)
        line = text.splitlines()[-1] if text else "(no output)"
        print(f"  {language:<12} {'clean':<7} {line}")
        if code != 0:
            problems.append(f"{language} clean: {text}")

    code, text = run(HARNESS / "ts_check_trees.mjs", blob, language, "--edited")
    line = text.splitlines()[-1] if text else "(no output)"
    print(f"  {language:<12} {'edited':<7} {line}")
    if code != 0:
        problems.append(f"{language} edited: {text}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language", help="check only this language")
    ap.add_argument("--keep", help="write blobs here instead of a temp dir")
    args = ap.parse_args()

    known = mf.bootstrap()
    manifests = mf.selected(known, args.language)
    ctx = (Path(args.keep) if args.keep else None)
    if ctx:
        ctx.mkdir(parents=True, exist_ok=True)

    parsers = mf.parsers(known)
    with tempfile.TemporaryDirectory() as tmp:
        out = ctx or Path(tmp)
        problems: list[str] = []
        for name, m in manifests.items():
            problems += check(name, m, out, parsers)

    if problems:
        print("\nFAILURES:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    star = " (* markdown against the host grammar; see the docstring)" \
        if any(n in INJECTED for n in manifests) else ""
    print(f"\n{len(manifests)}/{len(manifests)} languages byte-identical{star}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
