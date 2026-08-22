# Scheme corpus report (stage A)

Builder: **grok-4.6 via the grok CLI**.

Pins:
`tree-sitter-scheme @ git+https://github.com/6cdh/tree-sitter-scheme@v0.24.7-1`
(commit `933883742f909cf79bd8aa6fde05ef51d79c9263`); GNU Emacs 30.2 via
`nix run nixpkgs#emacs-nox`.

## Manifest

`harness/languages/scheme.toml`. Every field that could have been guessed was
observed.

| Field                  | Value                                                                                                                                       | How it was established                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grammar`              | `tree-sitter-scheme @ git+https://github.com/6cdh/tree-sitter-scheme@v0.24.7-1`                                                             | **Not on PyPI.** `https://pypi.org/pypi/tree-sitter-scheme/json` is 404; so are `tree_sitter_scheme`, `treesitter-scheme`. The orchestrator's `tree_sitter_scheme` guess is the importable _module_, not the distribution. The grammar is [6cdh/tree-sitter-scheme](https://github.com/6cdh/tree-sitter-scheme). Latest tag with Python bindings is `v0.24.7-1` (`pyproject.toml` version `0.24.7-1`); `v0.6.0` is an older numbering and has no `pyproject.toml`. Installed with `uv run --with 'tree-sitter-scheme @ git+https://github.com/6cdh/tree-sitter-scheme@v0.24.7-1'`. |
| `grammar_module`       | `tree_sitter_scheme`                                                                                                                        | `import tree_sitter_scheme` after that install. Hyphen-to-underscore is correct for the _module_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `grammar_symbol`       | `language`                                                                                                                                  | The module exports `language` (only). It returns a `PyCapsule`. No `language_scheme()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `injection_aliases`    | `["scheme"]`                                                                                                                                | Canonical info-string (highlight.js, GitHub linguist). `scm` is a file extension. `racket` / `guile` / `r5rs` are other languages or standards.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `extensions`           | `[".scm"]`                                                                                                                                  | The usual Scheme source suffix. No fake stdin filename is needed (scheme-mode is selected by name).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `reference`            | `nix run nixpkgs#emacs-nox -- --batch --quick --eval '(progn (scheme-mode) … insert-file-contents "/dev/stdin" … indent-region … princ …)'` | Source on stdin, indented source on stdout. `emacs-nox` is emacs 30.2 without X11; `scheme-mode` ships in the lisp tree. Every flag was proven (below).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `reference_version`    | `GNU Emacs 30.2`                                                                                                                            | Printed by `nix run nixpkgs#emacs-nox -- --version`. Not assumed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `reference_width`      | `fixed`                                                                                                                                     | `indent-region` ignores `fill-column`. The same 120-character `define` at `fill-column` 40, 80, and the default 70 is byte-identical. `fill-region` _does_ wrap, but it wraps as prose and is not scheme-mode indent. No `{width}` in the command.                                                                                                                                                                                                                                                                                                                                 |
| `widths`               | `[80]`                                                                                                                                      | `"fixed"` requires exactly one width. 80 is an arbitrary measurement width, not an emacs setting (`fill-column` defaults to 70 and is ignored). Same shape as gofmt.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `gate3`                | `default`                                                                                                                                   | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `transparent_wrappers` | `[]`                                                                                                                                        | Parentheses are the structure. Gate 3 accepted emacs on all 15 runs without naming a wrapper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `equivalent_kinds`     | `[]`                                                                                                                                        | Nothing was renamed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

No `[[injections]]`. No `[incomparable]`.

### The reference command, flag by flag

```
nix run nixpkgs#emacs-nox -- --batch --quick --eval '(progn
  (scheme-mode)
  (setq coding-system-for-read (quote utf-8-unix))
  (insert-file-contents "/dev/stdin")
  (indent-region (point-min) (point-max))
  (princ (buffer-substring-no-properties (point-min) (point-max))))'
```

