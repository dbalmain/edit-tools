#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""Report ledger reasons that name a capability which has since shipped.

    ./harness/reason_rot.py [--language NAME] [--json]

`review_ledger.state()` only returns `stale` when the stored hash moves, and
the hash is of the two outputs. A reason can name an opcode or a FINDINGS
entry as missing, that capability can ship, and the record stays `accepted`
because the bytes never changed. This script is the worklist for that case.

It is not a gate. A hit is a candidate for a reviewer of a different model
family; the detector does not edit `harness/reviews/`.

Two channels, both high-recall:

1. The reason cites a FINDINGS entry as the cause, and that entry's status
   now says the capability was built (including "Opcode built" while parked).
2. The reason uses absence language next to an opcode or predicate name that
   `rust/src/pkg.rs` actually implements.

Package JSON is evidence that a capability is in use, not a third matching
channel. Exact English parsing is not on: each hit prints the quoted phrase,
the capability, and why it now exists, so a human can throw it out.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_ledger  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FINDINGS_PATH = ROOT / "docs" / "onboarding" / "FINDINGS.md"
PKG_RS = ROOT / "rust" / "src" / "pkg.rs"
PACKAGES = ROOT / "packages"
REVIEWS = review_ledger.ROOT


# Words that are both IR names and ordinary English. Unquoted, they fire on
# almost every design-limit reason ("pins the group", "each item"). They still
# match when marked as code or collated with "opcode"/"predicate".
_COMMON = frozenset(
    {
        "all",
        "blank",
        "cell",
        "child",
        "count",
        "each",
        "group",
        "hard",
        "indent",
        "line",
        "opt",
        "paren",
        "prefix",
        "seq",
        "soft",
        "sp",
        "text",
        "tok",
        "when",
    }
)


@dataclass(frozen=True)
class Finding:
    number: int
    title: str
    status: str
    built: bool
    related: frozenset[str]


@dataclass(frozen=True)
class Inventory:
    opcodes: frozenset[str]
    predicates: frozenset[str]
    headers: frozenset[str]
    findings: dict[int, Finding]
    package_uses: dict[str, tuple[str, ...]]


@dataclass(frozen=True)
class Hit:
    id: str
    phrase: str
    capability: str
    kind: str
    evidence: tuple[str, ...]

    def as_dict(self) -> dict:
        return asdict(self)


def _quoted_idents(block: str) -> frozenset[str]:
    return frozenset(re.findall(r'"([a-z][a-z0-9-]*)"', block))


def parse_opcodes(source: str) -> frozenset[str]:
    """Opcode names the runtime will accept, from `match op.as_str()`."""
    start = source.index("match op.as_str()")
    end = source.index('unknown opcode', start)
    return _quoted_idents(source[start:end])


def parse_predicates(source: str) -> frozenset[str]:
    """Predicate names from `fn predicate`."""
    start = source.index("fn predicate(")
    end = source.index("unknown predicate", start)
    return _quoted_idents(source[start:end])


def parse_headers(source: str) -> frozenset[str]:
    """Package header fields on `Package`, which FINDINGS also names."""
    start = source.index("pub struct Package {")
    rest = source[start:]
    nxt = re.search(r"\npub (?:struct|enum) ", rest[len("pub struct Package {") :])
    window = rest[: len("pub struct Package {") + nxt.start()] if nxt else rest[:4000]
    return frozenset(re.findall(r"^\s+pub ([a-z_]+):", window, re.M))


def status_is_built(status: str) -> bool:
    """True when the status says the capability shipped.

    `leaning build` and `decided — build it` use `build`, not `built`, and
    stay false. `Opcode built` counts even when the policy is parked.
    """
    return re.search(r"(?i)\bbuilt\b", status) is not None


def _status_line(section: str) -> str:
    match = re.search(
        r"\*\*Status:\*\*\s*(.+?)(?:\s*·\s*\*\*Cost|\n\n)",
        section,
        re.S,
    )
    if match is None:
        match = re.search(r"\*\*Status:\*\*\s*(.+)", section)
        if match is None:
            return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()


# Header fields that are plumbing, not a FINDINGS capability. Matching
# "has no comments" against the `comments` field is a false positive.
_PLUMBING_HEADERS = frozenset(
    {"blank_cap", "comment_gap", "comments", "descend", "indent", "precedence", "rules", "tokens"}
)


