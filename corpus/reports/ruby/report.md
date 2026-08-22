# Ruby package report (stage C)

**Builder:** Claude (Opus 5), orchestrator session. First package this project
has had built in the Claude lane; grok is at a 402 and codex holds stage D.

```
gate 1 idempotence      pass    (30/30 ruby pairs; 250/250 corpus-wide)
gate 2 width            pass    59 overflow lines, against the reference's own 62
gate 3 non-destruction  pass    (method: default, per harness/languages/ruby.toml)
gate 4 agreement        9/14 @80,  5/14 @40   =  14/28, block_conversion.rb excluded
rust/js parity          identical on every file at every width
refusals                none
size                    package 1932 B gzip; runtime 13610 B gzip; delta vs main 0 B
```

`./test.sh` is green end to end, zero warnings, with no edit anywhere outside
`packages/ruby.json` and this report.

## What the number is

Fourteen of twenty-eight, and **every one of the fourteen misses is an existing
`FINDINGS` entry**, not a new one and not a package bug. Five entries carry all
of them, and two of those are the two entries the register already lists as the
cheapest open work.

| Cause | Entry | Pairs |
| --- | --- | --- |
| Trailing comment counted in group fit | **6** | 4 |
| Chain breaks at the dots | DESIGN's named limit | 3 |
| Continuation aligned to a computed column | **1** | 3 |
| Hash-in-hash cascade | **2** + **10** | 3 |
| Operator chain packs rather than breaks all | **8** (extension) | 1 |

Ruby raises the language count on entry 6 from two to three, on entry 2 from one
to two, and it is the first package anywhere to use `drop`.

## Every divergence

Ids and hashes from `./harness/review_formatter.py . --language ruby --json`.

- `ruby/collections.rb@40` `4d1cf1e1` — **design limit, entry 6.** `empty_array = []`
  and `mixed = [...]` both fit; their trailing comments do not, and the group
  measures the comment. syntax_tree never counts one.
- `ruby/comments.rb@40` `59c476a7` — **design limit, entry 6.** `result = a + b`
  is 14 characters and breaks in three because of a 34-character comment.
- `ruby/normalisation.rb@40` `89045347` — **design limit, entry 6.**
  `trailing_spaces = 1` plus a comment.
- `ruby/long_sequences.rb@80` `7da01a3f` — **design limit, entry 6.** The
  80-character `configure(…)` is exactly the width; the comment takes the line
  to 108 and syntax_tree still refuses to wrap it. Stage A predicted this file
  would be three of the counted overflow lines and it is.
- `ruby/chains.rb@80` `1cc97aaa`, `ruby/chains.rb@40` `e26f0ce9` — **design
  limit.** A long method chain breaks before every `.`; we break into the last
  call's brackets instead. Same limit DESIGN.md names for Python, with a
  sharper reason for Ruby — see below.
- `ruby/kitchen.rb@80` `100a1530` — **design limit, entry 1.** `raise KeyError,`
  wraps its second argument to the column of the first (14), not to an indent
  step (10). One hunk, nothing else.
- `ruby/kitchen.rb@40` `feac1497` — **design limit**, three entries at once:
  entry 1 twice (`raise`, and `rescue KeyError,` aligning `TypeError` under
  `KeyError`), the chain limit once (`results.sort_by { … }.reverse`), and
  entry 6 once.
- `ruby/patterns.rb@40` `17224478` — **design limit, entry 1.** A broken hash
  pattern aligns its contents to the `in ` prefix (column 5) and its `}` to
  column 3. We indent by 2 from the clause. Also packs both entries onto the
  aligned line, which we cannot do without the alignment.
- `ruby/nesting.rb@80` `fd0e7bfc`, `ruby/nesting.rb@40` `ec71ebe8` — **design
  limit, entries 2 and 10 together.** See below; this is the most valuable thing
  in the slice.
