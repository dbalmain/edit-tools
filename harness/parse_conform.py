#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""CST conformance runner: does this parse layer feed our runtimes?

    ./harness/parse_conform.py --adapter 'CMD' [--language NAME]
                              [--suite NAME] [--json] [--verbose] [--limit N]

`docs/parse-layer.md` item 3 asks to promote `docs/tree-interface-probe.md` to
a versioned CST contract with a conformance suite, so that "any parse layer
that passes it feeds both runtimes". This is that suite. The contract it checks
is `docs/cst-contract.md`, and every clause there names the check below that
covers it -- or is marked unchecked, which is the honest half.

**The adapter protocol.** The command is run once per source:

    <adapter> <language>      source bytes on stdin, tree JSON on stdout

Exit 0 with a tree doc `{language, source, root}` on stdout, or non-zero with a
reason on stderr, which the runner records as a refusal. `{adapter}` in the
command string is not substituted; the language is always argv[1], so a shell
wrapper can reorder if it must.

**The suites.**

* `structure` -- the clauses a tree must satisfy on its own terms, checked
  without an oracle. These apply to any language, including one with no frozen
  corpus, which is what makes them the useful half for a new parse layer.
* `clean` -- byte-identical roots against `corpus/trees/`. The hardest bar and
  the least general: it demands the adapter reproduce one grammar's exact node
  inventory.
* `dirty` -- byte-identical roots against `corpus/trees-edited/`, ERROR and
  MISSING included. This is the half no gate in this repo had before.
* `total` -- the adapter must not fail on input, however broken. Error recovery
  is a *requirement*, not a quality: the highlighter's contract is to degrade
  gracefully, and a parser that refuses has nothing to degrade from.

Run the tree-sitter adapter first. It is the positive control and must pass
everything; a failure there is a bug in this runner, not in tree-sitter.

Not on `test.sh` and not in `score.py`, the same way `parity_fuzz.py` is not.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TREES = ROOT / "corpus" / "trees"
EDITED = ROOT / "corpus" / "trees-edited"
SRC = ROOT / "corpus" / "src"
TIMEOUT_S = 30

SUITES = ("structure", "clean", "dirty", "total")


@dataclass
class Check:
    suite: str
    case: str
    clause: str
    ok: bool
    detail: str = ""


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def add(self, suite: str, case: str, clause: str, ok: bool, detail: str = "") -> bool:
        self.checks.append(Check(suite, case, clause, ok, detail))
        return ok

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]


# --------------------------------------------------------------------------
# adapter


@dataclass
class Parsed:
    ok: bool
    doc: dict | None
    error: str


def run_adapter(command: str, language: str, source: bytes) -> Parsed:
    argv = shlex.split(command) + [language]
    try:
        proc = subprocess.run(
            argv, input=source, capture_output=True, timeout=TIMEOUT_S
        )
    except subprocess.TimeoutExpired:
        return Parsed(False, None, f"timeout after {TIMEOUT_S}s")
    except OSError as exc:
        return Parsed(False, None, f"could not execute: {exc}")
    if proc.returncode != 0:
        return Parsed(False, None, proc.stderr.decode("utf-8", "replace").strip()[:400])
    try:
        doc = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return Parsed(False, None, f"stdout is not JSON: {exc}")
    if not isinstance(doc, dict) or "root" not in doc:
        return Parsed(False, None, "stdout is not a tree doc (no `root`)")
    return Parsed(True, doc, "")


# --------------------------------------------------------------------------
# structural clauses
#
# Every clause below was tested against all 234 committed corpus trees before
# it was written down. Two that read plausibly from the probe document are NOT
# here because the corpus falsifies them:
#
#   * "whitespace is never a leaf" -- 131 whitespace-only leaves exist in
#     corpus/trees (grammars reify newlines as tokens).
#   * "leaves have non-empty text" -- 32 zero-width leaves exist, and MISSING
#     nodes add more.
#
# A clause asserted from the prose and never run would have shipped both.


