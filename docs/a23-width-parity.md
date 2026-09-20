# A2.3 entry condition: do the two runtimes agree on displayed width?

Measurement, 2026-09-20. Reproduce with `./harness/probe_a23_width.py` (needs
`./build.sh` first).

**They agree.** On every case in the brief, and on every extra trap the same
naive implementations also get wrong, both printers returned the same column
count. The positive control (`é`, `ü`) passed at width 1. The case the brief
most expected to differ — `𝄞` (U+1D11E), one scalar and two UTF-16 code units —
is width 1 in both.

## Verdict

**A2.3 is schedulable as-is** for the entry condition that sent this page. The
two runtimes agree on the number the printer uses for non-ASCII. There is no
named fix to do first.

The brief's framing is slightly off in one place, and that is the useful part of
the result rather than a failure of the measurement. "Displayed width" in the
East Asian / `wcwidth` sense is **not what either runtime measures**, and they
have never claimed to. Both count Unicode scalar values: one scalar, one column.
That is a written contract (`docs/competition.md`), not an accident, and East
Asian width is deliberately out of scope there because it needs a Unicode table
in both runtimes. Admitting `東京` under A2.3 will wrap it as two columns, not
four. Both runtimes will wrap it as two columns, in the same place, and the
output will stay byte-identical. That is the property the twin runtimes exist to
hold.

A2.3's _exit_ criterion in `docs/a2-inline-price.md` also asks for agreement on
UTF-8 byte ranges and that no non-ASCII byte can be split. This page does not
take that measurement. The loaders already refuse a range that lands on a UTF-8
continuation byte; that is a different question from width.

## What each runtime actually does

There is one width function in JavaScript and three copies of the same function
in Rust. All four count Unicode scalar values.

### JavaScript — one function, used everywhere

`runtime-js/bundle.js` line 560:

```js
const width = (s) => [...s].length;
```

`[...s]` is the string iterator, which yields scalar values, not UTF-16 code
units. `.length` would have been the bug. The file header (lines 4–6) says so in
as many words: using `.length` "would put an astral character at two columns
here and one in Rust."

That single `width` is what `fits` subtracts from the remaining budget
(line 613) and what `print` adds to the column cursor (line 689). Pipe-table
padding (`tableCell`, line 571) uses it too. There is no second, display-width
path.

A unit test at `runtime-js/bundle.test.js` line 293 already pins the astral
case: three 🙂 plus a space plus `x` is seven columns, so the group stays flat
at width 7 and breaks at 6. That test is why the UTF-16 hypothesis was unlikely
before this page existed. It was still the right hypothesis to measure; the test
is one emoji, and A2.3 would admit everything else.

### Rust — three sites, same count

The printer does not call a function named `width`. It calls `scalars`:

```rust
// rust/src/doc.rs:146
fn scalars(s: &str) -> isize {
    s.chars().count() as isize
}
```

`fits` (line 185) and `print` (line 270) both go through that. The module header
(lines 3–4) states the rule: "Width is counted in Unicode scalar values, one
scalar one column."

Markdown pipe tables and the Go/Rust tabwriter each have their own helper, both
identical:

```rust
// rust/src/eval.rs:125
fn width(s: &str) -> usize {
    s.chars().count()
}

// rust/src/align.rs:20
fn width(s: &str) -> usize {
    s.chars().count()
}
```

`eval.rs` line 124 notes that the table helper is "the same measure the align
pass uses." A unit test at `rust/src/doc.rs` line 454 is the Rust twin of the JS
one: three 🙂 are three columns.

`s.chars()` yields Unicode scalar values. For any valid UTF-8 string that is the
same set `[...s]` yields in JavaScript. That is why the table below is a column
of matches rather than a hunt.

### What `harness/check_width.py` is (and is not)

It exists, and the brief was right to point at it. It is not a character-width
probe. It re-runs gate 1 at every width in a range, because a JS `.length` bug
only becomes visible when a mis-measured character sits on a fit boundary.
Historically that was `python__strings` at widths 56–59 and 74–77; the scored
widths 60 and 88 miss both. The file's own docstring is the account.

It cannot tell you what width `東京` or `𝄞` _is_. The committed corpus is almost
entirely ASCII, and the prose projection still refuses non-ASCII, so that sweep
cannot be the A2.3 entry measurement. It is the reason this page had to format
constructed atoms through both printers instead of reading a gate log.

## How the number was read

`harness/probe_a23_width.py` does not call `[...s].length` or `chars().count()`.
It builds a tiny package whose only rule is `group(atom, line, "X")`, writes a
tree, and runs `fmt-rust` and `fmt-js` at successive widths. Flat output is
`{atom} X`; broken output is `{atom}` then `X` on the next line. The smallest
width that stays flat is `width(atom) + 2`, so the atom's measured width is that
threshold minus two.

Two tree shapes, because A2.3 will feed the printer from source slices, not from
a JSON `text` field:

- **slice** — the atom is a UTF-8 source range; `verbatim` copies those bytes.
- **leaf** — the atom carries a JSON `text` field; both evaluators emit it
  without reading source (`runtime-js/bundle.js` line 1939, `rust/src/eval.rs`
  line 87).

Every case below is four measurements: two runtimes × two shapes. They never
split. An ASCII `abc` harness control must come back as 3; Latin-1 `é` / `ü`
must come back as 1. Both did. If either had failed, the wrap arithmetic would
have been wrong and the rest of the table would not be evidence.

Spot-checked by dumping the bytes, not only the derived number. Flat form is
`{atom} X` on one line; broken form puts `X` on the next line.

| atom   | broken at | flat at |
| ------ | --------: | ------: |
| `é`    |         2 |       3 |
| `𝄞`    |         2 |       3 |
| `Ａ`   |         2 |       3 |
| `東京` |         3 |       4 |

