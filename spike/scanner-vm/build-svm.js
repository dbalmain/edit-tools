#!/usr/bin/env node
// Regenerate `toml.svm` from `toml.program.js`.
//
//     node spike/scanner-vm/build-svm.js            # write toml.svm
//     node spike/scanner-vm/build-svm.js --check    # verify, write nothing
//
// This did not exist until the parser needed the artifact, which meant the
// committed 165-byte `toml.svm` had been produced by a command nobody could
// re-run: there was no way to tell whether it still matched its source. It does
// -- that is what `--check` asserts, and `harness/ts_lr.test.mjs` asserts it
// again inside `./test.sh` so the two cannot drift apart unnoticed.
const fs = require('fs');
const path = require('path');
const { encode } = require('./pack.js');
const { build } = require('./toml.program.js');

const out = path.join(__dirname, 'toml.svm');
const bytes = Buffer.from(encode(build()));

if (process.argv.includes('--check')) {
  const disk = fs.readFileSync(out);
  if (Buffer.compare(bytes, disk) !== 0) {
    console.error(`toml.svm is stale: source encodes to ${bytes.length} bytes, file has ${disk.length}`);
    process.exit(1);
  }
  console.log(`toml.svm up to date (${bytes.length} bytes)`);
} else {
  fs.writeFileSync(out, bytes);
  console.log(`wrote ${out} (${bytes.length} bytes)`);
}
