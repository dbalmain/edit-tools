#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Differential fuzzer for the parse layer: edit, reparse, compare.

    ./harness/parse_oracle.py [--language NAME] [--files N] [--edits N]
                              [--seed N] [--json] [--verbose]
    ./harness/parse_oracle.py --freeze [--language NAME]

`gen_trees.py` refuses to emit a tree containing ERROR or MISSING, so by
construction **no corpus file exercises error recovery**, and nothing in this
repo has ever edited a buffer and reparsed. Both gaps are named in
`docs/parse-layer.md` as the gate in front of any own-the-parser route. This
script is that gate.

Two products, and they test different halves:

* **The sweep** (default) makes seeded pseudo-random edits at UTF-8 character
  boundaries, reparses each state from scratch *and* incrementally from the
  previous tree, and demands the two agree node for node -- ERROR and MISSING
  included. That is the only thing here that can see an incremental-reparse
  bug, and it needs a live parser, so it can never be frozen.
* **`--freeze`** writes `corpus/trees-edited/`: four clean bases per language,
  four single-edit states each, with tree-sitter's answer including ERROR and
  MISSING, in the same JSON shape as `corpus/trees/*.tree.json` (whitespace
  differs -- one node per line, see `dumps`). A frozen fixture cannot
  test incrementality (a candidate parser has no old tree to hand), so it tests
  the other half: **error recovery**, against a diffable oracle that survives a
  grammar bump because it was committed before the bump.

A failure is replayable from its seed *and* the pinned grammar. The pin is the
weaker half of that promise -- see `docs/cst-contract.md` -- which is the
argument for freezing fixtures rather than shipping a seed and calling it
reproducible.

Injections are **off** here, deliberately: a candidate parse layer parses one
language, so the oracle it should be measured against is the host grammar's own
recovery, not a splice of two grammars over broken source. `corpus/trees/`
keeps its injected shape; `corpus/trees-edited/` does not.

Not on `test.sh` and not in `score.py`, the same way `parity_fuzz.py` is not.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
EDITED = ROOT / "corpus" / "trees-edited"

DEFAULT_SEED = 0
DEFAULT_EDITS = 24
DEFAULT_FILES = 3

# Fixture budget, and the shape of it matters more than the total. Coverage
# here is *breadth of syntactic neighbourhood*, not depth per file: a scanner
# bug lives in one construct, and eight edits around a single import block all
# probe the same construct. So spend the budget on more base files with fewer
# states each. Four files x four states, smallest files first.
FREEZE_FILES = 4
FREEZE_STATES = 4
FREEZE_CLEAN_STATES = 1
FREEZE_SEED = 0
FREEZE_CANDIDATES = 400

# Payloads that break a lexer rather than a parser: unbalanced delimiters, a
# stray backslash, a lone CR, a multi-byte character, an indent. Eight of ten
# grammars this repo pins have an imperative external scanner, and this is the
# input class those scanners own.
BREAKERS = (
    '"',
    "'",
    "`",
    "{",
    "}",
    "(",
    ")",
    "[",
    "]",
    "<",
    ">",
    "\\",
    "#",
    "//",
    "/*",
    "*/",
    "-->",
    "\n",
    "\n\n",
    "\r\n",
    "\r",
    "\t",
    "    ",
    " ",
    ";",
    ",",
    ":",
    "=",
    "é",
    "🙂",
    " ",
    "end",
    "]]>",
)


class Divergence(Exception):
    """The comparator found a difference. The message is the finding."""


# --------------------------------------------------------------------------
# recorded findings

