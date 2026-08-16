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
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import formatter_divergence as fd  # noqa: E402
import gate3  # noqa: E402
import gen_trees  # noqa: E402
import manifest as mf  # noqa: E402
import review_ledger  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TREES = ROOT / "corpus" / "trees"
REFERENCE = ROOT / "corpus" / "reference"
REVIEWS = review_ledger.ROOT


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


def as_tree_doc(
    text: str,
    manifest: mf.Manifest,
    manifests: dict[str, mf.Manifest],
    parsers: dict,
) -> dict | None:
    """Re-parse output through the same splicing path as the frozen corpus."""
    doc, problems = gen_trees.parse_doc(
        manifest,
        text.encode("utf-8"),
        f"<gate2:{manifest.name}>",
        manifests,
        parsers,
    )
    return None if problems else doc


# --------------------------------------------------------------------------
# scoring


@dataclass
class Report:
    submission: str
    gates: dict = field(default_factory=dict)
    measures: dict = field(default_factory=dict)
    detail: list = field(default_factory=list)
    # Languages with a corpus but no package yet; excluded from every gate.
    pending: list = field(default_factory=list)

    @property
    def disqualified(self) -> bool:
        stale = self.measures.get("6-reference-agreement", {}).get("stale", 0)
        return not all(g["pass"] for g in self.gates.values()) or stale > 0


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


def awaiting_package(
    submission: Path, manifests: dict[str, mf.Manifest]
) -> dict[str, mf.Manifest]:
    """Languages that have landed a corpus but not yet a package.

    Onboarding lands stage A (corpus, manifest, trees, reference output) before
    stage C writes the package, and without this the scorer reports a stage-A
    language as one refusal per tree per width and DISQUALIFIED -- which reads
    exactly like a broken package. Four reviewed TOML corpora sat unmerged for
    weeks because of it, and the stage-A brief asks for a green `./test.sh` from
    a stage that could not produce one.

    A language is awaiting its package only when no `packages/<name>.json`
    exists at all. A package that is present and refuses is a real failure and
    is still scored as one.
    """
    return {
        name: m
        for name, m in manifests.items()
        if not (submission / "packages" / f"{name}.json").is_file()
    }


def score(
    submission: Path,
    manifests: dict[str, mf.Manifest],
    verbose: bool = False,
    all_manifests: dict[str, mf.Manifest] | None = None,
) -> Report:
    rep = Report(submission=submission.name)
    rust, js = submission / "fmt-rust", submission / "fmt-js"
    all_manifests = all_manifests or manifests
    parsers = mf.parsers(all_manifests)

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
            src_sig = gate3.signature(
                src_text, m, parser, all_manifests, parsers
            )
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
                out_sig = gate3.signature(
                    text, m, parser, all_manifests, parsers
                )
                if out_sig != src_sig:
                    notes.append(f"{tag}: {gate3.describe(src_sig, out_sig, m)}")
                    continue
                nondestructive += 1

                # --- gate 2: formatting the output again changes nothing
                redoc = as_tree_doc(text, m, all_manifests, parsers)
                if redoc is None:
                    notes.append(f"{tag}: could not build round-2 tree")
                    continue
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
    package_paths = [
        submission / "packages" / f"{name}.json" for name in sorted(manifests)
    ]
    package_blob = b"".join(
        path.read_bytes() for path in package_paths if path.is_file()
    )
    all_packages = len(gzip.compress(package_blob, 9)) if package_blob else 0
    return {
        "js-runtime": js_bytes,
        "packages": all_packages,
        "total": js_bytes + all_packages,
        "per_language": per_language,
    }


