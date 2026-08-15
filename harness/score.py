#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Score a submission against the frozen corpus.

    ./harness/score.py <submission-dir> [--json] [--verbose] [--language NAME]

Gates 0-3 are pass/fail; failing any one disqualifies. 4-6 are measured.
See docs/competition.md for what each gate is for.

The harness owns all parsing. Submissions read trees and emit text; when a
gate needs the output re-parsed (idempotence, non-destruction) we do it here.
That is what lets submissions ship no parser at all.

Everything per-language -- which grammar, which widths, which non-destruction
check, which reference formatter -- comes from `harness/languages/*.toml`. This
file contains no language names. `--language` scores one language, which is what
a builder in a worktree wants; the full run is what the orchestrator merges on.
"""

import argparse
import gzip
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate3  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TREES = ROOT / "corpus" / "trees"
REFERENCE = ROOT / "corpus" / "reference"


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


def as_tree_doc(text: str, language: str, parser) -> dict | None:
    """Re-parse formatted output back into the corpus tree format."""
    source = text.encode("utf-8")
    root = parser.parse(source).root_node
    stack = [root]
    while stack:
        n = stack.pop()
        if n.type == "ERROR" or n.is_missing:
            return None
        stack.extend(n.children)

    def convert(node, fld: str | None) -> dict:
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
    to the reference baseline reported alongside, not to zero.
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


def corpus(manifests: dict[str, mf.Manifest]) -> list[tuple[Path, mf.Manifest]]:
    """Every tree whose language is in `manifests`, with its manifest.

    A tree whose language has no manifest is an error, not a skip: it means a
    manifest was deleted or a tree was committed without one, and silently
    scoring 14 of 15 languages is how a regression hides.
    """
    out = []
    orphans = []
    for path in sorted(TREES.glob("*.tree.json")):
        language = json.loads(path.read_text())["language"]
        if language in manifests:
            out.append((path, manifests[language]))
        else:
            orphans.append((path.name, language))
    if orphans and len(manifests) == len(mf.load_all()):
        names = ", ".join(f"{n} ({lang})" for n, lang in orphans[:5])
        sys.exit(f"trees with no manifest: {names}")
    return out


def score(
    submission: Path, manifests: dict[str, mf.Manifest], verbose: bool = False
) -> Report:
    rep = Report(submission=submission.name)
    rust, js = submission / "fmt-rust", submission / "fmt-js"
    parsers = mf.parsers(manifests)

    trees = corpus(manifests)
    if not trees:
        sys.exit(f"no trees in {TREES}; run harness/gen_trees.py first")

    total = sum(len(m.widths) for _, m in trees)
    covered = agree = idempotent = nondestructive = 0
    overflow = 0
    notes: list[str] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        for tree_path, m in trees:
            doc = json.loads(tree_path.read_text())
            parser = parsers[m.name]
            src_text = (ROOT / doc["source_file"]).read_text()
            src_sig = gate3.signature(src_text, m, parser)
            src_tokens = leaves(doc["root"])

            for width in m.widths:
                tag = f"{tree_path.stem}@{width}"
                r_run = invoke(rust, tree_path, width)
                j_run = invoke(js, tree_path, width)

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
                out_sig = gate3.signature(text, m, parser)
                if out_sig != src_sig:
                    notes.append(f"{tag}: {gate3.describe(src_sig, out_sig, m)}")
                    continue
                nondestructive += 1

                # --- gate 2: formatting the output again changes nothing
                redoc = as_tree_doc(text, m.name, parser)
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

    rep.measures = {
        "4-overflow-lines": overflow,
        "5-size-gzip": sizes(submission, manifests),
        "6-reference-agreement": reference_agreement(submission, trees),
    }
    rep.detail = notes if verbose else notes[:20]
    return rep


def _gate(got: int, total: int, what: str) -> dict:
    return {"pass": got == total, "got": got, "of": total, "what": what}


def sizes(submission: Path, manifests: dict[str, mf.Manifest]) -> dict:
    """Gzipped bytes, broken down per language package.

    Fifteen packages would dominate a single total and punish language 15 for
    arriving late, so the number a language is judged on is **runtime + its own
    package**. The all-languages total is reported alongside, as information.
    `per_language` is what LEDGER.md's attribution column is filled in from; a
    lump figure makes that table useless.
    """
    js_bytes = gzipped_tree(submission / "runtime-js" / "bundle.js")
    per_language = {}
    for name in sorted(manifests):
        path = submission / "packages" / f"{name}.json"
        if path.is_file():
            per_language[name] = {
                "package": gzipped(path),
                "with_runtime": js_bytes + gzipped(path),
            }
    all_packages = gzipped_tree(submission / "packages")
    return {
        "js-runtime": js_bytes,
        "packages": all_packages,
        "total": js_bytes + all_packages,
        "per_language": per_language,
    }


def reference_agreement(
    submission: Path, trees: list[tuple[Path, mf.Manifest]]
) -> dict:
    """Fraction of corpus files whose output matches the reference formatter's.

    Measured per language and at **every** width in the manifest, not just the
    widest. Measuring python only at 88 hid a real defect once: a submission that
    broke mixed-precedence chains at every operator matched black on 11/12 files,
    because operators.py fits at 88 and the fault only appears at 60. The narrow
    width is where layout decisions are actually forced.

    The reference output is read from `corpus/reference/`, generated by
    `harness/gen_reference.py`. A missing file is counted as uncompared and named
    -- never as a match, and never as a divergence.
    """
    per_language: dict[str, dict] = {}
    for tree_path, m in trees:
        doc = json.loads(tree_path.read_text())
        stem = Path(doc["source_file"]).stem
        tokens = leaves(doc["root"])
        entry = per_language.setdefault(
            m.name,
            {
                "reference": m.reference_version,
                "waived": m.waives_width,
                "matched": 0,
                "of": 0,
                "reference_overflow": 0,
                "missing": [],
                "diverged": [],
            },
        )
        for width in m.widths:
            path = REFERENCE / f"{m.name}__{stem}@{width}.txt"
            if not path.is_file():
                entry["missing"].append(f"{stem}@{width}")
                continue
            expected = path.read_text()
            entry["reference_overflow"] += overflow_lines(expected, width, tokens)
            run = invoke(submission / "fmt-rust", tree_path, width)
            entry["of"] += 1
            if not run.ok:
                entry["diverged"].append(f"{stem}@{width} (refused)")
            elif run.text == expected:
                entry["matched"] += 1
            else:
                # Name the files and widths, not just a count: "11/12" hides
                # *which* construct a design gets wrong -- the useful signal.
                entry["diverged"].append(f"{stem}@{width}")

    matched = sum(e["matched"] for e in per_language.values())
    of = sum(e["of"] for e in per_language.values())
    return {
        "matched": matched,
        "of": of,
        "fraction": round(matched / of, 3) if of else None,
        "by_language": per_language,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("submission", type=Path)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--verbose", action="store_true", help="every failure, not the first 20")
    ap.add_argument("--language", help="score only this language")
    args = ap.parse_args()

    manifests = mf.selected(mf.bootstrap(), args.language)
    rep = score(args.submission.resolve(), manifests, args.verbose)

    if args.json:
        print(json.dumps(rep.__dict__, indent=2))
        return 0 if not rep.disqualified else 1

    print(f"submission: {rep.submission}\n")
    for name, g in rep.gates.items():
        mark = "PASS" if g["pass"] else "FAIL"
        print(f"  [{mark}] {name:20} {g['got']:>3}/{g['of']:<3}  {g['what']}")
    m = rep.measures
    size = m["5-size-gzip"]
    ra = m["6-reference-agreement"]
    print(f"\n  overflow lines     {m['4-overflow-lines']}")
    print(f"  size (gzip)        {size['total']} B "
          f"= {size['js-runtime']} runtime + {size['packages']} packages")
    for lang, s in size["per_language"].items():
        print(f"    {lang:10} {s['package']:>6} B package"
              f"  -> {s['with_runtime']} B with runtime")
    print(f"  reference agreement {ra['matched']}/{ra['of']}")
    for lang, e in sorted(ra["by_language"].items()):
        waived = "  [width waived]" if e["waived"] else ""
        print(f"    {lang:10} {e['matched']:>3}/{e['of']:<3} vs {e['reference']}"
              f"  (its own overflow: {e['reference_overflow']}){waived}")
        if e["diverged"]:
            print(f"      diverges on:  {', '.join(e['diverged'])}")
        if e["missing"]:
            print(f"      NOT COMPARED: {', '.join(e['missing'])}"
                  f"  -- run harness/gen_reference.py")

    if rep.detail:
        print("\nfailures:")
        for note in rep.detail:
            print(f"  {note}")

    verdict = "DISQUALIFIED" if rep.disqualified else "gates passed"
    print(f"\n{verdict}")
    return 1 if rep.disqualified else 0


if __name__ == "__main__":
    mf.cli(main)