# Minimal reproducers for the scratch-vs-incremental divergence this script
# found, shrunk by delta debugging from a seeded sweep. `--known` replays them.
#
# Recorded as literal bytes rather than as a seed, on purpose. A seed
# reproduces only while the grammar pin *and* the tree-sitter runtime hold, and
# the runtime is pinned nowhere in this repo -- `gen_trees.py` declares a bare
# `tree-sitter`, so `uv` resolves whatever is current. These bytes outlive both.
#
# Measured 2026-08-30, tree-sitter 0.26.0, grammars at the manifest pins:
# 145 divergences in 60,480 states over 12 seeds and 16 languages, and **8
# languages reproduce it** (haskell, json, kotlin, javascript, rust,
# typescript, css, scheme). That breadth is why this is filed against the
# incremental machinery rather than against any one grammar.
KNOWN_DIVERGENCES = (
    {
        "id": "json/insert-brace",
        "language": "json",
        "before": b'"":{"":{"":{"":{"":{}}t"}}}}},"":"]}}',
        "edit": (0, 0, b"{"),
        "expect": "root.type: incremental='ERROR' scratch='document'",
    },
    {
        "id": "kotlin/insert-paren",
        "language": "kotlin",
        "before": (
            b"k e: :{\n ,\n    GREEN,\n    BLUE, /ember\n}\n\nobject Registry {\n"
            b"    const val version: Int = 1\n\n    companion object {\n <     */"
            b"fun create(): Registry = Registry /#/ companion fa    }\n}\n\n}\n"
        ),
        "edit": (6, 6, b")"),
        "expect": "root.type: incremental='ERROR' scratch='source_file'",
    },
)


# --------------------------------------------------------------------------
# tree -> our JSON shape, plus the one key tree-sitter has and the shape does not


def convert(node, source: bytes) -> dict:
    """`gen_trees.convert` with injections off, plus a `missing` marker.

    Shape fidelity is not restated here on purpose -- it is one function in
    `gen_trees.py` and a second copy of it is a second thing to keep in step.
    What that function cannot carry is `is_missing`: tree-sitter renders a
    MISSING node as a zero-width leaf whose `type` is the token it wanted, and
    a zero-width leaf is not otherwise distinguishable from a real empty one.
    With injections off the two structures are isomorphic, so a parallel walk
    stamps the flag exactly.

    `missing` is an additive key. `rust/src/tree.rs` deserialises without
    `deny_unknown_fields` and the JS loader reads named properties, so both
    runtimes ignore it and every existing consumer still reads these files.
    """
    out = gen_trees.convert(node, source, None)
    _stamp_missing(node, out)
    return out


def _stamp_missing(node, out: dict) -> None:
    if node.is_missing:
        out["missing"] = True
    children = out.get("children")
    if children is None:
        return
    if len(children) != len(node.children):  # pragma: no cover -- injections off
        raise Divergence("convert() dropped a child; injections must be off here")
    for ts_child, our_child in zip(node.children, children):
        _stamp_missing(ts_child, our_child)


def count_problems(root: dict) -> dict[str, int]:
    counts = {"error": 0, "missing": 0}
    stack = [root]
    while stack:
        node = stack.pop()
        if node.get("type") == "ERROR":
            counts["error"] += 1
        if node.get("missing"):
            counts["missing"] += 1
        stack.extend(node.get("children", ()))
    return counts


def signature(root: dict) -> str:
    """Shape identity for dedup: kinds and spans, no text, no fields."""
    parts: list[str] = []

    def walk(node: dict) -> None:
        parts.append(f"{node.get('type')}:{node.get('start')}:{node.get('end')}")
        if node.get("missing"):
            parts.append("!")
        for child in node.get("children", ()):
            walk(child)
        parts.append(")")

    walk(root)
    return "".join(parts)


# --------------------------------------------------------------------------
# comparison


