"""Content-addressed review records shared by both scorers.

Records live one-per-line in per-language JSONL files. Updating one verdict
therefore changes one line, and onboarding languages in parallel does not make
every builder edit the same ledger.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "reviews"
KINDS = {"formatter", "highlight"}
FIELDS = {"id", "hash", "verdict", "reason", "reviewed_by", "reviewed_at"}
HASH = re.compile(r"[0-9a-f]{64}")


class LedgerError(Exception):
    """A ledger is malformed or an approval request is invalid."""


@dataclass(frozen=True)
class Review:
    id: str
    hash: str
    verdict: str
    reason: str
    reviewed_by: str
    reviewed_at: str


def path_for(kind: str, language: str, root: Path = ROOT) -> Path:
    if kind not in KINDS:
        raise LedgerError(f"unknown review kind {kind!r}")
    if not language or "/" in language or language in {".", ".."}:
        raise LedgerError(f"invalid ledger language {language!r}")
    return root / kind / f"{language}.jsonl"


def _nonempty(value: object, field: str, path: Path, line: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LedgerError(
            f"{path}: line {line}: `{field}` must be a non-empty string"
        )
    return value.strip()


def _parse(raw: object, path: Path, line: int) -> Review:
    if not isinstance(raw, dict):
        raise LedgerError(f"{path}: line {line}: review must be an object")
    unknown = set(raw) - FIELDS
    missing = FIELDS - set(raw)
    if unknown:
        raise LedgerError(f"{path}: line {line}: unknown field(s) {sorted(unknown)}")
    if missing:
        raise LedgerError(f"{path}: line {line}: missing field(s) {sorted(missing)}")
    digest = _nonempty(raw["hash"], "hash", path, line)
    if HASH.fullmatch(digest) is None:
        raise LedgerError(f"{path}: line {line}: `hash` must be 64 lowercase hex digits")
    reviewed_at = _nonempty(raw["reviewed_at"], "reviewed_at", path, line)
    try:
        timestamp = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise LedgerError(
            f"{path}: line {line}: `reviewed_at` must be an ISO 8601 timestamp"
        ) from exc
    if timestamp.tzinfo is None:
        raise LedgerError(
            f"{path}: line {line}: `reviewed_at` must include a timezone"
        )
    return Review(
        id=_nonempty(raw["id"], "id", path, line),
        hash=digest,
        verdict=_nonempty(raw["verdict"], "verdict", path, line),
        reason=_nonempty(raw["reason"], "reason", path, line),
        reviewed_by=_nonempty(raw["reviewed_by"], "reviewed_by", path, line),
        reviewed_at=reviewed_at,
    )


def load(kind: str, language: str, root: Path = ROOT) -> dict[str, Review]:
    path = path_for(kind, language, root)
    if not path.is_file():
        return {}
    records = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            raise LedgerError(f"{path}: line {line_number}: blank lines are not allowed")
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LedgerError(f"{path}: line {line_number}: malformed JSON ({exc})") from exc
        record = _parse(raw, path, line_number)
        if record.id in records:
            raise LedgerError(f"{path}: line {line_number}: duplicate id {record.id!r}")
        records[record.id] = record
    return records


#: The one verdict that is not an acceptance. `design-limit`, `reference-quirk`
#: and `house-rule` all say the divergence is *settled* -- we could not, or we
#: chose not to. `package-bug` says the opposite: we could, and did not. It must
#: not count toward the merge bar, or a package reaches the floor by documenting
#: that it is broken. Rust's stage D printed `threshold_met: True` on six of
#: them while its reviewer said `escalate`; both were right, which is the bug.
DEFECT_VERDICT = "package bug"


def state(digest: str, review: Review | None) -> str:
    if review is None:
        return "unreviewed"
    if review.hash != digest:
        return "stale"
    if review.verdict.replace("-", " ").strip().lower() == DEFECT_VERDICT:
        return "defect"
    return "accepted"


def summary(states: list[str], threshold: float = 0.7) -> dict:
    counts = {
        name: states.count(name)
        for name in ("accepted", "stale", "unreviewed", "defect")
    }
    total = len(states)
    accepted_fraction = counts["accepted"] / total if total else 1.0
    return {
        **counts,
        "of": total,
        "accepted_fraction": round(accepted_fraction, 3),
        "threshold": threshold,
        "threshold_met": accepted_fraction >= threshold,
    }


def approve(
    kind: str,
    language: str,
    item_id: str,
    digest: str,
    verdict: str,
    reason: str,
    reviewed_by: str,
    *,
    root: Path = ROOT,
    reviewed_at: str | None = None,
) -> Review:
    path = path_for(kind, language, root)
    values = {
        "id": item_id,
        "hash": digest,
        "verdict": verdict,
        "reason": reason,
        "reviewed_by": reviewed_by,
        "reviewed_at": reviewed_at
        or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    record = _parse(values, path, 1)
    records = load(kind, language, root)
    path.parent.mkdir(parents=True, exist_ok=True)

    lines = []
    replaced = False
    for existing in records.values():
        if existing.id == record.id:
            lines.append(record)
            replaced = True
        else:
            lines.append(existing)
    if not replaced:
        lines.append(record)
    path.write_text(
        "".join(json.dumps(asdict(item), ensure_ascii=False) + "\n" for item in lines),
        encoding="utf-8",
    )
    return record


def retire(kind: str, language: str, item_id: str, *, root: Path = ROOT) -> Review:
    """Drop a record whose case no longer exists, and return what was dropped.

    Retiring is not a soft delete of a verdict someone disagrees with: it is the
    only correct response to a divergence that has been *fixed*. The reason a
    record can be removed at all is that its subject is gone, so there is
    nothing left to have an opinion about. A record whose divergence merely
    *changed* must be re-judged with `approve`, never retired -- that is the
    case the content hash exists to catch, and quietly deleting it is exactly
    the failure the ledger was built to prevent.

    Callers are responsible for establishing that the case now agrees; this
    function does not re-run the formatter.
    """
    records = load(kind, language, root)
    if item_id not in records:
        raise LedgerError(f"no review to retire for {item_id!r}")
    dropped = records.pop(item_id)
    path = path_for(kind, language, root)
    if records:
        path.write_text(
            "".join(
                json.dumps(asdict(item), ensure_ascii=False) + "\n"
                for item in records.values()
            ),
            encoding="utf-8",
        )
    else:
        path.unlink()
    return dropped
