#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter"]
# ///
"""Generate the review surface: one self-contained HTML page.

    ./harness/review_page.py <submission-dir> [--output review.html] [--language NAME]

**This page is generated, never edited.** Nothing downstream of it writes HTML,
and no agent hand-maintains it. Re-run the script and the page is current; that
is the only way it stays trustworthy, because a page someone patches by hand
stops being a view of the ledger and becomes a second, disagreeing copy of it.

It is a *review* surface, not a *storage* surface. Approval still goes through
`review_formatter.py --approve` or `score_highlight.py --approve`, so a verdict
arrives as a reviewable git diff rather than as state in a browser.

The page is also the first real consumer of our own highlighter, which is
deliberate -- it is the product dogfooding itself. That is exactly why the
highlight view must not rely on foreground colour: the `lambda` bug painted a
bare space as `keyword`, and a space has no foreground. Every span is drawn with
a background and a boundary marker, and whitespace inside a span is rendered
visibly. A review tool that renders output beautifully is the easiest place to
hide a defect in the output.
"""

import argparse
import datetime
import difflib
import html
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_trees  # noqa: E402
import manifest as mf  # noqa: E402
import review_formatter  # noqa: E402
import review_ledger  # noqa: E402
import score  # noqa: E402
import score_highlight as hl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


# --- highlighting, through our own highlighter -----------------------------


def highlight_packages(submission: Path) -> dict[str, Path]:
    return {
        path.name.removesuffix(".highlight.json"): path
        for path in (submission / "packages").glob("*.highlight.json")
    }


def spans_for(
    submission: Path,
    text: str,
    language: str,
    manifests: dict,
    parsers: dict,
    packages: dict[str, Path],
    tmp: Path,
) -> list[dict]:
    """Our own highlighter's spans for arbitrary text, or none.

    Returning `[]` rather than raising is the right shape here: a language with
    no highlight package yet (TOML today) still has formatter divergences worth
    reviewing, and the page should show them as plain text rather than refuse.
    """
    if language not in packages or language not in parsers:
        return []
    try:
        doc, problems = gen_trees.parse_doc(
            manifests[language], text.encode("utf-8"), "<review>", manifests, parsers
        )
    except Exception:
        return []
    if problems:
        return []
    tree_file = tmp / "review.tree.json"
    tree_file.write_text(json.dumps(doc), encoding="utf-8")
    needed = {
        name: packages[name]
        for name in hl.tree_languages(doc)
        if name in packages
    }
    run = hl.invoke(submission / "hl-js", tree_file, needed)
    if not run.ok:
        return []
    try:
        return json.loads(run.output)
    except json.JSONDecodeError:
        return []


def _visible(chunk: str) -> str:
    """Escape, and make whitespace inside a painted span visible.

    A span covering nothing but a space renders as an empty box otherwise, which
    is exactly how four stray `keyword` spans survived review once.
    """
    out = []
    for character in chunk:
        if character == " ":
            out.append('<i class="ws"> </i>')
        elif character == "\t":
            out.append('<i class="ws">\t</i>')
        else:
            out.append(html.escape(character))
    return "".join(out)


def paint(text: str, spans: list[dict], boundaries: bool = False) -> list[str]:
    """One HTML string per line of `text`, with spans applied.

    Spans carry byte offsets into the whole document, so the text is walked as
    bytes and decoded per fragment. Splitting on newlines *after* painting keeps
    a span that crosses a line break intact.
    """
    raw = text.encode("utf-8")
    ordered = sorted(spans, key=lambda s: (s["start"], s["end"]))

    # A span *does* cross a line break in practice -- a triple-quoted Python
    # string is one `string` span over several lines -- so each line is painted
    # from the spans clipped to it. Painting the whole document and splitting
    # the result on newlines leaves an unclosed <span> on one line and a stray
    # </span> on the next, which browsers then paper over silently.
    lines = []
    line_start = 0
    for line in raw.split(b"\n"):
        line_end = line_start + len(line)
        pieces: list[str] = []
        cursor = line_start
        for span in ordered:
            # Bounds are judged on the span as given, not on its clip to this
            # line: a span running past the end of the document is malformed,
            # and clipping it first would hide exactly the kind of defect this
            # page exists to show.
            if span["end"] > len(raw) or span["start"] > span["end"]:
                continue
            start = max(span["start"], line_start)
            end = min(span["end"], line_end)
            if start >= end or start < cursor:
                continue
            if start > cursor:
                pieces.append(html.escape(raw[cursor:start].decode("utf-8", "replace")))
            scope = span["scope"]
            body = raw[start:end].decode("utf-8", "replace")
            classes = f"s {_scope_class(scope)}" + (" b" if boundaries else "")
            pieces.append(
                f'<span class="{classes}" data-scope="{html.escape(scope)}">'
                f"{_visible(body) if boundaries else html.escape(body)}</span>"
            )
            cursor = end
        pieces.append(html.escape(raw[cursor:line_end].decode("utf-8", "replace")))
        lines.append("".join(pieces))
        line_start = line_end + 1
    return lines


