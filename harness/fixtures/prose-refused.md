<!-- Every paragraph below must be refused by the A1 prose projection. -->

# Paragraphs the projection must refuse

`harness/probe_prose.py` requires this file to yield **zero** eligible
paragraphs. Each one is a near miss: everything about it is admissible except
the single thing named in its heading, so widening the predicate by one
character or dropping one rule makes it eligible and fails the probe.

Real prose cannot play this role. A document that happens to contain a `\`
almost always also contains a backtick or a link, so admitting the `\`
changes nothing and the mutation that admits it looks safe. These paragraphs
exist to be the case where it is the only thing standing.

Every paragraph in this file, this one included, has to stay ineligible, so
the prose is written with `code spans` on purpose.

## An asterisk

alpha b*eta gamma*d epsilon zeta eta theta

## An underscore

alpha beta _gamma delta_ epsilon zeta eta theta

A leading gap byte, which would make the first atom zero-width and be
refused by `source_partitions` rather than by the predicate, cannot be
written here: the block grammar trims it before the `inline` node starts.

## A backtick

alpha beta `gamma delta` epsilon zeta eta theta

## A square bracket

alpha beta [gamma delta](epsilon) zeta eta theta

## An angle bracket

alpha beta <gamma> delta epsilon zeta eta theta

## A backslash

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

## A word that would become a list item at a line start

alpha beta gamma - delta epsilon zeta eta theta

## A word that would become an ordered list item at a line start

alpha beta gamma 1. delta epsilon zeta eta theta

## A word that would become a GFM table delimiter row at a line start

GFM needs a pipe only between cells, so a one-column delimiter row is just
`:-`. Moving it to its own line turns this paragraph into a table. The pinned
block grammar does not parse a pipeless table, so no reparse can catch this
one; this fixture entry is its only guard.

alpha beta :- gamma delta epsilon zeta eta

## The centre-aligned spelling of the same row

alpha beta :-: gamma delta epsilon zeta eta

## The same row with more dashes

alpha beta :--- gamma delta epsilon zeta eta

## A word that would become a heading at a line start

alpha beta gamma # delta epsilon zeta eta theta

## Inside a blockquote, where every new line would need its own marker

> alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi

## Inside a list item, where every new line would need its own indent

- alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi

## The right-aligned spelling of the delimiter row

alpha beta -: gamma delta epsilon zeta eta

## The setext underline that a two-dash atom would become

alpha beta -- gamma delta epsilon zeta eta

## A pipe inside a word, where no other rule reaches it

Every other entry that spells a pipe puts it at the start of an atom, where
`_ACQUIRES` refuses it and the character check never has to. Admitting `|` to
the whitelist therefore changed nothing measurable -- 536 eligible paragraphs
before and after -- until this entry existed. A character the whitelist
excludes needs an entry that fails for *that* reason, or the exclusion is
untested.

alpha beta|gamma delta epsilon zeta eta

## A paragraph whose next line is a table delimiter row

An exhaustive search over every two-character atom the whitelist admits found
exactly three that change meaning when moved to their own line, and the two
above plus `:-` are all of them. The remaining untested shape was the
paragraph's **neighbour**: a reflow changes which words land on the last line,
and the last line of a paragraph is the header row of the table that a
following delimiter row creates. The pinned block grammar keeps that delimiter
line inside the same paragraph, so the pipe refuses it here -- but the refusal
is load-bearing and has no other guard.

alpha beta gamma delta epsilon zeta eta theta
| --- |

## The same, with the pipeless delimiter row

alpha beta gamma delta epsilon zeta eta theta
:-
