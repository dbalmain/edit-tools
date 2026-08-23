# Haskell package report (stage C)

```
gate 1 idempotence      pass    (16/16)
gate 2 width            waived  reference_width = "fixed"; output 5 overflow lines, ormolu 4
gate 3 non-destruction  pass    (16/16, default named-tree comparison with transparent parens)
gate 4 agreement        11/14 @ width 80 (2 incomparable files excluded)
rust/js parity          identical (16/16 @80; 1920/1920 in the width 1-120 sweep)
refusals                none
size                    package 2040 B gzip; runtime 14216 B gzip; delta vs main +85 B
```

`./build.sh`, `./test.sh`, the Haskell scorer, and the adversarial width sweep
are green. The scorer's four hard gates are 16/16. The width measure is waived
because 80 is only a measurement scale for ormolu; it is not a wrap column.
The scorer counts four reference overflow lines after its comparative-token
exemption, while the package has five.

## Result

The package covers all 65 branch node kinds. It follows ormolu's source-driven
line structure for bracketed sequences, moves record commas from leading to
trailing position, removes explicit `do` braces, inserts the class-context
parentheses ormolu requires, inserts blank lines between ordinary top-level
declarations, and canonicalises intra-line spacing. The same package is stable
and Rust/JS-identical at every integer width from 1 through 120.

The two manifest exclusions remain exactly the stage-A/B exclusions:
`imports.hs` is reordered by ormolu, and `import_merging.hs` has declarations
deleted and merged by ormolu. Both still participate in coverage, parity,
idempotence, and non-destruction; only agreement excludes them.

## Divergences

Every scored divergence is classified below. None is a package bug.

- `haskell/comments.hs@80`
  `6ce494483a979397b57d56c8305ae8197da895413e9ddb5d68391387a72d5a7c`
  — **design limit**. The blank-line opcode cannot compare the selected names
  of adjacent signature/function declarations, and the record comment is
  attached to the following field before package evaluation, so a field rule
  cannot emit it at the enclosing separator column.
- `haskell/functions.hs@80`
  `b04bc003347926d9d907e0d4c5e5b5bd0926fdccd26be8899117391e57dbf05c`
  — **design limit**. Ormolu keeps equations for the same function together;
  the package can floor blanks by sibling node kind but cannot compare the
  function-name leaf of adjacent siblings, so the general top-level rule also
  separates the `fact` and `first` equation groups internally.
- `haskell/signatures.hs@80`
  `ece11d5b38739740c11f44e2d4ba73d22c792f9dfc70ac71db8a41dd7f010167`
  — **design limit**. Ormolu groups a signature with definitions having the
  same name. Rules cannot compare a signature's selected name with the next
  declaration's selected name, so the required general blank-line floor also
  separates `counted` and `kinded` from their definitions.

Preserving the input blank gaps instead is not an equivalent package-only fix:
it loses ormolu's required blank insertion in `normalisation.hs`,
`long_sequences.hs`, and `operators.hs`. Removing `function` or `signature`
from the floor merely moves the same error to ordinary neighbouring
declarations.

## Runtime edits

The runtime changed twice. Each change is shared, backwards-compatible, tested
in Rust and JavaScript, and charged separately using the scorer's gzip method.

| Commit | Construct that forced it | Runtime gzip delta | Case |
| --- | --- | ---: | --- |
| `adc0807` | source-broken lists and records with leading commas | **+42 B** (14131 to 14173) | Added the `source-multiline` predicate. `srcline` and `srcsoft` inspect the source gap at the current cursor; after the comma is moved before the break, that cursor no longer carries the original leading-comma newline. A width-driven `group` contradicts ormolu in both directions. Testing the node's source range lets one general bracket rule choose the source-flat or source-broken form. |
| `a727794` | a flat single class constraint | **+43 B** (14173 to 14216) | Extended `paren` with an optional leading boolean: `['paren', true, ...]` emits a balanced pair even in flat layout and still adopts a source pair. Existing `paren` inserted only when its group broke, and `autoparen` did not provide an unconditional balanced insertion, so neither could produce `class (Eq a) => ...` at width 80. |

Before adding `source-multiline`, I tried the existing source-break primitives
and a group. The former cannot relocate a break from before a leading comma to
after a trailing comma; the latter made source-flat output width-sensitive.
Before extending `paren`, I tried the existing policy unchanged; the class
context stayed flat, so its `IfBreak` parentheses never appeared. The width
1-120 sweep is the adversarial check for both package compositions.

No harness file was edited, including the Haskell manifest. No shared design
documentation was edited.

## The initial draft and its refusals

The draft was a useful node-shape inventory, but several assumptions were not
safe enough to patch locally:

1. The `declarations` refusal was a token/node-kind collision. `each "named"`
   skipped branch nodes whose kinds appeared in `tokens`, leaving the cursor on
   `class` or `newtype`. `tok` does compare leaf text, so the colliding kinds
   were removed from `tokens`.
2. The `imports` refusal was the same collision for the branch kind `import`.
3. The `parens` refusal was the proposed fielded-child issue: `child "named"`
   cannot consume a child carrying `expression`, `type`, or `pattern`; the
   transparent wrapper now uses `child "*"`.
4. The reported `lists.hs` item was not one runtime refusal. It combined two
   package defects: `descend` attached and indented the module-leading comment
   inside the first declaration, while the width-driven bracket rule mishandled
   the empty/source-broken list. All Haskell `descend` entries were removed and
   bracket layout became source-driven.

The exact draft collision set was `module`, `import`, `newtype`, `class`,
`instance`, `deriving`, `do`, `let`, `case`, and `infix`. `data` and `type`
were not collisions—the corresponding branch kinds have different names—and
remain token spellings. Other draft fixes included consuming `where` and guard
bars, keeping do-block semicolons while dropping only declared braces, spacing
the first application argument, keeping the arrow with the alternative that
owns it, and adding the omitted `wildcard` rule.

## Hardest construct and one design request

Haskell's offside rule was not the hard part: gate 3 confirms that layout is
represented in the tree. The hard part was ormolu's source-sensitive line
structure combined with punctuation migration. A leading record comma carries
the evidence that the container was broken, but ormolu prints that comma on the
previous line. That is why a node-range source predicate was smaller and more
faithful than a collection of width-sensitive groups.

If the design gained one further capability, it should be a separator
predicate that compares selected key paths on the left and right sibling. A
top-level separator could then say "blank unless these declarations name the
same binding", closing the three remaining files without encoding Haskell
names or individual corpus shapes in the runtime.

## Template delta

- The prompt said the draft covered all 65 branch node types. It covered 64;
  `wildcard` was absent.
- Saying the existing `paren`/`autoparen` policy covered the class-context
  rewrite was incomplete. The available `paren` policy was conditional on a
  width break and could not insert the required pair in a flat context.
- The token-collision diagnosis was correct, but `data` and `type` were examples
  of token spellings that do **not** collide with branch kinds. Removing every
  actual collision—not every keyword—was the required fix.
- The `descend` diagnosis was correct but narrower than the defect: none of the
  Haskell descend entries were appropriate, not only `declarations`.
