<!-- Pipe tables, already padded. Empty cells. -->

| name  |   n | ok  |
| ----- | --: | --- |
| alpha |   1 | yes |
| beta  |  22 |     |
|       |   3 | no  |

A wider table that still does not wrap at either scored width:

| a   | b   | c   | d   | e   | f   | g   | h   | i   | j   |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10  |

Cells that are not bare words. Each of these has children of its own, so a
package that routes cells through a rule rather than their own source text
refuses the whole document:

| `code span` | **bold** | _emphasis_ | [link](http://example.com) | a \| pipe |
| --- | --- | --- | --- | --- |
| plain | `x` | **y** | [z](#z) | done |

Unpadded source, no outer pipes, and a ruler far longer than its column. The
column width is the widest cell and the ruler is regenerated to it, so the
author's own dash count carries nothing:

a | bb
------------------- | -
1 | 2

Every alignment, including the narrow columns that a three-character ruler
cannot go below:

| left | right | centre | plain | wide centre |
|:-|-:|:-:|-|:-:|
| l | r | c | p | cc |
| longer | longer | longer | longer | x |

Ragged rows stay ragged: a short row stops rather than being squared off, and
a long one keeps the cells that have no column:

| a | b | c |
| - | - | - |
| 1 |
| 1 | 2 | 3 | 4 |