| Flag / form                              | Load-bearing?        | Evidence                                                                                                                                                                                                                                                            |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--batch`                                | yes                  | Without it emacs tries to open a frame. Also implies `-q` (user init skipped).                                                                                                                                                                                      |
| `--quick`                                | yes, as a disable    | `--batch` still loads `site-start.el` (`site-run-file="site-start"`). `--quick` sets `site-run-file` to `nil`. On this nix emacs-nox, `--batch` vs `--batch --quick` is **byte-identical** because site-start does not touch scheme indent, but the channel exists. |
| `scheme-mode`                            | yes                  | Without it, fundamental-mode inserts a tab on the continuation line of `(define (f x)\ny)`. With it, two spaces.                                                                                                                                                    |
| `indent-region`                          | yes                  | Without it, continuation lines stay at column 0.                                                                                                                                                                                                                    |
| `insert-file-contents "/dev/stdin"`      | yes                  | The form that actually read the pipe.                                                                                                                                                                                                                               |
| `coding-system-for-read utf-8-unix`      | encoding, not layout | stdin decode. Corpus is UTF-8 (`café` in `strings.scm`).                                                                                                                                                                                                            |
| fake filename / `--stdin-filepath x.scm` | **omitted**          | Language is selected by `scheme-mode`, not by filename. No parser inference.                                                                                                                                                                                        |
| `{width}` / `fill-column`                | **omitted**          | Does not change `indent-region` output.                                                                                                                                                                                                                             |
| `(setq indent-tabs-mode nil)`            | **omitted**          | Default is `t` and _does_ change output (tabs at columns 8, 16, 24). Pinning the default is a no-op; disabling it would be a house style, not emacs scheme-mode.                                                                                                    |
| `(setq comment-column …)`                | **omitted**          | Default 40 _does_ change top-level comment-only lines. Pinning 40 is a no-op. `(setq comment-column 10)` moves `; top` from five tabs to `TAB`+two spaces.                                                                                                          |

`gen_reference.py --check` is silent (exit 0). Two runs of the same stdin match
(`DETERMINISTIC`).

### Ambient config

Three channels, all closed or empty under this command:

1. **User init.** `--batch` implies `-q`. A planted `~/.emacs` with
   `(setq lisp-body-indent 8)` is **ignored**. The same file `--load`ed applies:
   define body moves from two spaces to a tab (column 8). `user-init-file` is
   `nil` under both `--batch` and `--batch --quick`. The brief's "bare emacs
   --batch still loads init files" is **false for user init on GNU Emacs 30.2**;
   it is true for `site-start.el`.
2. **Site-start.** `--quick` sets `site-run-file` to `nil`. Without `--quick` it
   is `"site-start"`. Output is identical on this nix emacs-nox.
3. **`.dir-locals.el`.** The command never sets `buffer-file-name` and never
   calls `hack-local-variables`. A planted
   `((scheme-mode . ((lisp-body-indent . 8) (comment-column . 10))))` in cwd is
   ignored. Forcing `(setq buffer-file-name "x.scm")` + `hack-local-variables`
   applies both options (body at column 8, top-level comment at column 10). That
   is why there is no fake filename: `--stdin-filepath x.scm` would have been
   the search root for dir-locals the way it is for prettier's `.editorconfig`.

Leftover channels the disable leaves open:

- An explicit `--load FILE` still applies (proven).
- `EMACSLOADPATH` / `--directory` can still change `load-path` after `--quick`.
- There is no `EMACS_*` equivalent of `TAPLO_CONFIG` that re-enables init search
  under `-Q`.

A discovered config can still supply every scheme-mode variable the command line
does not name (`lisp-body-indent`, `comment-column`, `indent-tabs-mode`,
`scheme-mit-dialect`, per-symbol `scheme-indent-function` properties).
Command-line `--eval` setq **wins per variable** if it runs after the load;
`--quick` is the thing that stops the _search_. We name none of those variables,
so `--quick` is the whole disable.

### Option table (dumped from scheme-mode under `-Q`)

Command:

```
nix run nixpkgs#emacs-nox -- --batch --quick --eval '(progn (scheme-mode) (dolist (v …) (princ (format "%s = %S\n" v (symbol-value v)))))'
```

| Variable                  | Default                  | Load-bearing for this corpus?                                                                                                                                                                                                                 |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lisp-indent-offset`      | `nil`                    | no (the `def*` prefix rule and per-symbol properties fire instead)                                                                                                                                                                            |
| `lisp-body-indent`        | `2`                      | **yes** — define/let/lambda bodies. Planting 8 changes them.                                                                                                                                                                                  |
| `indent-tabs-mode`        | `t`                      | **yes** — columns 8/16/24 become tabs. **11 of the 15** reference files contain a tab, not just the three obvious ones.                                                                                                                       |
| `fill-column`             | `70`                     | **no** for `indent-region`. This is the option a width-driven package would reach for, and it does nothing here.                                                                                                                              |
| `comment-column`          | `40`                     | **yes**, for own-line comments starting with exactly one `;` — at **every nesting depth**, not only at file level. `;;` takes the enclosing code indent and `;;;` column 0, also at every depth. Trailing comments on code lines do not move. |
| `tab-width`               | `8`                      | yes, as the tab stop `indent-tabs-mode` uses                                                                                                                                                                                                  |
| `indent-line-function`    | `lisp-indent-line`       | the indent worker                                                                                                                                                                                                                             |
| `lisp-indent-function`    | `scheme-indent-function` | the dispatch                                                                                                                                                                                                                                  |
| `scheme-mit-dialect`      | `t`                      | did not change `do` indent when flipped before `scheme-mode` on this probe; it _does_ `put` a block of MIT-only indent properties at load. Left at the default.                                                                               |
| `comment-start`           | `";"`                    |                                                                                                                                                                                                                                               |
| `adaptive-fill-mode`      | `nil`                    |                                                                                                                                                                                                                                               |
| `auto-fill-function`      | `nil`                    | no auto-fill during indent                                                                                                                                                                                                                    |
| `fill-paragraph-function` | `lisp-fill-paragraph`    | unused (we do not call it)                                                                                                                                                                                                                    |
| `electric-indent-mode`    | `t`                      | unused in `--batch` indent-region                                                                                                                                                                                                             |