def clause_checks(doc: dict, source: bytes) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    def add(clause: str, ok: bool, detail: str = "") -> None:
        out.append((clause, ok, detail))

    text = doc.get("source")
    add(
        "S1 source round-trips the input bytes",
        isinstance(text, str) and text.encode("utf-8") == source,
        "" if isinstance(text, str) else f"`source` is {type(text).__name__}",
    )
    if not isinstance(text, str):
        return out
    buf = text.encode("utf-8")

    problems: list[str] = []
    seen = {"nodes": 0}

    def walk(node: dict, parent: dict | None) -> None:
        seen["nodes"] += 1
        kind = node.get("type")
        if not isinstance(kind, str) or not kind:
            problems.append(f"node has no string `type`: {node!r:.80}")
            return
        start, end = node.get("start"), node.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            problems.append(f"`{kind}` start/end are not integers")
            return
        if start > end:
            problems.append(f"`{kind}` reversed range {start}..{end}")
        if end > len(buf):
            problems.append(f"`{kind}` range {start}..{end} past source {len(buf)}")
        for edge, off in (("start", start), ("end", end)):
            if 0 <= off <= len(buf) and off < len(buf) and (buf[off] & 0xC0) == 0x80:
                problems.append(f"`{kind}` {edge} {off} splits a UTF-8 character")
        has_text, has_kids = "text" in node, "children" in node
        if has_text and has_kids:
            problems.append(f"`{kind}` carries both `text` and `children`")
        if has_text:
            want = buf[start:end].decode("utf-8", "replace")
            if node["text"] != want:
                problems.append(
                    f"`{kind}` text {node['text']!r:.40} != source[{start}:{end}] "
                    f"{want!r:.40}"
                )
        if parent is not None and not (parent["start"] <= start and end <= parent["end"]):
            problems.append(
                f"`{kind}` {start}..{end} escapes parent `{parent.get('type')}` "
                f"{parent['start']}..{parent['end']}"
            )
        kids = node.get("children") or []
        for i, child in enumerate(kids):
            if not isinstance(child, dict):
                problems.append(f"`{kind}` child {i} is not an object")
                continue
            if i:
                prev = kids[i - 1]
                if isinstance(prev, dict) and isinstance(prev.get("end"), int):
                    if prev["end"] > child.get("start", 0):
                        problems.append(
                            f"`{kind}` children {i - 1},{i} overlap "
                            f"({prev['end']} > {child.get('start')})"
                        )
            walk(child, node)

    root = doc["root"]
    if not isinstance(root, dict):
        add("S2 root is a node", False, f"root is {type(root).__name__}")
        return out
    walk(root, None)

    def only(prefix: str) -> str:
        hits = [p for p in problems if prefix in p]
        return hits[0] if hits else ""

    add("S2 every node has a string `type`", not only("no string `type`"), only("no string `type`"))
    add("S3 ranges are non-reversed", not only("reversed range"), only("reversed range"))
    add("S4 ranges are inside the source", not only("past source"), only("past source"))
    add("S5 offsets are UTF-8 character boundaries", not only("splits a UTF-8"), only("splits a UTF-8"))
    add("S6 a node is a leaf xor an interior", not only("both `text`"), only("both `text`"))
    add("S7 leaf text equals its source slice", not only("!= source["), only("!= source["))
    add("S8 children sit inside their parent", not only("escapes parent"), only("escapes parent"))
    add("S9 siblings are ordered and disjoint", not only("overlap"), only("overlap"))
    # Observed on all 234 corpus trees, and NOT required by the runtime -- the
    # probe showed a root ending at the last `}` formats identically. Reported
    # so a divergence is visible, never failed on.
    whole = root.get("start") == 0 and root.get("end") == len(buf)
    add(
        "S10 root spans the whole source (advisory)",
        True,
        "" if whole else f"root is {root.get('start')}..{root.get('end')}, source is {len(buf)}",
    )
    return out


ADVISORY = ("S10",)


# --------------------------------------------------------------------------
# oracle comparison


def diff_root(got: dict, want: dict, path: str = "root") -> str | None:
    keys = sorted((set(got) | set(want)) - {"children"})
    for key in keys:
        a, b = got.get(key, "<absent>"), want.get(key, "<absent>")
        if a != b:
            return f"{path}.{key}: adapter={a!r:.60} oracle={b!r:.60}"
    g, w = got.get("children", []), want.get("children", [])
    if len(g) != len(w):
        return (
            f"{path}: {len(g)} children from adapter, {len(w)} from oracle\n"
            f"      adapter: {[c.get('type') for c in g]}\n"
            f"      oracle:  {[c.get('type') for c in w]}"
        )
    for i, (a, b) in enumerate(zip(g, w)):
        kind = a.get("type") if a.get("type") == b.get("type") else "?"
        found = diff_root(a, b, f"{path}[{i}:{kind}]")
        if found:
            return found
    return None


# --------------------------------------------------------------------------
# suites


def fixtures(directory: Path, language: str | None, limit: int | None) -> list[Path]:
    found = sorted(directory.glob("*.tree.json"))
    if language:
        found = [p for p in found if p.name.startswith(f"{language}__")]
    return found[:limit] if limit else found


def injected(doc: dict) -> bool:
    """Does this tree splice a second grammar in?

    Injected trees are excluded from the clean suite: a single-language parse
    layer will never produce them, and `corpus/trees-edited/` is injection-free
    for the same reason. Six of the 234 corpus trees are injected.
    """

    def walk(node: dict) -> bool:
        if "language" in node:
            return True
        return any(walk(c) for c in node.get("children", ()))

    return walk(doc["root"])


def run_structure(command: str, language: str | None, limit: int | None, report: Report) -> None:
    for path in fixtures(TREES, language, limit) + fixtures(EDITED, language, limit):
        doc = json.loads(path.read_text())
        source = doc["source"].encode("utf-8")
        got = run_adapter(command, doc["language"], source)
        case = path.name
        if not got.ok:
            report.add("structure", case, "S0 adapter produced a tree", False, got.error)
            continue
        report.add("structure", case, "S0 adapter produced a tree", True)
        for clause, ok, detail in clause_checks(got.doc, source):
            report.add("structure", case, clause, ok or clause[:3] in ADVISORY, detail)


