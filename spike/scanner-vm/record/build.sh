#!/bin/sh
# Build the scanner-call recorder: tree-sitter's core, tree-sitter-toml 0.7.0's
# generated parser, and its real scanner.c wrapped in instrumentation.
#
# Nothing third-party is vendored into the repo; this fetches it into a work
# directory.  Run from this directory:  ./build.sh /tmp/rec-work
set -eu
WORK="${1:-./work}"
mkdir -p "$WORK"
cd "$WORK"

# tree-sitter-toml 0.7.0 declares LANGUAGE_VERSION 14, so it must be compiled
# against an ABI-14 parser.h.  tree-sitter core 0.24.0 ships one; 0.25's
# TSLanguage renamed .version to .abi_version and will not compile it.
if [ ! -d core ]; then
  python3 - <<'PY'
import io, json, tarfile, urllib.request
def grab(name, ver, dest):
    d = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{ver}/json"))
    url = [u for u in d["urls"] if u["packagetype"] == "sdist"][0]["url"]
    tarfile.open(fileobj=io.BytesIO(urllib.request.urlopen(url).read())).extractall(dest)
grab("tree-sitter", "0.24.0", "core")
grab("tree-sitter-toml", "0.7.0", "grammar")
PY
fi

CORE=core/tree-sitter-0.24.0/tree_sitter/core/lib
GRAMMAR=grammar/tree_sitter_toml-0.7.0/src
mkdir -p inc/tree_sitter
cp "$CORE"/src/parser.h "$CORE"/src/array.h "$CORE"/src/alloc.h inc/tree_sitter/
cp "$GRAMMAR"/parser.c "$GRAMMAR"/scanner.c .

cc -O1 -o trace ../main.c ../trace_scanner.c parser.c "$CORE"/src/lib.c \
   -I. -Iinc -I"$CORE"/include -I"$CORE"/src
echo "built $WORK/trace"