def compare(got: dict, want: dict, path: str = "root") -> None:
    """First structural difference between two converted trees, as a message.

    Compares every key both trees carry, so `missing`, `field` and `text` are
    all in scope. A comparator that only walked `type` would agree on exactly
    the divergence class this script exists to find.
    """
    keys = sorted(set(got) | set(want) - {"children"})
    for key in keys:
        if key == "children":
            continue
        a, b = got.get(key, "<absent>"), want.get(key, "<absent>")
        if a != b:
            raise Divergence(f"{path}.{key}: incremental={a!r} scratch={b!r}")
    g_kids, w_kids = got.get("children", []), want.get("children", [])
    if len(g_kids) != len(w_kids):
        g_types = [c.get("type") for c in g_kids]
        w_types = [c.get("type") for c in w_kids]
        raise Divergence(
            f"{path}: {len(g_kids)} children incremental, {len(w_kids)} scratch\n"
            f"    incremental: {g_types}\n"
            f"    scratch:     {w_types}"
        )
    for i, (a, b) in enumerate(zip(g_kids, w_kids)):
        kind = a.get("type") if a.get("type") == b.get("type") else "?"
        compare(a, b, f"{path}[{i}:{kind}]")


# --------------------------------------------------------------------------
# edits


@dataclass(frozen=True)
class Edit:
    """A byte-range replacement. Offsets are UTF-8 byte offsets, always on a
    character boundary -- tree-sitter's own contract, and the runtime's."""

    start: int
    old_end: int
    inserted: bytes
    label: str

    @property
    def new_end(self) -> int:
        return self.start + len(self.inserted)

    def apply(self, source: bytes) -> bytes:
        return source[: self.start] + self.inserted + source[self.old_end :]

    def kind(self) -> str:
        if self.start == self.old_end:
            return "insert"
        if not self.inserted:
            return "delete"
        return "replace"

    def as_json(self, base: bytes) -> dict:
        return {
            "kind": self.kind(),
            "label": self.label,
            "start": self.start,
            "old_end": self.old_end,
            "new_end": self.new_end,
            "removed": base[self.start : self.old_end].decode("utf-8"),
            "inserted": self.inserted.decode("utf-8"),
        }


def boundaries(source: bytes) -> list[int]:
    """Every UTF-8 character boundary, `len` included.

    An edit off a boundary would be rejected by the runtime's tree loader long
    before it was a parser question, so the fuzzer must not generate one --
    `parity_fuzz.py` already owns the split-character sites.
    """
    return [
        i for i in range(len(source) + 1) if i == len(source) or (source[i] & 0xC0) != 0x80
    ]


def random_edit(rng: random.Random, source: bytes) -> Edit:
    bounds = boundaries(source)
    start = rng.choice(bounds)
    roll = rng.random()
    if roll < 0.40:
        payload = rng.choice(BREAKERS).encode("utf-8")
        label = f"insert {payload.decode('utf-8')!r}"
        return Edit(start, start, payload, label)
    later = [b for b in bounds if b > start]
    if not later:
        payload = rng.choice(BREAKERS).encode("utf-8")
        return Edit(start, start, payload, f"insert {payload.decode('utf-8')!r}")
    # Bias short: a one-character deletion is the edit a human makes, and it is
    # also the one most likely to leave the file *nearly* valid, which is where
    # recovery has to make a choice rather than give up.
    span = min(len(later) - 1, int(abs(rng.gauss(0, 3))))
    old_end = later[span]
    if roll < 0.75:
        return Edit(start, old_end, b"", f"delete {old_end - start}B")
    if roll < 0.90:
        payload = rng.choice(BREAKERS).encode("utf-8")
        return Edit(start, old_end, payload, f"replace with {payload.decode('utf-8')!r}")
    # Splice the file into itself: syntactically plausible, semantically wrong,
    # and the class a payload table cannot generate.
    lo = rng.choice(bounds)
    hi = rng.choice([b for b in bounds if b >= lo])
    return Edit(start, old_end, source[lo:hi], f"splice {lo}..{hi}")


def point_of(source: bytes, offset: int) -> tuple[int, int]:
    """(row, byte column) for a byte offset, tree-sitter's Point convention."""
    row = source.count(b"\n", 0, offset)
    line_start = source.rfind(b"\n", 0, offset) + 1
    return (row, offset - line_start)


