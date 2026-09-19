// One language's discrepancies, as a list plus a pair of panes.
//
// The left pane holds **our formatter's output**, which is Q2's answer and
// determines almost everything else here. The consequences are worth naming,
// because each one is a thing the other option would have made harder:
//
//   * The divergence is on screen with no keystroke, and scrolling the list is
//     the primary gesture. That is what the app is for -- "in most cases, I'm
//     not going to enter the editor at all."
//   * A page load fetches no parse table. `gen.py` pre-computed both texts, so
//     nothing here needs a parser until the first `:w`, and a 7 MB blob is
//     never paid for by a visit that only reads.
//   * "Refresh" restores what the pane held on load, which is our output --
//     not the raw corpus source. The raw source is still reachable, under the
//     `source` button, because editing it is how you find out whether a
//     formatting difference is ours or the input's.
//
// The right pane is the reference formatter's output, frozen, never
// re-rendered. That is what "correctly formatted" means in this app.

import { casesFor, language, formatText, Refusal } from "./lang.js";
import { VimEditor } from "./editor.js";

const params = new URLSearchParams(location.search);
const NAME = params.get("lang") ?? "rust";

const listHost = document.querySelector(".entries");
const caseEl = document.getElementById("case");
const rightEl = document.getElementById("right");
const rightLabel = document.getElementById("right-label");
const verdictEl = document.getElementById("verdict");
const diffButton = document.getElementById("toggle-diff");
const refreshButton = document.getElementById("refresh");

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = { entry: null, cases: [], current: null, showDiff: false, editor: null };

/** Where `:w` leaves a buffer, per the spec: the session, never disk. */
const sessionKey = (id) => `editor-tools:buffer:${id}`;

function renderDiff(text) {
  rightEl.textContent = "";
  for (const line of text.split("\n")) {
    const kind = line.startsWith("+")
      ? "add"
      : line.startsWith("-")
        ? "del"
        : line.startsWith("@@")
          ? "hunk"
          : null;
    rightEl.append(kind ? el("span", kind, line + "\n") : document.createTextNode(line + "\n"));
  }
}

function showRight() {
  const item = state.current;
  if (!item) return;
  if (state.showDiff) {
    rightLabel.textContent = "diff · reference → ours";
    renderDiff(item.diff);
  } else {
    rightLabel.textContent = `reference · ${state.entry.reference ?? "reference formatter"}`;
    rightEl.textContent = item.reference;
  }
}

function showVerdict() {
  const item = state.current;
  verdictEl.textContent = "";
  if (item?.excluded) {
    // Not a verdict: this file is outside the scorer's denominator entirely, so
    // it has no ledger entry and is not waiting for one.
    verdictEl.hidden = false;
    verdictEl.append(el("b", null, "excluded"), document.createTextNode(` — ${item.excluded}`));
    return;
  }
  const review = item?.review;
  if (!review) {
    verdictEl.hidden = true;
    return;
  }
  verdictEl.hidden = false;
  verdictEl.append(
    el("b", null, review.verdict),
    document.createTextNode(` — ${review.reason} `),
    el("span", "hint", `${review.reviewed_by}, ${review.reviewed_at.slice(0, 10)}`),
  );
}

function select(item) {
  state.current = item;
  caseEl.textContent = `${item.file} @ ${item.width}`;
  for (const button of listHost.querySelectorAll("button")) {
    button.setAttribute("aria-current", String(button.dataset.id === item.id));
  }
  const saved = sessionStorage.getItem(sessionKey(item.id));
  state.editor.setText(saved ?? item.ours);
  state.editor.options.indent = state.entry.indent ?? 4;
  showRight();
  showVerdict();
  const qs = new URLSearchParams(location.search);
  qs.set("lang", NAME);
  qs.set("case", item.id);
  history.replaceState(null, "", `?${qs}`);
}

function renderList() {
  listHost.textContent = "";
  if (state.cases.length === 0) {
    listHost.append(
      el("div", "empty", `${NAME} agrees with its reference formatter on every corpus case.`),
    );
    return;
  }
  const list = el("ol");
  for (const item of state.cases) {
    const li = el("li");
    const button = el("button");
    button.dataset.id = item.id;
    button.append(el("div", "file", item.file));
    const meta = el("div", "meta");
    meta.append(
      el("span", null, `@${item.width}`),
      el(
        "span",
        item.state === "open" || item.state === "unreviewed" || item.state === "stale"
          ? "verdict-open"
          : "verdict-accepted",
        item.state === "accepted" ? (item.review?.verdict ?? "accepted") : item.state,
      ),
    );
    button.append(meta);
    button.addEventListener("click", () => select(item));
    li.append(button);
    list.append(li);
  }
  listHost.append(list);
}

async function main() {
  document.getElementById("crumb-lang").textContent = NAME;
  document.title = `${NAME} discrepancies`;

  let entry, cases;
  try {
    [entry, cases] = await Promise.all([language(NAME), casesFor(NAME)]);
  } catch (error) {
    listHost.textContent = "";
    listHost.append(el("div", "empty", `Could not load ${NAME} — run ./web/gen.py. (${error.message})`));
    return;
  }
  if (!entry) {
    listHost.textContent = "";
    listHost.append(el("div", "empty", `No language called ${NAME}.`));
    return;
  }
  state.entry = entry;
  state.cases = cases;

  state.editor = new VimEditor(document.getElementById("editor"), {
    language: NAME,
    indent: entry.indent ?? 4,
    lineComment: entry.lineComment,
    // The width the case was scored at, so `:w` reproduces the scorer's run
    // rather than a prettier-looking one.
    format: async (text) => {
      const width = state.current?.width ?? entry.widths[0];
      try {
        return await formatText(text, NAME, width);
      } catch (error) {
        throw error instanceof Refusal
          ? new Error(`refused: ${error.message}`)
          : new Error(`parse or format failed: ${error.message}`);
      }
    },
    onWrite: (text) => {
      if (state.current) sessionStorage.setItem(sessionKey(state.current.id), text);
    },
  });

  renderList();
  const wanted = params.get("case");
  select(cases.find((item) => item.id === wanted) ?? cases[0] ?? null);
  if (!state.current) caseEl.textContent = "no discrepancies";

  diffButton.addEventListener("click", () => {
    state.showDiff = !state.showDiff;
    diffButton.setAttribute("aria-pressed", String(state.showDiff));
    showRight();
  });

  // Two restore points, because they answer different questions. "refresh"
  // puts back what the pane held on load, which is our output; "source" puts
  // back the corpus file, which is what you edit to ask whether the difference
  // comes from us or from the input.
  const sourceButton = el("button", "action", "source");
  sourceButton.title = "load the raw corpus file instead of our output";
  sourceButton.addEventListener("click", () => {
    if (!state.current) return;
    state.editor.setText(state.current.source);
    state.editor.focus();
  });
  refreshButton.before(sourceButton);

  refreshButton.addEventListener("click", () => {
    if (!state.current) return;
    sessionStorage.removeItem(sessionKey(state.current.id));
    state.editor.setText(state.current.ours);
    state.editor.focus();
  });

  state.editor.focus();
}

main();
