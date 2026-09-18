#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Record every call a grammar's real external scanner makes, per corpus file.

    ./harness/ts_scanner_record.py <grammar> [--out DIR] [--keep] [--jobs N]

Twelve of the sixteen languages still need their external scanner, and however
those scanners get produced -- hand-compiled to VM bytecode, compiled from C,
or something else -- each one is checked against what the real C scanner does.
This records that. It is the oracle, and it is the same under every route,
which is why it exists before the route is chosen.

`spike/scanner-vm/record/` did this for toml. Everything language-specific there
was three identifiers and a hardcoded token count, so this is that build
parameterised, plus two things it did not do:

* **serialize and deserialize are traced.** toml is stateless, so the original
  never needed to. Eight of the twelve remaining scanners carry state across
  tokens, and a port that scans correctly while serializing differently is
  wrong in a way only the *next* token reveals.
* **The valid-symbols vector is a bit string and the state is hex.** yaml
  declares 113 external tokens; as a JSON array of ints per call, its trace is
  larger than the file that produced it.

## Why the core version is chosen by ABI

A grammar's generated `parser.c` initializes `TSLanguage` with the field names
of the ABI it was generated for, and tree-sitter 0.25 renamed `.version` to
`.abi_version`. So an ABI-14 `parser.c` does not compile against 0.25's
`parser.h`, and an ABI-15 one does not compile against 0.24's -- even though
either core can *load* either grammar at runtime. The wrapper includes both the
grammar's `scanner.c` and the core's internal `lexer.h` in one translation
unit, so the two cannot be given different headers, and the version is picked
from the grammar's own `LANGUAGE_VERSION` instead.

Sources come from `.grammars/`, so run `ts_grammars.py` first (this does, if
needed). Six of the sixteen sdists are incomplete and that script is what
repairs them; without it, five of these scanners do not compile at all.
"""

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as mf  # noqa: E402
import ts_grammars as tg  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
ADVERSARIAL = Path(__file__).resolve().parent / "fixtures" / "scanner"
TRACES = ROOT / "corpus" / "scanner-traces"
BUILD = tg.CACHE / ".build"
CORE_CACHE = tg.CACHE / ".core"
HERE = Path(__file__).resolve().parent / "scanner_record"

# See the module docstring: the field names in a generated TSLanguage moved at
# ABI 15, so the core has to match the grammar rather than simply being recent.
CORE_FOR_ABI = {13: "0.24.0", 14: "0.24.0", 15: "0.25.2"}


class RecordError(Exception):
    """A scanner could not be built or run."""


def core_for(abi: int) -> Path:
    """tree-sitter's own sources at the version this ABI compiles against."""
    version = CORE_FOR_ABI.get(abi)
    if version is None:
        raise RecordError(f"no core version known for ABI {abi}")
    dest = CORE_CACHE / version
    lib = dest / f"tree-sitter-{version}" / "tree_sitter" / "core" / "lib"
    if lib.is_dir():
        return lib
    dest.mkdir(parents=True, exist_ok=True)
    meta = json.load(
        urllib.request.urlopen(f"https://pypi.org/pypi/tree-sitter/{version}/json")
    )
    url = next(u["url"] for u in meta["urls"] if u["packagetype"] == "sdist")
    raw = urllib.request.urlopen(url).read()
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        archive.extractall(dest, filter="data")
    if not lib.is_dir():
        raise RecordError(f"tree-sitter {version}'s sdist has no core at {lib}")
    return lib


def facts(src: Path) -> tuple[int, int]:
    """`(abi, external_token_count)` from the grammar's own generated tables."""
    text = (src / "parser.c").read_text(encoding="utf-8", errors="replace")
    abi = tg.ABI.search(text)
    ext = tg.EXTERNALS.search(text)
    if abi is None:
        raise RecordError(f"{src}: parser.c declares no LANGUAGE_VERSION")
    return int(abi.group(1)), int(ext.group(1)) if ext else 0


def entry_points(src: Path, language: str) -> str:
    """The `tree_sitter_<name>` prefix this grammar exports.

    Read out of `scanner.c` rather than assumed from the language, because they
    differ: the corpus calls one language `markdown` while its scanner exports
    `tree_sitter_markdown_block_*`, and typescript's scanner is a shim whose
    names live in a shared header.
    """
    pattern = re.compile(r"tree_sitter_(\w+?)_external_scanner_scan")
    for candidate in [tg.scanner_of(src)] + sorted(src.parent.rglob("*.h")):
        if candidate is None or not candidate.is_file():
            continue
        if m := pattern.search(candidate.read_text(encoding="utf-8", errors="replace")):
            return m.group(1)
    raise RecordError(f"{language}: no external_scanner_scan definition found")