def apply_to_tree(tree, before: bytes, after: bytes, edit: Edit) -> None:
    tree.edit(
        start_byte=edit.start,
        old_end_byte=edit.old_end,
        new_end_byte=edit.new_end,
        start_point=point_of(before, edit.start),
        old_end_point=point_of(before, edit.old_end),
        new_end_point=point_of(after, edit.new_end),
    )


# --------------------------------------------------------------------------
# the sweep


@dataclass
class State:
    index: int
    edit: Edit
    source: bytes
    scratch: dict
    incremental: dict
    problems: dict[str, int]


@dataclass
class FileReport:
    language: str
    path: Path
    seed: int
    states: int = 0
    dirty: int = 0
    changed: int = 0
    diverged: list[str] = field(default_factory=list)
    crashed: list[str] = field(default_factory=list)


def sweep_file(
    parser, language: str, path: Path, seed: int, edits: int, verbose: bool
) -> FileReport:
    report = FileReport(language=language, path=path, seed=seed)
    rng = random.Random(f"{language}:{path.name}:{seed}")
    source = path.read_bytes()
    tree = parser.parse(source)
    previous = signature(convert(tree.root_node, source))

    for index in range(edits):
        edit = random_edit(rng, source)
        after = edit.apply(source)
        apply_to_tree(tree, source, after, edit)
        try:
            incremental_tree = parser.parse(after, tree)
            scratch_tree = parser.parse(after)
            incremental = convert(incremental_tree.root_node, after)
            scratch = convert(scratch_tree.root_node, after)
        except Exception as exc:  # noqa: BLE001 -- a crash is a finding
            report.crashed.append(f"state {index} ({edit.label}): {exc!r}")
            break

        report.states += 1
        problems = count_problems(scratch)
        if problems["error"] or problems["missing"]:
            report.dirty += 1
        current = signature(scratch)
        if current != previous:
            report.changed += 1
        previous = current
        try:
            compare(incremental, scratch)
        except Divergence as exc:
            report.diverged.append(
                f"state {index} seed={seed} {edit.kind()} "
                f"@{edit.start}..{edit.old_end} {edit.label}: {exc}"
            )
            # Carry the *scratch* tree forward, not the diverged one. A chain
            # that keeps reparsing from a wrong tree reports the same defect
            # once per remaining edit, and the count then measures how early
            # the first one landed rather than how many there are.
            incremental_tree = scratch_tree
        if verbose:
            print(
                f"    {index:3d} {edit.kind():7} @{edit.start:5d}..{edit.old_end:<5d} "
                f"{edit.label:24} {len(after):6d}B "
                f"ERROR={problems['error']} MISSING={problems['missing']}"
            )
        source, tree = after, incremental_tree
    return report


def self_test(parser, source: bytes) -> None:
    """Positive control: prove the comparator can see a difference at all.

    A conformance check that passes everything you point it at has not been
    tested, and a *comparator* that never reports a difference is the same bug
    one layer down. Perturb one span and demand a complaint.
    """
    tree = convert(parser.parse(source).root_node, source)

    def first_interior(node: dict) -> dict | None:
        if node.get("children"):
            return node
        return None

    target = first_interior(tree)
    if target is None:
        raise Divergence("self-test needs a tree with an interior node")
    broken = json.loads(json.dumps(tree))
    broken["children"][0]["end"] = broken["children"][0]["end"] + 1
    try:
        compare(broken, tree)
    except Divergence:
        return
    raise Divergence("comparator accepted a perturbed tree; it discriminates nothing")


# --------------------------------------------------------------------------
# freezing


