# Rust side of the scanner VM

`vm.rs` is a deliberate transcription of `../vm.js`, not an idiomatic rewrite:
the two have to agree instruction for instruction, and the cheapest way to keep
them agreeing is for a side-by-side diff to be readable.  `../vm.js` is itself
now a re-export of `harness/ts_scanner_vm.mjs`, so that is the file to diff
against.

```sh
rustc -O -o replay main.rs
for lang in toml css xml; do
  ./replay "../../../harness/scanners/$lang.svm" \
           "../../../corpus/scanner-traces/$lang" \
           "../../../corpus/src/$lang"
done
```

`main.rs` decodes the same packed `.svm` the JS side loads and replays the same
committed traces, so the two runtimes are executing one artifact rather than
one program written twice.  It should print the same file, call and state
counts as `harness/ts_scanner_replay.mjs`:

| language | files | calls | states |
| -------- | ----- | ----- | ------ |
| toml     | 15    | 230   | 204    |
| css      | 15    | 450   | 12     |
| xml      | 15    | 803   | 350    |

xml is the first port that carries state across tokens, which is why `vm.rs`
gained `serialize`/`deserialize`: without them the Rust side could replay a
scanner's calls but not its state, and would have gone on reporting green over
a capability it was not exercising.  The state check is a **bijection** between
upstream's serialized bytes and the VM's, not an equality -- the two formats
differ by design.  `harness/ts_scanner_replay.mjs` carries the argument for why
that is sound on this corpus.

Not wired into `./test.sh`: it needs `rustc` on a file outside the cargo
workspace.  The JS replay is the gate; this is the twin-runtime check, run by
hand when a port lands.
