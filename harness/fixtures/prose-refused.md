<!-- Every top-level paragraph below must be refused by the prose projection. -->

# Paragraphs the projection must refuse

> `harness/probe_prose.py` requires this file to yield **zero** eligible
> paragraphs. Each entry is a near miss: everything about it is admissible
> except the single thing named in its heading, so widening the predicate by one
> character or dropping one rule makes it eligible and fails the probe.
>
> Real prose cannot play this role. A document that happens to contain a `\`
> almost always also contains a backtick or a link, so admitting the `\` changes
> nothing and the mutation that admits it looks safe. These paragraphs exist to
> be the case where it is the only thing standing.
>
> **Every explanatory paragraph in this file is a block quote, and that is
> load-bearing.** A paragraph inside a container is never offered to the
> predicate at all, so this prose cannot become an entry by accident. It used to
> rely on being written with code spans instead -- which worked until A2.1
> admitted code spans, and would have quietly turned this commentary into a
> dozen eligible paragraphs the probe then failed on. A device that depends on
> the predicate refusing something is not a device, because the predicate is the
> thing under test.

## An unpaired asterisk

alpha beta * gamma delta epsilon zeta eta theta

## An unpaired underscore

alpha beta _ gamma delta epsilon zeta eta theta

## A deferred construct nested inside emphasis

> Descending through emphasis must not hide an unsupported child. The shortcut
> link remains an A2.4 construct even though its enclosing emphasis is admitted.

alpha beta *gamma [delta] epsilon* zeta eta theta

## An unterminated code span

> A2.1 admits `code_span`, so a _terminated_ one is no longer a near miss -- it
> is an ordinary eligible paragraph now. The near miss moved one character to
> the left: a lone backtick the inline grammar cannot close.

alpha beta `gamma delta epsilon zeta eta theta

## A shortcut link

> Also one character from admissible. A2.1 admits `inline_link`, which carries
> its own destination; a `shortcut_link` resolves through a reference definition
> elsewhere in the document, which this layer never reads.

alpha beta [gamma delta] epsilon zeta eta theta

## A full reference link

alpha beta [gamma][delta] epsilon zeta eta theta

## An image

alpha beta ![gamma](delta) epsilon zeta eta theta

## An angle bracket that is not a URI autolink

alpha beta <gamma> delta epsilon zeta eta theta

## A backslash escape

alpha beta gamma\delta epsilon zeta eta theta

## A tilde

alpha be~~ta gamma~~d epsilon zeta eta theta

## An ampersand

alpha beta &amp; gamma delta epsilon zeta eta

## A hard break, spelled as two trailing spaces

alpha beta gamma delta  
epsilon zeta eta theta

## A double space inside the line

alpha beta gamma  delta epsilon zeta eta theta

## A tab

alpha beta	gamma delta epsilon zeta eta theta

## A non-ASCII letter

alpha beta gámma delta epsilon zeta eta theta

## A non-breaking space, which is whitespace this layer must not move

alpha beta gamma delta epsilon zeta eta theta

## A word that would become a heading at a line start

alpha beta gamma # delta epsilon zeta eta theta

## A pipe inside a word, where no other rule reaches it

> Every other entry that spells a pipe puts it at the start of an atom, where
> `_ACQUIRES` refuses it and the character check never has to. Admitting `|` to
> the whitelist therefore changed nothing measurable until this entry existed. A
> character the whitelist excludes needs an entry that fails for _that_ reason,
> or the exclusion is untested.

alpha beta|gamma delta epsilon zeta eta

## Inside a blockquote, where every new line would need its own marker

> alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi

## Inside a list item, where every new line would need its own indent

- alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi

## A paragraph whose last line is a table delimiter row

> **This is the entry A2.1 was caught by, and it is the boundary of the whole
> coalescing mechanism.** Bilateral gap protection works by keeping a hazardous
> atom's line context identical to the source's. A delimiter row does not depend
> on its own line: it makes the **preceding** line a table header, and that line
> is decided by gaps further left which are still breakable. So protection keeps
> the newline and the row, and reflows the header anyway.
>
> It leaks here and nowhere else because the pinned block grammar cannot parse a
> pipeless table, so this arrives as an ordinary paragraph. `_DELIMITER_ROW` in
> `prose.py` refuses it outright, and this entry is that rule's only guard -- no
> reparse can stand in for it.

alpha beta gamma delta epsilon zeta eta theta
:-

## A fence opener at a line start only reflow creates

> A code span delimited by four backticks spans a source newline, so one atom
> holds a line beginning with a backtick run. In the source that line continues
> `` fence in `x` y ``, and the backtick in the prospective info string is the
> only thing stopping it being a fence. Reflow can end the line before that
> backtick, and then it is one. This is the shape found live in
> `corpus/reports/markdown/report.md`.

a ```` ```json
```` fence in `x` y

## The same, indented one space

> CommonMark permits a fence opener after up to three spaces, so the check
> cannot anchor at column zero. These four entries are 1, 2, 3 and 4 spaces:
> the first three corrupt into a `fenced_code_block`, the fourth into an
> `indented_code_block`, which is why the rule allows any indent rather than
> CommonMark's three. Measured through the real parser and both runtimes at
> widths 10 to 60.

a ```` ```json
 ```` fence in `x` y

## The same, indented two spaces

a ```` ```json
  ```` fence in `x` y

## The same, indented three spaces, CommonMark's limit

a ```` ```json
   ```` fence in `x` y

## The same, indented four spaces, past the limit and still not safe

a ```` ```json
    ```` fence in `x` y

## The same, with a pipe, which the character check reaches first

alpha beta gamma delta epsilon zeta eta theta
| --- |

## The right-aligned spelling of the same trailing row

alpha beta gamma delta epsilon zeta eta theta
-:

## The centre-aligned spelling of the same trailing row

alpha beta gamma delta epsilon zeta eta theta
:-:

<!--
The entries below left this file deliberately when A2.1 landed, and the note
stays so the next reader does not restore them.

`- delta`, `1. delta`, and the mid-paragraph spellings of `:-`, `:-:`, `:---`,
`-:` and `--` were all A1 refusals ("block acquisition"). A2.1 admits them:
partition() protects the gap on *both* sides of a hazardous atom, so the atom
cannot be isolated on a line of its own and the paragraph is safe to reflow.

They cannot be guarded here any more, because this file can only detect a
change in **eligibility** and they are eligible either way. What has to be
guarded is now the *partition* -- which gaps came back breakable -- and that
lives in harness/test_prose.py, together with a mutation control that restores
predecessor-only protection and requires those cases to fail.
-->
