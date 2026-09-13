#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-markdown==0.5.1"]
# ///
"""The three things the A1 prose projection has to be true for.

    ./harness/probe_prose.py [--quiet]

`harness/prose.py` admits a paragraph by a whitelist, and the argument for each
admitted character is written there. This is the evidence for that argument.

**A. Reflow changes nothing but the gap bytes.** Replacing a gap is the only
edit the projection enables, and a space and a newline are both one byte, so a
reflow moves no offset anywhere in the document. That gives an invariant sharp
enough to test exhaustively: reflow every eligible paragraph in a file, reparse,
and require **the entire block tree to come back node for node at the same
offsets**. Not just the atoms -- the whole tree, because the damage worth
catching is a paragraph that acquired a list item or a blockquote that lost its
continuation marker, and both of those are invisible in an atom sequence. The
patterns are adversarial rather than realistic: one word per line is the worst
case for a word that could start a block, and no particular width need produce
it.

**A'. An eligible paragraph contains no inline syntax at all.** This is the
whitelist's actual claim, checked against an oracle that knows nothing about
the whitelist: the pinned Markdown package's *inline* grammar. Every eligible
paragraph is parsed with it, and the result must be a bare `inline` node -- no
`code_span`, no `emphasis`, no `inline_link`, nothing named. A1 cannot reason
about inline constructs, so admitting a paragraph that holds one is the error
this is looking for, and it is found directly rather than inferred from a
reflow that happened not to break.

The inline grammar is a **test-time** dependency, not a producer one. That
distinction is the whole A1/A2 split: `gen_trees.py` could load it today, the
browser could not, and a check that runs here costs the browser nothing.
Because it is not a producer dependency it also does not belong in
`probe_injection_parity.py`'s declared blob set.

**B. The two producers agree.** `prose.py` and `prose.mjs` are handed the same
documents and must return the same one -- *and* the same verdict for every
paragraph, including the nine in ten they refuse. Comparing documents alone
would be vacuous on a document with no eligible paragraph, which is most of
them, and would let the two implementations disagree about why as long as the
output happened to match. Parse agreement is not re-checked here -- markdown is
an injection host, so `probe_injection_parity.py` already compares the two parse
paths on it -- which leaves the projection itself as the new surface, and this
as the only check over it.

**C. The two runtimes agree, and formatting is idempotent.** The committed
markdown corpus, projected, formatted by `fmt-rust` and `fmt-js` at both
widths. Then reparsed, reprojected and formatted again: the second pass must
be byte-identical to the first.

**R. The refusal fixture stays refused.** Real prose is a poor test of a
whitelist. A document holding a backslash almost always holds a backtick or a
link too, so admitting the backslash changes which paragraphs are eligible not
at all, and the mutation that admits it looks safe. Measured: of ten unsafe
edits to `prose.py`, only four changed the eligible set on this repository's
own markdown at all. `harness/fixtures/prose-refused.md` is the control --
paragraphs that are near misses in exactly one respect each, which must yield
zero eligible paragraphs.

A, A' and B sweep every markdown file in the repository, not just the corpus,
so adding a document adds test material for free. A failure that names a file
outside `corpus/` is still a real failure: it means real prose reached a case
the predicate admits and should not.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import tree_sitter as ts
import tree_sitter_markdown as tsmd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402
import prose  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "harness"
REFUSED = HARNESS / "fixtures" / "prose-refused.md"
WIDTHS = (80, 40)


class Failed(Exception):
    """A property the projection is supposed to have does not hold."""


def markdown_files() -> list[Path]:
    """Every **tracked** markdown file in the repository, corpus first.

    Tracked, not globbed. A glob picks up gitignored offload notes, vendored
    trees and other worktrees, so the set this gate runs on would depend on
    what happened to be lying in the checkout -- and a probe whose input set is
    not reproducible from the commit cannot be a gate. `git ls-files` makes the
    input exactly the commit's, on every machine.
    """
    listed = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "*.md"],
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    tracked = sorted(
        ROOT / name for name in listed.split("\0") if name
    )
    corpus_dir = ROOT / "corpus" / "src" / "markdown"
    corpus = [path for path in tracked if path.parent == corpus_dir]
    rest = [path for path in tracked if path.parent != corpus_dir]
    return corpus + rest


def parse(parser, source: bytes, path: Path) -> dict | None:
    """The document `gen_trees.py` would freeze for this source, or None."""
    tree = parser.parse(source)
    if tree.root_node.has_error:
        return None
    return {
        "language": "markdown",
        "source_file": str(path.relative_to(ROOT)),
        "source": source.decode("utf-8"),
        "root": gen_trees.convert(tree.root_node, source, None),
    }


def runs(doc: dict) -> list[dict]:
    out = []
    stack = [doc["root"]]
    while stack:
        node = stack.pop()
        if node["type"] == prose.RUN:
            out.append(node)
            continue
        stack.extend(node.get("children", []))
    return sorted(out, key=lambda run: run["start"])


def atoms(doc: dict) -> list[tuple[int, int, str]]:
    return [
        (child["start"], child["end"], child["children"][0]["text"])
        for run in runs(doc)
        for child in run["children"]
        if child["type"] == prose.ATOM
    ]


def reflow(source: bytes, doc: dict, pattern) -> bytes:
    """Rewrite every gap in every run, keeping the byte length identical."""
    out = bytearray(source)
    for run in runs(doc):
        gaps = [c for c in run["children"] if c["type"] == prose.GAP]
        for index, gap in enumerate(gaps):
            out[gap["start"]] = ord(pattern(index, len(gaps)))
    return bytes(out)


PATTERNS = {
    "all-space": lambda i, n: " ",
    "all-newline": lambda i, n: "\n",
    "alternate": lambda i, n: " \n"[i % 2],
    "reverse-alternate": lambda i, n: "\n "[i % 2],
    "last-only": lambda i, n: "\n" if i == n - 1 else " ",
    "first-only": lambda i, n: "\n" if i == 0 else " ",
}


def shape(node: dict) -> list[tuple[str, int, int]]:
    """Every node's type and range, pre-order. Reflow must not move one."""
    out = []
    stack = [node]
    while stack:
        item = stack.pop()
        out.append((item["type"], item["start"], item["end"]))
        stack.extend(reversed(item.get("children", [])))
    return out


