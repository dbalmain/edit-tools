#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Hold gate 3 honest. Three checks, in increasing order of what they catch.

    ./harness/check_gate3.py [--language NAME] [--verbose]

**1. The reference formatter must pass.** Every language's reference is a
correct formatter, so whatever it does to the corpus must pass gate 3. Anything
it does that the gate rejects is a bug in the gate, not in the formatter. This
generalises the old "black is the oracle" check to every language, and reads the
committed `corpus/reference/` output so it needs nothing installed.

Files listed in the manifest's `incomparable` table skip only this assertion:
the reference is known to rewrite them in a way linearity forbids (quote
respelling, import sorting, `.5` → `0.5`). They still have to parse, still
feed the override and destruction arms, and still count for gates 0–3.

**2. An override must never be weaker than the generic default.** Agreement on
reference output is retained as a sanity check, but correct input is not an
adversarial test: every sound checker should accept it. Each reference output is
also changed by syntax-agnostic mutation families. Mutants that still parse and
that the generic default rejects form the oracle. A selected override must reject
every one too. It may reject more; it may never accept less.

The mutations replace a named leaf from another leaf of the same kind, respell
numbers and strings, swap same-kind siblings, and duplicate a subtree. They are
candidate generators, not language semantics: a candidate counts only when the
language parser accepts it and the generic signature changes. The useful count
is reported per language. Zero useful mutations for a selected override is a
failure, because it has tested no adversarial input at all.

**3. The gate must still reject destruction.** A gate that accepts everything
passes checks 1 and 2 perfectly. So each language's reference output is mutated
in two ways a real formatter bug would produce -- a comment dropped, a token
dropped -- and the gate must reject both. Without this, gate 3 could rot into a
no-op and every other check here would keep saying PASS.

The injection fixture adds the adversarial shape the single-language mutations
cannot cover: valid guest-only reformatting must pass, while changed guest
meaning, guest parse failure, lost guest extras, and any change to an unroutable
verbatim region must fail. A nested Markdown-in-Markdown fence proves the check
recurses rather than special-casing one host/guest pair.