`scheme-indent-function` properties (the actual layout table), dumped the same
way:

```
define -> nil          ; but the "def" prefix rule still fires
lambda -> 1
let -> scheme-let-indent
let* / letrec / letrec* / let-syntax -> 1
if -> nil
cond -> nil
case -> 1
and / or -> nil
begin -> 0
do -> 2
syntax-rules -> defun
when / unless -> 1
define-library -> 1
```

And the prefix rule in `scheme-indent-function` itself (from `scheme.el.gz` in
the 30.2 store):

```elisp
(cond ((or (eq method 'defun)
           (and (null method)
                (> (length function) 3)
                (string-match "\\`def" function)))
       (lisp-indent-defform state indent-point))
```

Any head whose name is longer than 3 characters and starts with `def` is
defun-style. `define` and `defxyz` indent alike; `list` does not. That is not an
allowlist of special forms.

**Flag: layout depends on the input's line breaks, not on width.** `fill-column`
is inert. Whether the first argument shares the head line decides between
first-arg alignment and the one-space default (`calls.scm`). The runtime's
`srcline` / `srcsoft` / `srctrail` are the opcodes that can see this. A package
that models every `list` as a width `group` will agree on files that happen to
already be broken the emacs way and be wrong in a way no count can see. Same
class as prettier `objectWrap: preserve`.

### Why `gate3 = "default"`

The generic named-node comparison is the right oracle. A Guile/`read` loader
would collapse the spellings a formatter must preserve (`#x2a` vs `42`, `#t` vs
`#true`, `'x` vs `(quote x)`) and cannot see indent. Parentheses are structural:
`(f)` is a list containing `f`. `transparent_wrappers` stays empty. Gate 3
accepted all 15 reference outputs without naming a wrapper or an equivalent
kind.

`check_gate3.py --language scheme`: 15 reference outputs accepted, 15
destructive mutations rejected, 212 useful adversarial mutations (arm inert, as
designed), 0 wrapper kinds needed.

`./harness/check_width.py . 20 120 --language scheme`:
`[PASS] width-sweep 1515/1515 agree`. Both runtimes refuse Scheme (no package);
shared refusal is agreement.

