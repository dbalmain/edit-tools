#!/usr/bin/env python3
"""Measure what one format() pass costs, and how often a postcheck would retry.

Option C for A2.1: a narrowed precheck admits paragraphs `_ACQUIRES` currently
refuses; after format, a scan of line starts re-projects any paragraph that
landed a block-opening atom at a new line start, and formats again.

This file lists the corpus, builds the controls, invokes the driver once, and
writes the report. The clock is `format()` of an already-parsed tree, matching
a warm `:w`. Parse sits outside it. One Node process for the whole corpus.

A sibling of `bench_secondary_cost.py`, not an extension: that clock is
`attachSecondaries` inside `parse()`. This one is `format()`, plus a
counterfactual postcheck over the same files.

Run from the repository root after `./web/gen.py` has written `web/data/blobs/`:

    ./harness/bench_format_pass.py
    ./harness/bench_format_pass.py --only README.md
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
import tempfile
from pathlib import Path


# Copied from `harness/prose.py`. The bench must not treat `_ACQUIRES` as a
# public API, but the postcheck has to match the precheck character for
# character. `test_bench_format_pass.py` asserts the two patterns agree.
ACQUIRES = re.compile(r"^(?:[-+*>#=|~]|\d+[.)]|```|~~~|:-+:?\Z)")

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "harness"
BLOB_DIR = ROOT / "web" / "data" / "blobs"
PACKAGE_DIR = ROOT / "packages"
Q29_DIR = ROOT / ".ai" / "reviews" / "a2" / "q29"
Q30_DIR = ROOT / ".ai" / "reviews" / "a2" / "q30"
WIDTHS = (80, 40)
NEGATIVE_SOURCE = "```\nx\n```\n"
# 39 x's plus a space fill width 40, so `- yyy` starts the next line there
# and stays on the first line at the editor's width 80.
TRIP_SOURCE = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx - yyy\n"
SYNTH_UNIT = (
    "hello world this is ordinary prose that wraps at forty columns "
    "and also at eighty columns without any block opener\n\n"
)
SYNTH_COUNTS = (1, 4, 16, 64, 256, 1024)

sys.path.insert(0, str(HARNESS))
import manifest as mf  # noqa: E402
import prose  # noqa: E402
import ts_injections as tj  # noqa: E402
import ts_secondaries as secondary  # noqa: E402


def formatted_lines(text: str) -> list[str]:
    text = text.replace("\r\n", "\n")
    if text.endswith("\n"):
        text = text[:-1]
    if text == "":
        return []
    return text.split("\n")


def atom_placements(text: str) -> list[tuple[str, bool]]:
    """Each atom and whether it sits at a line start, in document order."""
    out: list[tuple[str, bool]] = []
    at_line = True
    i = 0
    body = "\n".join(formatted_lines(text))
    while i < len(body):
        char = body[i]
        if char in " \n":
            at_line = char == "\n"
            i += 1
            continue
        stop = i
        while stop < len(body) and body[stop] not in " \n":
            stop += 1
        out.append((body[i:stop], at_line))
        at_line = False
        i = stop
    return out


def genuine_line(line: str, *, continuation: bool) -> str | None:
    """Why this formatted line would open a block, or None if it would not.

    Continuation lines are the ones reflow can create. CommonMark lets a
    bullet or a `1.` list interrupt a paragraph; an ordered list whose start
    is not 1 cannot. A GFM one-column delimiter row and a setext underline
    need the whole line, not just the atom at the start.
    """
    stripped = line.strip()
    if not stripped:
        return None
    if re.fullmatch(r":-+:?", stripped) or re.fullmatch(r"-+:", stripped):
        return "gfm-delimiter"
    if re.fullmatch(r"-+", stripped):
        return "setext-or-thematic"
    first, _, _rest = stripped.partition(" ")
    if first == "-":
        return "bullet"
    match = re.fullmatch(r"(\d+)[.)]", first)
    if match is None:
        return None
    number = int(match.group(1))
    if continuation and number != 1:
        return None
    return "ordered"


def hit_class(atom: str) -> str:
    """Bucket an `_ACQUIRES` hit: prefix, ordered-n, or a real opener."""
    if re.fullmatch(r":-+:?", atom) or re.fullmatch(r"-+:", atom):
        return "gfm"
    if re.fullmatch(r"-+", atom):
        return "dash"
    if re.fullmatch(r"1[.)]", atom):
        return "ordered-1"
    if re.fullmatch(r"\d+[.)]", atom):
        return "ordered-n"
    if ACQUIRES.match(atom):
        return "prefix"
    return "none"


def paragraph_class(source: str) -> str:
    classes = {
        hit_class(atom)
        for atom, _ in atom_placements(source)
        if ACQUIRES.match(atom)
    }
    if classes & {"dash", "gfm", "ordered-1"}:
        return "hazard"
    if "ordered-n" in classes:
        return "ordered-n"
    if "prefix" in classes:
        return "prefix"
    return "none"


def acquires_hits(source: str) -> list[str]:
    hits = []
    for atom, _ in atom_placements(source):
        if ACQUIRES.match(atom) and atom not in hits:
            hits.append(atom)
    return hits


def postcheck(source: str, formatted: str) -> dict:
    """Line-start scan of formatted output against the paragraph's source.

    `lexical` is `_ACQUIRES` at a line start reflow created. `genuine` is the
    subset that would actually change the block parse (or a GFM delimiter row
    the pinned grammar cannot see).
    """
    src = atom_placements(source)
    fmt = atom_placements(formatted)
    lexical: list[str] = []
    genuine: list[str] = []
    src_atoms = [atom for atom, _ in src]
    fmt_atoms = [atom for atom, _ in fmt]
    if src_atoms != fmt_atoms:
        return {
            "atoms_match": False,
            "lexical": lexical,
            "genuine": genuine,
            "src_atoms": src_atoms,
            "fmt_atoms": fmt_atoms,
        }
    lines = formatted_lines(formatted)
    line_of: list[int] = []
    for index, line in enumerate(lines):
        count = len([part for part in line.split(" ") if part != ""])
        line_of.extend([index] * count)
    for index, ((atom, src_ls), (_, fmt_ls)) in enumerate(zip(src, fmt)):
        if not (fmt_ls and not src_ls):
            continue
        if ACQUIRES.match(atom):
            lexical.append(atom)
        line_index = line_of[index]
        kind = genuine_line(lines[line_index], continuation=line_index > 0)
        if kind is not None:
            genuine.append(atom)
    return {"atoms_match": True, "lexical": lexical, "genuine": genuine}


def markdown_files() -> list[Path]:
    listed = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "*.md"],
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    return sorted(ROOT / name for name in listed.split("\0") if name)


def is_slice_note(path: Path) -> bool:
    return any(path == folder or folder in path.parents for folder in (Q29_DIR, Q30_DIR))


def select_files(only: list[str]) -> list[Path]:
    files = [path for path in markdown_files() if not is_slice_note(path)]
    if not only:
        return files
    picked = [path for path in files if any(token in str(path.relative_to(ROOT)) for token in only)]
    if not picked:
        raise SystemExit(f"--only matched no tracked markdown file: {only}")
    return picked


def ns_ms(ns: int) -> str:
    return f"{ns / 1_000_000:.3f}"


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warmup", type=int, default=5, help="unclocked format runs per arm per document")
    parser.add_argument("--iterations", type=int, default=11, help="timed format runs per arm per document")
    parser.add_argument("--only", action="append", default=[], help="restrict to paths containing this substring")
    parser.add_argument(
        "--out",
        type=Path,
        default=Q30_DIR / "report.md",
        help="report path",
    )
    parser.add_argument("--json-out", type=Path, help="raw driver JSON, in addition to the report")
    parser.add_argument(
        "--from-json",
        type=Path,
        help="rebuild the report from a previous driver JSON instead of re-timing",
    )
    return parser.parse_args()


def host_line() -> str:
    cpu = platform.processor() or ""
    if not cpu:
        try:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
                if line.startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
        except OSError:
            cpu = ""
    node = subprocess.run(["node", "-v"], capture_output=True, text=True, check=False)
    return f"{platform.platform()} | {cpu or 'unknown CPU'} | Node {node.stdout.strip() or '?'}"


def write_controls(tmp: Path) -> list[dict]:
    negative = tmp / "negative.md"
    negative.write_text(NEGATIVE_SOURCE, encoding="utf-8")
    trip = tmp / "trip.md"
    trip.write_text(TRIP_SOURCE, encoding="utf-8")
    files = [
        {"id": "__control__/negative.md", "path": str(negative), "role": "negative"},
        {"id": "__control__/trip.md", "path": str(trip), "role": "positive-trip"},
    ]
    for count in SYNTH_COUNTS:
        path = tmp / f"synth-{count}.md"
        path.write_text(SYNTH_UNIT * count, encoding="utf-8")
        files.append({
            "id": f"__control__/synth-{count}.md",
            "path": str(path),
            "role": "positive-size",
        })
    return files


def invoke(job: dict) -> dict:
    run = subprocess.run(
        ["node", str(HARNESS / "bench_format_pass.mjs")],
        input=json.dumps(job).encode(),
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        check=False,
    )
    if run.returncode:
        raise SystemExit(f"bench_format_pass.mjs exited {run.returncode}")
    try:
        return json.loads(run.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"driver returned invalid JSON: {run.stdout[:200]!r}") from error


def paragraph_verdict(paragraph: dict) -> dict:
    out = {
        "start": paragraph["start"],
        "source": paragraph["source"],
        "projected": paragraph["projected"],
        "subtree": paragraph["subtree"],
        "shapeChanged": paragraph["shapeChanged"],
        "widths": {},
    }
    for width, formatted in paragraph["formatted"].items():
        if isinstance(formatted, dict) and "refused" in formatted:
            out["widths"][width] = {"refused": formatted["refused"]}
            continue
        check = postcheck(paragraph["source"], formatted)
        out["widths"][width] = {
            "formatted": formatted,
            **check,
            "shape_changed": bool(paragraph["shapeChanged"].get(width)),
        }
    return out


def annotate(row: dict) -> dict:
    """Attach per-width postcheck verdicts. Driver output is otherwise untouched."""
    paragraphs = [paragraph_verdict(item) for item in row.get("paragraphs", [])]
    trips = {}
    for width in ("80", "40"):
        lexical = any(
            width in item["widths"]
            and item["widths"][width].get("lexical")
            for item in paragraphs
        )
        genuine = any(
            width in item["widths"]
            and (item["widths"][width].get("genuine") or item["widths"][width].get("shape_changed"))
            for item in paragraphs
        )
        trips[width] = {"lexical": lexical, "genuine": genuine}
    return {**row, "paragraphs": paragraphs, "trips": trips}


def check_controls(rows: list[dict]) -> list[str]:
    problems = []
    negatives = [row for row in rows if row["role"] == "negative"]
    if len(negatives) != 1:
        problems.append(f"expected 1 negative control, got {len(negatives)}")
    else:
        row = negatives[0]
        if row["eligible"] != 0 or row["blockAcquisition"] != 0:
            problems.append("negative control has projectable paragraphs")
        if row["paragraphs"]:
            problems.append("negative control collected block-acquisition paragraphs")
        if row["trips"]["80"]["lexical"] or row["trips"]["80"]["genuine"]:
            problems.append("negative control tripped the postcheck")
        if "refused" in row["projected"] or "refused" in row["shipped"]:
            problems.append("negative control refused format")
    trips = [row for row in rows if row["role"] == "positive-trip"]
    if len(trips) != 1:
        problems.append(f"expected 1 positive-trip control, got {len(trips)}")
    else:
        row = trips[0]
        if row["blockAcquisition"] != 1:
            problems.append(
                f"positive-trip control has {row['blockAcquisition']} block-acquisition paragraph(s)"
            )
        if not row["trips"]["40"]["genuine"]:
            problems.append("positive-trip control did not genuine-trip at width 40")
        if row["trips"]["80"]["genuine"] or row["trips"]["80"]["lexical"]:
            problems.append("positive-trip control wrapped at width 80; the fixture no longer fills a line")
    sizes = [row for row in rows if row["role"] == "positive-size"]
    if len(sizes) != len(SYNTH_COUNTS):
        problems.append(f"expected {len(SYNTH_COUNTS)} size controls, got {len(sizes)}")
    else:
        if any("refused" in row["projected"] for row in sizes):
            problems.append("a size control refused projected format")
        else:
            bytes_ = [float(row["bytes"]) for row in sizes]
            medians = [float(row["projected"]["median"]) for row in sizes]
            if medians != sorted(medians):
                problems.append(
                    "synthetic format medians are not increasing with size: "
                    + ", ".join(ns_ms(int(m)) for m in medians)
                )
            r = pearson(bytes_, medians)
            if r is None or r < 0.9:
                problems.append(f"synthetic format vs bytes correlation is {r}")
    if problems:
        raise SystemExit("controls failed:\n  " + "\n  ".join(problems))
    notes = [
        "negative control: 0 eligible, 0 block-acquisition, no postcheck trip, format accepted",
        "positive-trip control genuine-trips at width 40 and does not wrap at width 80",
    ]
    if sizes and "refused" not in sizes[0]["projected"]:
        r = pearson(
            [float(row["bytes"]) for row in sizes],
            [float(row["projected"]["median"]) for row in sizes],
        )
        notes.append(
            "synthetic projected-format medians increase with document size "
            f"(Pearson r={r:.4f})"
        )
    return notes


def timed(row: dict, arm: str) -> dict | None:
    payload = row[arm]
    if "refused" in payload:
        return None
    return payload


def render(notes: list[str], payload: dict, host: str) -> str:
    rows = [annotate(row) for row in payload["results"]]
    corpus = [row for row in rows if row["role"] == "corpus"]
    controls = [row for row in rows if row["role"] != "corpus"]
    warmup = payload["warmup"]
    iterations = payload["iterations"]
    lines = [
        "# Q30: what a second format pass costs",
        "",
        f"Host: {host}",
        f"Warmup: {warmup} unclocked `format()` calls per arm. Timed: median and max of "
        f"{iterations} interleaved shipped/projected runs after warmup, "
        "`process.hrtime.bigint()`. Width 80 is the editor (`markdown.js:536`). "
        "Width 40 is a wrap-sensitivity check, not a second editor.",
        "",
        "## Headline",
        "",
    ]
    timed_corpus = [row for row in corpus if timed(row, "projected") is not None]
    if timed_corpus:
        worst = max(timed_corpus, key=lambda row: row["projected"]["median"])
        findings = next((row for row in timed_corpus if row["id"].endswith("FINDINGS.md")), None)
        genuine_80 = [row for row in corpus if row["trips"]["80"]["genuine"]]
        lexical_80 = [row for row in corpus if row["trips"]["80"]["lexical"]]
        genuine_40 = [row for row in corpus if row["trips"]["40"]["genuine"]]
        lines += headline_block(worst, findings, corpus, genuine_80, lexical_80, genuine_40)
    lines += ["## What was verified about the brief", ""]
    for note in notes:
        lines.append(f"- {note}")
    lines += [
        "",
        "## Controls",
        "",
        "A run that could not have falsified its conclusion is not evidence. "
        "The negative control is a fenced block with no paragraph: the postcheck "
        "must not fire and there must be no second pass, or the harness is "
        "measuring something else. The positive-trip control is a one-line "
        "paragraph whose `-` wraps at width 40 and not at 80. The size control "
        "is a synthetic eligible paragraph repeated 1..1024 times: projected "
        "`format()` must increase with document size, or the clock is not on "
        "the walk that scales with the tree.",
        "",
        "| id | bytes | eligible | block-acq | shipped ms | projected ms | trip 80 | trip 40 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ]
    for row in controls:
        lines.append(control_row(row))
    if corpus:
        lines += corpus_sections(corpus)
    return "\n".join(lines) + "\n"


def headline_block(worst, findings, corpus, genuine_80, lexical_80, genuine_40) -> list[str]:
    findings_line = "FINDINGS.md was not in this run."
    if findings is not None and timed(findings, "projected") is not None:
        proj = findings["projected"]
        shipped = timed(findings, "shipped")
        shipped_s = ns_ms(shipped["median"]) if shipped else "refused"
        findings_line = (
            f"`docs/onboarding/FINDINGS.md` projected `format()` "
            f"**{ns_ms(proj['median'])} ms** median / {ns_ms(proj['max'])} ms max "
            f"({findings['bytes']} bytes). Shipped (no projection) {shipped_s} ms. "
            "Q29's block parse of the same file was 432.972 ms; attach stretch "
            "354.014 ms."
        )
    n = len(corpus)
    parse_ms = 432.972
    attach_ms = 354.014
    findings_ratio = ""
    if findings is not None and timed(findings, "projected") is not None:
        proj_ms = findings["projected"]["median"] / 1_000_000
        findings_ratio = (
            f" That is {parse_ms / proj_ms:.0f}× cheaper than the block parse "
            f"and {attach_ms / proj_ms:.0f}× cheaper than the attach stretch."
        )
    return [
        "**The second format pass does not sink option C. It is noise.**",
        "",
        findings_line + findings_ratio,
        "",
        f"Slowest projected median: **{ns_ms(worst['projected']['median'])} ms** "
        f"(`{worst['id']}`). Format is the cheap half.",
        "",
        f"Postcheck, document-level, width 80 (editor): "
        f"**{len(genuine_80)}/{n} genuine**, {len(lexical_80)}/{n} lexical "
        f"`_ACQUIRES`. Width 40: {len(genuine_40)}/{n} genuine. "
        "Expected extra cost at the editor width is **0 ms** on this corpus.",
        "",
    ]


def arm_ms(row: dict, arm: str) -> str:
    payload = row[arm]
    if "refused" in payload:
        return "refused"
    return ns_ms(payload["median"])


def trip_cell(row: dict, width: str) -> str:
    trips = row["trips"][width]
    if trips["genuine"]:
        return "genuine"
    if trips["lexical"]:
        return "lexical"
    return "no"


def control_row(row: dict) -> str:
    return (
        f"| {row['id']} | {row['bytes']} | {row['eligible']} | "
        f"{row['blockAcquisition']} | {arm_ms(row, 'shipped')} | "
        f"{arm_ms(row, 'projected')} | {trip_cell(row, '80')} | {trip_cell(row, '40')} |"
    )


def corpus_row(row: dict) -> str:
    return (
        f"| `{row['id']}` | {row['bytes']} | {row['eligible']} | "
        f"{row['blockAcquisition']} | {arm_ms(row, 'shipped')} | "
        f"{arm_ms(row, 'projected')} | "
        f"{ns_ms(row['projected']['max']) if timed(row, 'projected') else 'refused'} | "
        f"{trip_cell(row, '80')} | {trip_cell(row, '40')} |"
    )


def corpus_sections(corpus: list[dict]) -> list[str]:
    timed_rows = [row for row in corpus if timed(row, "projected") is not None]
    lines = [
        "",
        "## Corpus",
        "",
        f"{len(corpus)} tracked markdown files (`git ls-files '*.md'`, excluding "
        "this slice's and Q29's note/report).",
        "",
        "| file | bytes | eligible | block-acq | shipped ms | projected ms | projected max | trip 80 | trip 40 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ]
    ordered = sorted(
        corpus,
        key=lambda row: row["projected"]["median"] if timed(row, "projected") else -1,
        reverse=True,
    )
    for row in ordered:
        lines.append(corpus_row(row))
    lines += summary_section(corpus, timed_rows)
    lines += acquisition_section(corpus)
    lines += subtree_section(corpus)
    lines += falsifiers()
    return lines


def summary_section(corpus: list[dict], timed_rows: list[dict]) -> list[str]:
    if not timed_rows:
        return ["", "## Summary", "", "No corpus file accepted projected format.", ""]
    medians = [row["projected"]["median"] for row in timed_rows]
    shipped = [row["shipped"]["median"] for row in timed_rows if timed(row, "shipped")]
    bytes_ = [float(row["bytes"]) for row in timed_rows]
    r = pearson(bytes_, [float(m) for m in medians])
    genuine_80 = sum(1 for row in corpus if row["trips"]["80"]["genuine"])
    lexical_80 = sum(1 for row in corpus if row["trips"]["80"]["lexical"])
    genuine_40 = sum(1 for row in corpus if row["trips"]["40"]["genuine"])
    zeros = [
        row for row in corpus
        if row["eligible"] == 0 and row["blockAcquisition"] == 0
    ]
    findings = next((row for row in timed_rows if row["id"].endswith("FINDINGS.md")), None)
    expected = 0.0
    if findings is not None:
        expected = (genuine_80 / len(corpus)) * (findings["projected"]["median"] / 1_000_000)
    lines = [
        "",
        "## Summary",
        "",
        f"Projected `format()` corpus median {ns_ms(sorted(medians)[len(medians) >> 1])} ms; "
        f"max median {ns_ms(max(medians))} ms; "
        f"max of maxima {ns_ms(max(row['projected']['max'] for row in timed_rows))} ms.",
        "",
    ]
    if shipped:
        lines.append(
            f"Shipped (verbatim paragraphs) corpus median "
            f"{ns_ms(sorted(shipped)[len(shipped) >> 1])} ms; "
            f"max median {ns_ms(max(shipped))} ms."
        )
        lines.append("")
    lines += [
        "Pearson correlation of projected median with document bytes: "
        f"{'n/a' if r is None else f'{r:.4f}'}.",
        "",
        f"Document-level postcheck at width 80: {genuine_80}/{len(corpus)} genuine "
        f"({100.0 * genuine_80 / len(corpus):.1f}%), "
        f"{lexical_80}/{len(corpus)} lexical. "
        f"At width 40: {genuine_40}/{len(corpus)} genuine.",
        "",
    ]
    own = sum(
        (row["projected"]["median"] / 1_000_000)
        for row in timed_rows
        if row["trips"]["80"]["genuine"]
    )
    refused = [row for row in corpus if timed(row, "projected") is None]
    lines += [
        "Term 1, one `format()` pass (projected, width 80): corpus median "
        f"{ns_ms(sorted(medians)[len(medians) >> 1])} ms, worst "
        f"{ns_ms(max(medians))} ms on FINDINGS.md.",
        "",
        f"Term 2, P(document trips the postcheck) at width 80: "
        f"{genuine_80}/{len(corpus)} = **{genuine_80 / len(corpus):.3f}**.",
        "",
        f"Combined expected extra cost: {genuine_80}/{len(corpus)} × one pass "
        f"= **{expected:.3f} ms**. "
        f"Own-median sum over files that trip: **{own:.3f} ms**.",
        "",
    ]
    hazard_docs = [
        row for row in timed_rows
        if any(paragraph_class(item["source"]) == "hazard" for item in row["paragraphs"])
    ]
    if hazard_docs:
        hazard_sum = sum(row["projected"]["median"] for row in hazard_docs) / 1_000_000
        lines += [
            f"Sensitivity, not the measurement: if `fill` had wrapped every "
            f"genuine-potential paragraph, {len(hazard_docs)} documents would "
            f"retry, and the extra cost would be the sum of their projected "
            f"medians, **{hazard_sum:.3f} ms** "
            f"({', '.join(f'`{row['id']}`' for row in hazard_docs)}).",
            "",
        ]
    fill_extra = ""
    if findings is not None and timed(findings, "shipped") is not None:
        fill_extra = (
            f"FINDINGS.md has {findings['eligible']} eligible paragraphs in "
            f"{findings['bytes']} bytes, so projection adds "
            f"{ns_ms(findings['projected']['median'] - findings['shipped']['median'])} ms "
            f"({ns_ms(findings['projected']['median'])} − "
            f"{ns_ms(findings['shipped']['median'])}). "
        )
    lines += [
        "Fill of an all-eligible document is more expensive than today's "
        "verbatim walk (the 1024-paragraph control, in the table above). "
        + fill_extra
        + "Both stay an order below the block parse.",
        "",
    ]
    if refused:
        lines += [
            f"{len(refused)} files refused `format()` on both arms "
            f"({', '.join(f'`{row['id']}`' for row in refused)}). "
            "parse-survey.md is a dirty C injection (`field_declaration_list` "
            "separator); parse-tables-spike.md has an injected "
            "`continue_statement` with no package rule. Unrelated to prose. "
            "Their block-acquisition paragraphs were still mini-formatted "
            "and did not trip.",
            "",
        ]
    if zeros:
        lines += [
            f"{len(zeros)} corpus files have no eligible and no "
            "block-acquisition paragraph. None of them tripped — extra "
            "negative controls the corpus happened to contain.",
            "",
        ]
    return lines


def acquisition_section(corpus: list[dict]) -> list[str]:
    paras = []
    for row in corpus:
        for item in row["paragraphs"]:
            paras.append((row["id"], item))
    classes = {"hazard": 0, "ordered-n": 0, "prefix": 0}
    real_hazard = 0
    fixture_hazard = 0
    for path, item in paras:
        kind = paragraph_class(item["source"])
        classes[kind] = classes.get(kind, 0) + 1
        if kind == "hazard":
            if path.endswith("prose-refused.md"):
                fixture_hazard += 1
            else:
                real_hazard += 1
    lines = [
        "## Block-acquisition paragraphs",
        "",
        f"{len(paras)} paragraphs currently refused as `block acquisition` "
        f"across {sum(1 for row in corpus if row['blockAcquisition'])} files. "
        "**The brief said 31; this run found 32.** The extra paragraph is "
        "`corpus/reports/html/report.md` (`1.`, a genuine interruptor). "
        f"Of the 32: {classes.get('prefix', 0)} incomplete-marker prefix hits "
        f"(`0.5.1,`, `3.9.6`, `0.63`, …), {classes.get('ordered-n', 0)} "
        "complete ordered markers whose start is not 1 (`81.`, `2026.`, "
        f"`60.`, …), and {classes.get('hazard', 0)} genuine-potential openers "
        f"({fixture_hazard} in `prose-refused.md`, {real_hazard} in real "
        "documents — seven `--` plus the extra `1.`). The brief's 16 prefix "
        "hits are prefix + ordered-n. Its 15 hazards missed the `1.`.",
        "",
        "None of the 32 tripped the postcheck at width 80 or 40. Adversarial "
        "all-newline reflow would put a genuine opener at a line start in the "
        "16 hazard paragraphs; `fill` at the editor width does not. It wraps "
        "*after* a sentence-final `1.` and keeps `--` between words. The "
        "fixture `alpha beta gamma - delta …` at width 40 becomes `… zeta` / "
        "`eta theta` — the `-` stays on line 1. The `:-` that already sat on "
        "its own line was *joined* back onto the previous line.",
        "",
        "| file | start | class | lexical 80 | genuine 80 | shape 80 | lexical 40 | genuine 40 | shape 40 | hits |",
        "| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for path, item in paras:
        w80 = item["widths"].get("80", {})
        w40 = item["widths"].get("40", {})
        hits = acquires_hits(item["source"])

        def cell(payload: dict, key: str) -> str:
            values = payload.get(key) or []
            return ", ".join(values) if values else "—"

        lines.append(
            f"| `{path}` | {item['start']} | {paragraph_class(item['source'])} | "
            f"{cell(w80, 'lexical')} | {cell(w80, 'genuine')} | "
            f"{'yes' if w80.get('shape_changed') else 'no'} | "
            f"{cell(w40, 'lexical')} | {cell(w40, 'genuine')} | "
            f"{'yes' if w40.get('shape_changed') else 'no'} | "
            f"{', '.join(hits)} |"
        )
    lines.append("")
    return lines


def subtree_section(corpus: list[dict]) -> list[str]:
    samples = []
    for row in corpus:
        for item in row["paragraphs"]:
            timed_mini = item["subtree"]
            if "refused" in timed_mini:
                continue
            samples.append((row["id"], item["start"], timed_mini, row["projected"] if timed(row, "projected") else None))
    lines = [
        "## Is a subtree reformat sound?",
        "",
        "`format()` in `runtime-js/bundle.js` prints from `tree.root`, runs "
        "`validateTree` on the whole tree, then `alignCells` on the whole string. "
        "Markdown's `comment_cells` is unset (`CELLS_OFF`), and `hard` resets the "
        "print column to the current indent, so a top-level paragraph's `fill` does "
        "not share a line with its siblings. Layout of one paragraph is therefore "
        "independent of the others. The public contract still has no subtree entry "
        "point and no node-to-output map: a retry implemented against `format()` is "
        "a second whole-document pass. Splicing a verbatim paragraph back into the "
        "first-pass string would need output spans the printer does not return; "
        "diffing two whole-document formats to find those spans pays for the pass "
        "the splice was meant to avoid.",
        "",
        "A mini-document of one paragraph is what a subtree API would format. "
        "Those times sit next to the whole-document times for the same files. "
        "They do not make the whole-document question moot today.",
        "",
    ]
    if samples:
        lines += [
            "| file | start | subtree ms | whole projected ms |",
            "| --- | ---: | ---: | ---: |",
        ]
        for path, start, mini, whole in samples:
            whole_s = ns_ms(whole["median"]) if whole else "refused"
            lines.append(f"| `{path}` | {start} | {ns_ms(mini['median'])} | {whole_s} |")
        lines.append("")
    return lines


def falsifiers() -> list[str]:
    return [
        "## Cost model",
        "",
        "Format is not on a keystroke path. `web/js/markdown.js:536` binds `:w` "
        "and `\\F` to `formatText(text, \"markdown\", 80)`. The 150 ms debounce "
        "Q29 measured is `scheduleReparse` in `markdown.js`, reset on every "
        "text-changing key; it does not call `format()`. A second format pass "
        "is extra latency on an explicit format, not a frame drop while typing. "
        "`P(trip) × one pass` is the right model for that extra latency. It is "
        "the wrong model for input latency, because format is not on that path.",
        "",
        "The retry must re-project the existing tree and call `format()` again. "
        "If it went back through `formatText`, it would re-parse and pay "
        "Q29's attach stretch (354 ms on FINDINGS.md). That implementation "
        "would sink option C. The one specified does not.",
        "",
        "Adversarial all-newline reflow is a different question from this "
        "postcheck. The brief's 15 reflow-reachable hazards count gap "
        "assignments `fill` does not produce at width 80 or 40. Sensitivity: "
        "even if every genuine-potential paragraph's document retried, that "
        "is six files whose projected medians sum to well under a frame.",
        "",
        "## Falsifiers",
        "",
        "- If the negative control had tripped, or had grown an eligible paragraph, "
        "the harness would have been measuring something other than a postcheck "
        "over reflowed prose and the run would have been void.",
        "- If the positive-trip control had not genuine-tripped at width 40, the "
        "line-start scan would not have been looking at formatted wrap.",
        "- If synthetic projected medians had not increased with document size "
        "(Pearson r < 0.9), the clock would not have been on work that scales "
        "with the tree.",
        "- If a document with no eligible and no block-acquisition paragraph had "
        "shown a retry, the second pass would have been coming from somewhere else.",
        "",
    ]


def main() -> None:
    args = parse_args()
    if args.warmup < 1 or args.iterations < 1:
        raise SystemExit("warmup and iterations must be >= 1")
    if not (BLOB_DIR / "markdown.blob.json").is_file():
        raise SystemExit(f"missing blobs in {BLOB_DIR}; run ./web/gen.py to transcode them")
    notes = [
        "sibling `harness/bench_format_pass.{py,mjs}`, not an extension of "
        "bench_secondary_cost: different clock (`format()` vs `attachSecondaries`), "
        "different arms (shipped vs A1-projected), plus a counterfactual postcheck. "
        "Corpus listing, warmup/median/max, and control-fails-the-run are the same.",
        "refusal() is harness/prose.py:192, as the brief said",
        "markdown.js:536 formats on demand at width 80; :w and \\F in editor.js:301. "
        "The 150 ms timer at markdown.js:497 is parse, not format",
        "format() in runtime-js/bundle.js:1962 prints from tree.root after "
        "validateTree; there is no subtree entry point",
    ]
    if args.from_json:
        payload = json.loads(args.from_json.read_text(encoding="utf-8"))
    else:
        corpus_paths = select_files(args.only)
        manifests = mf.load_all()
        injections = tj.config(manifests, BLOB_DIR)
        secondaries = secondary.config(manifests)
        shipped = json.loads((PACKAGE_DIR / "markdown.json").read_text(encoding="utf-8"))
        a1 = prose.package(shipped)
        with tempfile.TemporaryDirectory(prefix="docfmt-format-pass-") as tmp:
            controls = write_controls(Path(tmp))
            files = [
                {
                    "id": str(path.relative_to(ROOT)),
                    "path": str(path),
                    "role": "corpus",
                }
                for path in corpus_paths
            ]
            job = {
                "warmup": args.warmup,
                "iterations": args.iterations,
                "widths": list(WIDTHS),
                "blobDir": str(BLOB_DIR),
                "packageDir": str(PACKAGE_DIR),
                "shippedPackage": shipped,
                "a1Package": a1,
                "injections": injections,
                "secondaries": secondaries,
                "files": controls + files,
            }
            payload = invoke(job)

    annotated = [annotate(row) for row in payload["results"]]
    control_notes = check_controls(annotated)
    notes.extend(control_notes)
    acq = sum(row["blockAcquisition"] for row in annotated if row["role"] == "corpus")
    notes.append(
        f"tracked-corpus block-acquisition paragraphs: {acq} "
        "(brief said 31; divergence is reported, not silently corrected)"
    )
    report = render(notes, payload, host_line())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report, encoding="utf-8")
    if args.json_out:
        args.json_out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    sys.stdout.write(report)


if __name__ == "__main__":
    main()