def build(target: mf.GrammarTarget, m) -> tuple[Path, int]:
    """Compile the instrumented parser. Returns `(binary, external_token_count)`."""
    language = target.name
    src = tg.src_of(target.source_language, m, target.grammar_symbol)
    abi, externals = facts(src)
    if externals == 0:
        raise RecordError(f"{language} declares no external tokens; nothing to record")
    core = core_for(abi)
    prefix = entry_points(src, language)
    scanner = tg.scanner_of(src)
    if scanner is None:
        raise RecordError(f"{language}: no scanner source in {src}")

    work = BUILD / language
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    binary = work / "trace"

    fn = f"tree_sitter_{prefix}_external_scanner"
    # The only generated file, and the only place a language's name appears in
    # C. It renames the grammar's three entry points aside, includes the real
    # scanner under those names, then undefines the renames so the wrapper can
    # define the public ones. `#undef` does not expand its argument, which is
    # why this cannot be done with -D from the command line.
    (work / "shim.c").write_text(
        "\n".join(
            [f"#define {fn}_{a} real_{a}" for a in ("scan", "serialize", "deserialize")]
            + [f'#include "{scanner}"']
            + [f"#undef {fn}_{a}" for a in ("scan", "serialize", "deserialize")]
            + [f"#define TS_{a.upper()}_FN {fn}_{a}" for a in ("scan", "serialize", "deserialize")]
            + [f'#include "{HERE / "trace_scanner.c"}"', ""]
        ),
        encoding="utf-8",
    )
    compiler = os.environ.get("CC", "cc")
    cmd = [
        compiler, "-O1", "-o", str(binary),
        str(HERE / "main.c"), str(work / "shim.c"),
        str(src / "parser.c"), str(core / "src" / "lib.c"),
        f"-DTS_NUM_EXT={externals}",
        f"-DTS_LANGUAGE_FN=tree_sitter_{prefix}",
        f"-I{src}", f"-I{core / 'include'}", f"-I{core / 'src'}",
        "-w",  # grammar C is not ours to lint, and several are warning-noisy
    ]
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode != 0:
        raise RecordError(f"{language}: compile failed\n{done.stderr.strip()[:4000]}")
    return binary, externals


def sources(target: mf.GrammarTarget, m) -> list[Path]:
    found: list[Path] = []
    for extension in m.extensions:
        found.extend((SRC / target.source_language).glob(f"*{extension}"))
        found.extend((ADVERSARIAL / target.name).glob(f"*{extension}"))
    stems = [path.stem for path in found]
    if len(stems) != len(set(stems)):
        raise RecordError(
            f"{target.name}: scanner sources have duplicate stems; trace names "
            "would overwrite"
        )
    return sorted(found)


def record(language: str, out: Path, jobs: int) -> dict:
    manifests = mf.load_all()
    targets = mf.grammar_targets(manifests)
    if language not in targets:
        raise RecordError(f"no manifest grammar for {language!r}")
    target = targets[language]
    m = manifests[target.source_language]
    binary, externals = build(target, m)
    files = sources(target, m)
    if not files:
        raise RecordError(
            f"{language}: no corpus sources in {SRC / target.source_language}"
        )

    out.mkdir(parents=True, exist_ok=True)

    def one(path: Path) -> tuple[str, int]:
        target = out / f"{path.stem}.jsonl"
        done = subprocess.run(
            [str(binary), str(path), str(target)], capture_output=True, text=True
        )
        if done.returncode != 0:
            raise RecordError(f"{language}/{path.name}: {done.stderr.strip()[:2000]}")
        return path.name, sum(1 for _ in target.open())

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        counts = dict(pool.map(one, files))
    return {
        "language": language,
        "externals": externals,
        "files": len(files),
        "calls": sum(counts.values()),
        "per_file": counts,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("language", nargs="?", help="omit to record every language with a scanner")
    ap.add_argument("--out", type=Path, help=f"default {TRACES.relative_to(ROOT)}/<language>")
    ap.add_argument("--keep", action="store_true", help="keep the build directory")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    manifests = mf.load_all()
    names = (
        [args.language]
        if args.language
        else sorted(mf.grammar_targets(manifests))
    )
    results, failures = [], []
    for name in names:
        out = args.out or TRACES / name
        try:
            results.append(record(name, out, args.jobs))
        except RecordError as e:
            # Sweeping every language, a grammar with no scanner is not a
            # failure -- it is the answer.
            if args.language or "no external tokens" not in str(e):
                failures.append(str(e))
    if not args.keep:
        shutil.rmtree(BUILD, ignore_errors=True)

    if args.json:
        print(json.dumps({"recorded": results, "failures": failures}, indent=1))
    else:
        for r in results:
            print(f"{r['language']:<12} {r['files']:>3} files  {r['calls']:>7,} scanner calls  "
                  f"{r['externals']:>3} external tokens")
        for f in failures:
            print(f"  {f}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
