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
//
// It disables **only** `project`. Disabling `reasons` too would make the
// control fail on the verdict list and never reach the document comparison --
// so the control would stay green with the document comparison deleted, which
// is precisely the thing it exists to rule out. A control must fail for the
// reason it names, and phase B checks that by reading the message back.
const inert = process.env.PROSE_NO_PROJECT === "1";
const out = payload.map(({ path, doc }) => ({
  path,
  reasons: reasons(doc),
  doc: inert ? doc : project(doc),
}));

process.stdout.write(JSON.stringify(out));
