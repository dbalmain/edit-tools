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

// `NO_PROJECT` is the probe's positive control: with it set this driver
// returns the document untouched, and phase B must fail. A producer-agreement
// check that passes when one producer does nothing is not a check, and that is
// exactly the shape this probe had before the verdicts were compared.
const inert = process.env.PROSE_NO_PROJECT === "1";
const out = payload.map(({ path, doc }) => {
  const verdicts = inert ? [] : reasons(doc);
  return { path, reasons: verdicts, doc: inert ? doc : project(doc) };
});

process.stdout.write(JSON.stringify(out));
