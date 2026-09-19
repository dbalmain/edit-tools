"""Mutate a string for a positive control, and refuse to mutate nothing.

A control that breaks something and expects a check to notice is only worth
what its mutation is worth. When the anchor it searches for is not in the text
-- a generator reworded its output, a fixture was reformatted, a shell mangled
the quoting -- `str.replace` returns the input unchanged and says nothing. The
control then runs against *unmutated* text, and two very different outcomes
become indistinguishable:

  * a case that expects the check to **reject** fails loudly, because nothing
    was broken and the check accepted. That one is safe by accident.
  * a case that expects the check to **accept** passes, having proved only that
    the check accepts the text it was already given. That one is vacuous, and
    it stays green forever.

This repository has had the second shape twice: `probe_prose.py`'s phase-B
control, where `sed` matched nothing because the pattern carried quotes and
slashes the shell ate, and where the control's own failure message was not read
back so any failure counted. Both were found by hand, after the fact.

So a mutation goes through `mutated`, which raises when it did not mutate. The
assertion belongs on the mutator rather than on the thing being measured,
because a mutation that does not apply and a mutation that is not caught
produce the same output.
"""

from __future__ import annotations


class AnchorMissing(Exception):
    """A mutation found nothing to change, so its control proves nothing."""


def mutated(text: str, old: str, new: str, count: int = -1) -> str:
    """`text.replace(old, new, count)`, raising unless it changed something.

    `count` is passed straight through, so `1` mutates the first occurrence
    only; when it is positive the text must hold at least that many, since a
    control asking for three mutations and receiving one is as partial as one
    asking for one and receiving none.
    """
    if old == new:
        raise AnchorMissing(f"mutation is a no-op: {old!r} replaced by itself")
    found = text.count(old)
    if found == 0:
        raise AnchorMissing(f"anchor not in text: {old!r}")
    if count > 0 and found < count:
        raise AnchorMissing(
            f"anchor {old!r} occurs {found} time(s), {count} asked for"
        )
    changed = text.replace(old, new, count)
    if changed == text:
        raise AnchorMissing(
            f"replacing {old!r} with {new!r} left the text unchanged"
        )
    return changed
