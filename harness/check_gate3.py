#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Hold gate 3 honest. Four checks, in increasing order of what they catch.

    ./harness/check_gate3.py [--language NAME] [--verbose]

**1. The reference formatter must pass.** Every language's reference is a
correct formatter, so whatever it does to the corpus must pass gate 3. Anything
it does that the gate rejects is a bug in the gate, not in the formatter. This
generalises the old "black is the oracle" check to every language, and reads the
committed `corpus/reference/` output so it needs nothing installed.

**2. The generic default must agree with every stronger override.** Python
compares `ast.dump` and JSON compares an ordered `json.loads`; both are stronger
than the generic named-node comparison and both are the reason we can tell
whether the generic one is any good. Where a language has both, they must reach
the same verdict on the same input. A generic checker that disagrees with `ast`
on real Python is telling you something, and this is where you find out --
before thirteen languages that have *only* the generic checker are onboarded
against it.

**2b. ...on inputs the reference formatter would never produce.** Check 2 on its
own is close to worthless, and this was measured, not guessed. It compares the
two checkers only on *committed reference output*, which both accept because the
reference is correct -- so it reports `0 disagreements` while an override is
strictly weaker than the default it replaced. A round-1 TOML builder declared
`gate3 = "toml"` backed by `tomllib.loads`; a reviewer found eleven
document-changing rewrites the override accepted and the generic default
rejected, and could construct none the other way round. Check 2 had blessed it.

The generalisation, and the reason this arm exists for the thirteen languages
still to come: **data-model loaders (`tomllib`, `yaml.safe_load`, `json.loads`)
collapse exactly the spelling distinctions a formatter must preserve.** Every
one of them is a tempting one-line override.

So each reference output is also mutated in ways that change the *document* --
respelling a number, swapping a quote style, reordering two sibling nodes --
and the rule is one-directional: **any mutation the generic default rejects, the
override must reject too.** An override may reject more; it may never reject
less. See `mutations()` for how the mutants are derived from the parse tree, and
note that they do *not* have to be meaning-preserving for the check to be sound
-- an override must reject a meaning *change* even more surely than a respelling.

**3. The gate must still reject destruction.** A gate that accepts everything
passes checks 1 and 2 perfectly. So each language's reference output is mutated
in two ways a real formatter bug would produce -- a comment dropped, a token
dropped -- and the gate must reject both. Without this, gate 3 could rot into a
no-op and every other check here would keep saying PASS.

Run after changing anything in `gate3.py` or a `*_gate3.py` override.
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate3  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
REFERENCE = ROOT / "corpus" / "reference"


def cases(m: mf.Manifest):
    """(label, source_text, formatted_text) per corpus file per width."""
    src_dir = SRC / m.name
    if not src_dir.is_dir():
        return
    for path in sorted(p for ext in m.extensions for p in src_dir.glob(f"*{ext}")):
        source = path.read_text()
        for width in m.widths:
            ref = REFERENCE / f"{m.name}__{path.stem}@{width}.txt"
            if not ref.is_file():
                yield (f"{m.name}__{path.stem}@{width}", source, None)
                continue
            yield (f"{m.name}__{path.stem}@{width}", source, ref.read_text())


def drop_a_comment(text: str, parser) -> str | None:
    """Remove one comment. A formatter that did this has destroyed something."""
    root = parser.parse(text.encode()).root_node
    stack, found = [root], None
    while stack:
        n = stack.pop()
        if n.is_extra and n.is_named:
            found = n
            break
        stack.extend(reversed(n.children))
    if found is None:
        return None
    b = text.encode()
    return (b[: found.start_byte] + b[found.end_byte :]).decode()


def drop_a_token(text: str, parser) -> str | None:
    """Remove the last named leaf. Usually an ERROR, sometimes silently valid."""
    root = parser.parse(text.encode()).root_node
    last = None
    stack = [root]
    while stack:
        n = stack.pop()
        if not n.children and n.is_named and not n.is_extra:
            last = n
        stack.extend(n.children)
    if last is None or last.start_byte == last.end_byte:
        return None
    b = text.encode()
    return (b[: last.start_byte] + b[last.end_byte :]).decode()


# --------------------------------------------------------------------------
# document-changing mutations, for the adversarial arm of check 2
#
# These are derived from the parse tree, never from a language's syntax, because
# the point is to arm the thirteen languages nobody has written a mutation for.
# Coverage is deliberately partial: a mutation that does not apply, or that stops
# the file parsing, is skipped. The bar is "would have caught the tomllib case",
# not "exhausts the grammar".

_MAX_PER_CLASS = 4  # per class per case; enough to find a hole, cheap to run

_DIGITS = re.compile(r"^[+-]?[0-9][0-9_]*$")
_DECIMAL = re.compile(r"^[+-]?[0-9][0-9_]*\.[0-9][0-9_]*$")
_RADIX = re.compile(r"^[+-]?0[xXoObB][0-9a-fA-F_]+$")
_QUOTES = ('"""', "'''", '"', "'", "`")