def run_oracle(
    suite: str, directory: Path, command: str, language: str | None,
    limit: int | None, report: Report,
) -> None:
    for path in fixtures(directory, language, limit):
        doc = json.loads(path.read_text())
        if suite == "clean" and injected(doc):
            continue
        source = doc["source"].encode("utf-8")
        got = run_adapter(command, doc["language"], source)
        case = path.name
        clause = "C1 root matches the frozen oracle" if suite == "clean" else \
                 "D1 root matches the frozen oracle, ERROR and MISSING included"
        if not got.ok:
            report.add(suite, case, clause, False, f"refused: {got.error}")
            continue
        found = diff_root(got.doc["root"], doc["root"])
        report.add(suite, case, clause, found is None, found or "")


def run_total(command: str, language: str | None, limit: int | None, report: Report) -> None:
    """Every dirty fixture's source, plus a handful of degenerate buffers.

    The dirty sources are real broken files; the literals are the edges a
    corpus cannot hold -- empty, a lone NUL-free control byte, an unterminated
    construct, a bare multi-byte character.
    """
    cases: list[tuple[str, str, bytes]] = []
    for path in fixtures(EDITED, language, limit):
        doc = json.loads(path.read_text())
        cases.append((doc["language"], path.name, doc["source"].encode("utf-8")))
    langs = sorted({c[0] for c in cases}) or ([language] if language else [])
    for lang in langs:
        for name, blob in (
            ("empty", b""),
            ("newline-only", b"\n"),
            ("lone-cr", b"\r"),
            ("multibyte-only", "é🙂".encode("utf-8")),
            ("unterminated", b'"'),
            ("brace-storm", b"{" * 64),
        ):
            cases.append((lang, f"{lang}/{name}", blob))
    for lang, case, blob in cases:
        got = run_adapter(command, lang, blob)
        report.add(
            "total", case, "T1 adapter returns a tree for any input", got.ok,
            got.error,
        )


# --------------------------------------------------------------------------
# CLI


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--adapter", required=True,
                    help="command; language is appended as argv[1], source on stdin")
    ap.add_argument("--language", help="restrict to one language")
    ap.add_argument("--suite", choices=SUITES, action="append",
                    help="run only this suite (repeatable; default all)")
    ap.add_argument("--limit", type=int, help="at most N fixtures per suite")
    ap.add_argument("--json", action="store_true", help="machine-readable summary")
    ap.add_argument("--verbose", action="store_true", help="print every check")
    args = ap.parse_args()

    suites = args.suite or list(SUITES)
    report = Report()
    if "structure" in suites:
        run_structure(args.adapter, args.language, args.limit, report)
    if "clean" in suites:
        run_oracle("clean", TREES, args.adapter, args.language, args.limit, report)
    if "dirty" in suites:
        run_oracle("dirty", EDITED, args.adapter, args.language, args.limit, report)
    if "total" in suites:
        run_total(args.adapter, args.language, args.limit, report)

    by_suite: dict[str, dict[str, int]] = {}
    for check in report.checks:
        row = by_suite.setdefault(check.suite, {"pass": 0, "fail": 0})
        row["pass" if check.ok else "fail"] += 1

    if args.json:
        json.dump(
            {
                "adapter": args.adapter,
                "suites": by_suite,
                "checks": len(report.checks),
                "failed": [
                    {"suite": c.suite, "case": c.case, "clause": c.clause,
                     "detail": c.detail}
                    for c in report.failed
                ],
            },
            sys.stdout, ensure_ascii=False, indent=2,
        )
        print()
        return 1 if report.failed else 0

    status = "FAIL" if report.failed else "PASS"
    print(f"[{status}] parse-conform  adapter: {args.adapter}")
    for suite in SUITES:
        if suite not in by_suite:
            continue
        row = by_suite[suite]
        mark = "ok" if not row["fail"] else f"{row['fail']} FAILED"
        print(f"  {suite:10} {row['pass']:5d} passed  {mark}")
    if report.failed:
        # Group by clause: a hundred fixtures failing one clause is one
        # finding, and printing it a hundred times hides the other ninety-nine.
        grouped: dict[str, list[Check]] = {}
        for check in report.failed:
            grouped.setdefault(f"{check.suite}/{check.clause}", []).append(check)
        print()
        for clause, checks in sorted(grouped.items()):
            print(f"  {clause}  ({len(checks)} case(s))")
            for check in checks[: (None if args.verbose else 3)]:
                print(f"    {check.case}")
                if check.detail:
                    for line in check.detail.splitlines():
                        print(f"      {line}")
            if not args.verbose and len(checks) > 3:
                print(f"    ... {len(checks) - 3} more (--verbose for all)")
    if args.verbose:
        for check in report.checks:
            if check.ok:
                print(f"  ok   {check.suite:10} {check.case:44} {check.clause}")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
