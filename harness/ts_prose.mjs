// Run `harness/prose.mjs` over documents handed in on stdin, for
// `harness/probe_prose.py` to compare against its own.
//
// JSON in, JSON out, one array each way: the probe owns the parse, so the only
// thing being compared is the projection. There is no file reading and no
// parser here on purpose -- a driver that could disagree about either would
// make a projection difference indistinguishable from an input difference.

import { project, reasons } from "./prose.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

// The verdicts are read *before* the projection rewrites the paragraphs they
// describe. Order matters: `project` replaces the `inline` child a refusal
// would have been computed from.
const out = payload.map(({ path, doc }) => {
  const verdicts = reasons(doc);
  return { path, reasons: verdicts, count: project(doc), doc };
});

process.stdout.write(JSON.stringify(out));