def _respell_number(text: str) -> list[str]:
    """Equivalent spellings of a numeric literal.

    `1_000` <-> `1000`, `0xdead` -> `57005`, `0xdead` -> `0xDEAD`, `1.0` ->
    `1.00`. All four appeared in the TOML review; all four leave the value a
    data-model loader sees untouched and the document visibly different.
    """
    out = []
    if _DIGITS.match(text) or _DECIMAL.match(text) or _RADIX.match(text):
        if "_" in text:
            out.append(text.replace("_", ""))
        elif _DIGITS.match(text) and len(text.lstrip("+-")) > 3:
            sign, digits = text[: len(text) - len(text.lstrip("+-"))], text.lstrip("+-")
            grouped = ""
            while len(digits) > 3:
                grouped, digits = "_" + digits[-3:] + grouped, digits[:-3]
            out.append(sign + digits + grouped)
    if _RADIX.match(text):
        try:
            out.append(str(int(text, 0)))
        except ValueError:
            pass
        swapped = text[:2] + text[2:].swapcase()
        if swapped != text:
            out.append(swapped)
    if _DECIMAL.match(text):
        out.append(text + "0")
    return out


def _requote(text: str) -> list[str]:
    """The same string body under a different delimiter.

    `'lit'` -> `"lit"` and `\"\"\"ab\"\"\"` -> `"ab"` are both spelling changes a
    data-model loader cannot see. Skipped when the body contains a backslash --
    escape rules differ between delimiters and the equivalence would be a guess.
    """
    for quote in _QUOTES:
        if len(text) < 2 * len(quote) or not text.startswith(quote):
            continue
        if not text.endswith(quote):
            continue
        body = text[len(quote) : -len(quote)]
        if "\\" in body:
            return []
        out = []
        for alt in _QUOTES:
            if alt == quote or alt in body:
                continue
            if "\n" in body and len(alt) == 1:
                continue
            out.append(alt + body + alt)
        return out
    return []


def _splice(source: bytes, edits: list[tuple[int, int, str]]) -> str:
    """Apply non-overlapping (start, end, replacement) byte edits."""
    out, at = [], 0
    for start, end, text in sorted(edits):
        out.append(source[at:start])
        out.append(text.encode())
        at = end
    out.append(source[at:])
    return b"".join(out).decode()


def _named(node) -> list:
    return [c for c in node.children if c.is_named and not c.is_extra]


def _clip(text: str, span: int = 32) -> str:
    one_line = " ".join(text.split())
    return repr(one_line if len(one_line) <= span else one_line[:span] + "...")