def phase_a(parser, docs) -> int:
    checked = 0
    for path, source, doc in docs:
        want_atoms = atoms(doc)
        if not want_atoms:
            continue
        # The unprojected tree: what the reflowed source has to reproduce.
        want = shape(parse(parser, source, path)["root"])
        for name, pattern in PATTERNS.items():
            moved = reflow(source, doc, pattern)
            if len(moved) != len(source):
                raise Failed(f"{path}: {name} changed the source length")
            again = parse(parser, moved, path)
            if again is None:
                raise Failed(
                    f"{path}: reflowed with {name}, the document no longer "
                    "parses cleanly"
                )
            got = shape(again["root"])
            if got != want:
                first = next(
                    (w for w, g in zip(want, got) if w != g),
                    (want + got)[min(len(want), len(got))],
                )
                raise Failed(
                    f"{path}: reflowed with {name}, the block tree changed "
                    f"({len(want)} nodes became {len(got)}); first divergence "
                    f"at {first!r}"
                )
            prose.project(again)
            if atoms(again) != want_atoms:
                raise Failed(
                    f"{path}: reflowed with {name}, the projection no longer "
                    f"finds the same atoms"
                )
            checked += 1
    return checked


def phase_a_inline(inline_parser, docs) -> int:
    """Every eligible paragraph, read by the grammar A1 refuses to depend on."""
    checked = 0
    for path, source, doc in docs:
        for run in runs(doc):
            text = source[run["start"] : run["end"]]
            tree = inline_parser.parse(text)
            root = tree.root_node
            if root.has_error:
                raise Failed(
                    f"{path}: an eligible paragraph does not parse as inline: "
                    f"{text[:60]!r}"
                )
            found = [
                child.type
                for child in root.children
                if child.is_named or child.type not in prose.SAFE_PUNCTUATION
            ]
            if found:
                raise Failed(
                    f"{path}: an eligible paragraph holds inline syntax "
                    f"({', '.join(sorted(set(found)))}) that A1 cannot reason "
                    f"about: {text[:60]!r}"
                )
            checked += 1
    return checked