Run after changing anything in `gate3.py` or a `*_gate3.py` override.
"""

import argparse
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate3  # noqa: E402
import manifest as mf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "corpus" / "src"
REFERENCE = ROOT / "corpus" / "reference"
PACKAGES = ROOT / "packages"
INJECTION = ROOT / "harness" / "fixtures" / "injection"


def cases(m: mf.Manifest):
    """(label, source_text, formatted_text, incomparable) per file per width."""
    src_dir = SRC / m.name
    if not src_dir.is_dir():
        return
    for path in sorted(p for ext in m.extensions for p in src_dir.glob(f"*{ext}")):
        source = path.read_text()
        incomparable = path.name in m.incomparable
        for width in m.widths:
            label = f"{m.name}__{path.stem}@{width}"
            ref = REFERENCE / f"{m.name}__{path.stem}@{width}.txt"
            if not ref.is_file():
                yield (label, source, None, incomparable)
                continue
            yield (label, source, ref.read_text(), incomparable)


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
# well-formed document mutations for the adversarial arm of check 2

_MAX_CANDIDATES_PER_FAMILY = 32
_MAX_USEFUL_PER_FAMILY_PER_CASE = 4
_NUMBER = re.compile(
    r"^[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|"
    r"[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9][0-9_]*)?)$"
)
_INTEGER = re.compile(r"^[+-]?[0-9][0-9_]*$")
_RADIX = re.compile(r"^[+-]?0[xXoObB][0-9a-fA-F_]+$")
_QUOTES = ('"""', "'''", '"', "'", "`")


@dataclass(frozen=True)
class Mutation:
    family: str
    change: str
    text: str


def _clip(text: str, span: int = 36) -> str:
    one_line = " ".join(text.split())
    if len(one_line) > span:
        one_line = one_line[:span] + "..."
    return repr(one_line)


def _splice(source: bytes, edits: list[tuple[int, int, str]]) -> str:
    """Apply non-overlapping byte-range replacements."""
    out: list[bytes] = []
    at = 0
    for start, end, replacement in sorted(edits):
        out.append(source[at:start])
        out.append(replacement.encode())
        at = end
    out.append(source[at:])
    return b"".join(out).decode()


def _named_children(node) -> list:
    return [child for child in node.children if child.is_named and not child.is_extra]


def _number_spellings(text: str) -> list[str]:
    """Mechanically plausible spellings of the same numeric value."""
    if not _NUMBER.fullmatch(text):
        return []
    out: list[str] = []
    if "_" in text:
        out.append(text.replace("_", ""))
    if _INTEGER.fullmatch(text):
        out.extend((text + ".0", text + "e0"))
        digits = text.lstrip("+-")
        if "_" not in text and len(digits) > 3:
            sign = text[: len(text) - len(digits)]
            groups = []
            while digits:
                groups.append(digits[-3:])
                digits = digits[:-3]
            out.append(sign + "_".join(reversed(groups)))
    if _RADIX.fullmatch(text):
        try:
            out.append(str(int(text.replace("_", ""), 0)))
        except ValueError:
            pass
        out.append(text[:2] + text[2:].swapcase())
    if "." in text:
        mantissa, marker, exponent = text.partition("e")
        if not marker:
            mantissa, marker, exponent = text.partition("E")
        out.append(mantissa + "0" + marker + exponent)
    return list(dict.fromkeys(candidate for candidate in out if candidate != text))


def _string_spellings(text: str) -> list[str]:
    """Delimiter and escape changes, offered to every quote-shaped node."""
    quote = next(
        (
            delimiter
            for delimiter in _QUOTES
            if len(text) >= 2 * len(delimiter)
            and text.startswith(delimiter)
            and text.endswith(delimiter)
        ),
        None,
    )
    if quote is None:
        return []
    body = text[len(quote) : -len(quote)]
    out = []
    if "\\" not in body:
        for delimiter in _QUOTES:
            if delimiter == quote or delimiter in body:
                continue
            if "\n" in body and len(delimiter) == 1:
                continue
            out.append(delimiter + body + delimiter)
    for i, char in enumerate(body):
        if char.isascii() and char.isalnum():
            escaped = body[:i] + f"\\u{ord(char):04x}" + body[i + 1 :]
            out.append(quote + escaped + quote)
            break
    return out


def adversarial_mutations(text: str, parser):
    """Yield bounded, language-independent document mutation candidates."""
    source = text.encode()
    root = parser.parse(source).root_node
    nodes = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(reversed(node.children))
        if node.is_named and not node.is_extra and node.start_byte < node.end_byte:
            nodes.append(node)

    candidates: list[Mutation] = []
    counts: Counter[str] = Counter()

    def add(family: str, change: str, changed: str) -> None:
        if changed == text or counts[family] >= _MAX_CANDIDATES_PER_FAMILY:
            return
        candidates.append(Mutation(family, change, changed))
        counts[family] += 1

    leaves_by_kind: dict[str, list] = {}
    for node in nodes:
        if not _named_children(node):
            leaves_by_kind.setdefault(node.type, []).append(node)
    for leaves in leaves_by_kind.values():
        texts = [source[node.start_byte : node.end_byte].decode() for node in leaves]
        for node, old in zip(leaves, texts):
            replacement = next((other for other in texts if other != old), None)
            if replacement is None:
                continue
            add(
                "leaf-rewrite",
                f"{node.type} {_clip(old)} -> {_clip(replacement)}",
                _splice(source, [(node.start_byte, node.end_byte, replacement)]),
            )

    for node in nodes:
        old = source[node.start_byte : node.end_byte].decode()
        for replacement in _number_spellings(old):
            add(
                "number-respell",
                f"{_clip(old)} -> {_clip(replacement)}",
                _splice(source, [(node.start_byte, node.end_byte, replacement)]),
            )
        for replacement in _string_spellings(old):
            add(
                "string-respell",
                f"{_clip(old)} -> {_clip(replacement)}",
                _splice(source, [(node.start_byte, node.end_byte, replacement)]),
            )

        siblings = _named_children(node)
        for left, right in zip(siblings, siblings[1:]):
            if left.type != right.type or left.end_byte > right.start_byte:
                continue
            left_text = source[left.start_byte : left.end_byte].decode()
            right_text = source[right.start_byte : right.end_byte].decode()
            if left_text == right_text:
                continue
            add(
                "sibling-swap",
                f"{left.type} {_clip(left_text)} <-> {_clip(right_text)}",
                _splice(
                    source,
                    [
                        (left.start_byte, left.end_byte, right_text),
                        (right.start_byte, right.end_byte, left_text),
                    ],
                ),
            )
            gap = source[left.end_byte : right.start_byte].decode()
            add(
                "subtree-duplicate",
                f"duplicate {left.type} {_clip(left_text)}",
                _splice(source, [(right.start_byte, right.start_byte, left_text + gap)]),
            )

    yield from candidates


def _adversarial_verdict(
    mutation: Mutation,
    generic_reference,
    selected_reference,
    manifest: mf.Manifest,
    parser,
    manifests: dict[str, mf.Manifest],
    parsers: dict,
) -> tuple[bool, bool]:
    generic_changed = gate3.generic_signature(
        mutation.text, manifest, parser, manifests, parsers
    )
    useful = generic_changed is not None and generic_changed != generic_reference
    if not useful:
        return False, False
    selected_changed = gate3.signature(
        mutation.text, manifest, parser, manifests, parsers
    )
    return True, selected_changed != selected_reference


def check_injection_mutations(
    markdown, manifests, parsers, failures: list[str]
) -> int:
    """Markdown-shaped changes the host grammar cannot judge on its own."""
    source = (INJECTION / "regions.md").read_text()
    body = '{"outer":{"items":[1,2]}}'
    parser = parsers[markdown.name]
    before = gate3.signature(source, markdown, parser, manifests, parsers)
    cases = (
        (
            "legitimate guest reformat",
            body,
            '{ "outer": { "items": [1, 2] } }',
            True,
        ),
        ("non-JSON fence body", body, "TOTAL GARBAGE, NOT JSON AT ALL", False),
        ("renamed JSON key", body, '{"renamed":{"items":[1,2]}}', False),
        ("altered JSON value", body, '{"outer":{"items":[1,3]}}', False),
        ("changed no-info fence", "no language", "changed no-info body", False),
        ("changed unknown fence", "leave unknown", "changed unknown body", False),
        (
            "changed malformed guest fence",
            '{"broken": [1,}',
            '{"still-broken": [2,}',
            False,
        ),
    )
    for label, original, replacement, should_pass in cases:
        changed = source.replace(original, replacement, 1)
        passed = (
            gate3.signature(changed, markdown, parser, manifests, parsers) == before
        )
        if passed != should_pass:
            verdict = "rejects" if should_pass else "ACCEPTS"
            failures.append(f"markdown injection: gate {verdict} {label}")

    commented = "```python\nx=1  # keep me\n```\n"
    comment_sig = gate3.signature(
        commented, markdown, parser, manifests, parsers
    )
    for label, changed, should_pass in (
        ("guest comment-preserving reformat", "```python\nx = 1 # keep me\n```\n", True),
        ("dropped guest comment", "```python\nx = 1\n```\n", False),
    ):
        passed = (
            gate3.signature(changed, markdown, parser, manifests, parsers)
            == comment_sig
        )
        if passed != should_pass:
            verdict = "rejects" if should_pass else "ACCEPTS"
            failures.append(f"markdown injection: gate {verdict} {label}")

    nested = "````markdown\n```json\n{\"a\":1}\n```\n````\n"
    nested_sig = gate3.signature(nested, markdown, parser, manifests, parsers)
    for label, replacement, should_pass in (
        ("nested guest reformat", '{ "a": 1 }', True),
        ("nested guest meaning change", '{"a":2}', False),
    ):
        changed = nested.replace('{"a":1}', replacement)
        passed = (
            gate3.signature(changed, markdown, parser, manifests, parsers)
            == nested_sig
        )
        if passed != should_pass:
            verdict = "rejects" if should_pass else "ACCEPTS"
            failures.append(f"markdown injection: gate {verdict} {label}")

    return len(cases) + 4


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--language")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    known = mf.load_all()
    markdown = mf.parse(INJECTION / "markdown.toml")
    bootstrapped = mf.bootstrap({**known, markdown.name: markdown})
    manifests = mf.selected(known, args.language)
    parsers = mf.parsers(bootstrapped)
    failures: list[str] = []
    checked = disagreements = destructive = uncompared = 0
    useful_counts: dict[str, Counter[str]] = {
        name: Counter() for name in manifests
    }
    seen_mutations: dict[str, set[tuple[str, str]]] = {
        name: set() for name in manifests
    }
    blind: dict[tuple[str, str], list] = {}

    for name, m in manifests.items():
        parser = parsers[m.name]
        overridden = m.gate3 != "default"

        for label, source, formatted, incomparable in cases(m):
            if formatted is None:
                uncompared += 1
                failures.append(
                    f"{label}: no committed reference output "
                    f"-- run harness/gen_reference.py"
                )
                continue

            # --- 1. the reference formatter must pass the gate
            before = gate3.signature(source, m, parser, bootstrapped, parsers)
            after = gate3.signature(formatted, m, parser, bootstrapped, parsers)
            checked += 1
            if before is None:
                failures.append(f"{label}: the *source* does not pass its own gate")
            elif after is None:
                failures.append(f"{label}: reference output does not parse")
            elif before != after and not incomparable:
                failures.append(f"{label}: {gate3.describe(before, after, m)}")
            elif before != after and args.verbose:
                print(f"  incomparable (reference rewrite skipped) {label}")

            # --- 2. the generic default must reach the same verdict
            if overridden:
                g_before = gate3.generic_signature(
                    source, m, parser, bootstrapped, parsers
                )
                g_after = gate3.generic_signature(
                    formatted, m, parser, bootstrapped, parsers
                )
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

            # --- 2b. an override may narrow, but never widen, the default
            if after is not None:
                generic_reference = gate3.generic_signature(
                    formatted, m, parser, bootstrapped, parsers
                )
                per_case: Counter[str] = Counter()
                for mutation in adversarial_mutations(formatted, parser):
                    if per_case[mutation.family] >= _MAX_USEFUL_PER_FAMILY_PER_CASE:
                        continue
                    identity = (formatted, mutation.text)
                    if identity in seen_mutations[name]:
                        continue
                    useful, rejected = _adversarial_verdict(
                        mutation,
                        generic_reference,
                        after,
                        m,
                        parser,
                        bootstrapped,
                        parsers,
                    )
                    if not useful:
                        continue
                    seen_mutations[name].add(identity)
                    per_case[mutation.family] += 1
                    useful_counts[name][mutation.family] += 1
                    if overridden and not rejected:
                        entry = blind.setdefault((name, mutation.family), [0, []])
                        entry[0] += 1
                        if len(entry[1]) < 3:
                            entry[1].append(f"{label}: {mutation.change}")
                    elif args.verbose and overridden:
                        print(
                            f"  override rejects ({mutation.family}) "
                            f"{label}: {mutation.change}"
                        )

            # --- 3. the gate must still reject destruction
            for what, mutate in (("a dropped comment", drop_a_comment),
                                 ("a dropped token", drop_a_token)):
                broken = mutate(formatted, parser)
                if broken is None or broken == formatted:
                    continue
                destructive += 1
                if (
                    gate3.signature(broken, m, parser, bootstrapped, parsers)
                    == before
                ):
                    failures.append(f"{label}: gate ACCEPTS {what}")

    injection_cases = check_injection_mutations(
        markdown, bootstrapped, parsers, failures
    )

    for name, m in manifests.items():
        counts = useful_counts[name]
        total = sum(counts.values())
        families = ", ".join(
            f"{family}={count}" for family, count in sorted(counts.items())
        ) or "none"
        package = PACKAGES / f"{name}.json"
        # The oracle *is* the generic default, so for a language that selects
        # it there is nothing to compare and the count proves nothing. Say that
        # rather than print a reassuring number: a check that reports activity
        # while testing nothing is the shape of defect this arm exists to fix.
        state = (
            f"{m.gate3} override"
            if m.gate3 != "default"
            else "generic default -- arm inert, nothing to compare against"
        )
        if not package.is_file():
            state += "; package pending, not scored"
        print(f"  adversarial {name}: {total} useful mutation(s) "
              f"({families}); {state}")
        if m.gate3 != "default":
            missed = sum(
                value[0]
                for (language, _family), value in blind.items()
                if language == name
            )
            missed_families = ", ".join(
                family
                for (language, family) in sorted(blind)
                if language == name
            ) or "none found"
            print(f"    {m.gate3} override blind spots: {missed}/{total} "
                  f"useful mutation(s) accepted ({missed_families})")
            if total == 0:
                failures.append(
                    f"{name}: ZERO useful mutations -- {m.gate3} override NOT TESTED"
                )

    for (name, family), (count, examples) in sorted(blind.items()):
        override = manifests[name].gate3
        detail = "; ".join(examples)
        failures.append(
            f"{name}: {override} override ACCEPTS {count} {family} mutation(s) "
            f"the generic default rejects -- WEAKER; {detail}"
        )

    for f in failures:
        print(f"  FAIL {f}")

    adversarial = sum(sum(counts.values()) for counts in useful_counts.values())
    print(f"\n{checked} reference outputs checked across "
          f"{len(manifests)} language(s); "
          f"{destructive} destructive mutations rejected; "
          f"{adversarial} useful adversarial mutations checked; "
          f"{disagreements} generic/override disagreement(s); "
          f"{injection_cases} injection cases checked")
    if failures:
        print(f"{len(failures)} problem(s) -- the gate is wrong, "
              f"or the reference corpus is stale")
        return 1
    if uncompared:
        return 1
    print("gate 3 accepts valid formatting and rejects every oracle mutation")
    return 0


def _as_generic(m: mf.Manifest) -> mf.Manifest:
    """Same manifest with the override switched off, for `describe`."""
    return mf.Manifest(**{**m.__dict__, "gate3": "default"})


if __name__ == "__main__":
    mf.cli(main)
