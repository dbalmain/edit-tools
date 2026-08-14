"use strict";

// ---------------------------------------------------------------- Doc IR
// text/concat/group/indent/line/softline/hardline, per docs/design.md.
// `brk` marks a doc containing a hardline: any group enclosing one must break.

const text = (s) => ({ t: "text", s, brk: false });
const line = { t: "line", brk: false };
const softline = { t: "softline", brk: false };
const hardline = { t: "hardline", brk: true };

const concat = (ds) => ({ t: "concat", d: ds, brk: ds.some((x) => x.brk) });
const indent = (d) => ({ t: "indent", d, brk: d.brk });
const group = (d) => ({ t: "group", d, brk: d.brk });

function join(sep, docs) {
  const out = [];
  docs.forEach((d, i) => {
    if (i) out.push(sep);
    out.push(d);
  });
  return concat(out);
}

// ------------------------------------------------------------- the printer

const INDENT_WIDTH = 2;

function fits(remaining, ind, doc) {
  const stack = [[ind, "flat", doc]];
  let rem = remaining;
  while (stack.length) {
    if (rem < 0) return false;
    const [i, mode, d] = stack.pop();
    switch (d.t) {
      case "text":
        rem -= d.s.length;
        break;
      case "concat":
        for (let k = d.d.length - 1; k >= 0; k--) stack.push([i, mode, d.d[k]]);
        break;
      case "group":
        stack.push([i, d.brk ? "break" : "flat", d.d]);
        break;
      case "indent":
        stack.push([i + INDENT_WIDTH, mode, d.d]);
        break;
      case "line":
        if (mode === "flat") rem -= 1;
        else return true;
        break;
      case "softline":
        if (mode !== "flat") return true;
        break;
      case "hardline":
        return true;
    }
  }
  return rem >= 0;
}

function print(doc, width) {
  const out = [];
  const stack = [[0, "break", doc]];
  let pos = 0;
  const newline = (i) => {
    out.push("\n" + " ".repeat(i));
    pos = i;
  };
  while (stack.length) {
    const [i, mode, d] = stack.pop();
    switch (d.t) {
      case "text":
        out.push(d.s);
        pos += d.s.length;
        break;
      case "concat":
        for (let k = d.d.length - 1; k >= 0; k--) stack.push([i, mode, d.d[k]]);
        break;
      case "indent":
        stack.push([i + INDENT_WIDTH, mode, d.d]);
        break;
      case "group": {
        const flat = !d.brk && fits(width - pos, i, d.d);
        stack.push([i, flat ? "flat" : "break", d.d]);
        break;
      }
      case "line":
        if (mode === "flat") {
          out.push(" ");
          pos += 1;
        } else newline(i);
        break;
      case "softline":
        if (mode !== "flat") newline(i);
        break;
      case "hardline":
        newline(i);
        break;
    }
  }
  return out.join("");
}

// ------------------------------------------------------- JSON rules (dumb)

const raw = (node) =>
  "text" in node ? node.text : (node.children || []).map(raw).join("");

const isPunct = (n) => ["{", "}", "[", "]", ",", ":"].includes(n.type);

function build(node) {
  switch (node.type) {
    case "document":
      return build(node.children.find((c) => !isPunct(c)));
    case "object": {
      const pairs = node.children.filter((c) => c.type === "pair");
      if (!pairs.length) return text("{}");
      return group(
        concat([
          text("{"),
          indent(concat([line, join(concat([text(","), line]), pairs.map(build))])),
          line,
          text("}"),
        ]),
      );
    }
    case "array": {
      const items = node.children.filter((c) => !isPunct(c));
      if (!items.length) return text("[]");
      return group(
        concat([
          text("["),
          indent(
            concat([softline, join(concat([text(","), line]), items.map(build))]),
          ),
          softline,
          text("]"),
        ]),
      );
    }
    case "pair": {
      const [key, value] = node.children.filter((c) => !isPunct(c));
      return concat([text(raw(key)), text(": "), build(value)]);
    }
    default:
      return text(raw(node));
  }
}

function format(doc, width) {
  if (doc.language !== "json") {
    throw new Error(`reference submission handles json only, got ${doc.language}`);
  }
  return print(concat([build(doc.root), hardline]), width);
}

module.exports = { format, text, concat, group, indent, line, softline, hardline, print };
