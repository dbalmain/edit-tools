#!/usr/bin/env node
// Moved to `harness/ts_scanner_build.mjs`, which builds every ported scanner
// rather than only toml's, with the programs and packed artifacts under
// `harness/scanners/`. Kept as a pointer because this path is named in
// `run.sh`, in `rust/README.md`'s workflow, and in `docs/scanner-vm.md`.
//
//     node harness/ts_scanner_build.mjs [--check] [language...]
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const target = path.join(__dirname, '..', '..', 'harness', 'ts_scanner_build.mjs');
process.exit(spawnSync(process.execPath, [target, ...process.argv.slice(2)],
                       { stdio: 'inherit' }).status ?? 1);