def _ticks_in(text: str, known: frozenset[str]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for raw in re.findall(r"`([^`]*)`", text):
        token = raw.strip().strip("\"'")
        if not token:
            continue
        first = token.split()[0].strip(",").lower()
        if first in known and first not in seen:
            seen.add(first)
            found.append(first)
    return found


def _related_names(title: str, status: str, section: str, known: frozenset[str]) -> frozenset[str]:
    """Bind an entry to the IR names it introduced, not every name it mentions.

    Title first (`fill`, `comment_cells`, `flatten`). If the title is a
    prose problem statement (entry 13), take the first opcode/predicate
    the body actually ticks.
    """
    from_title = _ticks_in(title, known)
    if from_title:
        return frozenset(from_title)
    from_status = _ticks_in(status, known)
    if from_status:
        return frozenset(from_status[:3])
    return frozenset(_ticks_in(section, known)[:3])


def parse_findings(text: str, known: frozenset[str]) -> dict[int, Finding]:
    """FINDINGS.md entries keyed by number, with a built/open status."""
    headings = list(re.finditer(r"^## (\d+)\.\s+(.+)$", text, re.M))
    out: dict[int, Finding] = {}
    for index, match in enumerate(headings):
        number = int(match.group(1))
        title = match.group(2).strip()
        start = match.end()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        section = text[start:end]
        status = _status_line(section)
        related = _related_names(title, status, section, known - _PLUMBING_HEADERS)
        out[number] = Finding(
            number=number,
            title=title,
            status=status,
            built=status_is_built(status),
            related=related,
        )
    return out


def _walk_ops(value: object, known: frozenset[str], found: set[str]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in known:
                found.add(key)
            _walk_ops(item, known, found)
        return
    if isinstance(value, list):
        if value and isinstance(value[0], str) and value[0] in known:
            found.add(value[0])
        for item in value:
            _walk_ops(item, known, found)


def parse_package_uses(packages_dir: Path, known: frozenset[str]) -> dict[str, tuple[str, ...]]:
    uses: dict[str, set[str]] = {name: set() for name in known}
    if not packages_dir.is_dir():
        return {name: () for name in known}
    for path in sorted(packages_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        found: set[str] = set()
        _walk_ops(payload, known, found)
        rel = path.name
        for name in found:
            uses[name].add(rel)
    return {name: tuple(sorted(paths)) for name, paths in uses.items()}


def load_inventory(
    *,
    pkg_rs: Path = PKG_RS,
    findings_path: Path = FINDINGS_PATH,
    packages: Path = PACKAGES,
) -> Inventory:
    source = pkg_rs.read_text(encoding="utf-8")
    opcodes = parse_opcodes(source)
    predicates = parse_predicates(source)
    headers = parse_headers(source)
    known = opcodes | predicates | headers
    findings = parse_findings(findings_path.read_text(encoding="utf-8"), known)
    return Inventory(
        opcodes=opcodes,
        predicates=predicates,
        headers=headers,
        findings=findings,
        package_uses=parse_package_uses(packages, known),
    )


# --------------------------------------------------------------------------
# channel 1: a FINDINGS entry cited as the cause, now built


_CITE = re.compile(
    r"(?i)\b(?:FINDINGS(?:\s+entr(?:y|ies))?|existing\s+entr(?:y|ies)|"
    r"entr(?:y|ies))\s+"
    r"(\d+[a-z]?(?:\s*(?:[/&,]|and|plus|with)\s*\d+[a-z]?)*)"
)


def _cite_numbers(cluster: str) -> list[int]:
    return [int(n) for n in re.findall(r"(\d+)[a-z]?", cluster)]


def _cite_is_blocking(reason: str, match: re.Match[str]) -> bool:
    """Drop citations that already treat the entry as fixed, extended, or not-the-cause."""
    before = reason[max(0, match.start() - 28) : match.start()]
    after = reason[match.end() : match.end() + 56]
    before_l = before.lower()
    after_l = after.lower()
    if re.search(r"(?i)\bnot\s+$", before) or before_l.rstrip().endswith("rather than"):
        return False
    if re.match(r"(?i)\s*is fixed\b", after):
        return False
    if re.match(r"(?i)\s*landed\b", after):
        return False
    # "FINDINGS 8's missing extension" / "FINDINGS 8 extension": fill exists;
    # the claim is a further gap, not that entry 8 is still open.
    if re.match(r"(?i)('s missing extension|\s+extension\b)", after):
        return False
    if re.search(r"(?i)\bboundary\b", after_l[:40]):
        return False
    return True


def findings_claims(reason: str, inv: Inventory) -> list[Hit]:
    hits: list[Hit] = []
    seen: set[int] = set()
    for match in _CITE.finditer(reason):
        if not _cite_is_blocking(reason, match):
            continue
        phrase = match.group(0).strip()
        for number in _cite_numbers(match.group(1)):
            if number in seen:
                continue
            finding = inv.findings.get(number)
            if finding is None or not finding.built:
                continue
            seen.add(number)
            hits.append(
                Hit(
                    id="",
                    phrase=phrase,
                    capability=f"FINDINGS {number}",
                    kind="findings",
                    evidence=_findings_evidence(finding, inv),
                )
            )
    return hits


def _findings_evidence(finding: Finding, inv: Inventory) -> tuple[str, ...]:
    lines = [f'FINDINGS {finding.number} status is {finding.status!r}']
    for name in sorted(finding.related):
        lines.extend(_name_evidence(name, inv))
    if finding.related:
        return tuple(lines)
    # A built entry with no IR name in the excerpt still shipped.
    return tuple(lines)


# --------------------------------------------------------------------------
# channel 2: absence language next to an implemented name


def _absence_patterns(name: str) -> list[re.Pattern[str]]:
    ident = re.escape(name)
    # Stop at a hyphen so `group` does not fire inside `group-fit`.
    end = r"(?![A-Za-z0-9_-])"
    marked = rf"(?:`{ident}`|{ident})"
    return [
        re.compile(rf"(?i)\blacks\s+(?:the\s+)?{marked}{end}"),
        re.compile(rf"(?i)\bmissing\s+(?:the\s+)?{marked}{end}"),
        re.compile(rf"(?i)\bproposed\s+{marked}(?:\s+opcode|\s+predicate)?{end}"),
        re.compile(rf"(?i)\bno\s+{marked}\s+(?:opcode|predicate)\b"),
        re.compile(rf"(?i)\bhas no\s+{marked}{end}"),
        re.compile(rf"(?i)\bthere is no\s+{marked}{end}"),
        re.compile(rf"(?i)\bwithout (?:an? )?(?:opcode|predicate) for\s+{marked}{end}"),
        re.compile(rf"(?i)\bthe IR (?:still )?lacks\s+{marked}{end}"),
        re.compile(rf"(?i)(?:no|missing|proposed)\s+[^.{{]{{0,40}}\b{marked}\s+opcode\b"),
        re.compile(rf"(?i)\b{marked}\s+opcode\b"),
        re.compile(rf"(?i)`{ident}`"),
    ]


def _opcode_match_is_absence(reason: str, match: re.Match[str], name: str) -> bool:
    """The name appears in an absence claim, not as an existing tool."""
    snippet = match.group(0)
    lower = snippet.lower()
    # Tight patterns already encode absence (`lacks fill`, `no drop opcode`)
    # except the last two, which only require a marked name / "X opcode".
    if re.search(
        r"(?i)^\s*(lacks|missing|proposed|no|has no|there is no|"
        r"without|the ir)\b",
        lower,
    ):
        return True
    if re.search(
        r"(?i)\b(lacks|missing|proposed|has no|there is no|no opcode|cannot express)\b",
        lower,
    ):
        return True
    start = match.start()
    window = reason[max(0, start - 48) : match.end() + 16]
    if not re.search(
        r"(?i)\b(lacks|missing|proposed|has no|there is no|no opcode|"
        r"cannot express|not present|still lacks)\b",
        window,
    ):
        return False
    # "existing flatten cannot" / "current fill" / "`fill` was applied":
    # the name is in use, the claim is a remaining limit.
    if re.search(
        r"(?i)\b(existing|current|now |already |applied |uses |using )\b",
        window,
    ):
        return False
    if name in _COMMON and "`" not in snippet and "opcode" not in lower and "predicate" not in lower:
        return False
    return True


def name_claims(reason: str, inv: Inventory) -> list[Hit]:
    hits: list[Hit] = []
    seen: set[str] = set()
    # Channel 2 names opcodes and predicates, not package headers:
    # "this number array has no comments" is English, not a missing field.
    ir_names = inv.opcodes | inv.predicates
    # Longer names first so `source-multiline` wins over `multiline`.
    for name in sorted(ir_names, key=len, reverse=True):
        if name in seen:
            continue
        for pattern in _absence_patterns(name):
            match = pattern.search(reason)
            if match is None:
                continue
            if not _opcode_match_is_absence(reason, match, name):
                continue
            if name in _COMMON and "opcode" not in match.group(0).lower() and "`" not in match.group(0):
                # `lacks group` is a real IR claim. `has no group to break`
                # is ordinary English about a missing wrapper, not the opcode.
                if not re.match(r"(?i)\s*(the ir (?:still )?lacks|lacks|missing|proposed)\b", match.group(0)):
                    continue
            kind = (
                "opcode"
                if name in inv.opcodes
                else "predicate"
                if name in inv.predicates
                else "header"
            )
            seen.add(name)
            hits.append(
                Hit(
                    id="",
                    phrase=match.group(0).strip(),
                    capability=name,
                    kind=kind,
                    evidence=_name_evidence(name, inv),
                )
            )
            break
    return hits


def _name_evidence(name: str, inv: Inventory) -> tuple[str, ...]:
    lines = []
    if name in inv.opcodes:
        lines.append(f"{name} is an opcode in rust/src/pkg.rs")
    if name in inv.predicates:
        lines.append(f"{name} is a predicate in rust/src/pkg.rs")
    if name in inv.headers:
        lines.append(f"{name} is a package header field in rust/src/pkg.rs")
    users = inv.package_uses.get(name, ())
    if users:
        shown = ", ".join(users[:6])
        extra = "" if len(users) <= 6 else f" (+{len(users) - 6})"
        lines.append(f"used by packages/{shown}{extra}")
    else:
        lines.append(f"no shipped package uses {name} yet")
    return tuple(lines)


# --------------------------------------------------------------------------
# scan


def scan_reason(reason: str, inv: Inventory, record_id: str = "") -> list[Hit]:
    """Extract now-false capability claims from one reason string."""
    hits = findings_claims(reason, inv) + name_claims(reason, inv)
    # Same capability via both channels is one work-item.
    deduped: list[Hit] = []
    seen: set[tuple[str, str]] = set()
    for hit in hits:
        key = (hit.kind, hit.capability)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(
            Hit(
                id=record_id,
                phrase=hit.phrase,
                capability=hit.capability,
                kind=hit.kind,
                evidence=hit.evidence,
            )
        )
    return deduped


def scan_review(review: review_ledger.Review, inv: Inventory) -> list[Hit]:
    return scan_reason(review.reason, inv, review.id)


def load_reviews(
    kind: str = "formatter",
    language: str | None = None,
    *,
    root: Path = REVIEWS,
) -> list[review_ledger.Review]:
    reviews = []
    kind_dir = root / kind
    if not kind_dir.is_dir():
        return []
    paths = sorted(kind_dir.glob("*.jsonl"))
    if language is not None:
        paths = [p for p in paths if p.stem == language]
    for path in paths:
        reviews.extend(review_ledger.load(kind, path.stem, root).values())
    return reviews


def scan(
    kind: str = "formatter",
    language: str | None = None,
    *,
    inv: Inventory | None = None,
    root: Path = REVIEWS,
) -> list[Hit]:
    inventory = inv if inv is not None else load_inventory()
    hits: list[Hit] = []
    for review in load_reviews(kind, language, root=root):
        hits.extend(scan_review(review, inventory))
    return hits


def render(hits: list[Hit], of: int) -> str:
    if not hits:
        return f"reason-rot: 0 hits in {of} records\n"
    lines = [f"reason-rot: {len(hits)} hits in {of} records", ""]
    # Group by record so a FINDINGS cite and an opcode name print together.
    by_id: dict[str, list[Hit]] = {}
    for hit in hits:
        by_id.setdefault(hit.id, []).append(hit)
    for record_id, group in by_id.items():
        lines.append(record_id)
        for hit in group:
            lines.append(f'  phrase      {hit.phrase!r}')
            lines.append(f"  capability  {hit.capability} ({hit.kind})")
            for item in hit.evidence:
                lines.append(f"  evidence    {item}")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--language", help="only this language's ledger")
    ap.add_argument("--json", action="store_true", help="machine-readable hits")
    ap.add_argument(
        "--kind",
        default="formatter",
        choices=sorted(review_ledger.KINDS),
        help="ledger kind (default: formatter)",
    )
    args = ap.parse_args(argv)

    inv = load_inventory()
    reviews = load_reviews(args.kind, args.language)
    hits = []
    for review in reviews:
        hits.extend(scan_review(review, inv))

    if args.json:
        print(
            json.dumps(
                {
                    "kind": args.kind,
                    "language": args.language,
                    "records": len(reviews),
                    "hits": [hit.as_dict() for hit in hits],
                },
                indent=2,
            )
        )
        return 0
    sys.stdout.write(render(hits, len(reviews)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
