"use strict";

const fs = require("fs");
const path = require("path");

const scalarWidth = (value) => [...value].length;
const text = (value) => ({ kind: "text", value, breaks: false });
const verbatim = (value) => ({
  kind: "verbatim",
  value,
  breaks: value.includes("\n"),
});
const line = { kind: "line", breaks: false };
const softline = { kind: "softline", breaks: false };
const hardline = { kind: "hardline", breaks: true };
const concat = (parts) => ({
  kind: "concat",
  parts,
  breaks: parts.some((part) => part.breaks),
});
const indent = (doc) => ({ kind: "indent", doc, breaks: doc.breaks });
const group = (doc, force = false, reserve = 0) => ({
  kind: "group",
  doc,
  force,
  reserve,
  breaks: force || doc.breaks,
});

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
      case "verbatim":
        if (current.value.includes("\n")) return true;
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
        stack.push([
          column,
          current.force || current.doc.breaks ? "break" : "flat",
          current.doc,
        ]);
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
      case "verbatim": {
        output.push(current.value);
        const lines = current.value.split("\n");
        position = lines.length === 1
          ? position + scalarWidth(current.value)
          : scalarWidth(lines.at(-1));
        break;
      }
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
          !current.force &&
          !current.doc.breaks &&
          fits(width - position - current.reserve, column, current.doc, indentWidth);
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

function validateSubtree(node, sourceBytes) {
  if (!Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end)) {
    throw new Error(`${node.type}: invalid source range`);
  }
  if (node.start < 0 || node.end < node.start || node.end > sourceBytes.length) {
    throw new Error(`${node.type}: source range is out of bounds`);
  }
  if (Object.prototype.hasOwnProperty.call(node, "text")) {
    if (sourceBytes.subarray(node.start, node.end).toString("utf8") !== node.text) {
      throw new Error(`${node.type}: leaf text differs from source`);
    }
    return;
  }
  let previousEnd = node.start;
  for (const child of node.children || []) {
    if (child.start < previousEnd || child.end > node.end) {
      throw new Error(`${node.type}: children are reordered or overlap`);
    }
    validateSubtree(child, sourceBytes);
    previousEnd = child.end;
  }
}

function sourceSlice(sourceBytes, start, end, context) {
  if (start < 0 || end < start || end > sourceBytes.length) {
    throw new Error(`${context}: source gap is out of bounds`);
  }
  return verbatim(sourceBytes.subarray(start, end).toString("utf8"));
}

function build(node, rules, sourceBytes) {
  if (Object.prototype.hasOwnProperty.call(node, "text")) {
    validateSubtree(node, sourceBytes);
    return text(node.text);
  }
  const children = node.children || [];
  const rule = rules[node.type];
  if (!rule) throw new Error(`no rule for interior node ${node.type}`);

  if (rule.layout === "verbatim") {
    validateSubtree(node, sourceBytes);
    return verbatim(sourceBytes.subarray(node.start, node.end).toString("utf8"));
  }
  if (rule.layout === "source") {
    validateSubtree(node, sourceBytes);
    const parts = [];
    let cursor = node.start;
    for (const child of children) {
      parts.push(sourceSlice(sourceBytes, cursor, child.start, node.type));
      parts.push(build(child, rules, sourceBytes));
      cursor = child.end;
    }
    parts.push(sourceSlice(sourceBytes, cursor, node.end, node.type));
    return concat(parts);
  }

  if (rule.layout === "tight") {
    return concat(children.map((child) => build(child, rules, sourceBytes)));
  }
  if (rule.layout === "sequence") {
    if (rule.gaps.length + 1 !== children.length) {
      throw new Error(`${node.type}: gaps do not partition direct children`);
    }
    const parts = [];
    children.forEach((child, index) => {
      if (index) parts.push(gap(rule.gaps[index - 1]));
      parts.push(build(child, rules, sourceBytes));
    });
    return concat(parts);
  }
  if (rule.layout === "delimited") {
    if (children.length < 2) throw new Error(`${node.type}: missing delimiters`);
    if (children[0].text !== rule.open || children.at(-1).text !== rule.close) {
      throw new Error(`${node.type}: delimiter mismatch`);
    }
    const items = [];
    const hasTrailing = children.at(-2)?.text === rule.separator;
    if (hasTrailing && !rule.preserveTrailing) {
      throw new Error(`${node.type}: trailing separator is not allowed`);
    }
    const contentEnd = children.length - 1 - (hasTrailing ? 1 : 0);
    let index = 1;
    while (index < contentEnd) {
      if (rule.itemsVerbatim) {
        validateSubtree(children[index], sourceBytes);
        items.push(
          sourceSlice(
            sourceBytes,
            children[index].start,
            children[index].end,
            node.type,
          ),
        );
      } else {
        items.push(build(children[index], rules, sourceBytes));
      }
      index += 1;
      if (index < contentEnd) {
        if (children[index].text !== rule.separator) {
          throw new Error(`${node.type}: expected separator at child ${index}`);
        }
        index += 1;
      }
    }
    if (index !== contentEnd) {
      throw new Error(`${node.type}: children are not a delimited partition`);
    }
    if (!items.length) return text(rule.open + rule.close);
    const edge = gap(rule.edge);
    let itemDoc = separated(items, () => concat([text(rule.separator), line]));
    if (rule.independentItems) {
      itemDoc = group(itemDoc, hasTrailing && rule.forceTrailing);
    }
    if (hasTrailing) itemDoc = concat([itemDoc, text(rule.separator)]);
    let reserve = 0;
    if (rule.reserveLineSuffix) {
      const suffix = sourceBytes.subarray(node.end).toString("utf8").split("\n", 1)[0];
      reserve = scalarWidth(suffix);
    }
    return group(
      concat([
        text(rule.open),
        indent(concat([edge, itemDoc])),
        edge,
        text(rule.close),
      ]),
      hasTrailing && rule.forceTrailing,
      reserve,
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
  if (typeof tree.source !== "string") throw new Error("tree has no source text");
  const body = build(
    tree.root,
    languagePackage.rules,
    Buffer.from(tree.source, "utf8"),
  );
  const document = languagePackage.style.finalNewline
    ? concat([body, hardline])
    : body;
  return render(document, width, languagePackage.style.indent);
}

module.exports = { format };
