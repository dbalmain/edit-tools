# editor-tools

A syntax highlighter and code formatter that run natively in both Rust and
JavaScript, sharing a downloadable, data-only language package format.

Sibling to [`vici`](https://github.com/dbalmain/vici), a headless vi editing
core with the same design constraint: two idiomatic implementations kept honest
by differential fuzzing, rather than one implementation behind FFI.

**The formatter works.** Two languages are merged (Python against black, JSON
against prettier), both runtimes produce byte-identical output across the
corpus, and a language is added by writing one JSON file rather than by touching
either runtime. The highlighter is not started.

```sh
./build.sh          # compiles the Rust runtime; the JS runtime needs no build
./test.sh           # both unit suites, then the harness's gates and scorer
./fmt-rust corpus/trees/python__calls.tree.json 88
./fmt-js   corpus/trees/python__calls.tree.json 88
```

- [DESIGN.md](DESIGN.md) — how the formatter works, what it cannot do, and the
  measured scores. Start here.
- [docs/house-style.md](docs/house-style.md) — what we optimise for when we
  differ from the canonical formatter, and why some divergences are the design
  working rather than defects.
- [docs/roadmap.md](docs/roadmap.md) — what is in flight, what is deferred, and
  the trigger that reopens each deferral.
- [docs/injection.md](docs/injection.md) — one document, several languages
  (JavaScript inside a markdown fence).
- [docs/design.md](docs/design.md) — the original design, the landscape
  research, and the formatter design space.
- [docs/competition.md](docs/competition.md) — protocol for the model
  competition that selected the formatting model.
- [docs/onboarding/](docs/onboarding/) — the workflow for adding a language, and
  the running record of how each model performed at it.
