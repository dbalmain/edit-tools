#!/bin/sh
# Everything this spike verifies, end to end.  Needs cc, python3, node and
# network access on the first run (to fetch tree-sitter core and the grammar).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work="${1:-/tmp/scanner-vm-work}"
corpus="$here/../../corpus/src/toml"

node "$here/vm.test.js"

# 1. Committed traces from the frozen corpus.
node "$here/replay.js" "$here/traces" "$corpus"

# 2. Rebuild the recorder and re-derive everything else.
(cd "$here/record" && ./build.sh "$work")

# 3. Fuzz, including malformed input -- the only way to reach error recovery.
python3 "$here/record/gen_fuzz.py" "$work/fuzzin" 3000
mkdir -p "$work/ftraces"
for f in "$work"/fuzzin/*.toml; do
  "$work/trace" "$f" "$work/ftraces/$(basename "$f" .toml).jsonl" >/dev/null 2>&1
done
node "$here/replay.js" "$work/ftraces" "$work/fuzzin"

# 4. Incremental reparse: edit, reparse against the old tree, replay.
cc -O1 -o "$work/incr" "$here/record/incr.c" "$here/record/trace_scanner.c" \
   "$work/parser.c" "$work"/core/tree-sitter-0.24.0/tree_sitter/core/lib/src/lib.c \
   -I"$work" -I"$work/inc" \
   -I"$work"/core/tree-sitter-0.24.0/tree_sitter/core/lib/include \
   -I"$work"/core/tree-sitter-0.24.0/tree_sitter/core/lib/src
mkdir -p "$work/itraces"
i=0
for f in "$corpus"/*.toml "$work"/fuzzin/hand*.toml; do
  i=$((i + 1))
  "$work/incr" "$f" "$work/itraces/$(basename "$f" .toml)" "$((1000 + i))" 25 2>/dev/null
done
node "$here/replay.js" "$work/itraces" "$work/itraces"
