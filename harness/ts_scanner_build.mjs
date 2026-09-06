#!/usr/bin/env node
// Assemble each ported scanner's `.svm` from its `.program.js`.
//
//     ./harness/ts_scanner_build.mjs [--check] [language...]
//
// `spike/scanner-vm/build-svm.js` did this for toml, and it exists because the
// committed 165-byte `toml.svm` had once been produced by a command nobody
// could re-run: there was no way to tell whether it still matched its source.
// The same hazard applies to every port, so this is that script generalised and
// `--check` is what `./test.sh` runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encode } from './ts_scanner_pack.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNERS = path.join(HERE, 'scanners');

const args = process.argv.slice(2);
const check = args.includes('--check');
const named = args.filter((a) => !a.startsWith('--'));
const languages = named.length
  ? named
  : fs.readdirSync(SCANNERS)
      .filter((n) => n.endsWith('.program.js'))
      .map((n) => n.slice(0, -'.program.js'.length))
      .sort();

let stale = 0;
for (const language of languages) {
  const source = path.join(SCANNERS, `${language}.program.js`);
  const out = path.join(SCANNERS, `${language}.svm`);
  const bytes = Buffer.from(encode(require(source).build()));
  if (!check) {
    fs.writeFileSync(out, bytes);
    console.log(`wrote ${path.relative(process.cwd(), out)} (${bytes.length} bytes)`);
    continue;
  }
  if (!fs.existsSync(out) || Buffer.compare(bytes, fs.readFileSync(out)) !== 0) {
    console.error(`${language}.svm is stale: source encodes to ${bytes.length} bytes`);
    stale++;
    continue;
  }
  console.log(`${language}.svm up to date (${bytes.length} bytes)`);
}
process.exit(stale ? 1 : 0);