`𝄞` flattening at 3, not 4, is the UTF-16 hypothesis dying in the output. `Ａ`
flattening at 3, not 4, is East Asian width not being consulted.

## Results

`term ~` is a per-code-point East Asian Width approximation (Wide/Fullwidth = 2,
combining and format chars = 0, else 1). It is **not** grapheme-cluster width
and it is not a spec. It is in the table so a match against the runtimes and a
miss against a terminal are not the same fact.

The positive control is the Latin-1 rows. They passed.

| sequence                       | Rust |  JS | agree | scalars | UTF-16 | term ~ |
| ------------------------------ | ---: | --: | ----- | ------: | -----: | -----: |
| `abc` (harness control)        |    3 |   3 | yes   |       3 |      3 |      3 |
| `é` U+00E9 (positive control)  |    1 |   1 | yes   |       1 |      1 |      1 |
| `ü` U+00FC (positive control)  |    1 |   1 | yes   |       1 |      1 |      1 |
| `東京`                         |    2 |   2 | yes   |       2 |      2 |      4 |
| `한국` (Hangul)                |    2 |   2 | yes   |       2 |      2 |      4 |
| `Ａ` U+FF21 (fullwidth Latin)  |    1 |   1 | yes   |       1 |      1 |      2 |
| `e` + U+0301 (combining acute) |    2 |   2 | yes   |       2 |      2 |      1 |
| `🙂`                           |    1 |   1 | yes   |       1 |      2 |      2 |
| `👨‍👩‍👧` (ZWJ family)              |    5 |   5 | yes   |       5 |      8 |      6 |
| `❤️` (U+2764 + VS16)           |    2 |   2 | yes   |       2 |      2 |      1 |
| U+200D (ZWJ alone)             |    1 |   1 | yes   |       1 |      1 |      0 |
| U+200B (ZWSP alone)            |    1 |   1 | yes   |       1 |      1 |      0 |
| `𝄞` U+1D11E (non-BMP)          |    1 |   1 | yes   |       1 |      2 |      1 |
| U+00A0 (NBSP)                  |    1 |   1 | yes   |       1 |      1 |      1 |
| `a東京b`                       |    4 |   4 | yes   |       4 |      4 |      6 |
| `🇦🇺` (regional indicators)     |    2 |   2 | yes   |       2 |      4 |      2 |
| `👍🏻` (emoji + skin tone)       |    2 |   2 | yes   |       2 |      4 |      4 |

17/17 agree across both runtimes and both tree shapes. In every row, Rust = JS =
scalar count.

Where that number is _not_ a terminal column count, the runtimes still match
each other:

- CJK, Hangul, fullwidth Latin: one scalar, one column; a terminal would spend
  two.
- Combining marks and variation selectors: one column each; a terminal would
  spend zero.
- ZWJ / ZWSP: one column; a terminal would spend zero.
- ZWJ emoji sequences: one column per scalar (`👨‍👩‍👧` = 5), not one per grapheme
  cluster (a terminal would typically spend 2).
- Non-BMP: one column, not two. This is the row a JS `.length` would have
  failed. It did not fail.

## If they disagreed

They did not. There is no reproducing input for a cross-runtime width split, and
so no diagnosis of one.

The smallest input that **would** have split them, had JS been using `.length`,
is any non-BMP scalar: `𝄞` or `🙂`. Measured, both are width 1 on both sides.
The historical bug is the one `docs/competition.md` already records; it is not
present in either shipped printer.

The smallest input that disagrees with the `term ~` column is `Ａ` (U+FF21): one
column in both runtimes, two on a terminal. That is the East Asian-width policy,
not a parity defect.

## What this did not settle

- **UTF-8 byte-range agreement**, the other half of A2.3's exit criterion. The
  loaders refuse a start or end offset that lands on a continuation byte
  (`runtime-js/bundle.js` lines 35–42, `rust/src/tree.rs` lines 90–100). This
  page did not re-prove that, and it did not prove that a `verbatim` slice of a
  non-ASCII atom round-trips byte-identical — only that the printer then
  measures the resulting string the same way.
- **The whole Unicode space.** The functions under test are "count the scalars."
  A disagreement on a valid UTF-8 string would mean one of those functions is
  not what it appears to be. The sweep is the cases where a _different_ function
  (UTF-16 length, East Asian width, grapheme clusters) would have given a
  different answer.
- **Unpaired surrogates in a JSON `text` field.** They cannot appear in UTF-8
  source, which is A2.3's path. If one is injected as a JSON `\uD800` escape,
  Rust's tree loader refuses (`unexpected end of hex escape`) and JS emits
  U+FFFD and continues. That is a loader split, not a width split, and it cannot
  arise from a source slice.
- **The 360 / 3,807 `non-ascii` figure** in the brief. Treated as the brief's,
  not re-measured.
- **Whether wrapping CJK and emoji as narrow is acceptable to look at.** That is
  a product question `docs/competition.md` already answered for the competition,
  and A2.3 would inherit. It is not an entry-condition question.

## Brief divergences

- `rust/src/align.rs` and `rust/src/doc.rs` are width sites, as guessed. The
  printer's function is named `scalars`, not `width`. A third copy lives at
  `rust/src/eval.rs` line 125, used for markdown pipe tables.
- `harness/check_width.py` is a corpus wrap-sweep, not a character-width oracle.
  The measurement that answers the entry condition is
  `harness/probe_a23_width.py`.
- The UTF-16-vs-scalar split the brief most expected is real as a class of bug
  and absent as a fact about these two printers. It was found in Phase 1,
  written into both codebases as a prohibition, and pinned by a unit test on
  each side. This page is the first time the rest of the non-ASCII catalogue was
  put through both printers.
