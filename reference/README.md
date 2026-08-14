# Reference submission

**Not a design entry.** This exists to prove the harness works end to end and to
show the submission contract in concrete form. Its formatting rules are
hardcoded in the runtime rather than expressed as a data package, which is
exactly what a real submission must _not_ do — that choice is deliberate, so
this does not anchor anyone on a particular design.

It handles JSON and refuses Python, so scoring it shows both the pass path and
the refusal path.

What to copy from it:

- the `fmt-rust` / `fmt-js` CLI shape: `<tree.json> <width>` to stdout, non-zero
  exit to refuse
- the Doc IR constructor set and the Wadler fits/print loop, in both languages
- reading the corpus tree format

What to ignore: everything about how the rules themselves are written.

```sh
./build.sh
../harness/score.py .
```
