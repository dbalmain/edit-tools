# One grammar version does not pin one tree

**Finding.** `docs/parse-layer.md` credits route A with *deleting* a divergence
risk: "with the same grammar version behind native and wasm, the parse layer
cannot diverge between runtimes." That is false, and it is measurably false in
the direction that matters. Five of the nine external scanners this project
depends on classify characters with `<wctype.h>` — `iswspace`, `iswalpha`,
`iswalnum`, `iswdigit`, `towlower` — and those functions are a property of the
**host process**, not of the grammar. Route A ships three different hosts.

This is filed separately from `docs/scanner-vm.md` because it is upstream of the
scanner-VM question and survives whatever is decided there. It reprices every
route, including the recommended one.

## The measurement

`tree-sitter-css` 0.25.0's scanner opens with:

```c
if (iswspace(lexer->lookahead) && valid_symbols[DESCENDANT_OP]) {
```

So whether `a<SEP>b` in a selector is one `descendant_selector` or two
unrelated tokens is decided by `iswspace`. Four inputs differing only in `<SEP>`,
across the three hosts, with ASCII space as the positive control:

| `<SEP>`                  | glibc, `LC_ALL=C`<br>(a Rust host) | glibc, `en_AU.UTF-8`<br>(CPython — froze the corpus) | musl/emscripten<br>(`web-tree-sitter`) |
| ------------------------ | ---------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| U+0020 SPACE (control)   | `descendant_selector`              | `descendant_selector`                                | `descendant_selector`                  |
| U+2003 EM SPACE          | **`ERROR`**                        | `descendant_selector`                                | `descendant_selector`                  |
| U+3000 IDEOGRAPHIC SPACE | **`ERROR`**                        | `descendant_selector`                                | `descendant_selector`                  |
| U+00A0 NO-BREAK SPACE    | not a separator                    | not a separator                                      | **`descendant_selector`**              |

Three hosts, three distinct behaviours, one pinned grammar. Reproduce with
`spike/scanner-vm/locale/` (`locale_divergence.py`, `host_ctype.rs`,
`wasm_ctype.cjs`).

The two columns that matter for route A are the first and third, and they
disagree on **every non-ASCII row**.

## Why each host answers differently

- **A Rust host runs the C locale.** Rust's `std` never calls `setlocale`, so
  `LC_CTYPE` stays `"C"` and glibc classifies ASCII only. Measured directly by
  `host_ctype.rs`, which declares the three symbols and no crates.
- **CPython sets `LC_CTYPE` from the environment.** So `harness/gen_trees.py`
  — which produced every file in `corpus/trees/` — ran under whatever locale the
  machine had. Here that is `en_AU.UTF-8`.
- **musl ignores `LC_CTYPE` altogether.** Its `iswspace` is a fixed Unicode
  table, and that table contains U+00A0, which no glibc locale calls a space.
  emscripten links musl, so this is what every `web-tree-sitter` build does.

## What this costs, route by route

**Route A is the one that loses a stated benefit.** Its Rust runtime (C locale,
ASCII-only) and its JS runtime (musl, Unicode) disagree on exactly the inputs
above, and the doc's argument for A leans on them not being able to. The
divergence is silent, input-dependent, and confined to non-ASCII — which is
this project's named failure mode, in the layer that was supposed to be immune
to it.

**The frozen corpus is already implicated, independent of wasm.** The trees in
`corpus/trees/` encode the locale of the machine that ran `gen_trees.py`. A Rust
host reading those same grammars is in the C locale and would not always
reproduce them. This is true *today*, under the current design, before any parse
layer is chosen.

**It is an argument for a data-only scanner** — the one place the bytecode-VM
route wins cleanly. A VM whose character classes are sorted code-point ranges
carried in the package has no `LC_CTYPE`, no libc, and no host. Both runtimes
read the same table. The ambiguity is not resolved at runtime; it is resolved
once, by whoever writes the class, and it is recorded in the package.

## How live is it?

Non-ASCII appears in 17 of 235 corpus source files, spread across 12 of 16
languages — so the inputs exist, though none of them is currently known to sit
on one of the five affected scanners' decision points.

The affected scanners are **css, javascript, kotlin, rust, markdown-block**
(`iswspace`/`iswalpha`/`iswalnum`/`iswdigit`/`towlower`). The clean four are
**toml, python, yaml, markdown-inline**, which classify with explicit
comparisons and are host-independent by construction.

That "none currently known" is the honest state and it is not reassurance: the
oracle gap `docs/parse-layer.md` already describes — no differential fuzzer, no
error-recovery tests — is exactly what would be needed to find a live instance,
and it is the same gap that makes a hand-ported scanner unsafe.

## What I controlled, and what I did not

Controlled: grammar version, input bytes, and parser for the two glibc columns —
same `tree-sitter-css` 0.25.0 shared object, same process, only `LC_ALL` varied.
ASCII space is the positive control and is identical across all three hosts, so
the harness is not simply reporting three broken setups.

**Not controlled: the grammar version in the wasm column.** The only prebuilt
css wasm I could obtain is `tree-sitter-wasms` 0.1.13, which is not built from
0.25.0, and I did not build a 0.25.0 wasm (that needs emscripten or docker).
So for the U+2003 and U+3000 rows, "wasm differs from the Rust host" is
confounded with grammar version.

The **U+00A0 row is not confounded**, and it alone carries the finding: no glibc
locale classifies U+00A0 as a space, both glibc columns agree it is not a
separator, and musl says it is. That is a libc-level disagreement that no
grammar version can produce or remove.

Also not established: whether any *real-world* source file in the target
languages hits one of these decision points, and whether Rust's `tree-sitter`
crate might acquire a locale from some other linked library in a larger binary.

**What would settle the confounded rows**: build `tree-sitter-css` 0.25.0 to
wasm with the tree-sitter CLI and rerun `wasm_ctype.cjs` against it.

## What should change in `docs/parse-layer.md`

1. **Strike the "deletes divergence" credit from route A**, or reduce it to
   "deletes divergence in the LR tables, not in the scanners".
2. **Record that the frozen corpus carries a locale.** Either pin `LC_ALL` in
   `gen_trees.py` so the corpus is reproducible, or state the locale in the
   corpus header. This is worth doing regardless of the route chosen, and it is
   the cheapest item on this page.
3. Add host-ctype divergence to the gate in *"The gate in front of any
   own-the-parser route"*, which currently lists error recovery, incremental
   reparse and state serialization. It belongs there, and unlike the other
   three it is not specific to owning the parser.
