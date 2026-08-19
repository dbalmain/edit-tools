#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Fixpoint probe: our Go formatter vs gofmt on GOROOT.

    ./harness/probe_alignment.py [--limit N] [--jobs N] [--align-only]

Take gofmt-clean non-test `.go` files from `GOROOT/src` (`go env GOROOT`),
run them through our formatter, and diff. Because the input is already
gofmt output, any change is a disagreement with gofmt — no false positives
and no hand-written expectations.

The walk is `GOROOT/src`, `*_test.go` skipped, `testdata/` skipped. That
is the spike's population: ~5,955 non-test files under `src/`, of which
4,816 are outside testdata and 4,814 survive `gofmt -l`. testdata is
excluded by path because it is full of deliberate syntax errors; leaving
it in and filtering "gofmt-clean parseable" inflates the set with
fixtures that gofmt happens to accept.

`--align-only` is **retired and now errors out**. It piped each file
through the alignment pass alone and measured about 10 / 4814 (0.21%)
when alignment was a text-scanning pass over rendered output. Since the
`cell` node landed (FINDINGS 18) the pass aligns *markers*, and gofmt
output has no markers, so the pass is a no-op by construction and the
flag printed a triumphant `0 / 4814`. A probe that cannot fail is worse
than no probe: it reports success at exactly the moment it stops
measuring anything.

To compare two trees, run this script in **default mode with --verbose**
in each and diff the mangled paths. Set-diffing matters: the absolute
counts move with coverage, so a tree that formats more files looks worse
while being better. That is how the cell merge was verified — 297/1,291
against 272/1,231 decomposed to 23 newly-covered files and 2 genuine
regressions.
Default mode raises the recursion limit: `cmd/compile` trees are deep
enough that `json.dump` dies at 1000 frames; a leftover overflow is
counted unparseable rather than crashing the run.

Not a gate: needs a Go toolchain and a large external tree. `--limit`
is for iteration. Exit 0 even when files disagree — the headline number
is the result. Exit 1 only if the probe cannot run.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RUST_BIN = ROOT / "rust" / "target" / "release" / "docfmt"
ALIGN_BIN = ROOT / "rust" / "target" / "release" / "align_pass"
# gofmt ignores width; 80 is the corpus measurement width and does not
# change what the alignment pass sees.
WIDTH = 80
# ARG_MAX headroom for `gofmt -l`.
BATCH = 200


class Failed(Exception):
    """The probe cannot run. Disagreements with gofmt are not this."""


