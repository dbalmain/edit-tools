#!/bin/sh
# Runtime and harness unit suites, then the harness's own checks and scorers,
# then the tree-interface and manifest-driven injection probes.
#
# check_gate3.py runs before the scorer on purpose: it establishes that gate 3
# still accepts every reference formatter (incomparable files skip only that
# assertion) and still rejects destruction. A 30/30 from the scorer means
# nothing if the gate has quietly become a no-op.
#
# The reference formatters are run by harness/gen_reference.py, not from this
# script, and their output is committed. That part is hermetic. Two probes
# are not: probe_injection_parity.py and probe_secondary_grammar.py read
# gitignored parse tables under web/data/blobs/, written by ./web/gen.py.
# Sixteen grammars, 22.9 MB raw -- they are not committed on purpose.
# gen.py itself exits unless a vici checkout sits next to this repo.
# Fail here, before the rest of the suite, if those tables are missing.
set -e
cd "$(dirname "$0")"
missing=0
for path in \
    web/data/blobs/markdown.blob.json \
    web/data/blobs/markdown_inline.blob.json
do
    if [ ! -f "$path" ]; then
        if [ "$missing" -eq 0 ]; then
            echo "$0: missing generated parse table(s):" >&2
            missing=1
        fi
        echo "  $path" >&2
    fi
done
if [ "$missing" -eq 1 ]; then
    echo "run ./web/gen.py to write them (needs a vici checkout next to this repo;" >&2
    echo "sixteen grammars, 22.9 MB raw, so they are gitignored)." >&2
    echo "Required by harness/probe_injection_parity.py and harness/probe_secondary_grammar.py." >&2
    exit 1
fi
./build.sh
cargo test --manifest-path rust/Cargo.toml
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
node --test runtime-js/bundle.test.js
node --test runtime-js/highlight.test.js
# The web apps' host-side policy. `web/js/host.js` has no imports on purpose,
# so this runs on a clean checkout, before `web/gen.py` has written vendor/.
node --test web/js/host.test.js
python3 -m unittest discover -s harness
./harness/check_gate3.py
./harness/score.py .
./harness/corpus_stats.py
./harness/score_highlight.py .
./harness/probe_tree_interface.py
./harness/probe_injection.py
./harness/probe_injection_parity.py
./harness/probe_secondary_grammar.py
./harness/probe_prose.py
