#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check Rust/JS highlight identity, span partitioning, and committed goldens.

    ./harness/score_highlight.py <submission-dir> [--json] [--verbose]
        [--language NAME] [--update]

Unlike the formatter scorer, this has no reference implementation and no
idempotence or non-destruction gates. Trees with no available package in any
language region are reported as unhighlighted and are not failures.
"""

import argparse
import gzip
import hashlib
import json
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_ledger  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TREE_DIRS = (
    ROOT / "corpus" / "trees",
    ROOT / "corpus" / "trees-dirty",
    ROOT / "corpus" / "trees-injected",
)
GOLDENS = ROOT / "corpus" / "highlight"
REVIEWS = review_ledger.ROOT


@dataclass
class Run:
    ok: bool
    output: bytes = b""
    error: str = ""


@dataclass
class Report:
    submission: str
    trees: dict = field(default_factory=dict)
    gates: dict = field(default_factory=dict)
    sizes: dict = field(default_factory=dict)
    updated: list[str] = field(default_factory=list)
    detail: list[str] = field(default_factory=list)
    advisory: dict = field(default_factory=dict)
    reviews: dict = field(default_factory=dict)

    @property
    def failed(self) -> bool:
        return (
            not all(gate["pass"] for gate in self.gates.values())
            or self.reviews.get("stale", 0) > 0
        )


def invoke(executable: Path, tree: Path, packages: dict[str, Path]) -> Run:
    try:
        proc = subprocess.run(
            [
                str(executable),
                str(tree),
                *(f"{language}={path}" for language, path in sorted(packages.items())),
            ],
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return Run(ok=False, error="timeout after 60s")
    except OSError as exc:
        return Run(ok=False, error=f"could not execute: {exc}")
    if proc.returncode != 0:
        error = proc.stderr.decode("utf-8", "replace").strip()
        return Run(ok=False, error=error[:200] or f"exit status {proc.returncode}")
    return Run(ok=True, output=proc.stdout)


def corpus(only: str | None) -> list[tuple[Path, dict]]:
    trees = []
    for directory in TREE_DIRS:
        for path in sorted(directory.glob("*.tree.json")):
            try:
                tree = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                sys.exit(f"malformed tree {path}: {exc}")
            language = tree.get("language")
            if not isinstance(language, str) or not language:
                sys.exit(
                    f"malformed tree {path}: `language` must be a non-empty string"
                )
            if only is None or language == only:
                trees.append((path, tree))
    if only is not None and not trees:
        known = sorted(
            {
                json.loads(path.read_text(encoding="utf-8")).get("language")
                for directory in TREE_DIRS
                for path in directory.glob("*.tree.json")
            }
        )
        sys.exit(f"no trees for {only!r}; known: {', '.join(known)}")
    return trees


def package_scopes(path: Path) -> set[str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"malformed package: {exc}") from exc
    scopes = raw.get("scopes")
    if not isinstance(scopes, list) or any(
        not isinstance(scope, str) for scope in scopes
    ):
        raise ValueError("malformed package: `scopes` must be a list of strings")
    return set(scopes)


def tree_languages(tree: dict) -> set[str]:
    languages = {tree["language"]}
    pending = [tree.get("root")]
    while pending:
        node = pending.pop()
        if not isinstance(node, dict):
            continue
        language = node.get("language")
        if isinstance(language, str) and language:
            languages.add(language)
        children = node.get("children")
        if isinstance(children, list):
            pending.extend(children)
    return languages


def partition_error(spans: object, scopes: set[str], source: str) -> str | None:
    if not isinstance(spans, list):
        return "span output must be a list"
    previous = None
    for index, span in enumerate(spans):
        if not isinstance(span, dict) or set(span) != {"start", "end", "scope"}:
            return f"span {index} must contain exactly start, end, and scope"
        start, end, scope = span["start"], span["end"], span["scope"]
        if type(start) is not int or type(end) is not int or not isinstance(scope, str):
            return f"span {index} has invalid field types"
        if start < 0 or start >= end:
            return f"span {index} has invalid range [{start}, {end})"
        if end > len(source.encode("utf-8")):
            return f"span {index} ends outside the UTF-8 source at {end}"
        if scope not in scopes:
            return f"span {index} emits unlisted scope {scope!r}"
        if previous is not None:
            prior_key = (previous["start"], previous["end"])
            if prior_key > (start, end):
                return f"span {index} is out of order"
            if previous["end"] > start:
                return f"span {index} overlaps its predecessor"
            if previous["end"] == start and previous["scope"] == scope:
                return f"span {index} is adjacent to the same scope and was not merged"
        previous = span
    return None


def whitespace_spans(spans: list[dict], source: str) -> dict[str, dict[str, list]]:
    source_bytes = source.encode("utf-8")
    groups = {"entirely": {}, "trailing": {}}
    for span in spans:
        text = source_bytes[span["start"] : span["end"]].decode(
            "utf-8", errors="replace"
        )
        category = None
        if text and text.isspace():
            category = "entirely"
        elif text and text[-1].isspace():
            category = "trailing"
        if category is not None:
            groups[category].setdefault(span["scope"], []).append(
                {"start": span["start"], "end": span["end"], "text": text}
            )
    return groups


def golden_path(tree_path: Path) -> Path:
    stem = tree_path.name.removesuffix(".tree.json")
    return GOLDENS / f"{stem}.spans.json"


def spans_hash(spans: object) -> str:
    encoded = json.dumps(
        spans, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _gate(got: int, total: int, what: str) -> dict:
    return {"pass": got == total, "got": got, "of": total, "what": what}


def package_sizes(submission: Path, only: str | None) -> dict:
    paths = sorted((submission / "packages").glob("*.highlight.json"))
    if only is not None:
        paths = [path for path in paths if path.name == f"{only}.highlight.json"]
    per_language = {}
    blobs = []
    for path in paths:
        data = path.read_bytes()
        blobs.append(data)
        language = path.name.removesuffix(".highlight.json")
        per_language[language] = {
            "raw": len(data),
            "gzip": len(gzip.compress(data, 9)),
        }
    combined = b"".join(blobs)
    return {
        "raw": len(combined),
        "gzip": len(gzip.compress(combined, 9)) if combined else 0,
        "per_language": per_language,
    }


def score(submission: Path, only: str | None, update: bool, verbose: bool) -> Report:
    report = Report(submission=submission.name)
    rust = submission / "rust" / "target" / "release" / "hl-rust"
    js = submission / "hl-js"
    all_trees = corpus(only)
    highlighted = []
    unhighlighted = []
    scopes_by_language = {}
    notes = []
    whitespace = {"entirely": {}, "trailing": {}}
    review_items = []
    reviews_by_language = {}
    package_paths = {
        path.name.removesuffix(".highlight.json"): path
        for path in (submission / "packages").glob("*.highlight.json")
    }

    destinations = {}
    for tree_path, tree in all_trees:
        language = tree["language"]
        packages = {
            name: package_paths[name]
            for name in tree_languages(tree)
            if name in package_paths
        }
        if not packages:
            unhighlighted.append({"tree": tree_path.name, "language": language})
            continue
        destination = golden_path(tree_path)
        if destination in destinations:
            sys.exit(
                f"golden collision: {destinations[destination]} and {tree_path} "
                f"both map to {destination.name}"
            )
        destinations[destination] = tree_path
        highlighted.append((tree_path, tree, packages, destination))
        if language not in reviews_by_language:
            reviews_by_language[language] = review_ledger.load(
                "highlight", language, REVIEWS
            )

    identity = partition = golden = 0
    for tree_path, tree, packages, destination in highlighted:
        tag = tree_path.name
        try:
            scopes = {"error"}
            for language, package in packages.items():
                if language not in scopes_by_language:
                    scopes_by_language[language] = package_scopes(package)
                scopes.update(scopes_by_language[language])
        except ValueError as exc:
            notes.append(f"{tag}: {exc}")
            continue

        rust_run = invoke(rust, tree_path, packages)
        js_run = invoke(js, tree_path, packages)
        if not rust_run.ok or not js_run.ok:
            which, error = (
                ("rust", rust_run.error) if not rust_run.ok else ("js", js_run.error)
            )
            notes.append(f"{tag}: {which} produced no span output ({error})")
            continue
        if rust_run.output != js_run.output:
            notes.append(f"{tag}: rust and js span JSON differs byte-for-byte")
            continue
        identity += 1

        try:
            spans = json.loads(rust_run.output)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            notes.append(f"{tag}: malformed span JSON ({exc})")
            continue
        problem = partition_error(spans, scopes, tree.get("source", ""))
        if problem is not None:
            notes.append(f"{tag}: {problem}")
            continue
        partition += 1

        for category, scopes_with_spans in whitespace_spans(
            spans, tree.get("source", "")
        ).items():
            for scope, items in scopes_with_spans.items():
                destination_group = whitespace[category].setdefault(scope, [])
                destination_group.extend({"tree": tag, **item} for item in items)

        if update:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(spans, indent=2) + "\n", encoding="utf-8")
            report.updated.append(destination.name)
        if not destination.is_file():
            notes.append(f"{tag}: missing golden {destination.name}; run with --update")
            continue
        try:
            expected = json.loads(destination.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            notes.append(f"{tag}: malformed golden {destination.name} ({exc})")
            continue
        item_id = tree_path.name.removesuffix(".tree.json")
        language_reviews = reviews_by_language[tree["language"]]
        review = language_reviews.get(item_id)
        digest = spans_hash(expected)
        item_state = review_ledger.state(digest, review)
        review_items.append(
            {
                "id": item_id,
                "language": tree["language"],
                "hash": digest,
                "state": item_state,
                "review": asdict(review) if review is not None else None,
            }
        )
        if spans != expected:
            notes.append(f"{tag}: span stream differs from {destination.name}")
            continue
        golden += 1

    seen_review_ids = {item["id"] for item in review_items}
    for language, language_reviews in reviews_by_language.items():
        for item_id, review in language_reviews.items():
            if item_id not in seen_review_ids:
                review_items.append(
                    {
                        "id": item_id,
                        "language": language,
                        "hash": None,
                        "state": "stale",
                        "why": "has no current reviewable golden",
                        "review": asdict(review),
                    }
                )

    total = len(highlighted)
    report.trees = {
        "discovered": len(all_trees),
        "highlighted": total,
        "unhighlighted": unhighlighted,
    }
    report.gates = {
        "identity": _gate(identity, total, "hl-rust and hl-js byte-identical"),
        "partition": _gate(partition, total, "ordered, bounded, listed, merged spans"),
        "golden": _gate(golden, total, "span stream matches committed golden"),
    }
    report.sizes = package_sizes(submission, only)
    report.detail = notes if verbose else notes[:20]
    report.advisory = {
        "note": "advisory only; whitespace spans do not affect gates",
        "whitespace": {
            category: dict(sorted(scopes_with_spans.items()))
            for category, scopes_with_spans in whitespace.items()
        },
    }
    report.reviews = {
        **review_ledger.summary([item["state"] for item in review_items]),
        "items": review_items,
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("submission", type=Path)
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument(
        "--verbose", action="store_true", help="every failure, not the first 20"
    )
    parser.add_argument("--language", help="score only this tree language")
    parser.add_argument("--update", action="store_true", help="rewrite span goldens")
    parser.add_argument("--approve", metavar="TREE", help="record a review for one golden")
    parser.add_argument("--verdict")
    parser.add_argument("--reason")
    parser.add_argument("--reviewed-by")
    args = parser.parse_args()

    approval_fields = (args.verdict, args.reason, args.reviewed_by)
    if args.approve is None and any(approval_fields):
        parser.error("--verdict, --reason, and --reviewed-by require --approve")
    if args.approve is not None and not all(approval_fields):
        parser.error("--approve requires --verdict, --reason, and --reviewed-by")
    if args.approve is not None and args.update:
        parser.error("--approve and --update must be separate review steps")

    report = score(args.submission.resolve(), args.language, args.update, args.verbose)
    if args.approve is not None:
        matches = [item for item in report.reviews["items"] if item["id"] == args.approve]
        if not matches:
            raise review_ledger.LedgerError(
                f"cannot approve {args.approve!r}: it is not a current golden"
            )
        item = matches[0]
        review_ledger.approve(
            "highlight",
            item["language"],
            item["id"],
            item["hash"],
            args.verdict,
            args.reason,
            args.reviewed_by,
            root=REVIEWS,
        )
        report = score(args.submission.resolve(), args.language, False, args.verbose)
    if args.json:
        print(json.dumps(report.__dict__, indent=2))
        return 1 if report.failed else 0

    print(f"highlight submission: {report.submission}\n")
    trees = report.trees
    print(f"  trees              {trees['highlighted']}/{trees['discovered']} highlighted")
    for item in trees["unhighlighted"]:
        print(f"    unhighlighted    {item['tree']} ({item['language']})")
    for name, gate in report.gates.items():
        mark = "PASS" if gate["pass"] else "FAIL"
        print(f"  [{mark}] {name:12} {gate['got']:>3}/{gate['of']:<3}  {gate['what']}")

    print("\n  package sizes")
    for language, size in report.sizes["per_language"].items():
        print(f"    {language:10} {size['raw']:>6} B raw  {size['gzip']:>6} B gzip")
    print(
        f"    {'all':10} {report.sizes['raw']:>6} B raw  "
        f"{report.sizes['gzip']:>6} B gzip"
    )
    print("\n  advisory: whitespace spans (does not affect gates)")
    labels = {
        "entirely": "entirely whitespace",
        "trailing": "non-whitespace ending in whitespace",
    }
    whitespace = report.advisory["whitespace"]
    if not any(whitespace.values()):
        print("    none")
    for category, label in labels.items():
        if not whitespace[category]:
            continue
        print(f"    {label}")
        for scope, items in whitespace[category].items():
            print(f"      {scope} ({len(items)})")
            for item in items:
                rendered = json.dumps(item["text"])
                print(
                    f"        {item['tree']} [{item['start']}, {item['end']}) "
                    f"{rendered}"
                )
    reviews = report.reviews
    threshold = "met" if reviews["threshold_met"] else "BELOW THRESHOLD"
    print("\n  golden reviews")
    print(
        f"    {reviews['accepted']} accepted, {reviews['stale']} stale, "
        f"{reviews['unreviewed']} unreviewed / {reviews['of']}"
    )
    print(
        f"    coverage {reviews['accepted_fraction']:.1%} "
        f"(floor {reviews['threshold']:.0%}: {threshold})"
    )
    for item in reviews["items"]:
        if item["state"] != "accepted":
            print(f"    {item['state']:10} {item['id']}")
    if report.updated:
        print(f"\n  updated {len(report.updated)} golden(s)")
    if report.detail:
        print("\nfailures:")
        for note in report.detail:
            print(f"  {note}")
    verdict = "highlight gates failed" if report.failed else "highlight gates passed"
    print(f"\n{verdict}")
    return 1 if report.failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except review_ledger.LedgerError as exc:
        raise SystemExit(f"review ledger error: {exc}") from None
