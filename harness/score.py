#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-python", "tree-sitter-json", "black"]
# ///
"""Score a submission against the frozen corpus.

    ./harness/score.py <submission-dir> [--json] [--verbose]

Gates 0-3 are pass/fail; failing any one disqualifies. 4-6 are measured.
See docs/competition.md for what each gate is for.

The harness owns all parsing. Submissions read trees and emit text; when a
gate needs the output re-parsed (idempotence, non-destruction) we do it here.
That is what lets submissions ship no parser at all.
"""

import argparse
import ast
import gzip
import io
import json
import subprocess
import sys
import tempfile
import tokenize
from dataclasses import dataclass, field
from pathlib import Path

import tree_sitter_json
import tree_sitter_python
from tree_sitter import Language, Node, Parser

ROOT = Path(__file__).resolve().parent.parent
TREES = ROOT / "corpus" / "trees"
WIDTHS = (88, 60)
BLACK_WIDTH = 88
CLOSERS = {")", "]", "}"}

PARSERS = {
    "python": Parser(Language(tree_sitter_python.language())),
    "json": Parser(Language(tree_sitter_json.language())),
}


# --------------------------------------------------------------------------
# running a submission


@dataclass
class Run:
    """One (tree, width) invocation of one runtime."""

    ok: bool
    text: str = ""
    refused: bool = False
    error: str = ""


def invoke(exe: Path, tree_path: Path, width: int) -> Run:
    try:
        proc = subprocess.run(
            [str(exe), str(tree_path), str(width)],
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return Run(ok=False, error="timeout after 60s")
    except OSError as exc:
        return Run(ok=False, error=f"could not execute: {exc}")

    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        # Non-zero is the documented way to say "I refuse to format this".
        return Run(ok=False, refused=True, error=stderr[:200])
    try:
        return Run(ok=True, text=proc.stdout.decode("utf-8"))
    except UnicodeDecodeError:
        return Run(ok=False, error="output was not valid UTF-8")


# --------------------------------------------------------------------------
# tree utilities


def leaves(node: dict) -> list[str]:
    if "text" in node:
        return [node["text"]]
    out = []
    for child in node.get("children", ()):
        out.extend(leaves(child))
    return out


def ts_leaves(node: Node, source: bytes) -> list[str]:
    if not node.children:
        return [source[node.start_byte : node.end_byte].decode("utf-8")]
    out = []
    for child in node.children:
        out.extend(ts_leaves(child, source))
    return out


def semantics(text: str, language: str) -> tuple | None:
    """A meaning-preserving signature, computed by the language's own parser.

    Deferring to `ast` rather than normalising a tree-sitter tree by hand is
    what makes this gate principled. `ast` already discards exactly what a
    formatter is entitled to change -- parenthesisation, quote style, trailing
    commas, line breaks -- and preserves everything it is not. Hand-rolled
    normalisation was whack-a-mole: stripping `parenthesized_expression` still
    missed the parens black adds to an import list, and missed `pattern_list`
    becoming `tuple_pattern` when a target list gains parens.

    Comments are invisible to `ast`, so they are compared separately; dropping
    one is the destructive change this gate most needs to catch.

    Returns None if the text does not parse, which is itself a gate failure.
    """
    if language == "python":
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError):
            return None
        return ("python", ast.dump(tree), tuple(comments_of(text)))
    try:
        # object_pairs_hook keeps key order significant -- reordering an
        # object's keys is a change a formatter must not make.
        return ("json", json.loads(text, object_pairs_hook=list))
    except ValueError:
        return None


def comments_of(text: str) -> list[str]:
    out: list[str] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type == tokenize.COMMENT:
                out.append(tok.string.strip())
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return out


def describe_diff(before: tuple, after: tuple) -> str:
    if before[0] == "python" and before[2] != after[2]:
        lost = [c for c in before[2] if c not in after[2]]
        return f"comments changed, lost {lost[:3]}" if lost else "comments changed"
    return "parse tree differs"


def reparse(text: str, language: str) -> tuple[Node | None, bytes]:
    source = text.encode("utf-8")
    tree = PARSERS[language].parse(source)
    stack = [tree.root_node]
    while stack:
        n = stack.pop()
        if n.type == "ERROR" or n.is_missing:
            return None, source
        stack.extend(n.children)
    return tree.root_node, source


