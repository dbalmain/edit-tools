"use strict";
const fs = require("fs");
const { OP_NAMES, opLen } = require("./opcodes");

const file = process.argv[2] || "packages/json.json";
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
const want = process.argv[3];

function disasm(from, to) {
  let pc = from;
  while (pc < to) {
    const op = pkg.code[pc];
    const len = opLen(op, pkg.code, pc);
    const name = OP_NAMES[op] || `?${op}`;
    const rest = pkg.code.slice(pc + 1, pc + len);
    let extra = rest.join(" ");
    if (rest.length && ["TEXT", "REFUSE", "PEEK_TOKEN", "NODE_TOKEN", "NODE_FIELD", "NODE_KIND", "BAG_FIELD", "BAG_KIND", "BAG_TOKEN", "BAG_FMT_KIND"].includes(name)) {
      extra += `  ; ${JSON.stringify(pkg.consts[rest[0]])}`;
    }
    console.log(`${String(pc).padStart(5)}  ${name} ${extra}`);
    pc += len;
  }
}

const ends = Object.entries(pkg.entry)
  .map(([k, v]) => [k, v])
  .sort((a, b) => a[1] - b[1]);
ends.push(["__end", pkg.code.length]);

if (want) {
  const start = pkg.entry[want];
  const idx = ends.findIndex((e) => e[0] === want);
  const end = ends[idx + 1][1];
  console.log(`;; ${want} kind=${pkg.kinds[want]} pc=${start}`);
  disasm(start, end);
} else {
  console.log(";; defaults", pkg.defaults);
  for (let i = 0; i < ends.length - 1; i++) {
    console.log(`\n;; ${ends[i][0]} kind=${pkg.kinds[ends[i][0]]} pc=${ends[i][1]}`);
    disasm(ends[i][1], ends[i + 1][1]);
  }
}