- `ruby/long_sequences.rb@40` `2ebe4088` — **design limit**, entries 2 and 8.
- `ruby/operators.rb@80` `95b2bf67` — **design limit, entry 8 extension.**
  `flatten` joins a chain with a `Concat`, so every operator breaks together;
  syntax_tree packs the chain and wraps, which is exactly `fill`'s decision rule
  applied to a flattened spine rather than to a child list.
- `ruby/operators.rb@40` `7b88c61d` — **design limit**, entries 8 and 6.
- `ruby/block_conversion.rb@40` `dcf408ea` — **excluded** by
  `harness/languages/ruby.toml`, as stage A declared. syntax_tree rewrites
  `{ … }` to `do … end` when the body stops fitting; that is a named-node
  rewrite and the linearity invariant forbids it.

Nothing is classified `package bug` and nothing is classified `reference quirk`.
Every miss is the IR, and each one is an entry that already exists.

## The hash cascade is not the rule entry 2 describes, and that is the finding

Stage A's report set stage C the question directly: hash-in-hash cascades
("every inner `{ a: 1 }` breaks too, with room to spare") while array-in-array
does not, and it told stage C to **"pick per node kind"**. That instruction does
not work, and the reason is worth more than the instruction.

Picking per node kind means: a `hash` emits no group of its own, so its `line`s
join the enclosing group and it breaks when its parent breaks; an `array` keeps
its group and stays independent. That matches `nesting.rb`. It then breaks
`collections.rb`, where `rows = [ { name: "alice", age: 30 }, … ]` keeps its
inner hashes flat inside a broken array — a group-less hash inside an array
inherits the array's break just as readily as it inherits a hash's. The two
files are on opposite sides of a distinction that is not about the hash at all.

So I ran the reference rather than reasoning further. Five constructions, one
width, `--print-width=80`:

| Construction | Parent breaks? | Inner |
| --- | --- | --- |
| hash of hashes | yes | **breaks** |
| hash of arrays | yes | stays flat |
| hash of calls | yes | stays flat |
| array of hashes | yes | stays flat |
| array of arrays | yes | stays flat |

The cascade is **one parent kind and one child kind**: a hash directly inside a
hash. Everything else in a broken hash keeps its own layout.

That matters because entry 2 is written as "the classic *expanded parent forces
expanded children* rule", and this is not that rule. A generic ancestor-break
context would break the arrays in `arrs` and the calls in `calls`, both of which
syntax_tree leaves flat — so implementing entry 2 as written would not fix
`nesting.rb`; it would trade two files for two others. What Ruby needs is
inheritance **the parent asks for, per child kind**: the `pair` rule, which can
already see that its value is a hash (`["all", "f:value", ["hash"]]` is an
existing predicate on an existing node), needs a way to say "format this child
without its own group". That is one child-emitting opcode, not a layout-time
context mechanism, and it lands on the entry-10 side of the line stage D drew
for CSS: selecting a different rendering by call site, decidable before layout.

Recommendation, for whoever rules on entry 2: **Ruby is the second language, so
the "decide when" condition is met — but it should be re-read before it is
built.** The cheap version (a global expanded-parent rule) is the version Ruby
disproves.

## Why `flatten` cannot walk a Ruby method chain

DESIGN.md says `flatten` does not do method chains and gives black's dot rule as
the reason. Ruby's reason is structural and different, and it is worth recording
because it constrains any future fix.

`flatten`'s spine contract is three fields — `left`, `operator`, `right` — and it
consumes exactly those on every node it folds, refusing if anything is left. A
tree-sitter-ruby `call` in a chain has **five** children:
`receiver operator method arguments block`. Mapping the spine onto
`receiver`/`operator`/`method` leaves `arguments` and `block` unconsumed on every
node of the chain, so the fold refuses. It is not that the layout is hard; the
opcode structurally cannot fold a node that carries more than the spine.