def _scope_class(scope: str) -> str:
    """Dotted scopes are prefix refinements, so the base scope carries colour."""
    return "sc-" + scope.split(".")[0].replace("_", "-")


# --- the formatter view ----------------------------------------------------


def diff_rows(ours: list[str], theirs: list[str]) -> list[tuple]:
    """Line-aligned (ours, theirs, kind) rows for a side-by-side view."""
    matcher = difflib.SequenceMatcher(
        None, [strip_tags(line) for line in theirs], [strip_tags(line) for line in ours]
    )
    rows = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                rows.append((ours[j1 + offset], theirs[i1 + offset], "same"))
        elif tag == "replace":
            for offset in range(max(i2 - i1, j2 - j1)):
                left = ours[j1 + offset] if j1 + offset < j2 else None
                right = theirs[i1 + offset] if i1 + offset < i2 else None
                rows.append((left, right, "changed"))
        elif tag == "delete":
            for offset in range(i1, i2):
                rows.append((None, theirs[offset], "changed"))
        elif tag == "insert":
            for offset in range(j1, j2):
                rows.append((ours[offset], None, "changed"))
    return rows


def strip_tags(line: str) -> str:
    out = []
    inside = False
    for character in line:
        if character == "<":
            inside = True
        elif character == ">":
            inside = False
        elif not inside:
            out.append(character)
    return html.unescape("".join(out))


def state_badge(state: str) -> str:
    return f'<span class="badge {state}">{state}</span>'


def review_block(review) -> str:
    if review is None:
        return '<p class="meta">No verdict has ever been recorded for this pair.</p>'
    return (
        '<dl class="verdict">'
        f"<dt>verdict</dt><dd>{html.escape(review.verdict)}</dd>"
        f"<dt>reason</dt><dd>{html.escape(review.reason)}</dd>"
        f"<dt>by</dt><dd>{html.escape(review.reviewed_by)}"
        f" &middot; {html.escape(review.reviewed_at)}</dd>"
        f"<dt>hash</dt><dd><code>{html.escape(review.hash[:16])}&hellip;</code></dd>"
        "</dl>"
    )


def approve_hint(record, kind: str) -> str:
    tool = "review_formatter.py" if kind == "formatter" else "score_highlight.py"
    return (
        f"<pre class='hint'>./harness/{tool} . \\\n"
        f"  --approve {html.escape(record)} \\\n"
        f"  --verdict &lt;kind&gt; --reason '&hellip;' --reviewed-by '&lt;you&gt;'</pre>"
    )


# --- the page --------------------------------------------------------------