def freeze_candidates(parser, source: bytes, seed: int) -> Iterator[tuple[Edit, dict]]:
    """Single edits off the clean base, each converted. Never cumulative.

    Cumulative chains are what the sweep does; a state twenty edits deep is not
    a fixture anyone can read, and its expected tree is not reviewable. One
    edit off a known-good file is, and a reviewer can see the whole story in
    the `edit` block.
    """
    rng = random.Random(f"freeze:{seed}")
    for _ in range(FREEZE_CANDIDATES):
        edit = random_edit(rng, source)
        after = edit.apply(source)
        try:
            after.decode("utf-8")
        except UnicodeDecodeError:  # pragma: no cover -- boundaries prevent it
            continue
        yield edit, convert(parser.parse(after).root_node, after)


def pick_states(parser, source: bytes, seed: int) -> list[tuple[Edit, dict, dict]]:
    """Deduplicated, deterministic: dirty states first, then a clean control.

    The clean states are not filler. A parse layer that reports ERROR on input
    tree-sitter accepts fails the contract just as surely as one that accepts
    input tree-sitter rejects, and only a clean fixture can catch that.
    """
    dirty: list[tuple[Edit, dict, dict]] = []
    clean: list[tuple[Edit, dict, dict]] = []
    seen: set[str] = set()
    for edit, root in freeze_candidates(parser, source, seed):
        sig = signature(root)
        if sig in seen:
            continue
        seen.add(sig)
        problems = count_problems(root)
        bucket = dirty if (problems["error"] or problems["missing"]) else clean
        wanted = FREEZE_STATES - FREEZE_CLEAN_STATES if bucket is dirty else FREEZE_CLEAN_STATES
        if len(bucket) < wanted:
            bucket.append((edit, root, problems))
        if len(dirty) >= FREEZE_STATES - FREEZE_CLEAN_STATES and len(clean) >= FREEZE_CLEAN_STATES:
            break
    return dirty + clean


def _node_lines(node: dict, depth: int) -> list[str]:
    pad = " " * depth
    own = {k: v for k, v in node.items() if k != "children"}
    head = json.dumps(own, ensure_ascii=False)
    if "children" not in node:
        return [pad + head]
    lines = [f'{pad}{head[:-1]}, "children": [']
    for child in node["children"]:
        lines.extend(_node_lines(child, depth + 1))
        lines[-1] += ","
    lines[-1] = lines[-1][:-1]
    lines.append(pad + "]}")
    return lines


def dumps(doc: dict) -> str:
    """One node per line, indented by depth. Still ordinary JSON.

    `gen_trees.py` uses `indent=1`, which spends five lines on every node and
    makes a one-node change a five-line diff. These files are an oracle people
    will read diffs of, and there are a lot of them, so they get a layout that
    is both smaller and easier to review: each node is one compact object on
    its own line, nesting shown by indentation. Only whitespace differs -- the
    JSON *shape* is identical to `corpus/trees/*.tree.json`, which is what any
    consumer actually parses.

    Measured on this fixture set: 3.3 MiB at `indent=1`, 1.5 MiB compact,
    1.6 MiB like this.
    """
    lines = ["{"]
    for key, value in doc.items():
        if key == "root":
            continue
        lines.append(f' {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)},')
    lines.append(' "root":')
    lines.extend(_node_lines(doc["root"], 1))
    lines.append("}")
    return "\n".join(lines) + "\n"


def freeze_language(parser, m: mf.Manifest, path: Path) -> list[Path]:
    source = path.read_bytes()
    written = []
    for index, (edit, root, problems) in enumerate(pick_states(parser, source, FREEZE_SEED)):
        after = edit.apply(source)
        doc = {
            "language": m.name,
            "source_file": str(path.relative_to(ROOT)),
            "source": after.decode("utf-8"),
            # Everything below `source` is additive: both runtimes ignore keys
            # they do not name, so these files load anywhere a corpus tree does.
            "base_source": source.decode("utf-8"),
            "edit": edit.as_json(source),
            "problems": problems,
            "grammar": m.grammar,
            "seed": FREEZE_SEED,
            "root": root,
        }
        dest = EDITED / f"{m.name}__{path.stem}__e{index:02d}.tree.json"
        text = dumps(doc)
        if json.loads(text) != doc:  # pragma: no cover -- serialiser guard
            raise Divergence(f"{dest.name}: hand-rolled layout does not round-trip")
        dest.write_text(text)
        written.append(dest)
    return written


