#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# ///
"""Do the two runtimes agree on displayed width for non-ASCII?

    ./harness/probe_a23_width.py

A2.3's stated entry condition is that they do. This probe is the measurement:
it does not change either runtime, and it does not admit non-ASCII into the
prose projection. It builds a one-atom group that is flat at width W and
broken at W-1, and reads the atom's column count off that wrap point.

The group is `atom + line + "X"`. Flat form is `{atom} X`; broken form is
`{atom}\\nX`. The smallest width that stays flat is `width(atom) + 2`, so
the atom's measured width is that threshold minus two. An ASCII `abc`
control must come back as 3; if it does not, the harness is wrong.

Two tree shapes are measured for every case, because A2.3 will feed the
printer from source slices, not from a `text` field:

* **slice** -- the atom is a source range; `verbatim` copies those bytes.
* **leaf** -- the atom carries a JSON `text` field; the evaluator emits it
  without reading source.

Not a gate. Exit 0 when every case agrees across runtimes and shapes;
exit 1 on a disagreement or if a binary cannot run.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FMT_JS = ROOT / "fmt-js"
FMT_RUST = ROOT / "fmt-rust"

PACKAGE = {
    "format": "et-doc-rules/1",
    "indent": 0,
    "tokens": [],
    "rules": {
        "probe": ["group", ["child", "named"], ["line"], ["child", "named"]],
        "atom": ["verbatim"],
        "mark": ["verbatim"],
    },
}

# Brief-required cases first. Extra rows after the blank comment are traps
# the same naive implementations also get wrong; they are not in the brief.
CASES: list[tuple[str, str]] = [
    ("ascii-abc (harness control)", "abc"),
    ("latin1-e-acute (positive control)", "é"),
    ("latin1-u-umlaut (positive control)", "ü"),
    ("cjk-tokyo", "東京"),
    ("hangul", "한국"),
    ("fullwidth-latin-a", "Ａ"),
    ("combining-acute (e + U+0301)", "e\u0301"),
    ("emoji-smile", "🙂"),
    ("emoji-family-zwj", "👨‍👩‍👧"),
    ("emoji-vs16 (heart)", "❤️"),
    ("zwj-alone", "\u200d"),
    ("zwsp-alone", "\u200b"),
    ("non-bmp-g-clef (U+1D11E)", "𝄞"),
    # Extra traps, same question.
    ("nbsp", "\u00a0"),
    ("cjk-plus-ascii", "a東京b"),
    ("flag-regional-indicators", "🇦🇺"),
    ("emoji-skin-tone", "👍🏻"),
]


class Failed(Exception):
    """The probe cannot run, or a case disagreed."""


def scalars(s: str) -> int:
    """Unicode scalar count -- Python 3 `str` is already scalars."""
    return len(s)


def utf16_units(s: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in s)


def term_width(s: str) -> int:
    """A common terminal approximation of display width, not a spec.

    Combining marks and format chars (ZWJ, ZWSP, variation selectors) are
    0; East Asian Wide/Fullwidth are 2; everything else is 1. This is the
    number a naive `wcwidth` would report, and the number the runtimes are
    *not* required to match -- it is here so a disagreement with it can be
    named rather than confused with a disagreement between the runtimes.
    """
    total = 0
    for ch in s:
        if unicodedata.combining(ch) or unicodedata.category(ch) in {
            "Cf",
            "Cc",
            "Mn",
            "Me",
        }:
            continue
        if unicodedata.east_asian_width(ch) in {"W", "F"}:
            total += 2
        else:
            total += 1
    return total


def tree_slice(atom: str) -> dict:
    raw = atom.encode("utf-8")
    n = len(raw)
    return {
        "language": "widthprobe",
        "source": atom,
        "root": {
            "type": "probe",
            "start": 0,
            "end": n,
            "children": [
                {"type": "atom", "start": 0, "end": n},
                {"type": "mark", "start": 0, "end": 0, "text": "X"},
            ],
        },
    }


def tree_leaf(atom: str) -> dict:
    return {
        "language": "widthprobe",
        "source": "",
        "root": {
            "type": "probe",
            "start": 0,
            "end": 0,
            "children": [
                {"type": "atom", "start": 0, "end": 0, "text": atom},
                {"type": "mark", "start": 0, "end": 0, "text": "X"},
            ],
        },
    }


def run_fmt(exe: Path, tree_path: Path, width: int, packages: Path) -> str:
    env = os.environ.copy()
    env["FMT_PACKAGES"] = str(packages)
    proc = subprocess.run(
        [str(exe), str(tree_path), str(width)],
        capture_output=True,
        env=env,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip() or f"exit {proc.returncode}"
        raise Failed(f"{exe.name} @{width} refused: {err}")
    return proc.stdout.decode("utf-8")


def is_flat(out: str) -> bool:
    # The printer always terminates with one newline. A broken group adds one
    # more, between the atom and the mark.
    return out.count("\n") == 1


def measured_width(exe: Path, tree_path: Path, packages: Path, atom: str) -> int:
    """Smallest fitting width minus the ` X` tail (2 columns)."""
    hi = max(utf16_units(atom) + 8, 8)
    flats = [is_flat(run_fmt(exe, tree_path, w, packages)) for w in range(hi + 1)]
    if True not in flats:
        raise Failed(f"{exe.name} never fitted {atom!r} up to width {hi}")
    threshold = flats.index(True)
    if not all(flats[threshold:]):
        raise Failed(f"{exe.name} wrap for {atom!r} is not monotonic: {flats}")
    if any(flats[:threshold]):
        raise Failed(f"{exe.name} wrap for {atom!r} is not monotonic: {flats}")
    return threshold - 2


def write_workspace(tmp: Path) -> Path:
    packages = tmp / "packages"
    packages.mkdir()
    (packages / "widthprobe.json").write_text(
        json.dumps(PACKAGE, ensure_ascii=False), encoding="utf-8"
    )
    return packages


def measure_case(
    name: str, atom: str, packages: Path, tmp: Path
) -> dict[str, int | str | bool]:
    results: dict[str, int | str | bool] = {
        "name": name,
        "atom": atom,
        "scalars": scalars(atom),
        "utf16": utf16_units(atom),
        "term": term_width(atom),
    }
    rust: list[int] = []
    js: list[int] = []
    for shape, builder in (("slice", tree_slice), ("leaf", tree_leaf)):
        tree_path = tmp / f"{shape}.tree.json"
        tree_path.write_text(
            json.dumps(builder(atom), ensure_ascii=False), encoding="utf-8"
        )
        w_r = measured_width(FMT_RUST, tree_path, packages, atom)
        w_j = measured_width(FMT_JS, tree_path, packages, atom)
        results[f"rust_{shape}"] = w_r
        results[f"js_{shape}"] = w_j
        rust.append(w_r)
        js.append(w_j)
    results["agree"] = len(set(rust + js)) == 1
    results["rust"] = rust[0]
    results["js"] = js[0]
    return results


def pad(cell: str, width: int) -> str:
    # Display padding uses terminal-ish width so CJK headers still line up
    # in a UTF-8 terminal; the cell content may still be wider than `width`.
    extra = width - term_width(cell)
    return cell + " " * max(extra, 1)


def render_table(rows: list[dict[str, int | str | bool]]) -> str:
    headers = (
        "case",
        "Rust",
        "JS",
        "agree",
        "scalars",
        "UTF-16",
        "term ~",
    )
    cells = [
        [
            str(row["name"]),
            str(row["rust"]),
            str(row["js"]),
            "yes" if row["agree"] else "NO",
            str(row["scalars"]),
            str(row["utf16"]),
            str(row["term"]),
        ]
        for row in rows
    ]
    widths = [term_width(h) for h in headers]
    for line in cells:
        for i, cell in enumerate(line):
            widths[i] = max(widths[i], term_width(cell))
    out = []
    out.append("| " + " | ".join(pad(h, widths[i]) for i, h in enumerate(headers)) + " |")
    out.append("| " + " | ".join("-" * max(w, 3) for w in widths) + " |")
    for line in cells:
        out.append(
            "| " + " | ".join(pad(c, widths[i]) for i, c in enumerate(line)) + " |"
        )
    return "\n".join(out)


def main() -> int:
    for exe in (FMT_JS, FMT_RUST):
        if not exe.exists():
            print(f"missing {exe}; run ./build.sh", file=sys.stderr)
            return 1
    rust_bin = ROOT / "rust" / "target" / "release" / "docfmt"
    if not rust_bin.exists():
        print(f"missing {rust_bin}; run ./build.sh", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="a23-width-") as raw:
        tmp = Path(raw)
        packages = write_workspace(tmp)
        rows = [measure_case(name, atom, packages, tmp) for name, atom in CASES]

    print(render_table(rows))
    print()
    disagreements = [row for row in rows if not row["agree"]]
    shape_splits = [
        row
        for row in rows
        if row["rust_slice"] != row["rust_leaf"] or row["js_slice"] != row["js_leaf"]
    ]
    if disagreements:
        print(f"[FAIL] {len(disagreements)}/{len(rows)} cases disagree across runtimes")
        for row in disagreements:
            print(
                f"       {row['name']}: rust={row['rust']} js={row['js']} "
                f"slice=({row['rust_slice']},{row['js_slice']}) "
                f"leaf=({row['rust_leaf']},{row['js_leaf']})"
            )
        return 1
    if shape_splits:
        print(f"[FAIL] {len(shape_splits)}/{len(rows)} cases disagree across tree shapes")
        return 1

    control = next(row for row in rows if "positive control" in str(row["name"]))
    if control["rust"] != 1 or control["js"] != 1:
        print(
            f"[FAIL] positive control {control['name']!r} was "
            f"rust={control['rust']} js={control['js']}; expected 1",
            file=sys.stderr,
        )
        return 1
    abc = next(row for row in rows if str(row["name"]).startswith("ascii-abc"))
    if abc["rust"] != 3 or abc["js"] != 3:
        print(
            f"[FAIL] harness control {abc['name']!r} was "
            f"rust={abc['rust']} js={abc['js']}; expected 3",
            file=sys.stderr,
        )
        return 1

    print(f"[PASS] {len(rows)}/{len(rows)} cases agree  (slice and leaf, both runtimes)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Failed as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        sys.exit(1)