STYLE = """
:root {
  --bg: #fbfbfa; --fg: #1c1c1a; --dim: #6b6b66; --rule: #dcdcd6;
  --card: #ffffff; --add: #e8f3ea; --del: #fdecec; --accent: #2f5d8c;
  --accepted: #2d7a4f; --stale: #b3401f; --unreviewed: #8a6d1f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14140f; --fg: #eae7dc; --dim: #9a978c; --rule: #33322b;
    --card: #1c1c17; --add: #1e2f22; --del: #33201d; --accent: #8fb8e0;
    --accepted: #74c493; --stale: #e0836a; --unreviewed: #d7b95f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 2rem 1.25rem 6rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem;
  padding-bottom: .35rem; border-bottom: 1px solid var(--rule); }
h3 { font-size: .95rem; margin: 0; font-family: ui-monospace, monospace; }
.sub { color: var(--dim); margin: 0 0 1.5rem; }
.meta { color: var(--dim); font-size: .85rem; }
table.status { border-collapse: collapse; width: 100%; font-size: .9rem; }
table.status th, table.status td {
  text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--rule); }
table.status th { color: var(--dim); font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.card { background: var(--card); border: 1px solid var(--rule);
  border-radius: 6px; padding: .9rem 1rem; margin: 0 0 1.1rem; }
.card > header { display: flex; gap: .75rem; align-items: baseline;
  flex-wrap: wrap; margin-bottom: .6rem; }
.badge { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em;
  padding: .12rem .45rem; border-radius: 3px; border: 1px solid currentColor; }
.badge.accepted { color: var(--accepted); }
.badge.stale { color: var(--stale); font-weight: 700; }
.badge.unreviewed { color: var(--unreviewed); }
dl.verdict { display: grid; grid-template-columns: max-content 1fr;
  gap: .1rem .75rem; margin: 0 0 .7rem; font-size: .85rem; }
dl.verdict dt { color: var(--dim); }
dl.verdict dd { margin: 0; }
.scroll { overflow-x: auto; border: 1px solid var(--rule); border-radius: 4px; }
table.sbs { border-collapse: collapse; width: 100%;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
table.sbs td { padding: 0 .5rem; vertical-align: top; white-space: pre;
  width: 50%; border-left: 1px solid var(--rule); }
table.sbs td:first-child { border-left: 0; }
table.sbs th { font: 600 .72rem/1.6 -apple-system, sans-serif; color: var(--dim);
  text-align: left; padding: .25rem .5rem; border-bottom: 1px solid var(--rule);
  text-transform: uppercase; letter-spacing: .05em; }
tr.changed td:first-child { background: var(--add); }
tr.changed td:last-child { background: var(--del); }
pre.code { margin: 0; padding: .6rem .75rem; overflow-x: auto;
  font: 12.5px/1.6 ui-monospace, Menlo, monospace; }
pre.hint { margin: .6rem 0 0; padding: .5rem .6rem; color: var(--dim);
  background: var(--bg); border: 1px dashed var(--rule); border-radius: 4px;
  font: 11.5px/1.5 ui-monospace, monospace; overflow-x: auto; }
/* Span rendering. Boundaries are drawn, never implied by colour: the bug this
   page exists to catch painted a bare space, and a space has no foreground. */
.s { border-bottom: 2px solid currentColor; }
.s.b { outline: 1px solid var(--rule); outline-offset: 1px; }
.ws { background: currentColor; opacity: .22; border-radius: 1px;
  font-style: normal; }
.sc-keyword { color: #a3306f; } .sc-string { color: #2c7a3f; }
.sc-comment { color: #79796f; font-style: italic; } .sc-number { color: #9a5b1e; }
.sc-function { color: #2f5d8c; } .sc-property { color: #1f6f77; }
.sc-operator { color: #8a4b1f; } .sc-punctuation { color: var(--dim); }
.sc-type { color: #6b4ba8; } .sc-variable { color: var(--fg); }
.sc-error { color: #b3401f; background: rgba(179,64,31,.14); }
@media (prefers-color-scheme: dark) {
  .sc-keyword { color: #e58bb8; } .sc-string { color: #86ce9b; }
  .sc-comment { color: #8d8d82; } .sc-number { color: #e0a86a; }
  .sc-function { color: #8fb8e0; } .sc-property { color: #6fc6cd; }
  .sc-operator { color: #dba077; } .sc-type { color: #b79ae8; }
}
.legend { display: flex; gap: 1rem; flex-wrap: wrap; font-size: .78rem;
  color: var(--dim); margin: .5rem 0 1rem; }
"""


def page(sections: list[str], generated: str) -> str:
    return (
        "<!doctype html>\n<html lang='en'>\n<head>\n"
        "<meta charset='utf-8'>\n"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>\n"
        "<title>editor-tools review surface</title>\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>\n"
        "<h1>Review surface</h1>\n"
        f"<p class='sub'>Generated by <code>harness/review_page.py</code> at "
        f"{html.escape(generated)}. Never edited by hand: re-run the script "
        "and this page is current. Verdicts are recorded with the CLI shown "
        "under each item, so a review arrives as a git diff.</p>\n"
        + "\n".join(sections)
        + "\n</main>\n</body>\n</html>\n"
    )


def formatter_section(
    submission: Path,
    records: list,
    states: dict,
    manifests: dict,
    parsers: dict,
    packages: dict,
    tmp: Path,
) -> str:
    if not records:
        return (
            "<h2>Formatter divergences</h2>\n"
            "<p class='meta'>Every corpus file matches its reference at every "
            "width. Nothing to review.</p>"
        )
    cards = []
    for record in records:
        state, review = states[record.id]
        ours = paint(
            record.our_output,
            spans_for(submission, record.our_output, record.language,
                      manifests, parsers, packages, tmp),
        )
        theirs = paint(
            record.reference_output,
            spans_for(submission, record.reference_output, record.language,
                      manifests, parsers, packages, tmp),
        )
        rows = []
        for left, right, kind in diff_rows(ours, theirs):
            rows.append(
                f"<tr class='{kind}'>"
                f"<td>{left if left is not None else ''}</td>"
                f"<td>{right if right is not None else ''}</td></tr>"
            )
        cards.append(
            "<article class='card'>\n<header>"
            f"<h3>{html.escape(record.id)}</h3>{state_badge(state)}"
            f"<span class='meta'><code>{record.hash[:16]}&hellip;</code></span>"
            "</header>\n"
            f"{review_block(review)}"
            "<div class='scroll'><table class='sbs'>"
            "<thead><tr><th>ours</th><th>reference</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table></div>"
            f"{approve_hint(record.id, 'formatter') if state != 'accepted' else ''}"
            "\n</article>"
        )
    return "<h2>Formatter divergences</h2>\n" + "\n".join(cards)