def as_tree_doc(text: str, language: str) -> dict | None:
    """Re-parse formatted output back into the corpus tree format."""
    root, source = reparse(text, language)
    if root is None:
        return None

    def convert(node: Node, fld: str | None) -> dict:
        out: dict = {"type": node.type, "start": node.start_byte, "end": node.end_byte}
        if fld is not None:
            out["field"] = fld
        if node.children:
            out["children"] = [
                convert(c, node.field_name_for_child(i))
                for i, c in enumerate(node.children)
            ]
        else:
            out["text"] = source[node.start_byte : node.end_byte].decode("utf-8")
        return out

    return {"language": language, "source": text, "root": convert(root, None)}


# --------------------------------------------------------------------------
# scoring


@dataclass
class Report:
    submission: str
    gates: dict = field(default_factory=dict)
    measures: dict = field(default_factory=dict)
    detail: list = field(default_factory=list)

    @property
    def disqualified(self) -> bool:
        return not all(g["pass"] for g in self.gates.values())


def gzipped(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), 9))


def gzipped_tree(path: Path) -> int:
    """Gzip a directory as the concatenation of its files, sorted for stability."""
    if path.is_file():
        return gzipped(path)
    if not path.is_dir():
        return 0
    blob = b"".join(p.read_bytes() for p in sorted(path.rglob("*")) if p.is_file())
    return len(gzip.compress(blob, 9))


def overflow_lines(text: str, width: int, tokens: list[str]) -> int:
    """Lines over budget.

    This is a **comparative** measure, not an absolute one. Exempting lines that
    contain an over-long token removes the obvious false positives, but some
    overflow is genuinely unfixable -- a JSON pair whose value is a long string
    has no break opportunity at all -- and the scorer cannot tell those apart
    without modelling each design's break points. Every submission formats the
    same corpus, so the floor is shared; compare submissions to each other and
    to the black baseline reported alongside, not to zero.
    """
    unbreakable = [t for t in tokens if len(t) > width]
    count = 0
    for line in text.split("\n"):
        if len(line) <= width:
            continue
        if any(t in line for t in unbreakable):
            continue
        count += 1
    return count


def score(submission: Path, verbose: bool = False) -> Report:
    rep = Report(submission=submission.name)
    rust, js = submission / "fmt-rust", submission / "fmt-js"

    trees = sorted(TREES.glob("*.tree.json"))
    if not trees:
        sys.exit(f"no trees in {TREES}; run harness/gen_trees.py first")

    total = len(trees) * len(WIDTHS)
    covered = agree = idempotent = nondestructive = 0
    overflow = 0
    notes: list[str] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        for tree_path in trees:
            doc = json.loads(tree_path.read_text())
            language = doc["language"]
            src_text = (ROOT / doc["source_file"]).read_text()
            src_sig = semantics(src_text, language)
            src_tokens = leaves(doc["root"])

            for width in WIDTHS:
                tag = f"{tree_path.stem}@{width}"
                r_run, j_run = invoke(rust, tree_path, width), invoke(js, tree_path, width)

                if not (r_run.ok and j_run.ok):
                    why = r_run.error or j_run.error or "unknown"
                    which = "rust" if not r_run.ok else "js"
                    notes.append(f"{tag}: {which} produced no output ({why})")
                    continue
                covered += 1

                # --- gate 1: the two runtimes agree, byte for byte
                if r_run.text != j_run.text:
                    notes.append(f"{tag}: rust and js disagree")
                    continue
                agree += 1
                text = r_run.text

                # --- gate 3: output parses and means the same thing
                out_sig = semantics(text, language)
                if out_sig is None:
                    notes.append(f"{tag}: output does not parse")
                    continue
                if out_sig != src_sig:
                    notes.append(f"{tag}: {describe_diff(src_sig, out_sig)}")
                    continue
                nondestructive += 1

                # --- gate 2: formatting the output again changes nothing
                redoc = as_tree_doc(text, language)
                round2 = tmp / f"{tag}.tree.json"
                round2.write_text(json.dumps(redoc))
                again = invoke(rust, round2, width)
                if not again.ok:
                    notes.append(f"{tag}: refused its own output")
                elif again.text != text:
                    notes.append(f"{tag}: not idempotent")
                else:
                    idempotent += 1

                overflow += overflow_lines(text, width, src_tokens)

    rep.gates = {
        "0-coverage": _gate(covered, total, "formatted every corpus file at every width"),
        "1-agreement": _gate(agree, total, "rust and js byte-identical"),
        "2-idempotence": _gate(idempotent, total, "fmt(fmt(x)) == fmt(x)"),
        "3-nondestruction": _gate(nondestructive, total, "meaning and comments preserved"),
    }

    js_bytes = gzipped_tree(submission / "runtime-js" / "bundle.js")
    pkg_bytes = gzipped_tree(submission / "packages")
    rep.measures = {
        "4-overflow-lines": overflow,
        "5-size-gzip": {
            "js-runtime": js_bytes,
            "packages": pkg_bytes,
            "total": js_bytes + pkg_bytes,
        },
        "6-black-agreement": black_agreement(submission),
    }
    rep.detail = notes if verbose else notes[:20]
    return rep