15 destructive, not 30: `drop_a_comment` looks for `is_extra and is_named`,
finds nothing, and skips. The 15 rejections are all `drop_a_token`. Line
comments _are_ named leaves, so dropping one still fails the structural layer.
The extras layer is inert. See "Harness finding".

The empty-container probe `(quote ( ))` is in `normalisation.scm`. emacs leaves
the space in. Gate 3 accepts it (`_tokens` drops whitespace between anonymous
`(` `)`). Not a finding.

## Corpus

Fifteen files in `corpus/src/scheme/`. Each is valid Scheme: clean under
tree-sitter-scheme v0.24.7-1 (no `ERROR` / `MISSING`);
`guile --no-auto-compile -q` `primitive-load`s every file (Guile 3.0.11).

Required probes:

- `nesting.scm` — nested `let`s, already broken, deep enough that emacs emits
  tabs (indent-tabs-mode t, columns ≥ 8).
- `long_sequences.scm` — a ten-argument `+` and a 26-symbol list, already broken
  so indent applies per element. emacs does not wrap; this probe is indent of a
  long sequence, not overflow.
- `comments.scm` — every position: file-level `;` (emacs moves these to
  `comment-column` 40), trailing on a definition, own-line in a body, trailing
  in a list, own-line in a list, one-line `#| block |#`, `#;` sexp comment,
  before a closing delimiter, end of file. Plus the `semis` block: `;`, `;;` and
  `;;;` on their own lines inside a `let` body, which is what separates the
  semicolon-count rule from a nesting-depth one.
- `strings.scm` — escapes, a multi-line string (emacs does **not** reindent
  inside quotes — measured), unicode `café`, characters. The one file
  byte-identical input to output: there is no leading indent to rewrite, and
  string interiors are not touched.
- `normalisation.scm` — packed delimiters `(define( packed x )( + x 1 ))`
  (preserved), over-indent (rewritten), under-indent (rewritten), empty list
  with a space `(quote ( ))` (preserved), empty list tight (preserved), a run of
  spaces before a trailing comment (preserved), mixed padding on a `list`
  (intra-line preserved, continuation indented).
- `kitchen.scm` — named `let`, `cond`, quasiquote, comments; the one file
  allowed to be messy.

Characteristic of Scheme (one line each):

- `heads.scm` — **the** probe. `(define …)`, `(let …)`, `(cons …)`, `(list …)`
  are all a `list` node; emacs indents them three different ways. Smallest case
  that proves head-driven layout.
- `calls.scm` — same `list` / `begin` head, two source line-breaks, two indents.
  Width is not involved. This is the `srcline` probe.
- `bindings.scm` — `let` / `let*` / `letrec` / named `let`. Named let is the
  same `let` head; `scheme-let-indent` looks at whether the cadr is a symbol.
- `define.scm` — variable / procedure define, and a `defxyz` call vs a `list`
  call. The `def*` prefix rule, not an allowlist.
- `control.scm` — `if` (property `nil`), `cond` (`nil`), `case` (1), `do` (2),
  `and` / `or`.
- `quote.scm` — `quote` / `quasiquote` / `unquote` / `unquote-splicing` as their
  own node types wrapping a datum, not a `list` headed by the word `quote`.
- `literals.scm` — `#x2a` / `#b101010` / `#o52` / `1/2` / `#t` / `#f` / a broken
  vector / `#:key` / `'()`. Spellings the grammar distinguishes.
- `lambda.scm` — formals on the head line vs the next line (specform 1), rest
  args, nested lambda.
- `macros.scm` — `syntax-rules` (`defun` indent) under `define-syntax`.

## Counts

From `./harness/corpus_stats.py --language scheme`:

```
scheme  --  15 files, vs GNU Emacs 30.2
  reference changes    14/15 at some width   (@80 14/15)
  differs by width     n/a -- fixed-width reference, one width
  carries a comment    0/15   [BELOW half -- gate 3's extras layer is inert there]
  reference overflow   @80 0
```

From two `cmp` loops:

- **Files emacs changes at all: 14 of 15.**
  `for f in corpus/src/scheme/*.scm; cmp -s $f corpus/reference/scheme__$(basename $f .scm)@80.txt`.
  Only `strings.scm` is byte-identical: the reference does not rewrite string
  interiors and those defines were already one line. That is a fact about the
  reference, not a corpus that forgot to probe normalisation —
  `normalisation.scm` is the rewrite probe and it changes.
- **Files that differ between two widths: n/a.** One width. A comparison of two
  independent invocations of the same command is a determinism run (0 of 15
  differ; `gen_reference.py --check` silent).
- **Files carrying a comment, by named `comment` / `block_comment` nodes: 15
  of 15.** `corpus_stats` reports 0/15 because it counts `is_extra and is_named`
  and this grammar's `extras: []`. Every file has at least one named `comment`
  node (range 2–21, counted by the reviewer from `corpus/trees`; `comments.scm`
  also has one `block_comment`). See "Harness finding".

**Reference overflow: 0 lines over 80.** emacs never wraps, and no committed
line is longer than 76 characters (the longest are the file-header comments).
The scorer's `its own overflow: N` against the arbitrary measurement width 80 is
therefore 0, which is _not_ "the reference always fits a fill column" — it does
not have one. Same caveat as gofmt: print
`n/a (fixed reference; measurement width 80)` for humans. A stage-C package that
emits this indent has no width to honour.

## What emacs scheme-mode does that surprised me

### It is an indent-only reference, and that is the finding