def goroot() -> Path:
    proc = subprocess.run(
        ["go", "env", "GOROOT"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or "go env GOROOT failed"
        raise Failed(err)
    path = Path(proc.stdout.strip())
    if not path.is_dir():
        raise Failed(f"GOROOT is not a directory: {path}")
    return path


def gofmt_bin(root: Path) -> Path:
    candidate = root / "bin" / "gofmt"
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return candidate
    from shutil import which

    found = which("gofmt")
    if found is None:
        raise Failed(f"no gofmt next to GOROOT ({candidate}) or on PATH")
    return Path(found)


def in_testdata(path: Path) -> bool:
    return "testdata" in path.parts


def non_test_go_files(root: Path) -> tuple[list[Path], int]:
    """Return (candidates outside testdata, count of testdata files skipped).

    Candidates are `GOROOT/src/**/*.go` excluding `*_test.go` and any
    path with a `testdata` component.
    """
    src = root / "src"
    if not src.is_dir():
        raise Failed(f"GOROOT has no src/: {src}")
    testdata = 0
    found = []
    for path in src.rglob("*.go"):
        if path.name.endswith("_test.go"):
            continue
        if in_testdata(path):
            testdata += 1
            continue
        found.append(path)
    found.sort()
    return found, testdata


def batched(items: list[Path], size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def gofmt_clean(files: list[Path], gofmt: Path) -> tuple[list[Path], int, int]:
    """Return (clean, gofmt-unparsable, gofmt-dirty)."""
    unparsable: set[Path] = set()
    dirty: set[Path] = set()

    def consume(chunk: list[Path], allow_retry: bool) -> None:
        proc = subprocess.run(
            [str(gofmt), "-l", *[str(path) for path in chunk]],
            capture_output=True,
            text=True,
            check=False,
        )
        for line in proc.stdout.splitlines():
            line = line.strip()
            if line:
                dirty.add(Path(line))
        if proc.returncode == 0:
            return
        if allow_retry and len(chunk) > 1:
            for path in chunk:
                consume([path], allow_retry=False)
            return
        unparsable.update(chunk)
        dirty.difference_update(chunk)

    for chunk in batched(files, BATCH):
        consume(chunk, allow_retry=True)
    clean = [path for path in files if path not in unparsable and path not in dirty]
    return clean, len(unparsable), len(dirty)


def parseable(path: Path, source: bytes, parser) -> dict | None:
    tree = parser.parse(source)
    if gen_trees.check_clean(tree.root_node, path):
        return None
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return {
        "language": "go",
        "source_file": str(path),
        "source": text,
        "root": gen_trees.convert(tree.root_node, source, None),
    }


def format_tree(tree_path: Path, rust: Path) -> tuple[str | None, str | None]:
    try:
        proc = subprocess.run(
            [str(rust), str(tree_path), str(WIDTH)],
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout after 60s"
    except OSError as exc:
        return None, f"could not execute: {exc}"
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        return None, err[:200] or f"exit {proc.returncode}"
    try:
        return proc.stdout.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "output was not valid UTF-8"


def align_only(text: str, align: Path) -> tuple[str | None, str | None]:
    try:
        proc = subprocess.run(
            [str(align)],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout after 60s"
    except OSError as exc:
        return None, f"could not execute: {exc}"
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        return None, err[:200] or f"exit {proc.returncode}"
    try:
        return proc.stdout.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "output was not valid UTF-8"


def first_diff(got: str, want: str) -> str:
    g_lines, w_lines = got.splitlines(), want.splitlines()
    for i, (a, b) in enumerate(zip(g_lines, w_lines), 1):
        if a != b:
            return f"line {i}: got {a!r} want {b!r}"
    if len(g_lines) != len(w_lines):
        return f"{len(g_lines)} vs {len(w_lines)} lines"
    if got != want:
        return "differ only in trailing newline"
    return "identical"


_thread = threading.local()


def thread_parser(manifest: mf.Manifest):
    parser = getattr(_thread, "parser", None)
    if parser is None:
        parser = mf.parser_for(manifest)
        _thread.parser = parser
    return parser


def check_formatter(path: Path, rust: Path, manifest: mf.Manifest) -> tuple[str, str]:
    source = path.read_bytes()
    try:
        doc = parseable(path, source, thread_parser(manifest))
    except RecursionError:
        return "unparsed", "tree-sitter convert exceeded recursion limit"
    if doc is None:
        return "unparsed", ""
    want = doc["source"]
    with tempfile.NamedTemporaryFile(
        "w",
        suffix=".tree.json",
        prefix="align-probe-",
        delete=False,
        encoding="utf-8",
    ) as tmp:
        tmp_path = Path(tmp.name)
        try:
            json.dump(doc, tmp, ensure_ascii=False, separators=(",", ":"))
        except RecursionError:
            tmp_path.unlink(missing_ok=True)
            return "unparsed", "tree JSON exceeded recursion limit"
    try:
        got, err = format_tree(tmp_path, rust)
    finally:
        tmp_path.unlink(missing_ok=True)
    if err is not None:
        return "refused", err
    assert got is not None
    if got == want:
        return "ok", ""
    return "mangled", first_diff(got, want)


def check_align(path: Path, align: Path) -> tuple[str, str]:
    try:
        want = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return "unparsed", "not utf-8"
    got, err = align_only(want, align)
    if err is not None:
        return "refused", err
    assert got is not None
    if got == want:
        return "ok", ""
    return "mangled", first_diff(got, want)


def rel_to(root: Path, path: str) -> str:
    try:
        return str(Path(path).relative_to(root))
    except ValueError:
        return path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        metavar="N",
        help="check at most N gofmt-clean files (0 = all)",
    )
    ap.add_argument(
        "--jobs",
        type=int,
        default=os.cpu_count() or 4,
        metavar="N",
        help="parallel workers (default: nproc)",
    )
    ap.add_argument(
        "--align-only",
        action="store_true",
        help="retired: errors out, see the module docstring",
    )
    ap.add_argument(
        "--verbose",
        action="store_true",
        help="print every mangled/refused file",
    )
    args = ap.parse_args()
    if args.limit < 0:
        raise Failed("--limit must be >= 0")
    if args.jobs < 1:
        raise Failed("--jobs must be >= 1")
    # cmd/compile trees are deep enough that the default 1000-frame
    # limit dies inside json.dump. --align-only never builds a tree.
    sys.setrecursionlimit(10000)

    if args.align_only:
        raise Failed(
            "--align-only is retired. Alignment aligns markers now, and gofmt "
            "output has none, so the pass is a no-op and this flag reported "
            "0/4814 whatever the code did. To compare two trees, run default "
            "mode with --verbose in each and diff the mangled paths. See "
            "docs/onboarding/cell-spike.md."
        )
    if not RUST_BIN.is_file():
        raise Failed("rust/target/release/docfmt is missing; run ./build.sh first")

    # Bootstrap before any work so a missing grammar re-execs the script
    # once, rather than reprinting the GOROOT walk.
    go = None if args.align_only else mf.bootstrap()["go"]

    root = goroot()
    gofmt = gofmt_bin(root)
    mode = "alignment pass" if args.align_only else "full formatter"
    print(f"GOROOT  {root}")
    print(f"gofmt   {gofmt}")
    print(f"mode    {mode}")
    print(f"runtime {ALIGN_BIN if args.align_only else RUST_BIN}")

    candidates, testdata = non_test_go_files(root)
    print(f"non-test under src/         {len(candidates) + testdata}")
    print(f"testdata skipped            {testdata}")
    print(f"candidates                  {len(candidates)}")
    clean, gofmt_unparsed, gofmt_dirty = gofmt_clean(candidates, gofmt)
    print(f"gofmt unparseable           {gofmt_unparsed}")
    print(f"gofmt would rewrite         {gofmt_dirty}")
    print(f"gofmt-clean                 {len(clean)}")

    paths = [str(path) for path in clean]
    if args.limit:
        paths = paths[: args.limit]
    jobs = min(args.jobs, len(paths)) or 1
    mangled: list[tuple[str, str]] = []
    refused: list[tuple[str, str]] = []
    unparsed = 0
    compared = 0

    def submit(pool, path: str):
        if args.align_only:
            return pool.submit(check_align, Path(path), ALIGN_BIN)
        assert go is not None
        return pool.submit(check_formatter, Path(path), RUST_BIN, go)

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {submit(pool, path): path for path in paths}
        for fut in as_completed(futures):
            path = futures[fut]
            status, detail = fut.result()
            if status == "unparsed":
                unparsed += 1
                continue
            if status == "refused":
                refused.append((path, detail))
                continue
            compared += 1
            if status == "mangled":
                mangled.append((path, detail))

    print(f"tree-sitter unparseable     {unparsed}")
    print(f"refused                     {len(refused)}")
    print(f"compared                    {compared}")
    rate = (100.0 * len(mangled) / compared) if compared else 0.0
    print(f"\n{len(mangled)} mangled / {compared} checked ({rate:.2f}%)")
    show = mangled if args.verbose else mangled[:20]
    for path, detail in show:
        print(f"  {rel_to(root, path)}: {detail}")
    if not args.verbose and len(mangled) > 20:
        print(f"  ... {len(mangled) - 20} more; pass --verbose for the full list")
    if refused and (args.verbose or len(refused) <= 10):
        for path, detail in refused:
            print(f"  refused {rel_to(root, path)}: {detail}")
    elif refused:
        print(f"  {len(refused)} refusals; pass --verbose to list them")
    return 0


if __name__ == "__main__":
    try:
        mf.cli(main)
    except Failed as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