So the chain limit for Ruby is not "we chose the ugly layout" — the tidy layout
is unreachable with the opcode as specified. `results.sort_by { … }.reverse` is
in `kitchen.rb` at 40 and `chains.rb` has three of them.

## What was hardest, and the one thing I would ask for

Three things cost real time, and all three are grammar shape rather than layout:

1. **tree-sitter-ruby gives a keyword leaf the same type string as the node it
   opens.** `if`, `case`, `class`, `begin`, `do`, `else`, `elsif`, `ensure`,
   `for`, `in`, `module`, `next`, `nil`, `rescue`, `retry`, `return` and `when`
   are each both a node type and the type of their own opening token. `tokens`
   is a set of *type strings*, and `named` is defined as "not one of these" — so
   declaring `if` punctuation would make the `if` **statement** unnamed and drop
   it out of every statement list. The package therefore declares none of them
   and leans on `tok` matching by **text**, which it does. Worth knowing before
   the next grammar does this: `tokens` cannot express "this spelling is
   punctuation" for a grammar that reuses the spelling as a node type.

2. **`tokens` is doing two jobs.** `begin`'s body statements are direct children
   alongside its `rescue` and `ensure` clauses, and no selector says "named, but
   not those". Declaring `rescue` and `ensure` as tokens stops `each "named"`
   from swallowing them as statements, and type selectors still reach them. It
   works and it is what the package ships, but it is a lie about punctuation
   told to get a stopping condition, and it has a real cost: comment attachment
   also asks `is_token`, so a comment written immediately above a `rescue` will
   not lead it. No corpus file does that. **If I could ask for one thing, it is
   a negative or first-match selector** — `each` that stops at a named type it
   is told about — which would remove the lie and, I suspect, is cheaper than
   the alternatives already in the register.

3. **A heredoc body is a program-level sibling that begins with its own
   newline.** `message = <<~MSG` is an `assignment`; the body is the *next*
   child of `program`, starting at the same byte the assignment ends on and
   opening with `\n`. A statement separator that emits `hard` therefore
   manufactures a blank line. `srcsoft` — mirror the source's own break — is
   exactly right here and also keeps `x = 1; y = 2; z = 3` working, because the
   `;` case emits its own `hard` before the mirror sees it.

## Template delta

**`DESIGN.md`'s opcode tables are missing seven opcodes, and one of them was
load-bearing here.** The document says the set is "small and closed" and then
lists `seq group indent line soft hard sp blank child each fill tok opt verbatim
flatten when trail paren autoparen`. `rust/src/pkg.rs` also accepts **`drop`,
`srcline`, `srcsoft`, `srcbreak`, `srctrail`, `cell`, `cellblock`** and a
fractional max on `group`. Four of those are in shipped packages already — Go
uses three, Kotlin and JavaScript one each — so this is documentation drift, not
an unreleased feature.

The stage-C brief tells a builder to read `DESIGN.md`, `packages/python.json`
and `packages/json.json`. A builder who does exactly that cannot discover
`srcsoft`, which is the opcode Ruby's heredocs need; I found it by reading the
package loader. Either the brief should say "the opcode set is defined by
`rust/src/pkg.rs`; DESIGN.md explains the important ones", or DESIGN.md should
be brought level. The first is cheaper and more honest about which file is the
contract.

**Second, smaller:** `FINDINGS` 13 records `drop` as "built, it works, and it
earns nothing yet" — the rustfmt leading-`|` case it was built for is parked.
Ruby earns it: `x = 1; y = 2; z = 3` becomes three statements only because the
package can drop the `;`, and `normalisation.rb` matches at both widths. The
entry should stop saying it earns nothing.

**Third:** stage A's corpus report told stage C to "pick per node kind" on the
nested-container question. It does not work, for the reason in the section
above. That is a correction to `corpus/reports/ruby/corpus-report.md`, not a
defect in it — the report's own two sentences describing the trade are accurate,
and it is the conclusion drawn from them that is wrong.
