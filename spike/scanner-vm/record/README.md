# Scanner-call recorder

Wraps tree-sitter-toml 0.7.0's real `scanner.c` and logs every invocation the
parser makes: entry offset, lookahead, the valid-symbols vector, every
`advance`/`mark_end` call in order, and the verdict. `trace_scanner.c` gets the
byte offsets by casting `TSLexer *` to tree-sitter's internal `Lexer *` — legal
because `TSLexer` is its first member — and gets the lexer call sequence by
swapping the `TSLexer` function pointers before delegating.

```sh
./build.sh /tmp/rec-work
for f in ../../../corpus/src/toml/*.toml; do
  /tmp/rec-work/trace "$f" "../traces/$(basename "$f" .toml).jsonl"
done
node ../replay.js ../traces ../../../corpus/src/toml
```

The committed `../traces/*.jsonl` are the output of exactly that, so the replay
runs without rebuilding.
