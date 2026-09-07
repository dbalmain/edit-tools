// The dashboard: every language, and how far our formatter is from the
// reference one.
//
// The counted thing is a (file, width) case, not a file: `rust.toml` names two
// widths, so a file can diverge at 60 and agree at 100, and collapsing that to
// one row per file would hide which. `cases` is therefore files x widths, and
// it is the denominator the bar is drawn against.
//
// Three columns split the divergences, and the split is the interesting part.
// *accepted* carries a reviewed verdict. *excluded* is a file the manifest
// calls incomparable -- the reference rewrites it in a way gate 3 cannot
// express as equivalent -- so it is outside the scorer's denominator and can
// never be reviewed. *open* is what is left, and it is the only column that
// represents work. Folding excluded into open, which this page did at first,
// invents eleven pieces of review debt that nobody can discharge.

import { languages } from "./lang.js";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function row(entry) {
  const tr = el("tr");

  const name = el("td", "name");
  const link = el("a", null, entry.name);
  link.href = `language.html?lang=${encodeURIComponent(entry.name)}`;
  name.append(link);

  const ext = el("td", "ext", entry.extensions.join(" "));
  const widths = el("td", "ext n", entry.widths.join(", "));
  const cases = el("td", "n", String(entry.cases));

  const total = el("td", "n");
  total.append(el("span", entry.divergences === 0 ? "zero" : "some", String(entry.divergences)));

  const accepted = el("td", "n zero", entry.accepted === 0 ? "—" : String(entry.accepted));
  const excluded = el("td", "n zero", entry.excluded === 0 ? "—" : String(entry.excluded));
  const open = el("td", "n");
  open.append(
    el("span", entry.needsReview === 0 ? "zero" : "some", entry.needsReview === 0 ? "—" : String(entry.needsReview)),
  );

  const bar = el("td", "bar-cell");
  const track = el("div", "bar-track");
  const fill = el("div", "bar-fill");
  const fraction = entry.cases === 0 ? 0 : entry.divergences / entry.cases;
  fill.style.width = `${(fraction * 100).toFixed(1)}%`;
  track.append(fill);
  track.title = `${entry.divergences} of ${entry.cases} cases (${(fraction * 100).toFixed(0)}%)`;
  bar.append(track);

  tr.append(name, ext, widths, cases, total, accepted, excluded, open, bar);
  return tr;
}

async function main() {
  const host = document.getElementById("table");
  let entries;
  try {
    entries = await languages();
  } catch (error) {
    host.append(
      el("p", "lede", `Could not load web/data/languages.json — run ./web/gen.py. (${error.message})`),
    );
    return;
  }

  const table = el("table", "languages");
  const head = el("thead");
  const headRow = el("tr");
  for (const [label, className] of [
    ["language", ""],
    ["ext", ""],
    ["widths", "n"],
    ["cases", "n"],
    ["diverge", "n"],
    ["accepted", "n"],
    ["excluded", "n"],
    ["open", "n"],
    ["", ""],
  ]) {
    headRow.append(el("th", className, label));
  }
  head.append(headRow);

  const body = el("tbody");
  for (const entry of entries) body.append(row(entry));

  const sum = (key) => entries.reduce((n, entry) => n + entry[key], 0);
  const foot = el("tfoot");
  const footRow = el("tr");
  footRow.append(
    el("td", null, `${entries.length} languages`),
    el("td"),
    el("td"),
    el("td", "n", String(sum("cases"))),
    el("td", "n", String(sum("divergences"))),
    el("td", "n", String(sum("accepted"))),
    el("td", "n", String(sum("excluded"))),
    el("td", "n", String(sum("needsReview"))),
    el("td"),
  );
  foot.append(footRow);

  table.append(head, body, foot);
  host.append(table);
}

main();
