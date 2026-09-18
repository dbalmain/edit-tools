#!/usr/bin/env python3
"""Measure what secondary (inline-grammar) attachment costs on the JS parse path.

Two arms, same document, same Node process, interleaved:

    ON  -- `parse(text, "markdown")` as `web/js/lang.js` ships it
    OFF -- the same path with `attachSecondaries` skipped, not parsed-and-discarded

The driver is `harness/bench_secondary_cost.mjs`. This file lists the corpus,
builds the controls, invokes the driver once, and writes the report. One process
for the whole corpus, not one per file: the parse tables are JSON-parsed once,
matching a warm editor tab. That is the departure from `bench_format_js.js`,
which times a already-loaded formatter and so can afford a process per tree.

Run from the repository root after `./web/gen.py` has written `web/data/blobs/`:

    ./harness/bench_secondary_cost.py
    ./harness/bench_secondary_cost.py --only README.md
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "harness"
BLOB_DIR = ROOT / "web" / "data" / "blobs"
PARSE_LAYER = (
    "ts_lr.mjs",
    "ts_doc.mjs",
    "ts_inject.mjs",
    "ts_secondary.mjs",
    "ts_scanner_vm.mjs",
    "ts_scanner_pack.mjs",
)
NEGATIVE_SOURCE = "```\nx\n```\n"
SYNTH_UNIT = "alpha *beta* gamma\n\n"
SYNTH_COUNTS = (1, 4, 16, 64, 256, 1024)

sys.path.insert(0, str(HARNESS))
import manifest as mf  # noqa: E402
import ts_injections as tj  # noqa: E402
import ts_secondaries as secondary  # noqa: E402


def markdown_files() -> list[Path]:
    """Every tracked markdown file, the same set `probe_prose.py` uses."""
    listed = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "*.md"],
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    return sorted(ROOT / name for name in listed.split("\0") if name)


def verify_parse_layer() -> list[str]:
    """Fail if gen.py no longer copies the parse layer verbatim."""
    notes = []
    gen = (ROOT / "web" / "gen.py").read_text(encoding="utf-8")
    if "PARSE_LAYER = (" not in gen:
        raise SystemExit("web/gen.py no longer names PARSE_LAYER; Node numbers are not browser numbers")
    if 'shutil.copy(ROOT / "harness" / name, VENDOR / name)' not in gen:
        raise SystemExit("web/gen.py no longer shutil.copy's harness parse-layer files verbatim")
    vendor = ROOT / "web" / "vendor"
    if vendor.is_dir():
        drifted = [
            name for name in PARSE_LAYER
            if (vendor / name).read_bytes() != (HARNESS / name).read_bytes()
        ]
        if drifted:
            raise SystemExit(
                "web/vendor/ has drifted from harness/ for "
                + ", ".join(drifted)
                + "; Node numbers are not browser numbers"
            )
        notes.append("web/vendor/ matches harness/ byte for byte")
    else:
        notes.append(
            "web/vendor/ absent (gitignored); web/gen.py:96 still shutil.copy's "
            "PARSE_LAYER from harness/ with no transformation"
        )
    return notes


def ns_ms(ns: int) -> str:
    return f"{ns / 1_000_000:.3f}"


def pct(delta: int, off: int) -> str:
    if off == 0:
        return "n/a"
    return f"{100.0 * delta / off:.1f}%"


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
    parser.add_argument("--warmup", type=int, default=5, help="unclocked runs per arm per document")
    parser.add_argument("--iterations", type=int, default=11, help="timed runs per arm per document")
    parser.add_argument("--only", action="append", default=[], help="restrict to paths containing this substring")
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / ".ai" / "reviews" / "a2" / "q29" / "report.md",
        help="report path",
    )
    parser.add_argument("--json-out", type=Path, help="raw driver JSON, in addition to the report")
    return parser.parse_args()


def select_files(only: list[str]) -> list[Path]:
    files = markdown_files()
    if not only:
        return files
    picked = [path for path in files if any(token in str(path.relative_to(ROOT)) for token in only)]
    if not picked:
        raise SystemExit(f"--only matched no tracked markdown file: {only}")
    return picked


def write_controls(tmp: Path) -> list[dict]:
    negative = tmp / "negative.md"
    negative.write_text(NEGATIVE_SOURCE, encoding="utf-8")
    files = [{"id": "__control__/negative.md", "path": str(negative), "role": "negative"}]
    for count in SYNTH_COUNTS:
        path = tmp / f"synth-{count}.md"
        path.write_text(SYNTH_UNIT * count, encoding="utf-8")
        files.append({
            "id": f"__control__/synth-{count}.md",
            "path": str(path),
            "role": "positive",
        })
    return files


def invoke(job: dict) -> dict:
    run = subprocess.run(
        ["node", str(HARNESS / "bench_secondary_cost.mjs")],
        input=json.dumps(job).encode(),
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        check=False,
    )
    if run.returncode:
        raise SystemExit(f"bench_secondary_cost.mjs exited {run.returncode}")
    try:
        return json.loads(run.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"driver returned invalid JSON: {run.stdout[:200]!r}") from error


def check_controls(rows: list[dict]) -> list[str]:
    problems = []
    negatives = [row for row in rows if row["role"] == "negative"]
    if len(negatives) != 1:
        problems.append(f"expected 1 negative control, got {len(negatives)}")
    else:
        row = negatives[0]
        if row["secondary"]["count"] != 0:
            problems.append("negative control attached secondary ranges")
        # A few hundred microseconds of noise is still "about zero" on a
        # document whose OFF path is itself a walk of a tiny tree. Absolute,
        # not relative: a 50% swing on 0.05 ms is not a second parse.
        if abs(row["deltaNs"]) > 500_000:
            problems.append(
                f"negative control delta {ns_ms(row['deltaNs'])} ms is not ~0; "
                "the harness is timing something other than secondary attachment"
            )
    positives = [row for row in rows if row["role"] == "positive"]
    if len(positives) != len(SYNTH_COUNTS):
        problems.append(f"expected {len(SYNTH_COUNTS)} positive controls, got {len(positives)}")
    else:
        counts = [row["secondary"]["count"] for row in positives]
        deltas = [row["deltaNs"] for row in positives]
        if counts != sorted(counts):
            problems.append(f"synthetic range counts are not increasing: {counts}")
        if deltas != sorted(deltas):
            problems.append(
                f"synthetic deltas are not increasing with range count: "
                f"{[ns_ms(d) for d in deltas]}"
            )
        r = pearson([float(c) for c in counts], [float(d) for d in deltas])
        if r is None or r < 0.9:
            problems.append(f"synthetic delta vs range count correlation is {r}")
    if problems:
        raise SystemExit("controls failed:\n  " + "\n  ".join(problems))
    notes = [
        f"negative delta {ns_ms(negatives[0]['deltaNs'])} ms on a document with 0 inline ranges",
        "synthetic deltas increase with range count "
        f"(Pearson r={pearson([float(r['secondary']['count']) for r in positives], [float(r['deltaNs']) for r in positives]):.4f})",
    ]
    return notes


def render(notes: list[str], payload: dict, host: str) -> str:
    rows = payload["results"]
    corpus = [row for row in rows if row["role"] == "corpus"]
    controls = [row for row in rows if row["role"] != "corpus"]
    warmup = payload["warmup"]
    iterations = payload["iterations"]
    lines = [
        "# Q29: secondary attachment cost on the JS parse path",
        "",
        f"Host: {host}",
        f"Warmup: {warmup} unclocked runs per arm. Timed: median and max of {iterations} "
        "interleaved ON/OFF runs after warmup, `process.hrtime.bigint()`.",
        "",
        "## Headline",
        "",
    ]
    if corpus:
        worst_stretch = max(corpus, key=lambda row: row["stretch"]["max"])
        worst_delta = max(corpus, key=lambda row: row["deltaNs"])
        lines += [
            f"The number that can drop a frame is the **post-load loop inside "
            f"`attachSecondaries`**, not total `parse()`. After the inline table "
            f"is in hand the loop does not yield. Longest stretch on this corpus: "
            f"**{ns_ms(worst_stretch['stretch']['max'])} ms** "
            f"(`{worst_stretch['id']}`, max of {iterations}; "
            f"median {ns_ms(worst_stretch['stretch']['median'])} ms).",
            "",
            f"Largest median ON−OFF delta: **{ns_ms(worst_delta['deltaNs'])} ms** "
            f"({pct(worst_delta['deltaNs'], worst_delta['off']['median'])} of OFF) "
            f"on `{worst_delta['id']}` "
            f"({worst_delta['secondary']['count']} ranges, "
            f"{worst_delta['secondary']['bytes']} inline bytes).",
            "",
        ]
    lines += ["## What was verified about the brief", ""]
    for note in notes:
        lines.append(f"- {note}")
    lines += [
        "",
        "## Controls",
        "",
        "A run that could not have falsified its conclusion is not evidence. "
        "The negative control is a fenced block with no `inline` node: ON minus "
        "OFF must be ~0, or the clock is not on secondary attachment. The "
        "positive control is a synthetic paragraph repeated 1..1024 times: "
        "delta must increase with range count, or the clock is not on the work "
        "that scales with attachment.",
        "",
        "| id | ranges | inline B | OFF ms | ON ms | Δ ms | Δ% of OFF | stretch ms |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in controls:
        lines.append(control_row(row))
    if corpus:
        lines += [
            "",
            "## Corpus",
            "",
            f"{len(corpus)} tracked markdown files (`git ls-files '*.md'`).",
            "",
            "| file | bytes | ranges | inline B | OFF ms | ON ms | Δ ms | Δ% | stretch median | stretch max | block ms |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
        for row in sorted(corpus, key=lambda item: item["deltaNs"], reverse=True):
            lines.append(corpus_row(row))
        lines += summary_section(corpus)
    return "\n".join(lines) + "\n"


def control_row(row: dict) -> str:
    return (
        f"| {row['id']} | {row['secondary']['count']} | {row['secondary']['bytes']} | "
        f"{ns_ms(row['off']['median'])} | {ns_ms(row['on']['median'])} | "
        f"{ns_ms(row['deltaNs'])} | {pct(row['deltaNs'], row['off']['median'])} | "
        f"{ns_ms(row['stretch']['median'])} |"
    )


def corpus_row(row: dict) -> str:
    return (
        f"| `{row['id']}` | {row['bytes']} | {row['secondary']['count']} | "
        f"{row['secondary']['bytes']} | {ns_ms(row['off']['median'])} | "
        f"{ns_ms(row['on']['median'])} | {ns_ms(row['deltaNs'])} | "
        f"{pct(row['deltaNs'], row['off']['median'])} | "
        f"{ns_ms(row['stretch']['median'])} | {ns_ms(row['stretch']['max'])} | "
        f"{ns_ms(row['onBlock']['median'])} |"
    )


def summary_section(corpus: list[dict]) -> list[str]:
    deltas = [row["deltaNs"] for row in corpus]
    stretches = [row["stretch"]["median"] for row in corpus]
    counts = [float(row["secondary"]["count"]) for row in corpus]
    spans = [float(row["secondary"]["bytes"]) for row in corpus]
    r_count = pearson(counts, [float(d) for d in deltas])
    r_span = pearson(spans, [float(d) for d in deltas])
    named = [row for row in corpus if row["id"] in (
        "docs/onboarding/FINDINGS.md",
        "docs/onboarding/LEDGER.md",
    )]
    lines = [
        "",
        "## Summary",
        "",
        f"Corpus median Δ {ns_ms(sorted(deltas)[len(deltas) >> 1])} ms; "
        f"max Δ {ns_ms(max(deltas))} ms; "
        f"max stretch median {ns_ms(max(stretches))} ms; "
        f"max stretch max {ns_ms(max(row['stretch']['max'] for row in corpus))} ms.",
        "",
        "Pearson correlation of median Δ with attached range count: "
        f"{'n/a' if r_count is None else f'{r_count:.4f}'}. "
        "With attached inline bytes: "
        f"{'n/a' if r_span is None else f'{r_span:.4f}'}.",
        "",
    ]
    for row in named:
        ctor = row.get("ctor")
        ctor_line = ""
        if ctor and ctor["ranges"]:
            per = ctor["ctorNs"] / ctor["ranges"]
            share = ctor["ctorNs"] / row["stretch"]["median"] if row["stretch"]["median"] else 0
            ctor_line = (
                f" `new Language(blob)` × {ctor['ranges']} took "
                f"{ns_ms(ctor['ctorNs'])} ms ({per / 1_000:.1f} µs/range, "
                f"{100 * share:.1f}% of the stretch). This is the A2-review "
                "construction cost, left inside the clock."
            )
        lines.append(
            f"- `{row['id']}`: {row['bytes']} bytes, "
            f"{row['secondary']['count']} ranges, "
            f"{row['secondary']['bytes']} inline bytes. "
            f"OFF {ns_ms(row['off']['median'])} ms, "
            f"ON {ns_ms(row['on']['median'])} ms, "
            f"Δ {ns_ms(row['deltaNs'])} ms "
            f"({pct(row['deltaNs'], row['off']['median'])} of OFF). "
            f"Stretch median {ns_ms(row['stretch']['median'])} ms, "
            f"max {ns_ms(row['stretch']['max'])} ms. "
            f"Block parse {ns_ms(row['onBlock']['median'])} ms."
            f"{ctor_line}"
        )
    lines += [
        "",
        "## Falsifiers",
        "",
        "- If the negative control's Δ had exceeded 0.5 ms, the clock would have "
        "been on something other than `attachSecondaries` and the run would have "
        "been void.",
        "- If synthetic Δ had not increased with range count (Pearson r < 0.9), "
        "the measurement would not have been measuring attached work.",
        "- If OFF had ever produced a `secondary` array, or ON had disagreed with "
        "the host `inline` count, the arms would not have diverged and the driver "
        "would have exited 1.",
        "",
    ]
    return lines


def main() -> None:
    args = parse_args()
    if args.warmup < 1 or args.iterations < 1:
        raise SystemExit("warmup and iterations must be >= 1")
    if not (BLOB_DIR / "markdown.blob.json").is_file() or not (
        BLOB_DIR / "markdown_inline.blob.json"
    ).is_file():
        raise SystemExit(
            f"missing blobs in {BLOB_DIR}; run ./web/gen.py to transcode them"
        )
    notes = verify_parse_layer()
    notes.append(
        "web/gen.py PARSE_LAYER is lines 88–89 (brief said 92); the copy at "
        "line 96 is still shutil.copy with no transformation"
    )
    corpus_paths = select_files(args.only)
    manifests = mf.load_all()
    injections = tj.config(manifests, BLOB_DIR)
    secondaries = secondary.config(manifests)

    with tempfile.TemporaryDirectory(prefix="docfmt-secondary-bench-") as tmp:
        controls = write_controls(Path(tmp))
        files = [
            {
                "id": str(path.relative_to(ROOT)),
                "path": str(path),
                "role": "corpus",
                "ctor": path.name in ("FINDINGS.md", "LEDGER.md"),
            }
            for path in corpus_paths
        ]
        job = {
            "warmup": args.warmup,
            "iterations": args.iterations,
            "blobDir": str(BLOB_DIR),
            "injections": injections,
            "secondaries": secondaries,
            "files": controls + files,
        }
        payload = invoke(job)

    control_notes = check_controls(payload["results"])
    notes.extend(control_notes)
    host = f"{platform.platform()} | {platform.processor() or 'unknown CPU'}"
    report = render(notes, payload, host)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report, encoding="utf-8")
    if args.json_out:
        args.json_out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    sys.stdout.write(report)


if __name__ == "__main__":
    main()
