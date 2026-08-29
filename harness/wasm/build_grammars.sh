#!/bin/sh
# Build one grammar wasm per manifest language, at the pinned version.
#
#     harness/wasm/build_grammars.sh [workdir]
#
# Output: harness/wasm/build/tree-sitter-<lang>.wasm (gitignored, ~14 MB).
#
# Why this is not `pip download` plus a compile. Three facts, each found the
# hard way and each load-bearing:
#
#  1. The PyPI sdists for css, python and yaml ship `src/parser.c` WITHOUT
#     `src/scanner.c`, while all three grammars have an external scanner. The
#     published wheels are built in CI from the git checkout, so the wheel this
#     repo actually pins has the scanner and the sdist does not. Building from
#     the sdist would produce a scanner-less parser and a silently different
#     tree. So the source of truth here is the git tag, and grammars.tsv
#     records the commit.
#
#  2. Every other grammar's sdist `parser.c` is byte-identical to the git tag's,
#     which is what makes (1) safe -- see `verify_provenance.sh`. The single
#     exception is rust, where the tag's generated header carries
#     `.minor_version = 23, .patch_version = 3` and the sdist's carries 24/0:
#     a metadata stamp the packaging step re-generates. The LR tables are
#     identical. We build rust from the SDIST parser.c so the wasm carries the
#     pinned stamp; scanner.c is identical either way.
#
#  3. `tree-sitter build --wasm` (CLI 0.26.8) does NOT use emscripten or docker
#     any more -- it downloads a wasi-sdk toolchain to ~/.cache/tree-sitter and
#     runs its clang directly. That binary is dynamically linked against a
#     generic-linux loader, so on NixOS it fails with "Could not start
#     dynamically linked executable". Hence the container: it is here for the
#     glibc, not for emscripten. node:24-trixie, because tree-sitter-cli 0.26.8
#     needs GLIBC_2.39 and bookworm has 2.36.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=${1:-$here/.work}
out=$here/build
mkdir -p "$work/grammars" "$work/sdist" "$out"

tsv=$here/grammars.tsv

echo "== cloning grammars at their pinned tags"
grep -v '^#' "$tsv" | while IFS="$(printf '\t')" read -r lang repo tag sub commit pin; do
  [ -n "${lang:-}" ] || continue
  dir=$work/grammars/$lang
  if [ ! -d "$dir" ]; then
    git clone --quiet --depth 1 --branch "$tag" "$repo" "$dir"
  fi
  have=$(git -C "$dir" rev-parse HEAD)
  if [ "$have" != "$commit" ]; then
    echo "  $lang: MOVED -- tag $tag is now $have, grammars.tsv says $commit" >&2
    exit 1
  fi
  echo "  $lang $tag $commit"
done

echo "== rust: swapping in the sdist parser.c (see header note 2)"
if [ ! -f "$work/sdist/rust.tar.gz" ]; then
  url=$(curl -sf https://pypi.org/pypi/tree-sitter-rust/0.24.0/json \
        | python3 -c 'import json,sys;print(next(u["url"] for u in json.load(sys.stdin)["urls"] if u["packagetype"]=="sdist"))')
  curl -sfL "$url" -o "$work/sdist/rust.tar.gz"
fi
rm -rf "$work/sdist/rust" && mkdir -p "$work/sdist/rust"
tar xzf "$work/sdist/rust.tar.gz" -C "$work/sdist/rust" --strip-components=1
cp "$work/sdist/rust/src/parser.c" "$work/grammars/rust/src/parser.c"

echo "== building the toolchain container"
docker build --quiet -t editor-tools-wasm - <<'DOCKERFILE'
FROM node:24-trixie
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils git \
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g tree-sitter-cli@0.26.8
# Warm the wasi-sdk download into the image so each build is not a 114 MB fetch.
RUN mkdir -p /tmp/probe && cd /tmp/probe \
 && printf 'module.exports = grammar({name:"probe",rules:{source_file: $ => "a"}});' > grammar.js \
 && printf '{"grammars":[{"name":"probe","camelcase":"Probe","scope":"source.probe","file-types":["probe"]}],"metadata":{"version":"0.0.1"}}' > tree-sitter.json \
 && tree-sitter generate && tree-sitter build --wasm -o /tmp/probe.wasm . && rm -rf /tmp/probe
DOCKERFILE

echo "== compiling to wasm"
script=$work/.build-inner.sh
{
  echo 'set -eu'
  grep -v '^#' "$tsv" | while IFS="$(printf '\t')" read -r lang repo tag sub commit pin; do
    [ -n "${lang:-}" ] || continue
    echo "tree-sitter build --wasm -o /out/tree-sitter-$lang.wasm /g/$lang/$sub >/dev/null && echo \"  ok   $lang \$(stat -c%s /out/tree-sitter-$lang.wasm)\" || echo \"  FAIL $lang\""
  done
} > "$script"

docker run --rm \
  -v "$work/grammars:/g:ro" -v "$out:/out" -v "$script:/build.sh:ro" \
  editor-tools-wasm sh /build.sh

echo "== done: $out"