`indent-region` rewrites leading whitespace and nothing else. It does not join
lines, split lines, or wrap at `fill-column`. Flat stays flat; broken stays
broken and gets indented. WORKFLOW already named this ("Scheme's gate 4 is
honestly _indentation_ agreement, not layout agreement"). Measured, not
inherited: 40 vs 80 vs 70 were byte-identical on a 120-character define.

The fuller alternative is still `raco fmt` (`nix run nixpkgs#racket`, package
`fmt`). emacs is available at a pin, deterministic, and is a formatter in the
indent-only sense gofmt is. I am **not** switching. If stage C finds indentation
agreement too weak, that is the switch to make — and it is a different
reference, not a flag on this one.

### Head of form, not node type — and richer than HTML's `tag_name`

This is the board's known stress, measured rather than discovered. The smallest
case is `heads.scm`. After emacs:

```
(define (as-define x)
  x)            ; 2 spaces  (def* prefix → lisp-indent-defform)

(define (as-let x)
  (let ((a 1))
    a))         ; 2 then 4  (scheme-let-indent, cadr is a list)

(define (as-cons a b)
  (cons a
	b))     ; 2 then TAB (nil property, first arg on the head line)

(define (as-call a b)
  (list a
	b))     ; same TAB as cons
```

All four inner forms are a `list` node. The grammar "doesn't parse language
constructs. Instead, it parses code as lists" (6cdh README) — that is the right
grammar for this test. HTML arrived at the same limit a round early: every
element is an `element` node, and whether prettier may break between two of them
depends on `tag_name`. Scheme is that shape in a different costume: a property
of a _token inside_ the node decides the layout of the node.

Scheme is **strictly richer** than HTML's exact-match `tag_name`, and a stage-C
agent should not flatten it to "look up the first symbol":

1. **Exact property** on the head symbol (`begin` → 0, `lambda` → 1, `let` →
   `scheme-let-indent`, …).
2. **Prefix rule:** any head matching
   `\\`def`with length > 3 is defun-style.`define.scm`has`(defxyz a /
   b)`indenting like define (`b`at 4 spaces) and`(list a /
   b)`aligning under`a`(a tab). Same`list` node.
3. **Cadr shape, named let:** `scheme-let-indent` does `looking-at` a symbol vs
   a list. `(let loop ((i 0)) …)` is specform 2; `(let ((a 1)) …)` is
   specform 1. Both heads are `let`. `bindings.scm`.
4. **Whether the first argument shares the head line** (source-driven, not
   width-driven). `calls.scm`:

```
(list a
      b)        ; first arg on the head line → align under a (tab)

(list
 a
 b)             ; first arg on the next line → one-space default
```

Same `list` head, two layouts, no width. `begin` with property 0 is the same
split: first form on the head line aligns; on the next line, body at
`lisp-body-indent`.

A node-type table cannot express any of the four. A "head symbol → indent spec"
table covers (1) and, with a prefix, (2). (3) needs the cadr. (4) needs the
source line of the first child (`srcline`). That is the runtime-change request,
not made: stage A is not writing a package, and the smallest case that would
force one is `heads.scm` plus `calls.scm`. Leave the runtimes alone.

### When a container "breaks", the containers inside it do not

emacs never breaks. A broken outer `let` whose binding is
`(list 1 2 3 4 5 6 7 8 9 10)` keeps that inner list on one line (verified).
Inner line structure is source-driven independently of outer. A package that
models each list as an independent group and breaks children because the parent
broke would diverge on every nested flat form in `nesting.scm` and
`kitchen.scm`.

### A trailing comment does not count toward a width (there is no width)

Nothing counts toward a fill column. Trailing comments on code lines **stay
put** — `comment-column` does not move them.

Own-line comments are placed by their **semicolon count**, not by their nesting
depth — the classic Lisp convention, and the thing it is easiest to get wrong
here:

| Spelling | Column                           | Depends on nesting?                              |
| -------- | -------------------------------- | ------------------------------------------------ |
| `;`      | `comment-column` (40, five tabs) | **no** — a `;` two forms deep still lands at 40  |
| `;;`     | the enclosing code indent        | it _is_ the code indent                          |
| `;;;`    | 0                                | **no** — a `;;;` two forms deep still lands at 0 |

An earlier draft of this report described the rule as "file-level goes to 40,
nested follows lisp indent". That reproduces `comments.scm` as it originally
stood — which held only `;` at file level and `;;` nested — and is wrong on the
cause. The `semis` block in `comments.scm` is the discriminator: it carries all
three spellings inside a `let` body, where a depth-keyed rule puts all three at
column 4 and emacs puts them at 40, 4 and 0. Adding it moved **none** of the
four `corpus_stats` counts; this rewrite is width-insensitive and counting
cannot see it.

### Token-level normalisation is almost empty

emacs indent-region rewrites:

- leading indentation of continuation lines (spaces, then tabs at multiples of
  8);
- own-line comment lines, by semicolon count (`;` to `comment-column`, `;;` to
  the code indent, `;;;` to column 0).

It does **not** rewrite:

- intra-line spacing (`(define( packed x )( + x 1 ))` stays);
- delimiter padding (`(quote ( ))` stays `( )`);
- runs of spaces before a trailing comment on a code line;
- string interiors, including multi-line strings;
- token text of any kind.

That is the opposite of gofmt/black/prettier. A package that emits canonical
`(+ x 1)` spacing will diverge on `normalisation.scm` even if every indent
agrees. Stage C should treat intra-line spacing as source-preserving (`sp` as in
the input, or a house style that the reference will not match).

### Tabs are the default

`indent-tabs-mode` is `t` in scheme-mode under `-Q`. `nesting.scm` starts
emitting tabs at the fourth nested `let` (column 8). `heads.scm` / `calls.scm`
emit a tab wherever first-arg alignment lands on column 8. A package that prints
only spaces will fail those files. This is emacs's default, not a setting we
added.

### `scheme-mit-dialect` defaults to `t`

It installs a block of MIT-only `scheme-indent-function` properties at mode load
(`fluid-let`, `named-lambda`, …). The corpus does not use those heads. Left at
the default; recorded so a stage-C package that special-cases only R5RS names is
not surprised by the mode's MIT bias.

## Runtime change (not made)

The board said to expect a runtime-change request and not to make one at stage
A. The request is: **dispatch on the head symbol of a `list` (and on whether the
first child shares the head line), not on `node.type`.** Smallest case:
`heads.scm` as quoted above. `calls.scm` is the source-line half. I did not
touch `rust/` or `runtime-js/`.

HTML's `tag_name` is the same class of limit. If a runtime change is built for
one, it should be built as "a property of a token inside the node", not as "HTML
tags" or "Scheme heads", so the other language gets it.

## Harness finding (not applied)

tree-sitter-scheme v0.24.7-1 sets `extras: _ => []`. Whitespace is a hidden
`_intertoken`; `comment` and `block_comment` are named, non-extra children of
`program` / `list`. There are no extras in any corpus tree.

Consequences, same class as XML `Comment` and markdown `html_block`
(LANGUAGES.md round 4; XML's proposed `comment_kinds`):

- Gate 3's universal extras layer is inert. Dropping a line comment still fails,
  because `comment` is in the structural named-tree. `#;` sexp comments have a
  named child (the skipped datum), so they fail structurally too.
- `check_gate3.drop_a_comment` finds nothing. The 15 destructive mutations this
  run rejected are all `drop_a_token`.
- `corpus_stats.comment_count` prints `carries a comment 0/15` while every file
  contains `comment` nodes.

This does not block a gate — `check_gate3` and `corpus_stats` both exit 0 — but
it makes two advertised checks lie for this grammar.

Proposed field, default empty, so existing languages do not change:

```
comment_kinds = []   # extra node types treated as comments
                     # for extras / drop_a_comment / comment_count
                     # default empty = named extras only (today's behaviour)
```

Scheme would set `comment_kinds = ["comment", "block_comment"]`.

| File                      | Change                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/manifest.py`     | Add `comment_kinds` to `_KNOWN` (tuple of str, default `()`), onto `Manifest`, parse it.                                                                                                                                        |
| `harness/check_gate3.py`  | `drop_a_comment` (lines 85–96): treat `n.type in m.comment_kinds` the same as named extras.                                                                                                                                     |
| `harness/corpus_stats.py` | `comment_count` (lines 55–65): same. Needs the manifest, which `stats_for` already has.                                                                                                                                         |
| `harness/gate3.py`        | Optional: `_extras` (line 120) also emit `comment_kinds`. Not required for correctness, because the structural layer already sees `comment`. Including it would make the extras layer do the job the workflow doc says it does. |

**Safety.** This is an additive field with default `()`. Languages that omit it
keep today's behaviour. It does not change what a shared function returns for
existing manifests. `_extras` currently yields an empty sequence for scheme;
opting in would populate it with this grammar's comments, which is the intended
fix, not a silent reinterpretation of another language's extras. Callers of
`_extras` are `gate3.signature`'s universal layer; callers of `drop_a_comment` /
`comment_count` are the two scripts above. None of them rebase tree offsets or
splice guest source (`gen_trees.convert` is not a caller).

Not applied. The field is the same proposal XML made; landing it once covers
XML, markdown, and scheme.

## Changes outside `corpus/` and `harness/languages/`

```
git diff --stat fed4974 -- . ':(exclude)corpus' ':(exclude)harness/languages'
```

(empty)

Nothing outside those two trees. No shared harness script, no runtime, no
package.

## Template delta

- The orchestrator's distribution guess `tree_sitter_scheme` /
  `tree-sitter-scheme==0.7.0` is wrong: the package is **not on PyPI**. The git
  form the schema already allows is the one that works. A brief that only shows
  `==` pins will send the next non-PyPI grammar hunting for a number that does
  not exist.
- "Bare `emacs --batch` still loads init files" is false for **user** init on
  GNU Emacs 30.2 (`--batch` implies `-q`; `user-init-file` is `nil`). It is true
  for `site-start.el`. The planted-config proof still holds; the channel that
  needs `--quick` is site-start, not `~/.emacs`.
- The fake-filename example `x.scheme` would have been wrong here (extension is
  `.scm`) and was unnecessary: scheme-mode is selected by name. Adding a fake
  `x.scm` would have opened the dir-locals channel we spent the proof closing.
- "Most files should carry a comment" is the right requirement and this corpus
  meets it (15/15 named `comment` nodes), but the _measurement_ assumes comments
  are named extras. Scheme is the third grammar on the roster where they are not
  (`extras: []`). The `comment_kinds` field above is the schema gap, now paid
  for three times.