def highlight_section(submission: Path, only: str | None) -> str:
    """Every golden, rendered with its own spans applied to the source.

    Reviewing a span stream as JSON is why the `lambda` bug survived; this is
    the same data drawn on the code it describes.
    """
    packages = highlight_packages(submission)
    cards = []
    for tree_path, tree in hl.corpus(only):
        golden = hl.golden_path(tree_path)
        if not golden.is_file():
            continue
        language = tree["language"]
        if not any(name in packages for name in hl.tree_languages(tree)):
            continue
        spans = json.loads(golden.read_text(encoding="utf-8"))
        source = tree.get("source")
        if source is None:
            continue
        item = tree_path.name.removesuffix(".tree.json")
        reviews = review_ledger.load("highlight", language)
        review = reviews.get(item)
        state = review_ledger.state(hl.spans_hash(spans), review)
        painted = "\n".join(paint(source, spans, boundaries=True))
        cards.append(
            "<article class='card'>\n<header>"
            f"<h3>{html.escape(item)}</h3>{state_badge(state)}"
            f"<span class='meta'>{len(spans)} spans &middot; "
            f"{html.escape(language)}</span></header>\n"
            f"{review_block(review)}"
            f"<div class='scroll'><pre class='code'>{painted}</pre></div>"
            f"{approve_hint(item, 'highlight') if state != 'accepted' else ''}"
            "\n</article>"
        )
    if not cards:
        return "<h2>Highlight goldens</h2>\n<p class='meta'>No goldens.</p>"
    return (
        "<h2>Highlight goldens</h2>\n"
        "<p class='legend'>"
        "<span>Each painted span is underlined and outlined, so a span covering "
        "only whitespace is still visible.</span>"
        "<span><i class='ws'>&nbsp;</i> = a space inside a span</span>"
        "</p>\n" + "\n".join(cards)
    )


def status_section(submission: Path, manifests: dict, records: list, states: dict) -> str:
    pending = score.awaiting_package(submission, manifests)
    rows = []
    for name in sorted(manifests):
        mine = [r for r in records if r.language == name]
        counts = {"accepted": 0, "stale": 0, "unreviewed": 0}
        for record in mine:
            counts[states[record.id][0]] += 1
        cases = len(manifests[name].widths) * len(
            score.corpus({name: manifests[name]})
        )
        note = "awaiting package" if name in pending else f"{cases - len(mine)} agree"
        rows.append(
            f"<tr><td><strong>{html.escape(name)}</strong></td>"
            f"<td class='meta'>{html.escape(note)}</td>"
            f"<td class='num'>{counts['accepted']}</td>"
            f"<td class='num'>{counts['stale']}</td>"
            f"<td class='num'>{counts['unreviewed']}</td>"
            f"<td class='num'>{cases}</td></tr>"
        )
    stale_total = sum(1 for r in records if states[r.id][0] == "stale")
    banner = (
        "<p class='meta'>Nothing is stale: every recorded verdict still "
        "describes the pair it was given for.</p>"
        if not stale_total
        else f"<p><span class='badge stale'>{stale_total} stale</span> "
        "&mdash; a verdict exists but the outputs moved underneath it. "
        "This is a hard scorer failure, not a warning.</p>"
    )
    return (
        "<h2>Status</h2>\n" + banner + "\n<table class='status'><thead><tr>"
        "<th>language</th><th></th><th class='num'>accepted</th>"
        "<th class='num'>stale</th><th class='num'>unreviewed</th>"
        "<th class='num'>compared</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("submission", type=Path)
    ap.add_argument("--output", type=Path, default=Path("review.html"))
    ap.add_argument("--language", help="only this language")
    args = ap.parse_args()

    submission = args.submission.resolve()
    known = mf.bootstrap()
    selected = mf.selected(known, args.language)
    parsers = mf.parsers(known)
    packages = highlight_packages(submission)

    scored = {
        name: m
        for name, m in selected.items()
        if name not in score.awaiting_package(submission, selected)
    }
    records, problems = review_formatter.divergences(submission, score.corpus(scored))
    states = review_formatter._states(records)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        sections = [
            status_section(submission, selected, records, states),
            formatter_section(
                submission, records, states, known, parsers, packages, tmp
            ),
            highlight_section(submission, args.language),
        ]
    generated = datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%d %H:%M UTC"
    )
    args.output.write_text(page(sections, generated), encoding="utf-8")
    print(f"{args.output} written ({args.output.stat().st_size} bytes)")
    for problem in problems:
        print(f"  note: {problem}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        mf.cli(main)
    except review_ledger.LedgerError as exc:
        raise SystemExit(f"review ledger error: {exc}") from None