def reference_agreement(
    submission: Path,
    trees: list[tuple[Path, mf.Manifest]],
    ledger_root: Path | None = None,
) -> dict:
    """Classify comparisons and content-address every differing output pair.

    Measured per language and at **every** width in the manifest, not just the
    widest. Measuring python only at 88 hid a real defect once: a submission that
    broke mixed-precedence chains at every operator matched black on 11/12 files,
    because operators.py fits at 88 and the fault only appears at 60. The narrow
    width is where layout decisions are actually forced.

    A matching review accepts a divergence. Any review whose pair changed, now
    agrees, is refused, lacks a reference, or no longer has a corpus comparison is
    stale. Stale review is a hard scorer failure; an unreviewed difference is
    reported against the stage-D 70% review threshold.

    The reference output is read from `corpus/reference/`, generated by
    `harness/gen_reference.py`. A missing file is counted as uncompared and named
    -- never as agreement, and never as divergence.
    """
    ledger_root = ledger_root or REVIEWS
    per_language: dict[str, dict] = {}
    reviews: dict[str, dict[str, review_ledger.Review]] = {}
    seen: dict[str, set[str]] = {}

    def stale(entry: dict, case: str, review: review_ledger.Review, why: str) -> None:
        entry["stale"] += 1
        entry["stale_divergences"].append(
            {"case": case, "why": why, "review": asdict(review)}
        )

    for tree_path, m in trees:
        doc = json.loads(tree_path.read_text())
        source = Path(doc["source_file"])
        stem = source.stem
        try:
            file = source.relative_to(Path("corpus") / "src" / m.name).as_posix()
        except ValueError as exc:
            raise mf.ManifestError(
                f"{m.path.name}: review ledger cannot address source_file "
                f"{source.as_posix()!r}"
            ) from exc
        tokens = leaves(doc["root"])
        if m.name not in reviews:
            reviews[m.name] = review_ledger.load("formatter", m.name, ledger_root)
        language_reviews = reviews[m.name]
        language_seen = seen.setdefault(m.name, set())
        entry = per_language.setdefault(
            m.name,
            {
                "reference": m.reference_version,
                "waived": m.waives_width,
                "agreement": 0,
                "accepted": 0,
                "stale": 0,
                "unreviewed": 0,
                "of": 0,
                "reference_overflow": 0,
                "missing": [],
                "accepted_divergences": [],
                "stale_divergences": [],
                "unreviewed_divergences": [],
                "by_width": {
                    str(width): {
                        "agreement": 0,
                        "accepted": 0,
                        "stale": 0,
                        "unreviewed": 0,
                        "of": 0,
                    }
                    for width in m.widths
                },
            },
        )
        for width in m.widths:
            case = f"{file}@{width}"
            item_id = f"{m.name}/{case}"
            review = language_reviews.get(item_id)
            language_seen.add(item_id)
            path = REFERENCE / f"{m.name}__{stem}@{width}.txt"
            if not path.is_file():
                entry["missing"].append(case)
                if review is not None:
                    stale(
                        entry,
                        case,
                        review,
                        "cannot be checked because its reference is missing",
                    )
                continue
            expected = path.read_text()
            entry["reference_overflow"] += overflow_lines(expected, width, tokens)
            run = invoke(submission / "fmt-rust", tree_path, width)
            entry["of"] += 1
            width_entry = entry["by_width"][str(width)]
            width_entry["of"] += 1
            if not run.ok:
                if review is None:
                    entry["unreviewed"] += 1
                    width_entry["unreviewed"] += 1
                    entry["unreviewed_divergences"].append(f"{case} (refused)")
                else:
                    width_entry["stale"] += 1
                    stale(entry, case, review, "formatter now refuses this case")
            elif run.text == expected:
                if review is None:
                    entry["agreement"] += 1
                    width_entry["agreement"] += 1
                else:
                    # Two different situations wear the same word otherwise.
                    # A divergence that *changed* needs a human to look again; a
                    # divergence that was *resolved* needs nobody -- its verdict
                    # simply has no subject any more. Saying "stale" for both
                    # sends someone to re-review a case that now agrees, and the
                    # only way out is hand-editing the ledger. Name it, and name
                    # the command that clears it.
                    width_entry["stale"] += 1
                    stale(
                        entry,
                        case,
                        review,
                        "resolved: output now agrees with the reference -- "
                        "retire the record with review_formatter.py --retire",
                    )
            else:
                divergence = fd.make(m.name, file, width, run.text, expected)
                item_state = review_ledger.state(divergence.hash, review)
                width_entry[item_state] += 1
                if item_state == "accepted":
                    entry["accepted"] += 1
                    entry["accepted_divergences"].append(
                        {
                            "case": case,
                            "hash": divergence.hash,
                            "review": asdict(review),
                        }
                    )
                elif item_state == "stale":
                    stale(entry, case, review, "formatter divergence changed")
                else:
                    entry["unreviewed"] += 1
                    entry["unreviewed_divergences"].append(
                        {"case": case, "hash": divergence.hash}
                    )

    for language, language_reviews in reviews.items():
        entry = per_language[language]
        for item_id, review in language_reviews.items():
            if item_id not in seen[language]:
                stale(entry, item_id, review, "has no corpus comparison")

    agreement = sum(e["agreement"] for e in per_language.values())
    accepted = sum(e["accepted"] for e in per_language.values())
    stale_count = sum(e["stale"] for e in per_language.values())
    unreviewed = sum(e["unreviewed"] for e in per_language.values())
    of = sum(e["of"] for e in per_language.values())
    coverage = (agreement + accepted) / of if of else 1.0
    width_thresholds = []
    for entry in per_language.values():
        for outcomes in entry["by_width"].values():
            width_of = outcomes["of"]
            width_coverage = (
                (outcomes["agreement"] + outcomes["accepted"]) / width_of
                if width_of
                else 1.0
            )
            outcomes["review_coverage"] = round(width_coverage, 3)
            outcomes["review_threshold_met"] = width_coverage >= 0.7
            width_thresholds.append(outcomes["review_threshold_met"])
    return {
        "agreement": agreement,
        "accepted": accepted,
        "stale": stale_count,
        "unreviewed": unreviewed,
        "of": of,
        "agreement_fraction": round(agreement / of, 3) if of else None,
        "review_coverage": round(coverage, 3),
        "review_threshold": 0.7,
        "review_threshold_met": all(width_thresholds),
        "by_language": per_language,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("submission", type=Path)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--verbose", action="store_true", help="every failure, not the first 20")
    ap.add_argument("--language", help="score only this language")
    args = ap.parse_args()

    known = mf.bootstrap()
    submission = args.submission.resolve()
    manifests = mf.selected(known, args.language)
    pending = awaiting_package(submission, manifests)
    scored = {n: m for n, m in manifests.items() if n not in pending}
    if not scored:
        names = ", ".join(sorted(pending))
        print(f"no package yet for {names}; nothing to score")
        return 0
    rep = score(submission, scored, args.verbose, known)
    rep.pending = sorted(pending)

    if args.json:
        print(json.dumps(rep.__dict__, indent=2))
        return 0 if not rep.disqualified else 1

    print(f"submission: {rep.submission}\n")
    if rep.pending:
        print(f"  awaiting package   {', '.join(rep.pending)} "
              f"(corpus landed, not yet scored)\n")
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
    print(f"  reference agreement          {ra['agreement']}/{ra['of']}")
    print(f"  accepted divergence          {ra['accepted']}/{ra['of']}")
    print(f"  stale review                 {ra['stale']}/{ra['of']}")
    print(f"  unreviewed divergence        {ra['unreviewed']}/{ra['of']}")
    threshold = "met" if ra["review_threshold_met"] else "BELOW AT SOME WIDTH"
    print(
        f"  review coverage              {ra['review_coverage']:.1%} overall "
        f"(per-width floor {ra['review_threshold']:.0%}: {threshold})"
    )
    for lang, e in sorted(ra["by_language"].items()):
        waived = "  [width waived]" if e["waived"] else ""
        print(f"    {lang:10} {e['agreement']:>3} agreement,"
              f" {e['accepted']:>3} accepted,"
              f" {e['stale']:>3} stale,"
              f" {e['unreviewed']:>3} unreviewed / {e['of']:<3}"
              f" vs {e['reference']}"
              f"  (its own overflow: {e['reference_overflow']}){waived}")
        for width, outcomes in e["by_width"].items():
            width_mark = "" if outcomes["review_threshold_met"] else "  [BELOW 70%]"
            print(f"      @{width:<4} {outcomes['agreement']:>3} agreement,"
                  f" {outcomes['accepted']:>3} accepted,"
                  f" {outcomes['stale']:>3} stale,"
                  f" {outcomes['unreviewed']:>3} unreviewed"
                  f" / {outcomes['of']}{width_mark}")
        if e["accepted_divergences"]:
            print("      accepted:")
            for divergence in e["accepted_divergences"]:
                review = divergence["review"]
                print(
                    f"        {divergence['case']}: {review['verdict']} — "
                    f"{review['reason']} ({review['reviewed_by']}, "
                    f"{review['reviewed_at']})"
                )
        if e["stale_divergences"]:
            print("      STALE:")
            for divergence in e["stale_divergences"]:
                print(f"        {divergence['case']}: {divergence['why']}")
        if e["unreviewed_divergences"]:
            cases = [
                item if isinstance(item, str) else item["case"]
                for item in e["unreviewed_divergences"]
            ]
            print(f"      unreviewed: {', '.join(cases)}")
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
    try:
        mf.cli(main)
    except review_ledger.LedgerError as exc:
        raise SystemExit(f"review ledger error: {exc}") from None
