"""Language manifests: `harness/languages/<lang>.toml`.

One file per language, so onboarding a language is **adding a file** and never
editing a shared one. Fifteen languages are built in fifteen parallel worktrees;
anything they all have to edit is a merge conflict every round.

That rule has a second half people miss. The harness scripts are PEP 723
`uv run --script` files whose grammar dependencies used to live in an inline
`dependencies = [...]` block -- which is *also* a shared file, and conflicts just
as badly as a shared dict. So the scripts declare only `tree-sitter` inline and
call `bootstrap()`, which reads the manifests, notices a grammar module it cannot
import, and re-execs itself under `uv run --with <pinned requirement>`. Adding a
grammar is then a line in the new language's own manifest.

Not a module in a package: harness scripts are standalone `uv` scripts, so they
`sys.path.insert` this directory and import it by name.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LANG_DIR = Path(__file__).resolve().parent / "languages"

# Set on the re-exec so a grammar that fails to install reports a real error
# instead of forking forever.
_BOOTSTRAPPED = "EDITOR_TOOLS_GRAMMARS_READY"

_REQUIRED = ("name", "extensions", "grammar", "grammar_module", "reference",
             "reference_version", "widths", "reference_width", "gate3",
             "injection_aliases")
_KNOWN = set(_REQUIRED) | {"grammar_symbol", "gate3_requires",
                           "transparent_wrappers", "equivalent_kinds",
                           "comment_kinds", "injections", "incomparable"}


class ManifestError(Exception):
    """A manifest is malformed. Always names the file and the field."""


@dataclass(frozen=True)
class Injection:
    node: str
    info: str | None = None
    content: str | None = None
    guest: str | None = None


@dataclass(frozen=True)
class Manifest:
    name: str
    extensions: tuple[str, ...]
    grammar: str            # PEP 508 requirement, pin included
    grammar_module: str     # importable module name
    grammar_symbol: str     # callable on that module returning the Language
    injection_aliases: tuple[str, ...]  # info-string names for this language
    injections: tuple[Injection, ...]   # host node shapes containing regions
    reference: str          # shell command, source on stdin, result on stdout
    reference_version: str  # the version string actually observed
    widths: tuple[int, ...]
    reference_width: str    # "flag" (honours {width}) | "fixed" (one output)
    gate3: str              # "default", or <name> -> languages/<name>_gate3.py
    gate3_requires: tuple[str, ...]
    transparent_wrappers: frozenset[str]
    equivalent_kinds: tuple[frozenset[str], ...]
    incomparable: dict[str, str]  # corpus filename -> why the reference rewrite is not scored
    path: Path
    comment_kinds: tuple[str, ...] = ()  # non-extra node kinds that hold comments

    @property
    def waives_width(self) -> bool:
        return self.reference_width == "fixed"

    def reference_command(self, width: int) -> str:
        return self.reference.replace("{width}", str(width))


def _need(raw: dict[str, Any], key: str, kind: type, path: Path) -> Any:
    if key not in raw:
        raise ManifestError(f"{path.name}: missing required field `{key}`")
    val = raw[key]
    if not isinstance(val, kind):
        raise ManifestError(
            f"{path.name}: `{key}` must be {kind.__name__}, got {type(val).__name__}"
        )
    return val


def _injection_aliases(raw: dict[str, Any], path: Path) -> tuple[str, ...]:
    aliases = tuple(_need(raw, "injection_aliases", list, path))
    for i, alias in enumerate(aliases):
        if not isinstance(alias, str) or not alias or any(c.isspace() for c in alias):
            raise ManifestError(
                f"{path.name}: `injection_aliases[{i}]` must be a non-empty "
                "string containing no whitespace"
            )
    if len(set(aliases)) != len(aliases):
        raise ManifestError(f"{path.name}: `injection_aliases` contains duplicates")
    return aliases


def _injections(raw: dict[str, Any], path: Path) -> tuple[Injection, ...]:
    out = []
    fields = {"node", "info", "content", "guest"}
    entries = raw.get("injections", [])
    if not isinstance(entries, list):
        raise ManifestError(f"{path.name}: `injections` must be a list")
    for i, entry in enumerate(entries):
        name = f"injections[{i}]"
        if not isinstance(entry, dict):
            raise ManifestError(f"{path.name}: `{name}` must be a table")
        unknown = set(entry) - fields
        if unknown:
            raise ManifestError(
                f"{path.name}: `{name}` has unknown field(s) {sorted(unknown)}"
            )
        if "node" not in entry:
            raise ManifestError(
                f"{path.name}: `{name}` missing required field(s) ['node']"
            )
        for field in sorted(entry):
            value = entry[field]
            if not isinstance(value, str) or not value:
                raise ManifestError(
                    f"{path.name}: `{name}.{field}` must be a non-empty string"
                )
        routes = [field for field in ("info", "guest") if field in entry]
        if len(routes) != 1:
            raise ManifestError(
                f"{path.name}: `{name}` must declare exactly one of `info` or `guest`"
            )
        out.append(
            Injection(
                node=entry["node"],
                info=entry.get("info"),
                content=entry.get("content"),
                guest=entry.get("guest"),
            )
        )
    return tuple(out)


def _comment_kinds(raw: dict[str, Any], path: Path) -> tuple[str, ...]:
    kinds = raw.get("comment_kinds", [])
    if not isinstance(kinds, list):
        raise ManifestError(f"{path.name}: `comment_kinds` must be a list")
    for i, kind in enumerate(kinds):
        if not isinstance(kind, str) or not kind:
            raise ManifestError(
                f"{path.name}: `comment_kinds[{i}]` must be a non-empty string"
            )
    if len(set(kinds)) != len(kinds):
        raise ManifestError(f"{path.name}: `comment_kinds` contains duplicates")
    return tuple(kinds)


def _incomparable(
    raw: dict[str, Any], name: str, extensions: tuple[str, ...], path: Path
) -> dict[str, str]:
    """Files the reference rewrites in a way linearity forbids.

    Optional. A table so the reason is structurally required; a list of names
    can drift from its comments. Removing an entry (when the construct later
    becomes comparable) is a one-line delete. The name is a current measurement
    state, not a permanent exile — do not read it as "excluded forever".
    """
    if "incomparable" not in raw:
        return {}
    table = raw["incomparable"]
    if not isinstance(table, dict):
        raise ManifestError(
            f"{path.name}: `incomparable` must be a table of "
            f"`\"filename{extensions[0]}\" = \"reason\"`"
        )
    src_dir = ROOT / "corpus" / "src" / name
    out: dict[str, str] = {}
    for filename, reason in table.items():
        key = f"incomparable.{filename}"
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise ManifestError(
                f"{path.name}: `{key}` must be a filename in "
                f"corpus/src/{name}/, not a path"
            )
        if not any(filename.endswith(ext) for ext in extensions):
            raise ManifestError(
                f"{path.name}: `{key}` must end in one of this language's "
                f"extensions {list(extensions)}"
            )
        if not isinstance(reason, str) or not reason.strip():
            raise ManifestError(
                f"{path.name}: `{key}` needs a non-empty reason "
                f"(why the reference rewrite is not comparable)"
            )
        if not (src_dir / filename).is_file():
            raise ManifestError(
                f"{path.name}: `{key}` names a file that does not exist at "
                f"corpus/src/{name}/{filename}"
            )
        out[filename] = reason.strip()
    return out


def parse(path: Path) -> Manifest:
    raw = tomllib.loads(path.read_text())

    unknown = set(raw) - _KNOWN
    if unknown:
        # Silently ignoring a typo'd field is how a builder loses an hour.
        raise ManifestError(f"{path.name}: unknown field(s) {sorted(unknown)}")

    name = _need(raw, "name", str, path)
    if name != path.stem:
        raise ManifestError(f"{path.name}: `name` is {name!r}, must match the filename")

    grammar = _need(raw, "grammar", str, path)
    if "==" not in grammar and "@" not in grammar:
        # An unpinned grammar makes the committed corpus unreproducible: the
        # trees are ground truth and a silent grammar bump rewrites them.
        raise ManifestError(
            f"{path.name}: `grammar` must be a pinned requirement "
            f"(`tree-sitter-x==1.2.3`, or `name @ git+https://...`), got {grammar!r}"
        )

    widths = tuple(_need(raw, "widths", list, path))
    if not widths or not all(isinstance(w, int) and w > 0 for w in widths):
        raise ManifestError(f"{path.name}: `widths` must be a non-empty list of ints")

    ref_width = _need(raw, "reference_width", str, path)
    reference = _need(raw, "reference", str, path)
    if ref_width == "flag":
        if "{width}" not in reference:
            raise ManifestError(
                f"{path.name}: reference_width = \"flag\" but `reference` has no "
                f"`{{width}}` placeholder -- the width would never reach the tool"
            )
    elif ref_width == "fixed":
        if "{width}" in reference:
            raise ManifestError(
                f"{path.name}: reference_width = \"fixed\" but `reference` "
                f"interpolates `{{width}}`; use \"flag\" instead"
            )
        if len(widths) != 1:
            raise ManifestError(
                f"{path.name}: reference_width = \"fixed\" needs exactly one width "
                f"(the reference has only one output), got {list(widths)}"
            )
    else:
        raise ManifestError(
            f"{path.name}: `reference_width` must be \"flag\" or \"fixed\", "
            f"got {ref_width!r}"
        )

    extensions = tuple(_need(raw, "extensions", list, path))
    if not extensions or not all(
        isinstance(e, str) and e.startswith(".") for e in extensions
    ):
        raise ManifestError(
            f"{path.name}: `extensions` must be a non-empty list like [\".py\"]"
        )

    equiv = []
    for group in raw.get("equivalent_kinds", []):
        if not isinstance(group, list) or len(group) < 2:
            raise ManifestError(
                f"{path.name}: each `equivalent_kinds` entry must be a list of "
                f"two or more node kinds"
            )
        equiv.append(frozenset(group))

    return Manifest(
        name=name,
        extensions=extensions,
        grammar=grammar,
        grammar_module=_need(raw, "grammar_module", str, path),
        grammar_symbol=raw.get("grammar_symbol", "language"),
        injection_aliases=_injection_aliases(raw, path),
        injections=_injections(raw, path),
        reference=reference,
        reference_version=_need(raw, "reference_version", str, path),
        widths=widths,
        reference_width=ref_width,
        gate3=_need(raw, "gate3", str, path),
        gate3_requires=tuple(raw.get("gate3_requires", [])),
        transparent_wrappers=frozenset(raw.get("transparent_wrappers", [])),
        equivalent_kinds=tuple(equiv),
        incomparable=_incomparable(raw, name, extensions, path),
        path=path,
        comment_kinds=_comment_kinds(raw, path),
    )


def load_all() -> dict[str, Manifest]:
    if not LANG_DIR.is_dir():
        raise ManifestError(f"no manifest directory at {LANG_DIR}")
    out = {}
    for path in sorted(LANG_DIR.glob("*.toml")):
        m = parse(path)
        out[m.name] = m
    if not out:
        raise ManifestError(f"no manifests in {LANG_DIR}")
    injection_map(out)
    return out


def injection_map(manifests: dict[str, Manifest]) -> dict[str, Manifest]:
    """Info-string alias -> guest manifest, rejecting ambiguous aliases."""
    out = {}
    for manifest in manifests.values():
        for alias in manifest.injection_aliases:
            if alias in out:
                other = out[alias]
                raise ManifestError(
                    f"{manifest.path.name}: injection alias {alias!r} is already "
                    f"declared by {other.path.name}"
                )
            out[alias] = manifest
    return out


# --------------------------------------------------------------------------
# grammar bootstrap


def _requirements(manifests: dict[str, Manifest]) -> list[str]:
    reqs: list[str] = []
    for m in manifests.values():
        reqs.append(m.grammar)
        reqs.extend(m.gate3_requires)
    return sorted(set(reqs))


def _missing(manifests: dict[str, Manifest]) -> list[str]:
    out = []
    for m in manifests.values():
        if importlib.util.find_spec(m.grammar_module) is None:
            out.append(m.name)
    return out


def bootstrap(manifests: dict[str, Manifest] | None = None) -> dict[str, Manifest]:
    """Ensure every manifest's grammar is importable, re-execing under uv if not.

    Call this first thing in `main()`. Returns the manifests so the caller does
    not load them twice.
    """
    manifests = manifests if manifests is not None else load_all()
    if not _missing(manifests):
        return manifests

    if os.environ.get(_BOOTSTRAPPED):
        missing = ", ".join(
            f"{n} ({manifests[n].grammar})" for n in _missing(manifests)
        )
        raise ManifestError(
            f"grammar module(s) still unimportable after `uv run --with`: {missing}"
        )

    script = Path(sys.argv[0]).resolve()
    cmd = ["uv", "run", "--quiet"]
    for req in _requirements(manifests):
        cmd += ["--with", req]
    cmd += ["--script", str(script), *sys.argv[1:]]
    proc = subprocess.run(cmd, env={**os.environ, _BOOTSTRAPPED: "1"})
    raise SystemExit(proc.returncode)


def parser_for(m: Manifest):
    """tree_sitter.Parser for a manifest. Grammars must already be importable."""
    from tree_sitter import Language, Parser

    try:
        mod = importlib.import_module(m.grammar_module)
    except ImportError as exc:  # pragma: no cover -- bootstrap should prevent
        raise ManifestError(
            f"{m.path.name}: cannot import `{m.grammar_module}` ({exc}). "
            f"Is `grammar_module` right for distribution `{m.grammar}`?"
        ) from exc
    fn = getattr(mod, m.grammar_symbol, None)
    if fn is None:
        exported = sorted(n for n in dir(mod) if n.startswith("language"))
        raise ManifestError(
            f"{m.path.name}: `{m.grammar_module}` has no `{m.grammar_symbol}()`; "
            f"it exports {exported}. Set `grammar_symbol` to one of those."
        )
    return Parser(Language(fn()))


def parsers(manifests: dict[str, Manifest]) -> dict[str, Any]:
    return {name: parser_for(m) for name, m in manifests.items()}


def cli(main) -> None:
    """Run a harness script's `main`, reporting a bad manifest as a message.

    A builder who typos a field should read one line, not a traceback through
    the loader -- the manifest is the thing they are editing and the error
    already names the file and the field.
    """
    try:
        code = main()
    except ManifestError as exc:
        raise SystemExit(f"manifest error: {exc}") from None
    raise SystemExit(code)


def selected(manifests: dict[str, Manifest], only: str | None) -> dict[str, Manifest]:
    """Apply a `--language` filter, erroring on an unknown name."""
    if only is None:
        return manifests
    if only not in manifests:
        raise ManifestError(
            f"no manifest for {only!r}; known: {', '.join(sorted(manifests))}"
        )
    return {only: manifests[only]}