def mutations(text: str, parser):
    """(class, what-changed, mutated_text) triples: same data, different document.

    Three classes, each read off the parse tree so no language is hard-coded:

    - `number` -- a numeric literal respelt (see `_respell_number`)
    - `quotes` -- a string's delimiter swapped (see `_requote`)
    - `reorder` -- two adjacent same-kind siblings swapped, which is key
      reordering in every data language and statement reordering in the rest

    Applied to the text of *any* named node, not only leaves: in tree-sitter's
    Python grammar a string is an interior node whose delimiters are its
    children, so a leaf-only walk would never see a quote style at all.
    """
    source = text.encode()
    root = parser.parse(source).root_node
    counts: dict[str, int] = {}

    def take(cls: str) -> bool:
        counts[cls] = counts.get(cls, 0) + 1
        return counts[cls] <= _MAX_PER_CLASS

    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(reversed(node.children))
        if not node.is_named or node.is_extra:
            continue
        span = source[node.start_byte : node.end_byte].decode("utf-8", "replace")

        for cls, candidates in (
            ("number", _respell_number(span)),
            ("quotes", _requote(span)),
        ):
            for candidate in candidates:
                if candidate == span or not take(cls):
                    continue
                yield (
                    cls,
                    f"{_clip(span)} -> {_clip(candidate)}",
                    _splice(source, [(node.start_byte, node.end_byte, candidate)]),
                )

        kids = _named(node)
        for a, b in zip(kids, kids[1:]):
            if a.type != b.type or a.end_byte > b.start_byte:
                continue
            ta = source[a.start_byte : a.end_byte].decode("utf-8", "replace")
            tb = source[b.start_byte : b.end_byte].decode("utf-8", "replace")
            if ta == tb or not take("reorder"):
                continue
            yield (
                "reorder",
                f"{_clip(ta)} <-> {_clip(tb)}",
                _splice(
                    source,
                    [(a.start_byte, a.end_byte, tb), (b.start_byte, b.end_byte, ta)],
                ),
            )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    manifests = mf.selected(mf.bootstrap(), args.language)
    failures: list[str] = []
    checked = disagreements = destructive = adversarial = uncompared = 0
    # (language, mutation class) -> [how many the gate let through, example]
    weak: dict[tuple[str, str], list] = {}
    # language -> [document changes generated, how many the override alone
    # misses, which classes] -- reported, not failed: see below
    blind: dict[str, list] = {}

    for name, m in manifests.items():
        parser = mf.parser_for(m)
        overridden = m.gate3 != "default"

        for label, source, formatted in cases(m):
            if formatted is None:
                uncompared += 1
                failures.append(
                    f"{label}: no committed reference output "
                    f"-- run harness/gen_reference.py"
                )
                continue

            # --- 1. the reference formatter must pass the gate
            before = gate3.signature(source, m, parser)
            after = gate3.signature(formatted, m, parser)
            checked += 1
            if before is None:
                failures.append(f"{label}: the *source* does not pass its own gate")
            elif after is None:
                failures.append(f"{label}: reference output does not parse")
            elif before != after:
                failures.append(f"{label}: {gate3.describe(before, after, m)}")

            # --- 2. the generic default must reach the same verdict
            if overridden:
                g_before = gate3.generic_signature(source, m, parser)
                g_after = gate3.generic_signature(formatted, m, parser)
                strong_ok = before is not None and before == after
                generic_ok = g_before is not None and g_before == g_after
                if strong_ok != generic_ok:
                    disagreements += 1
                    verdict = "accepts" if generic_ok else "rejects"
                    failures.append(
                        f"{label}: generic default {verdict} but {m.gate3} override "
                        f"does not -- "
                        + gate3.describe(g_before, g_after, _as_generic(m))
                    )
                elif args.verbose:
                    print(f"  agree ({'pass' if strong_ok else 'fail'}) {label}")

            # --- 2b. ...and must be at least as strong on document changes
            #         the reference formatter would never make
            if overridden and after is not None:
                g_ref = gate3.generic_signature(formatted, m, parser)
                o_ref = gate3.override_signature(formatted, m)
                tally = blind.setdefault(m.name, [0, 0, set()])
                for cls, what, mutant in mutations(formatted, parser):
                    g_mut = gate3.generic_signature(mutant, m, parser)
                    if g_mut is None or g_mut == g_ref:
                        continue  # not a change the generic default rejects
                    adversarial += 1
                    tally[0] += 1
                    if gate3.override_signature(mutant, m) == o_ref:
                        tally[1] += 1
                        tally[2].add(cls)
                    if gate3.signature(mutant, m, parser) == after:
                        entry = weak.setdefault((m.name, cls), [0, ""])
                        entry[0] += 1
                        if not entry[1]:
                            entry[1] = f"{label}: {what}"
                    elif args.verbose:
                        print(f"  rejected ({cls}) {label}: {what}")

            # --- 3. the gate must still reject destruction
            for what, mutate in (("a dropped comment", drop_a_comment),
                                 ("a dropped token", drop_a_token)):
                broken = mutate(formatted, parser)
                if broken is None or broken == formatted:
                    continue
                destructive += 1
                if gate3.signature(broken, m, parser) == before:
                    failures.append(f"{label}: gate ACCEPTS {what}")

    for (lang, cls), (count, example) in sorted(weak.items()):
        failures.append(
            f"{lang}: the {manifests[lang].gate3} override accepts {count} "
            f"{cls} mutation(s) that the generic default rejects -- it is WEAKER "
            f"than the gate it replaced, not stronger. e.g. {example}"
        )

    for f in failures:
        print(f"  FAIL {f}")

    # Not a failure, and not a hole: the generic default is a conjunct of every
    # override, so anything here is already rejected by the gate as a whole. It
    # is printed because it is the only measurement of how much an override is
    # actually carrying -- a builder who reaches for `yaml.safe_load` should see
    # it score 0/N here and reconsider spending a file on it.
    for lang, (seen, missed, classes) in sorted(blind.items()):
        if not seen:
            continue
        kinds = ", ".join(sorted(classes)) if classes else "none"
        print(f"  the {manifests[lang].gate3} override alone would accept "
              f"{missed}/{seen} document changes the generic default rejects "
              f"({kinds}); the default is a conjunct, so the gate rejects them")

    print(f"\n{checked} reference outputs checked across "
          f"{len(manifests)} language(s); "
          f"{destructive} destructive mutations rejected; "
          f"{adversarial} document-changing mutations the generic default "
          f"rejects, checked against every override; "
          f"{disagreements} generic/override disagreement(s)")
    if failures:
        print(f"{len(failures)} problem(s) -- the gate is wrong, "
              f"or the reference corpus is stale")
        return 1
    if uncompared:
        return 1
    print("gate 3 accepts every reference formatter and rejects every mutation")
    return 0


def _as_generic(m: mf.Manifest) -> mf.Manifest:
    """Same manifest with the override switched off, for `describe`."""
    return mf.Manifest(**{**m.__dict__, "gate3": "default"})


if __name__ == "__main__":
    mf.cli(main)