def base_files(m: mf.Manifest) -> list[Path]:
    """The smallest clean corpus sources. Deterministic, and small on purpose.

    Tree JSON runs ~40x its source, so this choice *is* the size budget.
    Smallest-first also tends to pick files with the least incidental
    structure, which is what makes a frozen ERROR tree reviewable.
    """
    found = gen_trees.sources(m)
    ordered = sorted(found, key=lambda p: (p.stat().st_size, p.name))
    return ordered[:FREEZE_FILES]


# --------------------------------------------------------------------------
# CLI


def do_freeze(manifests: dict[str, mf.Manifest], parsers: dict) -> int:
    EDITED.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    total_files = 0
    for name, m in sorted(manifests.items()):
        paths = base_files(m)
        if not paths:
            print(f"  {name}: no corpus sources, skipped")
            continue
        written = 0
        for path in paths:
            for dest in freeze_language(parsers[name], m, path):
                total_bytes += dest.stat().st_size
                total_files += 1
                written += 1
        names = ", ".join(p.name for p in paths)
        print(f"  {name}: {written} states from {names}")
    print(f"\n{total_files} fixtures, {total_bytes / 1024:.1f} KiB in {EDITED.relative_to(ROOT)}")
    return 0


def do_known(manifests: dict[str, mf.Manifest], parsers: dict) -> int:
    """Replay the recorded minimal reproducers.

    Exit 0 means every one still reproduces, which is the *expected* state and
    not a pass in the usual sense -- these record a defect, so a case that
    stops reproducing is news (upstream fixed it, or a pin moved) and is
    reported as CHANGED rather than silently swallowed.
    """
    changed = []
    for case in KNOWN_DIVERGENCES:
        name = case["language"]
        if name not in manifests:
            continue
        start, old_end, inserted = case["edit"]
        edit = Edit(start, old_end, inserted, "recorded")
        before = case["before"]
        after = edit.apply(before)
        parser = parsers[name]
        tree = parser.parse(before)
        apply_to_tree(tree, before, after, edit)
        incremental = convert(parser.parse(after, tree).root_node, after)
        scratch = convert(parser.parse(after).root_node, after)
        try:
            compare(incremental, scratch)
        except Divergence as exc:
            got = str(exc).split("\n")[0]
            mark = "same" if got == case["expect"] else "DIFFERENT SHAPE"
            print(f"  REPRODUCES {case['id']:24} {mark}\n    {got}")
            if mark != "same":
                print(f"    recorded: {case['expect']}")
            continue
        changed.append(case["id"])
        print(f"  CHANGED    {case['id']:24} no longer diverges")
    if changed:
        print(
            f"\n{len(changed)} recorded divergence(s) no longer reproduce: "
            f"{', '.join(changed)}. Check the tree-sitter runtime version and "
            f"the grammar pins before deleting the case -- this is the good "
            f"kind of news, but only if upstream is what changed."
        )
    return 0


