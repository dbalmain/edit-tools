#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Show formatter divergences and record one reviewed verdict.

    ./harness/review_formatter.py <submission-dir> [--language NAME] [--json]
    ./harness/review_formatter.py <submission-dir> --needs-review
    ./harness/review_formatter.py <submission-dir> --approve ID --verdict KIND \
        --reason TEXT --reviewed-by NAME

Every divergence carries its ledger state, and a reviewed one carries the
verdict, reason, reviewer and date it was given. Without that a reviewer cannot
tell an approved difference from one nobody has ever seen, and re-review costs
the whole corpus every run rather than only what moved -- which is the point of
having a ledger at all. `--needs-review` is that filter made explicit.
"""

import argparse
import json
import sys
from dataclasses import asdict
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


def _states(
    records: list[fd.FormatterDivergence],
) -> dict[str, tuple[str, review_ledger.Review | None]]:
    """Each record's ledger state, and the review it was judged against."""
    ledgers: dict[str, dict[str, review_ledger.Review]] = {}
    out = {}
    for record in records:
        if record.language not in ledgers:
            ledgers[record.language] = review_ledger.load("formatter", record.language)
        review = ledgers[record.language].get(record.id)
        out[record.id] = (review_ledger.state(record.hash, review), review)
    return out


def _header(state: str, review: review_ledger.Review | None) -> str:
    if review is None:
        return "state      unreviewed\n"
    if state == "stale":
        return (
            "state      STALE -- both sides are rehashed, and this pair moved\n"
            f"was        {review.verdict}: {review.reason}\n"
            f"           by {review.reviewed_by} at {review.reviewed_at}\n"
            f"           against {review.hash}\n"
        )
    return (
        f"state      accepted -- {review.verdict}\n"
        f"reason     {review.reason}\n"
        f"           by {review.reviewed_by} at {review.reviewed_at}\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("submission", type=Path)
    parser.add_argument("--language")
    parser.add_argument("--json", action="store_true", help="machine-readable records")
    parser.add_argument(
        "--needs-review",
        action="store_true",
        help="only stale and unreviewed divergences",
    )
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

    states = _states(records)
    shown = records
    if args.needs_review:
        shown = [r for r in records if states[r.id][0] != "accepted"]

    if args.json:
        print(
            json.dumps(
                {
                    "divergences": [
                        {
                            **record.as_dict(),
                            "state": states[record.id][0],
                            "review": (
                                None
                                if states[record.id][1] is None
                                else asdict(states[record.id][1])
                            ),
                        }
                        for record in shown
                    ],
                    "problems": problems,
                },
                indent=2,
            )
        )
    else:
        for index, record in enumerate(shown):
            if index:
                print("\n" + "=" * 78 + "\n")
            state, review = states[record.id]
            rendered = record.render()
            head, _, body = rendered.partition("\n")
            print(head)
            print(_header(state, review), end="")
            print(body, end="" if body.endswith("\n") else "\n")
        for problem in problems:
            print(f"ERROR: {problem}", file=sys.stderr)
        if not shown and not problems:
            print(
                "nothing to review"
                if args.needs_review
                else "no formatter divergences"
            )
    return 1 if problems else 0


if __name__ == "__main__":
    try:
        mf.cli(main)
    except review_ledger.LedgerError as exc:
        raise SystemExit(f"review ledger error: {exc}") from None