def phase_b(parser, docs) -> int:
    # Re-parse rather than reuse: `docs` holds already-projected documents, and
    # a verdict computed from one of those would describe the projection's own
    # output instead of the source. Both sides must be handed the same
    # unprojected input.
    fresh = [(path, parse(parser, source, path)) for path, source, _ in docs]
    mine = [(path, prose.reasons(doc)) for path, doc in fresh]
    payload = [
        {"path": str(path.relative_to(ROOT)), "doc": doc}
        for path, doc in fresh
    ]
    proc = subprocess.run(
        ["node", str(HARNESS / "ts_prose.mjs")],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise Failed(f"JavaScript projection failed: {proc.stderr.strip()}")
    theirs = json.loads(proc.stdout)
    if len(theirs) != len(payload):
        raise Failed(
            f"JavaScript returned {len(theirs)} documents for {len(payload)}"
        )
    compared = 0
    for (path, verdicts), (_, doc), other in zip(mine, fresh, theirs, strict=True):
        got = [(start, reason) for start, reason in other["reasons"]]
        if got != verdicts:
            first = next(
                (w for w, g in zip(verdicts, got) if w != g),
                (verdicts + got)[min(len(verdicts), len(got))],
            )
            raise Failed(
                f"{path.relative_to(ROOT)}: the two producers disagree on a "
                f"paragraph verdict; first divergence at {first!r}"
            )
        prose.project(doc)
        if other["doc"] != doc:
            raise Failed(
                f"{path.relative_to(ROOT)}: the two projections differ "
                f"({other['count']} runs in JavaScript)"
            )
        compared += len(verdicts)
    if compared == 0:
        raise Failed("the producer comparison saw no paragraphs at all")
    return compared


def phase_c(parser, packages: Path, docs) -> int:
    corpus = [
        (path, source, doc)
        for path, source, doc in docs
        if path.parent == ROOT / "corpus" / "src" / "markdown"
    ]
    env = {**os.environ, "FMT_PACKAGES": str(packages)}
    checked = 0
    with tempfile.TemporaryDirectory(prefix="prose-fmt-") as tmp:
        tree_path = Path(tmp) / "doc.tree.json"
        for path, _, doc in corpus:
            if not runs(doc):
                continue
            for width in WIDTHS:
                outputs = {}
                for exe in ("fmt-rust", "fmt-js"):
                    tree_path.write_text(json.dumps(doc), encoding="utf-8")
                    proc = subprocess.run(
                        [str(ROOT / exe), str(tree_path), str(width)],
                        capture_output=True,
                        env=env,
                        timeout=120,
                    )
                    if proc.returncode != 0:
                        raise Failed(
                            f"{path.name} at {width}: {exe} refused: "
                            f"{proc.stderr.decode().strip()}"
                        )
                    outputs[exe] = proc.stdout
                if outputs["fmt-rust"] != outputs["fmt-js"]:
                    raise Failed(f"{path.name} at {width}: the runtimes disagree")

                # Idempotence: the formatter's own output, parsed and projected
                # again, must format to itself. This is where a projection that
                # is stable only on hand-written source would come apart.
                again = parse(parser, outputs["fmt-rust"], path)
                if again is None:
                    raise Failed(
                        f"{path.name} at {width}: formatted output does not "
                        "parse cleanly"
                    )
                prose.project(again)
                tree_path.write_text(json.dumps(again), encoding="utf-8")
                proc = subprocess.run(
                    [str(ROOT / "fmt-rust"), str(tree_path), str(width)],
                    capture_output=True,
                    env=env,
                    timeout=120,
                )
                if proc.returncode != 0 or proc.stdout != outputs["fmt-rust"]:
                    raise Failed(f"{path.name} at {width}: not idempotent")
                checked += 1
    return checked


def main(quiet: bool = False) -> int:
    parser = ts.Parser(ts.Language(tsmd.language()))
    inline_parser = ts.Parser(ts.Language(tsmd.inline_language()))
    docs = []
    skipped = 0
    for path in markdown_files():
        source = path.read_bytes()
        doc = parse(parser, source, path)
        if doc is None:
            skipped += 1
            continue
        prose.project(doc)
        docs.append((path, source, doc))

    admitted = [
        (path, source, doc) for path, source, doc in docs if path == REFUSED
    ]
    if not admitted:
        raise Failed(f"the refusal fixture {REFUSED.name} was not swept")
    for path, source, doc in admitted:
        found = runs(doc)
        if found:
            text = source[found[0]["start"] : found[0]["end"]].decode()
            raise Failed(
                f"{path.name} exists to be refused, but {len(found)} of its "
                f"paragraphs are eligible, starting with {text[:60]!r}"
            )

    eligible = sum(len(runs(doc)) for _, _, doc in docs)
    if eligible == 0:
        raise Failed(
            f"0 eligible paragraphs in {len(docs)} markdown files -- the sweep "
            "ran on nothing, which is not the same as finding nothing"
        )

    with tempfile.TemporaryDirectory(prefix="prose-pkg-") as tmp:
        packages = Path(tmp)
        base = json.loads((ROOT / "packages" / "markdown.json").read_text())
        (packages / "markdown.json").write_text(
            json.dumps(prose.package(base)), encoding="utf-8"
        )
        reflows = phase_a(parser, docs)
        inlines = phase_a_inline(inline_parser, docs)
        projections = phase_b(parser, docs)
        formats = phase_c(parser, packages, docs)

    if not quiet:
        print(
            f"prose projection: {eligible} eligible paragraphs in "
            f"{len(docs)} files ({skipped} unparseable); "
            f"{reflows} reflow-reparse checks, "
            f"{inlines} inline-oracle checks, "
            f"{projections} producer paragraph verdicts, "
            f"{formats} runtime/idempotence checks; "
            f"{REFUSED.name} still refuses every paragraph"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main("--quiet" in sys.argv[1:]))
    except Failed as exc:
        print(f"FAIL prose projection: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
