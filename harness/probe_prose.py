#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter", "tree-sitter-markdown==0.5.1"]
# ///
"""The three things the A2.1 prose projection has to be true for.

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

**A'. An eligible paragraph holds only inline syntax A2.1 admits, and holds
each piece of it whole.** Every eligible paragraph is re-parsed with the
package's *inline* grammar -- from its own bytes, not from the secondary table
the producer attached, so a dropped or misranged record cannot hide here. Two
things must hold: every named node is a `code_span`, `inline_link` or
`uri_autolink`, and every one of those lies wholly **inside a single atom**.

Under A1 this check demanded no named node at all. A2.1 admits three, so the
oracle moves rather than retires -- `emphasis`, `image`, `shortcut_link` and
`full_reference_link` all occur in this corpus and must still refuse. The
protected-whole half is new, and it is the half a reflow-and-reparse sweep
cannot do: the block grammar sees a paragraph's interior as one opaque node, so
only the inline grammar can say whether a gap landed inside a code span.

**It is weaker than "contains no inline syntax", and the gap has a name.** GFM
extended autolinks -- `www.example.com`, `https://example.com` -- *are* inline
syntax, and a renderer makes them links, but tree-sitter-markdown 0.5.1 parses
both as a bare `inline` node. So this check cannot speak for `.`, `:` or `/`,
which are exactly the characters that spell them. What can be said for those
rests on argument plus two independent searches with real renderers: neither
prettier 3.9.6 nor micromark+GFM nor cmark-gfm produced a meaning change from
any gap assignment near an autolink, across roughly 43,000 rendered variants.
An autolink contains no space, so it lies inside one atom and cannot be split,
and a space and a newline are the same flanking class on either side of it.

The same blindness is what let a GFM table delimiter row through until a
renderer-driven search found it -- see `_ACQUIRES` in `prose.py`. A CST oracle
is bounded by what its grammar models, and this one models neither pipeless
tables nor autolink literals.

**The inline grammar stopped being a test-time dependency at A2.1.** Under A1
it was an oracle this probe consulted and the producers did not, which was the
whole A1/A2 split. A2.1's predicate reads the secondary table, so the grammar is
now a **producer** dependency on both sides: `markdown_inline.blob.json` is
required for the browser path to reach the same verdicts, and `test.sh` fails in
its first second without it.

It still does not appear in `probe_injection_parity.py`'s declared blob set,
because that set is derived from the *injected* languages in a produced document
and a secondary grammar is never one -- the open half of the 2026-09-13 finding,
recorded at the top of that file. `markdown_manifest()` below declares it here
instead, and fails loudly if the manifest stops carrying it.

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

A2.1 retargeted that fixture, because a near miss is only a near miss for one
predicate. Terminated code spans and inline links are now *inside* the
boundary, so the entries moved one character out (an unterminated backtick, a
shortcut link), and the entries A2.1 deliberately admits left -- this file can
only detect a change in eligibility, and those are eligible either way. What
guards them now is `harness/test_prose.py`, which asserts the emitted partition
and carries a mutation control that restores predecessor-only protection.

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
import manifest as mf  # noqa: E402
import prose  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "harness"
REFUSED = HARNESS / "fixtures" / "prose-refused.md"
ADMITTED = HARNESS / "fixtures" / "prose-admitted.md"
WIDTHS = (80, 40)
# The secondary grammar A2.1 reads. Named here rather than hardcoded at the
# call site so that a manifest rename fails loudly in `markdown_manifest`.
INLINE = "markdown_inline"


class Failed(Exception):
    """A property the projection is supposed to have does not hold."""


def markdown_manifest() -> mf.Manifest:
    """Markdown's manifest, with its inline secondary declaration checked.

    `probe_injection_parity.py` derives its required blob set from the injected
    languages in a produced document, so a *secondary* grammar is never in it --
    the open half of the 2026-09-13 finding. A2.1 makes the inline grammar a
    hard dependency of the projection, so this probe declares it itself.
    """
    manifest = mf.load_all()["markdown"]
    names = [grammar.name for grammar in manifest.secondary_grammars]
    if INLINE not in names:
        raise Failed(
            f"markdown declares secondary grammars {names}, not {INLINE!r}; "
            "the prose projection reads that tree and cannot run without it"
        )
    return manifest


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


def parse(parser, source: bytes, path: Path, inline_parser=None) -> dict | None:
    """The document `gen_trees.py` would freeze for this source, or None.

    The secondary table is attached through `gen_trees.secondary_trees` -- the
    same function `parse_doc` calls -- rather than rebuilt here. A2.1 reads
    that table, so a probe that synthesised its own would be testing the probe.
    """
    tree = parser.parse(source)
    if tree.root_node.has_error:
        return None
    rel = str(path.relative_to(ROOT))
    root = gen_trees.convert(tree.root_node, source, None)
    doc = {
        "language": "markdown",
        "source_file": rel,
        "source": source.decode("utf-8"),
        "root": root,
    }
    if inline_parser is not None:
        secondary = gen_trees.secondary_trees(
            markdown_manifest(), source, root, {INLINE: inline_parser}, rel
        )
        if secondary:
            doc["secondary"] = secondary
    return doc


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
        (child["start"], child["end"], child["text"])
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


def phase_a(parser, inline_parser, docs) -> int:
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
            again = parse(parser, moved, path, inline_parser)
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
            if atoms(prose.project(again)) != want_atoms:
                raise Failed(
                    f"{path}: reflowed with {name}, the projection no longer "
                    f"finds the same atoms"
                )
            checked += 1
    return checked


def phase_a_inline(inline_parser, docs) -> int:
    """Every eligible paragraph, re-read by the inline grammar from scratch.

    Independent of the projection, and that is the point: `prose.py` reads the
    secondary table the *producer* attached, so a bug that dropped or misranged
    a record would be invisible to a check that read the same table. This
    reparses the run's own bytes and asserts two things the projection claims.

    **Every named node is an admitted construct.** A1 required *no* named node;
    A2.1 admits three and still refuses the rest, so the oracle moves rather
    than retires -- `emphasis`, `image`, `shortcut_link` and
    `full_reference_link` all occur in this corpus and must still refuse.

    **Every admitted construct lies wholly inside one atom.** This is the
    "protected whole" claim stated as a property of the emitted partition, and
    it is what a reflow-and-reparse sweep cannot check on its own, since
    tree-sitter's block grammar sees a paragraph's interior as one opaque node.
    """
    checked = 0
    for path, source, doc in docs:
        for run in runs(doc):
            start, text = run["start"], source[run["start"] : run["end"]]
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
                if child.type not in prose.CONSTRUCTS
                and (child.is_named or child.type not in prose.SAFE_PUNCTUATION)
            ]
            if found:
                raise Failed(
                    f"{path}: an eligible paragraph holds inline syntax "
                    f"({', '.join(sorted(set(found)))}) that A2.1 cannot reason "
                    f"about: {text[:60]!r}"
                )
            spans = [
                (child["start"], child["end"])
                for child in run["children"]
                if child["type"] == prose.ATOM
            ]
            for child in root.children:
                if child.type not in prose.CONSTRUCTS:
                    continue
                first, last = start + child.start_byte, start + child.end_byte
                if not any(a <= first and last <= b for a, b in spans):
                    raise Failed(
                        f"{path}: a {child.type} at {first}..{last} is split "
                        f"across atoms {spans}, so it is not protected whole: "
                        f"{text[:60]!r}"
                    )
            checked += 1
    return checked


def phase_b(parser, inline_parser, docs, inert: bool = False) -> int:
    # Re-parse rather than reuse: `docs` holds already-projected documents, and
    # a verdict computed from one of those would describe the projection's own
    # output instead of the source. Both sides must be handed the same
    # unprojected input.
    fresh = [
        (path, parse(parser, source, path, inline_parser))
        for path, source, _ in docs
    ]
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
        env={**os.environ, "PROSE_NO_PROJECT": "1"} if inert else None,
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
        if other["doc"] != prose.project(doc):
            raise Failed(
                f"{path.relative_to(ROOT)}: the two projections differ "
                f"over {len(verdicts)} paragraph(s)"
            )
        compared += len(verdicts)
    if compared == 0:
        raise Failed("the producer comparison saw no paragraphs at all")
    return compared


def phase_b_control(parser, inline_parser, docs) -> str:
    """Phase B must fail when the JavaScript side does nothing.

    The positive control for the producer comparison, and it is here because
    this check has already been vacuous once: it compared *projected*
    documents that Python had projected before JavaScript ever saw them, so a
    JavaScript projection replaced by a no-op passed. A gate that cannot tell a
    working producer from an absent one is the same failure as a sweep that
    runs on nothing.

    **The control has to fail for the reason it names.** It was itself vacuous
    a second time: the inert driver returned no verdicts either, so phase B
    stopped at the verdict list and never reached the document comparison --
    the control would have stayed green with that comparison deleted. So the
    inert driver now computes verdicts normally, and the message is read back
    here. A control that accepts *any* failure only proves something is broken,
    not that the check under test is the thing doing the catching.
    """
    want = "the two projections differ"
    try:
        phase_b(parser, inline_parser, docs, inert=True)
    except Failed as failure:
        if want not in str(failure):
            raise Failed(
                "phase B failed with the JavaScript projection disabled, but "
                f"not at the projection comparison: {failure}"
            ) from None
        return "a no-op JavaScript projection fails phase B's document check"
    raise Failed(
        "the producer comparison PASSED with the JavaScript projection "
        "disabled -- it is not comparing what it claims to"
    )


def phase_c(parser, inline_parser, packages: Path, docs) -> int:
    # The admitted fixture joins the corpus here deliberately. Phase A proves
    # its shapes survive reflow; this proves the two runtimes agree on them and
    # that formatting them is idempotent, which is the half a reparse cannot
    # see. Without it the coalesced shapes would reach neither runtime, since
    # none of them occurs in `corpus/src/markdown`.
    corpus = [
        (path, source, doc)
        for path, source, doc in docs
        if path.parent == ROOT / "corpus" / "src" / "markdown" or path == ADMITTED
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
                again = parse(parser, outputs["fmt-rust"], path, inline_parser)
                if again is None:
                    raise Failed(
                        f"{path.name} at {width}: formatted output does not "
                        "parse cleanly"
                    )
                # Both runtimes on the second pass, not just Rust. A JavaScript
                # defect reachable only from a formatter-produced line
                # distribution -- which is a different shape from any
                # hand-written source -- would otherwise pass.
                tree_path.write_text(
                    json.dumps(prose.project(again)), encoding="utf-8"
                )
                for exe in ("fmt-rust", "fmt-js"):
                    proc = subprocess.run(
                        [str(ROOT / exe), str(tree_path), str(width)],
                        capture_output=True,
                        env=env,
                        timeout=120,
                    )
                    if proc.returncode != 0:
                        raise Failed(
                            f"{path.name} at {width}: {exe} refused its own "
                            f"output: {proc.stderr.decode().strip()}"
                        )
                    if proc.stdout != outputs["fmt-rust"]:
                        raise Failed(
                            f"{path.name} at {width}: {exe} is not idempotent"
                        )
                    checked += 1
    return checked


def main(quiet: bool = False) -> int:
    parser = ts.Parser(ts.Language(tsmd.language()))
    inline_parser = ts.Parser(ts.Language(tsmd.inline_language()))
    docs = []
    skipped = 0
    for path in markdown_files():
        source = path.read_bytes()
        doc = parse(parser, source, path, inline_parser)
        if doc is None:
            skipped += 1
            continue
        docs.append((path, source, prose.project(doc)))

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

    # The mirror invariant: `prose-refused.md` must yield nothing, and
    # `prose-admitted.md` must refuse nothing. A refusal fixture can only
    # detect a change in eligibility, so it cannot guard the shapes A2.1
    # deliberately admits -- those are eligible before and after any mutation
    # worth worrying about, and what changes is the partition. This file is
    # where the real parser, the real secondary grammar and both runtimes get
    # to see them.
    admitted = [entry for entry in docs if entry[0] == ADMITTED]
    if not admitted:
        raise Failed(f"the admitted fixture {ADMITTED.name} was not swept")
    for path, source, doc in admitted:
        fresh = parse(parser, source, path, inline_parser)
        refused = [
            (start, why)
            for start, why in prose.reasons(fresh)
            if why != "eligible"
        ]
        if refused:
            start, why = refused[0]
            text = source[start : start + 60].decode(errors="replace")
            raise Failed(
                f"{path.name} exists to be admitted, but {len(refused)} of its "
                f"paragraphs are refused, starting with {why!r} at {text!r}"
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
        reflows = phase_a(parser, inline_parser, docs)
        inlines = phase_a_inline(inline_parser, docs)
        projections = phase_b(parser, inline_parser, docs)
        control = phase_b_control(parser, inline_parser, docs)
        formats = phase_c(parser, inline_parser, packages, docs)

    if not quiet:
        print(
            f"prose projection: {eligible} eligible paragraphs in "
            f"{len(docs)} files ({skipped} unparseable); "
            f"{reflows} reflow-reparse checks, "
            f"{inlines} inline-oracle checks, "
            f"{projections} producer paragraph verdicts, "
            f"{formats} runtime/idempotence checks; {control}; "
            f"{REFUSED.name} still refuses every paragraph and "
            f"{ADMITTED.name} still admits every paragraph"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main("--quiet" in sys.argv[1:]))
    except Failed as exc:
        print(f"FAIL prose projection: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
