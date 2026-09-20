# A2.3 non-ASCII atom content — running done-note

Measured at `238992f` with `./harness/probe_prose_ceiling.py`: **3,868**
top-level paragraphs in 141 tracked markdown files (1 unparseable), **2,538**
eligible, **975** `non-ascii`, **275** `inline construct`. The brief's 975 of
3,868 and the 275 runner-up both reproduce. The 360 `non-ascii` cell in
`docs/prose-projection.md` is the A2.1 first-match figure at `019b79b`; A2.2
unmasked 607 of today's 975 that used to refuse as emphasis first.

## The four categories collapse to one rule

A gap is exactly one ASCII space or one ASCII newline. Every other scalar is
opaque atom content. ASCII outside a protected range still has to pass the A1
whitelist. `_ACQUIRES` is ASCII-only, matching the pinned grammar.

That is the whole policy. The brief's four hazards are not four special cases:

- **Non-ASCII whitespace** (NBSP, U+2000–200A, U+202F, U+3000, U+2028/2029) is
  content, never a gap. Treating it as a gap would wrap where the author joined
  words. Treating it as content does not normalise it. This is the same
  decision `gate3._prose` already took (`[ \t\n\r\f]+` only); the files must
  not diverge. `harness/gate3.py` is out of scope for this slice, so its
  comment that `prose.py` refuses a paragraph containing NBSP will go stale.
- **Zero-width / format / combining marks** cannot land on a break the source
  did not already have. The partition splits only on ASCII space and newline,
  so a ZWJ sequence, a base+mark cluster, and a ZWSP-joined pair stay inside
  one atom. A combining mark after an ASCII space was already detached in the
  source.
- **Lookalikes of markdown syntax** are not markers. Checked against
  tree-sitter-markdown 0.5.1: fullwidth `＊＃＿～＋＞＝`, em/en dash, minus
  sign, Arabic-Indic / fullwidth / Devanagari digits all parse as a paragraph,
  never as a list, heading, fence, quote or setext underline. The inline CST
  leaves them as implicit text, so `_protected` never sees a token.
- **Bidi spanning controls** (RLO etc.) change UBA paragraph boundaries when a
  gap flips, because newline is class B and space is WS. Markdown parse does
  not change; both runtimes emit the same bytes. Admitted, same class of
  accepted display consequence as narrow CJK. The fact that would reverse it
  is a consumer that parses markdown in visual order. None is known.

U+2028/2029 are not line endings in the pinned grammar (`alpha\u2028- word`
stays a paragraph). They stay content.

## One latent split this rung makes live

Python `_ACQUIRES` uses `\d`, which matches Unicode `Nd`, so `١.` matches.
JS `\d` without the `u` flag is `[0-9]`. Unreachable today only because the
ASCII decode runs first. After A2.3 that is a producer disagreement on every
Arabic-Indic / fullwidth ordered-looking atom. Both sides change to `[0-9]`,
which is also what CommonMark and the pinned grammar use.

## Implementation shape, not yet built

Drop the `decode("ascii")` / `/[^\x00-\x7f]/` guard. Walk scalars, not bytes:
a UTF-8 character is not one index in either runtime (JS `.length` is UTF-16).
Gaps keep their byte offsets. Invalid UTF-8 still returns `non-ascii`.

The `non-ascii` verdict becomes a decode-failure only. Latin-1, CJK, emoji,
NBSP, ZWSP, combining marks, lookalikes and bidi all become eligible.

Discriminators to add: NBSP is one atom not a gap; `e`+U+0301 stays one atom;
fullwidth `＊` is eligible (ASCII `*` still refuses); `١.` does not coalesce;
a tilde beside `é` still refuses as `byte` — admitting Unicode must not punch
a hole in the ASCII whitelist.

## Implemented

Policy as recorded above, in both `harness/prose.py` and `harness/prose.mjs`.
The walk is over scalars with UTF-8 byte offsets. `_ACQUIRES` is `[0-9]`.
`non-ascii` remains only for invalid UTF-8 (0 on the live corpus).

Census at `238992f`: 2,538 eligible of 3,868, 975 `non-ascii`.
Census at `3ad322c` (implementation + fixtures + this note, before the
docs section): 3,490 eligible of 3,884, 0 `non-ascii`, `byte` 36 -> 72.
The 975 were first-match: 36 next refuse as `byte`, 3 as `inline construct`.

`./harness/probe_prose.py` green at `3ad322c`: 3,490 eligible, fixtures hold.

Discriminators:
- admitted: Latin-1, CJK, `𝄞`, NBSP-joined words, U+2028, ZWSP, combining
  mark, fullwidth `＊`, Arabic-Indic `١.`
- refused: `é` beside `~` (`byte`)
- unit tests pin the gap after `é` at byte 2, and that `١.` does not coalesce
