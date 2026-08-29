#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate the case files for the native-vs-wasm divergence experiment.

    harness/wasm/divergence_cases.py <workdir>

Writes `<workdir>/cases/<case-id>.<ext>` plus `<workdir>/cases.json`, and does
nothing else. Both sides of the experiment then read the SAME bytes off disk,
which is the control: neither runtime gets to mutate its own input.

Why mutants at all. docs/parse-layer.md's route A is credited with deleting a
divergence risk -- "with the same grammar version behind native and wasm, the
parse layer cannot diverge between runtimes" -- and the frozen corpus cannot
test that claim, because gen_trees.py refuses to emit a tree containing ERROR
or MISSING. So every corpus file is, by construction, a clean parse. Error
recovery is where a parser's two implementations are most likely to part
company and is exactly the half the repo's oracle has never seen; the same
document says so in "The gate in front of any own-the-parser route".

The four mutations are deliberately boring and deterministic. They are not a
fuzzer -- a fuzzer is the project that document asks for -- they are a way to
put ERROR and MISSING nodes in front of both runtimes at all.
"""

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "corpus" / "src"

CLOSERS = "}])>"


def truncate60(text: str) -> str | None:
    """Cut the file off mid-construct. The classic half-typed buffer."""
    cut = len(text) * 60 // 100
    return text[:cut] if 0 < cut < len(text) else None


def drop_last_closer(text: str) -> str | None:
    """Delete the last closing bracket. Forces a MISSING, or a long ERROR."""
    best = max((text.rfind(c) for c in CLOSERS), default=-1)
    if best < 0:
        return None
    return text[:best] + text[best + 1 :]


def inject_closer(text: str) -> str | None:
    """Drop a stray `}` in at 40%. Forces a recovery in the middle of a file."""
    at = len(text) * 40 // 100
    if at <= 0:
        return None
    return text[:at] + "}" + text[at:]


def drop_middle_line(text: str) -> str | None:
    """Delete one whole line from the middle."""
    lines = text.split("\n")
    if len(lines) < 4:
        return None
    del lines[len(lines) // 2]
    return "\n".join(lines)


MUTATIONS = {
    "clean": lambda t: t,
    "truncate60": truncate60,
    "drop_last_closer": drop_last_closer,
    "inject_closer": inject_closer,
    "drop_middle_line": drop_middle_line,
}


def edit_point(text: str) -> int | None:
    """The single-character edit site: the last mid-line space in the file.

    Insert one space there. Mid-line so it does not disturb the block structure
    of the indentation-sensitive grammars (python, yaml, markdown, haskell),
    which would otherwise turn a reparse test into an error-recovery test by
    accident. Last, rather than first, because an edit near the end is the case
    where an incremental reparse has the most to reuse and therefore the most
    room to get it wrong.
    """
    for i in range(len(text) - 1, 0, -1):
        if text[i] == " " and text[i - 1] not in " \n\t":
            return i
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    work = Path(sys.argv[1]).resolve()
    cases_dir = work / "cases"
    if cases_dir.exists():
        shutil.rmtree(cases_dir)
    cases_dir.mkdir(parents=True)

    trees = sorted((ROOT / "corpus" / "trees").glob("*.tree.json"))
    cases = []
    skipped = []
    for tree_path in trees:
        frozen = json.loads(tree_path.read_text())
        lang = frozen["language"]
        src_path = ROOT / frozen["source_file"]
        text = src_path.read_text()
        stem = tree_path.name.removesuffix(".tree.json")
        ext = src_path.suffix

        for mutation, fn in MUTATIONS.items():
            out = fn(text)
            if out is None or (mutation != "clean" and out == text):
                skipped.append(f"{stem}/{mutation}")
                continue
            case_id = f"{stem}__{mutation}"
            (cases_dir / f"{case_id}{ext}").write_text(out)
            cases.append(
                {
                    "id": case_id,
                    "language": lang,
                    "mutation": mutation,
                    "file": f"cases/{case_id}{ext}",
                    "origin": frozen["source_file"],
                }
            )

    # The incremental arm runs on the largest file per language: the most tree
    # for a reparse to reuse.
    biggest: dict[str, tuple[int, dict]] = {}
    for case in cases:
        if case["mutation"] != "clean":
            continue
        size = (ROOT / case["origin"]).stat().st_size
        if case["language"] not in biggest or size > biggest[case["language"]][0]:
            biggest[case["language"]] = (size, case)

    edits = []
    for lang, (size, case) in sorted(biggest.items()):
        text = (ROOT / case["origin"]).read_text()
        at = edit_point(text)
        if at is None:
            skipped.append(f"{lang}/edit")
            continue
        edits.append(
            {
                "id": case["id"],
                "language": lang,
                "file": case["file"],
                "origin": case["origin"],
                "bytes": size,
                # A single inserted space, expressed in characters. Each side
                # converts to its own index units (bytes native, UTF-16 wasm).
                "insert_at_char": at,
            }
        )

    (work / "cases.json").write_text(
        json.dumps({"cases": cases, "edits": edits, "skipped": skipped}, indent=1) + "\n"
    )
    print(f"{len(cases)} cases, {len(edits)} edit cases, {len(skipped)} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