def do_sweep(
    manifests: dict[str, mf.Manifest],
    parsers: dict,
    args: argparse.Namespace,
) -> int:
    reports: list[FileReport] = []
    for name, m in sorted(manifests.items()):
        found = gen_trees.sources(m)[: args.files]
        if not found:
            continue
        try:
            self_test(parsers[name], found[0].read_bytes())
        except Divergence as exc:
            print(f"SANITY {name}: {exc}", file=sys.stderr)
            return 2
        for path in found:
            if not args.json:
                print(f"  {name}/{path.name}")
            reports.append(
                sweep_file(parsers[name], name, path, args.seed, args.edits, args.verbose)
            )

    states = sum(r.states for r in reports)
    dirty = sum(r.dirty for r in reports)
    diverged = [(r, d) for r in reports for d in r.diverged]
    crashed = [(r, c) for r in reports for c in r.crashed]
    # A sweep whose edits never moved a tree proves nothing, and it reads
    # exactly like a sweep that moved every tree and found no bug. The
    # sanity bar is *changed*, not *dirty*: tree-sitter-markdown accepts any
    # byte string, so it legitimately never produces ERROR or MISSING, and
    # failing on that would be failing on a fact about the language.
    inert = sorted({r.language for r in reports if r.states and not r.changed})
    per_language: dict[str, dict[str, int]] = {}
    for r in reports:
        row = per_language.setdefault(r.language, {"states": 0, "dirty": 0, "changed": 0})
        row["states"] += r.states
        row["dirty"] += r.dirty
        row["changed"] += r.changed
    total = [name for name, row in per_language.items() if row["states"] and not row["dirty"]]

    if args.json:
        json.dump(
            {
                "files": len(reports),
                "states": states,
                "dirty": dirty,
                "diverged": [f"{r.language}/{r.path.name}: {d}" for r, d in diverged],
                "crashed": [f"{r.language}/{r.path.name}: {c}" for r, c in crashed],
                "inert": inert,
                "never_dirty": sorted(total),
                "per_language": per_language,
                "seed": args.seed,
            },
            sys.stdout,
            ensure_ascii=False,
            indent=2,
        )
        print()
    else:
        status = "FAIL" if diverged or crashed else "PASS"
        print(
            f"\n[{status}] parse-oracle  {len(reports)} files  {states} states  "
            f"{dirty} with ERROR/MISSING  {len(diverged)} DIVERGE  "
            f"{len(crashed)} CRASH  (seed {args.seed})"
        )
        for r, d in diverged:
            print(f"DIVERGE {r.language}/{r.path.name}\n  {d}")
        for r, c in crashed:
            print(f"CRASH   {r.language}/{r.path.name}\n  {c}")
        if args.verbose:
            for name, row in sorted(per_language.items()):
                print(
                    f"  {name:12} {row['states']:4d} states  "
                    f"{row['changed']:4d} changed  {row['dirty']:4d} dirty"
                )
        if total:
            print(
                f"NOTE: {', '.join(sorted(total))} never produced ERROR or MISSING "
                "on the files swept. That is a fact about these files and these "
                "edits, not about the grammar -- markdown reads as total here and "
                "still emits ERROR under --freeze on a different file -- so treat "
                "it as thin coverage to widen, not as a property to rely on."
            )
        if inert:
            print(
                f"SANITY: edits did not move the tree for {', '.join(inert)} -- "
                "the sweep is measuring nothing"
            )
    if inert:
        return 2
    return 1 if (diverged or crashed) else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--language", help="sweep or freeze only this language")
    ap.add_argument("--files", type=int, default=DEFAULT_FILES,
                    help=f"corpus files per language (default {DEFAULT_FILES})")
    ap.add_argument("--edits", type=int, default=DEFAULT_EDITS,
                    help=f"cumulative edits per file (default {DEFAULT_EDITS})")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED,
                    help="replay a run; a failure is reported with its seed")
    ap.add_argument("--freeze", action="store_true",
                    help="write corpus/trees-edited/ instead of sweeping")
    ap.add_argument("--known", action="store_true",
                    help="replay the recorded minimal divergence reproducers")
    ap.add_argument("--json", action="store_true", help="machine-readable summary")
    ap.add_argument("--verbose", action="store_true", help="print every state")
    args = ap.parse_args()

    known = mf.bootstrap()
    manifests = mf.selected(known, args.language)
    parsers = mf.parsers(known)

    if args.known:
        return do_known(manifests, parsers)
    if args.freeze:
        return do_freeze(manifests, parsers)
    return do_sweep(manifests, parsers, args)


if __name__ == "__main__":
    mf.cli(main)
