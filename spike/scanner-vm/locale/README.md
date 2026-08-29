# One grammar version, two trees

Reproduces the measurement behind the "route A does not delete divergence"
finding in `docs/scanner-vm.md`.

```sh
./locale_divergence.py                    # inherits the environment's locale
LC_ALL=C LANG=C ./locale_divergence.py    # C locale

rustc -O -o host_ctype host_ctype.rs && ./host_ctype
```

`locale_divergence.py` parses four CSS snippets that differ only in which space
character separates two tag names. `host_ctype.rs` reports which locale a Rust
process runs in, with no crates.

Everything here is a probe. Nothing is shipped and nothing is imported by the
runtimes.
