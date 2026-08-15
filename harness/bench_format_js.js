#!/usr/bin/env node
"use strict";

// In-process timing driver for bench_break_propagation.py. Parsing the tree
// and package is outside the clock, matching the Rust driver.

const fs = require("fs");
const path = require("path");
const { format } = require(path.join(__dirname, "..", "runtime-js", "bundle.js"));

const [treePath, widthArg, iterationsArg] = process.argv.slice(2);
const tree = JSON.parse(fs.readFileSync(treePath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "packages", `${tree.language}.json`), "utf8"));
const width = Number(widthArg);
const iterations = Number(iterationsArg);

for (let index = 0; index < 10; index++) format(tree, width, pkg);
const started = process.hrtime.bigint();
for (let index = 0; index < iterations; index++) format(tree, width, pkg);
const elapsed = process.hrtime.bigint() - started;
process.stdout.write(elapsed.toString());
