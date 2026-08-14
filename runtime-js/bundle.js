"use strict";

const fs = require("fs");
const path = require("path");

const scalarWidth = (value) => [...value].length;
const text = (value) => ({ kind: "text", value, breaks: false });
const line = { kind: "line", breaks: false };
const softline = { kind: "softline", breaks: false };
const hardline = { kind: "hardline", breaks: true };
const concat = (parts) => ({
  kind: "concat",
  parts,
  breaks: parts.some((part) => part.breaks),
});
const indent = (doc) => ({ kind: "indent", doc, breaks: doc.breaks });
const group = (doc) => ({ kind: "group", doc, breaks: doc.breaks });

function separated(docs, separator) {
  const parts = [];
  for (const doc of docs) {
    if (parts.length) parts.push(separator());
    parts.push(doc);
  }
  return concat(parts);
}

function fits(remaining, initialIndent, doc, indentWidth) {
  const stack = [[initialIndent, "flat", doc]];
  let room = remaining;
  while (stack.length) {
    if (room < 0) return false;
    const [column, mode, current] = stack.pop();
    switch (current.kind) {
      case "text":
        room -= scalarWidth(current.value);
        break;
      case "concat":
        for (let i = current.parts.length - 1; i >= 0; i--) {
          stack.push([column, mode, current.parts[i]]);
        }
        break;
      case "indent":
        stack.push([column + indentWidth, mode, current.doc]);
        break;
      case "group":
        stack.push([column, current.doc.breaks ? "break" : "flat", current.doc]);
        break;
      case "line":
        if (mode === "flat") room -= 1;
        else return true;
        break;
      case "softline":
        if (mode !== "flat") return true;
        break;
      case "hardline":
        return true;
      default:
        throw new Error(`unknown Doc kind ${current.kind}`);
    }
  }
  return room >= 0;
}

function render(doc, width, indentWidth) {
  const output = [];
  const stack = [[0, "break", doc]];
  let position = 0;
  const newline = (column) => {
    output.push(`\n${" ".repeat(column)}`);
    position = column;
  };

  while (stack.length) {
    const [column, mode, current] = stack.pop();
    switch (current.kind) {
      case "text":
        output.push(current.value);
        position += scalarWidth(current.value);
        break;
      case "concat":
        for (let i = current.parts.length - 1; i >= 0; i--) {
          stack.push([column, mode, current.parts[i]]);
        }
        break;
      case "indent":
        stack.push([column + indentWidth, mode, current.doc]);
        break;
      case "group": {
        const flat =
          !current.doc.breaks &&
          fits(width - position, column, current.doc, indentWidth);
        stack.push([column, flat ? "flat" : "break", current.doc]);
        break;
      }
      case "line":
        if (mode === "flat") {
          output.push(" ");
          position += 1;
        } else newline(column);
        break;
      case "softline":
        if (mode !== "flat") newline(column);
        break;
      case "hardline":
        newline(column);
        break;
      default:
        throw new Error(`unknown Doc kind ${current.kind}`);
    }
  }
  return output.join("");
}

function gap(name) {
  switch (name) {
    case "none":
      return text("");
    case "space":
      return text(" ");
    case "line":
      return line;
    case "softline":
      return softline;
    case "hardline":
      return hardline;
    default:
      throw new Error(`unknown gap ${name}`);
  }
}

function build(node, rules) {
  if (Object.prototype.hasOwnProperty.call(node, "text")) return text(node.text);
  const children = node.children || [];
  const rule = rules[node.type];
  if (!rule) throw new Error(`no rule for interior node ${node.type}`);

  if (rule.layout === "tight") {
    return concat(children.map((child) => build(child, rules)));
  }
  if (rule.layout === "sequence") {
    if (rule.gaps.length + 1 !== children.length) {
      throw new Error(`${node.type}: gaps do not partition direct children`);
    }
    const parts = [];
    children.forEach((child, index) => {
      if (index) parts.push(gap(rule.gaps[index - 1]));
      parts.push(build(child, rules));
    });
    return concat(parts);
  }
  if (rule.layout === "delimited") {
    if (children.length < 2) throw new Error(`${node.type}: missing delimiters`);
    if (children[0].text !== rule.open || children.at(-1).text !== rule.close) {
      throw new Error(`${node.type}: delimiter mismatch`);
    }
    const items = [];
    let index = 1;
    while (index < children.length - 1) {
      items.push(build(children[index], rules));
      index += 1;
      if (index < children.length - 1) {
        if (children[index].text !== rule.separator) {
          throw new Error(`${node.type}: expected separator at child ${index}`);
        }
        index += 1;
      }
    }
    if (!items.length) return text(rule.open + rule.close);
    const edge = gap(rule.edge);
    return group(
      concat([
        text(rule.open),
        indent(concat([edge, separated(items, () => concat([text(rule.separator), line]))])),
        edge,
        text(rule.close),
      ]),
    );
  }
  throw new Error(`unknown layout ${rule.layout}`);
}

function format(tree, width) {
  const packagePath = path.join(__dirname, "..", "packages", `${tree.language}.json`);
  const languagePackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (languagePackage.format !== "et-linear-layout/1") {
    throw new Error("unsupported package format");
  }
  if (languagePackage.language !== tree.language) {
    throw new Error("tree and package languages differ");
  }
  const body = build(tree.root, languagePackage.rules);
  const document = languagePackage.style.finalNewline
    ? concat([body, hardline])
    : body;
  return render(document, width, languagePackage.style.indent);
}

module.exports = { format };

