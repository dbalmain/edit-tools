"""Reviewable formatter divergences and their terminal/JSON renderings."""

from __future__ import annotations

import difflib
import hashlib
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class FormatterDivergence:
    language: str
    file: str
    width: int
    our_output: str
    reference_output: str
    unified_diff: str
    hash: str

    @property
    def id(self) -> str:
        return f"{self.language}/{self.file}@{self.width}"

    def as_dict(self) -> dict:
        return {"id": self.id, **asdict(self)}

    def render(self) -> str:
        ours = self.our_output
        if ours and not ours.endswith("\n"):
            ours += "\n"
        reference = self.reference_output
        if reference and not reference.endswith("\n"):
            reference += "\n"
        difference = self.unified_diff
        if difference and not difference.endswith("\n"):
            difference += "\n"
        return (
            f"{self.id}\n"
            f"sha256 {self.hash}\n\n"
            f"ours:\n{ours}"
            f"reference:\n{reference}"
            f"diff:\n{difference}"
        )


def make(
    language: str,
    file: str,
    width: int,
    our_output: str,
    reference_output: str,
) -> FormatterDivergence:
    item_id = f"{language}/{file}@{width}"
    digest = hashlib.sha256(
        our_output.encode("utf-8") + reference_output.encode("utf-8")
    ).hexdigest()
    difference = "".join(
        difflib.unified_diff(
            reference_output.splitlines(keepends=True),
            our_output.splitlines(keepends=True),
            fromfile=f"reference/{item_id}",
            tofile=f"ours/{item_id}",
        )
    )
    return FormatterDivergence(
        language=language,
        file=file,
        width=width,
        our_output=our_output,
        reference_output=reference_output,
        unified_diff=difference,
        hash=digest,
    )
