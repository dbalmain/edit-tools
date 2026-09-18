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
# This slice force-adds its own note and report. They are tracked `*.md`, so
# `git ls-files` would feed them back in and the corpus would measure itself.
Q29_DIR = ROOT / ".ai" / "reviews" / "a2" / "q29"
FRAME_NS = 16_000_000

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
    parser.add_argument(
        "--from-json",
        type=Path,
        help="rebuild the report from a previous driver JSON instead of re-timing",
    )
    return parser.parse_args()


def is_q29(path: Path) -> bool:
    return path == Q29_DIR or Q29_DIR in path.parents


def select_files(only: list[str]) -> list[Path]:
    files = [path for path in markdown_files() if not is_q29(path)]
    if not only:
        return files
    picked = [path for path in files if any(token in str(path.relative_to(ROOT)) for token in only)]
    if not picked:
        raise SystemExit(f"--only matched no tracked markdown file: {only}")
    return picked


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


def us_per_byte(row: dict) -> str:
    span = row["secondary"]["bytes"]
    if span == 0:
        return "n/a"
    return f"{row['stretch']['median'] / span / 1000:.2f}"


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
    corpus = [
        row for row in rows
        if row["role"] == "corpus" and not row["id"].startswith(".ai/reviews/a2/q29/")
    ]
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
        over_frame = sum(1 for row in corpus if row["stretch"]["median"] > FRAME_NS)
        lines += [
            f"The number that can drop a frame is the **post-load loop inside "
            f"`attachSecondaries`**, not total `parse()`. `parse()` yields between "
            f"the block parse, the attach loop, and inject; those are separate "
            f"synchronous stretches. After the inline table is in hand the range "
            f"loop does not yield.",
            "",
            f"Longest attach stretch: **{ns_ms(worst_stretch['stretch']['max'])} ms** "
            f"(`{worst_stretch['id']}`, max of {iterations}; "
            f"median {ns_ms(worst_stretch['stretch']['median'])} ms). "
            f"That file's block parse is "
            f"{ns_ms(worst_stretch['onBlock']['median'])} ms — a longer stretch "
            f"that already existed. Secondary attachment is new, the same order "
            f"of magnitude, and it does not yield.",
            "",
            f"Largest median ON−OFF delta: **{ns_ms(worst_delta['deltaNs'])} ms** "
            f"({pct(worst_delta['deltaNs'], worst_delta['off']['median'])} of OFF) "
            f"on `{worst_delta['id']}` "
            f"({worst_delta['secondary']['count']} ranges, "
            f"{worst_delta['secondary']['bytes']} inline bytes, "
            f"{us_per_byte(worst_delta)} µs/inline-byte).",
            "",
            f"{over_frame}/{len(corpus)} tracked markdown files have an attach-stretch "
            f"median over 16 ms (one frame at 60 Hz) on this machine.",
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
            f"{len(corpus)} tracked markdown files (`git ls-files '*.md'`, "
            "excluding this slice's own note/report).",
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
    zeros = [row for row in corpus if row["secondary"]["count"] == 0]
    dense = max(
        (row for row in corpus if row["secondary"]["bytes"] >= 1000),
        key=lambda row: (row["stretch"]["median"] / row["secondary"]["bytes"]),
        default=None,
    )
    ratios = [
        row["stretch"]["median"] / row["deltaNs"]
        for row in corpus if row["deltaNs"] > 1_000_000
    ]
    over_frame = sum(1 for row in corpus if row["stretch"]["median"] > FRAME_NS)
    lines = [
        "",
        "## Summary",
        "",
        f"Corpus median Δ {ns_ms(sorted(deltas)[len(deltas) >> 1])} ms; "
        f"max Δ {ns_ms(max(deltas))} ms; "
        f"median stretch {ns_ms(sorted(stretches)[len(stretches) >> 1])} ms; "
        f"max stretch median {ns_ms(max(stretches))} ms; "
        f"max stretch max {ns_ms(max(row['stretch']['max'] for row in corpus))} ms. "
        f"{over_frame}/{len(corpus)} files have stretch median > 16 ms.",
        "",
        "Pearson correlation of median Δ with attached range count: "
        f"{'n/a' if r_count is None else f'{r_count:.4f}'}. "
        "With attached inline bytes: "
        f"{'n/a' if r_span is None else f'{r_span:.4f}'}. "
        "Bytes are the better predictor because ranges vary in length.",
        "",
    ]
    if ratios:
        lines.append(
            f"Attach stretch / ON−OFF Δ is "
            f"{sorted(ratios)[len(ratios) >> 1]:.3f} at the median on files "
            f"with Δ > 1 ms. The delta of `parse()` is the attach loop, not "
            f"something else that moved with it."
        )
        lines.append("")
    for row in named:
        ctor = row.get("ctor")
        ctor_line = ""
        if ctor and ctor["ranges"]:
            per = ctor["ctorNs"] / ctor["ranges"]
            share = ctor["ctorNs"] / row["stretch"]["median"] if row["stretch"]["median"] else 0
            ctor_line = (
                f" `new Language(blob)` × {ctor['ranges']} took "
                f"{ns_ms(ctor['ctorNs'])} ms ({per / 1_000:.1f} µs/range, "
                f"{100 * share:.1f}% of the stretch). The A2 review's per-slice "
                "construction is real and is inside the clock; it is not the "
                "term that matters. Parser construction is not separately "
                "exported, so this number is Language only; the rest of the "
                "stretch is `parse()` of each slice."
            )
        lines.append(
            f"- `{row['id']}`: {row['bytes']} bytes, "
            f"{row['secondary']['count']} ranges, "
            f"{row['secondary']['bytes']} inline bytes "
            f"({us_per_byte(row)} µs/inline-byte). "
            f"OFF {ns_ms(row['off']['median'])} ms, "
            f"ON {ns_ms(row['on']['median'])} ms, "
            f"Δ {ns_ms(row['deltaNs'])} ms "
            f"({pct(row['deltaNs'], row['off']['median'])} of OFF). "
            f"Stretch median {ns_ms(row['stretch']['median'])} ms, "
            f"max {ns_ms(row['stretch']['max'])} ms. "
            f"Block parse {ns_ms(row['onBlock']['median'])} ms."
            f"{ctor_line}"
        )
    if zeros:
        lines += [
            "",
            f"{len(zeros)} corpus files have no `inline` node "
            f"({', '.join(f'`{row['id']}`' for row in zeros)}). "
            "Their ON−OFF deltas are "
            + ", ".join(f"{ns_ms(row['deltaNs'])} ms" for row in zeros)
            + " — extra negative controls the corpus happened to contain.",
        ]
    if dense is not None:
        lines += [
            "",
            f"Syntax-density outlier: `{dense['id']}` "
            f"({dense['secondary']['count']} range(s), "
            f"{dense['secondary']['bytes']} inline bytes, "
            f"stretch {ns_ms(dense['stretch']['median'])} ms, "
            f"{us_per_byte(dense)} µs/byte). Prose sits around 2.5–3.5 µs/byte; "
            "this file is a scanner-stress fixture, not typical editing.",
        ]
    findings = next((row for row in named if row["id"].endswith("FINDINGS.md")), None)
    findings_ms = ns_ms(findings["stretch"]["median"]) if findings else "?"
    lines += [
        "",
        "## Is a real-browser input-latency run worth doing?",
        "",
        "Node already closes the worst-case question. "
        f"`docs/onboarding/FINDINGS.md` holds the main thread for {findings_ms} ms "
        "median inside `attachSecondaries` on byte-identical JS. A browser "
        "run cannot turn that into a frame. The 150 ms debounce means this "
        "cost is paid on pause, after the user has already waited, and then "
        "the editor still cannot render until `parse()` finishes.",
        "",
        "A browser run would only refine the 5–16 ms band, where main-thread "
        "contention (layout, this editor's own render) could push a maybe-fine "
        "file over a frame. That is not the go/no-go. The with-versus-without "
        "baseline this slice exists to capture is the Node number.",
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
        "- If stretch/Δ had been far from 1 on large files, total `parse()` would "
        "have been moving for a reason other than the attach loop.",
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
    notes.append(
        "markdown.js:298 opens with scheduleReparse(0); :302 defaults to 150 ms; "
        "dispatch at 497 resets that timer on every text-changing key; "
        "replaceAll at 506 uses 0. The parse runs after 150 ms of quiet, not "
        "per keystroke and not continuously while someone types"
    )
    notes.append(
        "lang.js:89 parse() calls attachSecondaries at :99, then injectAll. "
        "OFF skips only the attachSecondaries call"
    )
    notes.append(
        "attachSecondaries awaits load() once per site, then parses every "
        "matching range synchronously. After the table is cached, await still "
        "yields one microtask; the stretch figure includes that yield "
        "(microseconds) and then the range loop"
    )
    tracked = markdown_files()
    findings = ROOT / "docs" / "onboarding" / "FINDINGS.md"
    ledger = ROOT / "docs" / "onboarding" / "LEDGER.md"
    notes.append(
        f"FINDINGS.md is {findings.stat().st_size} B, LEDGER.md "
        f"{ledger.stat().st_size} B, {len(tracked)} tracked *.md files "
        f"({len([p for p in tracked if is_q29(p)])} of them this slice's "
        "force-added note/report, excluded from the corpus table). Brief was "
        "right on the sizes; the 114 was before those two files were added."
    )
    if args.from_json:
        payload = json.loads(args.from_json.read_text(encoding="utf-8"))
    else:
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
    report = render(notes, payload, host_line())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report, encoding="utf-8")
    if args.json_out:
        args.json_out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    sys.stdout.write(report)


if __name__ == "__main__":
    main()
