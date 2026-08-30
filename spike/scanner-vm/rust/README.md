# Rust side of the scanner VM

`vm.rs` is a deliberate transcription of `../vm.js`, not an idiomatic rewrite:
the two have to agree instruction for instruction, and the cheapest way to keep
them agreeing is for a side-by-side diff to be readable.

```sh
rustc -O -o replay main.rs
./replay ../toml.svm ../traces ../../../corpus/src/toml
```

`main.rs` decodes the same `toml.svm` package blob the JS side loads and
replays the same recorded traces. Same bytes in, same verdicts out, or the
project's central claim is false.
