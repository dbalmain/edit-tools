#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Show formatter divergences and record one reviewed verdict.

    ./harness/review_formatter.py <submission-dir> [--language NAME] [--json]
    ./harness/review_formatter.py <submission-dir> --approve ID --verdict KIND \
        --reason TEXT --reviewed-by NAME
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import formatter_divergence as fd  # noqa: E402
import manifest as mf  # noqa: E402
import review_ledger  # noqa: E402
import score  # noqa: E402


def divergences(
    submission: Path, trees: list[tuple[Path, mf.Manifest]]
) -> tuple[list[fd.FormatterDivergence], list[str]]:
    records = []
    problems = []
    for tree_path, manifest in trees:
        doc = json.loads(tree_path.read_text(encoding="utf-8"))
        source = Path(doc["source_file"])
        try:
            file = source.relative_to(
                Path("corpus") / "src" / manifest.name
            ).as_posix()
        except ValueError:
            problems.append(
                f"{tree_path.name}: source file {source.as_posix()!r} is outside "
                f"corpus/src/{manifest.name}"
            )
            continue
        for width in manifest.widths:
            case = f"{manifest.name}/{file}@{width}"
            reference = (
                score.REFERENCE / f"{manifest.name}__{source.stem}@{width}.txt"
            )
            if not reference.is_file():
                problems.append(f"{case}: reference output is missing")
                continue
            run = score.invoke(submission / "fmt-rust", tree_path, width)
            if not run.ok:
                problems.append(f"{case}: formatter refused ({run.error})")
                continue
            expected = reference.read_text(encoding="utf-8")
            if run.text != expected:
                records.append(
                    fd.make(manifest.name, file, width, run.text, expected)
                )
    return records, problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("submission", type=Path)
    parser.add_argument("--language")
    parser.add_argument("--json", action="store_true", help="machine-readable records")
    parser.add_argument("--approve", metavar="ID", help="record a verdict for this ID")
    parser.add_argument(
        "--verdict",
        choices=("design-limit", "package-bug", "reference-quirk"),
    )
    parser.add_argument("--reason")
    parser.add_argument("--reviewed-by")
    args = parser.parse_args()

    approval_fields = (args.verdict, args.reason, args.reviewed_by)
    if args.approve is None and any(approval_fields):
        parser.error("--verdict, --reason, and --reviewed-by require --approve")
    if args.approve is not None and not all(approval_fields):
        parser.error("--approve requires --verdict, --reason, and --reviewed-by")

    known = mf.bootstrap()
    selected = mf.selected(known, args.language)
    records, problems = divergences(
        args.submission.resolve(), score.corpus(selected)
    )

    if args.approve is not None:
        matches = [record for record in records if record.id == args.approve]
        if not matches:
            raise review_ledger.LedgerError(
                f"cannot approve {args.approve!r}: it is not a current divergence"
            )
        record = matches[0]
        review_ledger.approve(
            "formatter",
            record.language,
            record.id,
            record.hash,
            args.verdict.replace("-", " "),
            args.reason,
            args.reviewed_by,
        )
        print(f"reviewed {record.id} at {record.hash}")
        return 0

    if args.json:
        print(
            json.dumps(
                {
                    "divergences": [record.as_dict() for record in records],
                    "problems": problems,
                },
                indent=2,
            )
        )
    else:
        for index, record in enumerate(records):
            if index:
                print("\n" + "=" * 78 + "\n")
            rendered = record.render()
            print(rendered, end="" if rendered.endswith("\n") else "\n")
        for problem in problems:
            print(f"ERROR: {problem}", file=sys.stderr)
        if not records and not problems:
            print("no formatter divergences")
    return 1 if problems else 0


if __name__ == "__main__":
    try:
        mf.cli(main)
    except review_ledger.LedgerError as exc:
        raise SystemExit(f"review ledger error: {exc}") from None