def _gate(got: int, total: int, what: str) -> dict:
    return {"pass": got == total, "got": got, "of": total, "what": what}


def first_diff(a: list[str], b: list[str]) -> str:
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return f"at token {i}: expected {x!r}, got {y!r}"
    return f"length {len(a)} vs {len(b)}"


def black_agreement(submission: Path) -> dict:
    """Fraction of Python files whose output matches black's, at both widths.

    Measuring only at 88 hid a real defect: a submission that broke
    mixed-precedence chains at every operator matched black on 11/12 files,
    because operators.py fits at 88 and the fault only appears at 60. The
    narrow width is where layout decisions are actually forced.

    Black runs with `string_normalization=False` because the mandatory
    linearity invariant forbids rewriting a token's text, so quote
    normalisation is not available to any submission. Comparing against a black
    that does it would make two of every twelve files unwinnable by a rule we
    imposed ourselves.
    """
    import black

    matched = compared = black_overflow = 0
    diverged: list[str] = []
    for tree_path in sorted(TREES.glob("python__*.tree.json")):
        doc = json.loads(tree_path.read_text())
        source = (ROOT / doc["source_file"]).read_text()
        for width in WIDTHS:
            try:
                expected = black.format_str(source, mode=black.Mode(line_length=width, string_normalization=False))
            except Exception:
                continue
            black_overflow += overflow_lines(expected, width, leaves(doc["root"]))
            run = invoke(submission / "fmt-rust", tree_path, width)
            compared += 1
            if not run.ok:
                continue
            if run.text == expected:
                matched += 1
            else:
                # Name the files and widths, not just a count: "11/12" hides
                # *which* construct a design gets wrong -- the useful signal.
                name = tree_path.stem.replace("python__", "").replace(".tree", "")
                diverged.append(f"{name}@{width}")
    return {
        "matched": matched,
        "of": compared,
        "black_overflow": black_overflow,
        "diverged": diverged,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("submission", type=Path)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--verbose", action="store_true", help="every failure, not the first 20")
    args = ap.parse_args()

    rep = score(args.submission.resolve(), args.verbose)

    if args.json:
        print(json.dumps(rep.__dict__, indent=2))
        return 0 if not rep.disqualified else 1

    print(f"submission: {rep.submission}\n")
    for name, g in rep.gates.items():
        mark = "PASS" if g["pass"] else "FAIL"
        print(f"  [{mark}] {name:20} {g['got']:>3}/{g['of']:<3}  {g['what']}")
    m = rep.measures
    size = m["5-size-gzip"]
    ba = m["6-black-agreement"]
    print(f"\n  overflow lines     {m['4-overflow-lines']}")
    print(f"  size (gzip)        {size['total']} B "
          f"= {size['js-runtime']} runtime + {size['packages']} packages")
    print(f"  black agreement    {ba['matched']}/{ba['of']}"
          f"  (black's own overflow: {ba['black_overflow']})")
    if ba["diverged"]:
        print(f"    diverges on:     {', '.join(ba['diverged'])}")

    if rep.detail:
        print("\nfailures:")
        for note in rep.detail:
            print(f"  {note}")

    verdict = "DISQUALIFIED" if rep.disqualified else "gates passed"
    print(f"\n{verdict}")
    return 1 if rep.disqualified else 0


if __name__ == "__main__":
    raise SystemExit(main())
