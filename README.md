# editor-tools

A syntax highlighter and code formatter that run natively in both Rust and
JavaScript, sharing a downloadable, data-only language package format.

Sibling to [`vici`](https://github.com/dbalmain/vici), a headless vi editing
core with the same design constraint: two idiomatic implementations kept honest
by differential fuzzing, rather than one implementation behind FFI.

Nothing is implemented yet. Current state is design.

- [docs/design.md](docs/design.md) — the design, the landscape research, and the
  formatter design space.
- [docs/competition.md](docs/competition.md) — protocol for the model
  competition that selects the formatting model.
