"use strict";

const FORMAT = "et-highlight/1";

class Refusal extends Error {}

function strings(value, name, required = false) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Refusal(`\`${name}\` must be a list of strings`);
  }
  return value;
}

function loadPackage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Refusal("highlight package must be an object");
  }
  if (raw.format !== FORMAT) {
    throw new Refusal(`unknown package format ${JSON.stringify(raw.format)}; expected "${FORMAT}"`);
  }

  const scopes = new Set(strings(raw.scopes, "scopes", true));
  for (const scope of scopes) {
    const dot = scope.lastIndexOf(".");
    if (dot !== -1 && !scopes.has(scope.slice(0, dot))) {
      throw new Refusal(
        `dotted scope \`${scope}\` requires prefix \`${scope.slice(0, dot)}\` in \`scopes\``,
      );
    }
  }

  if (raw.leaf !== undefined && (!raw.leaf || typeof raw.leaf !== "object" || Array.isArray(raw.leaf))) {
    throw new Refusal("`leaf` must be an object");
  }
  const leaf = Object.create(null);
  for (const [kind, scope] of Object.entries(raw.leaf || {})) {
    if (typeof scope !== "string") throw new Refusal(`scope for leaf \`${kind}\` must be a string`);
    leaf[kind] = scope;
  }
  for (const [scope, name] of [
    ["keyword", "keyword"],
    ["operator", "operator"],
    ["punctuation", "punctuation"],
  ]) {
    for (const kind of strings(raw[name], name)) leaf[kind] = scope;
  }

  if (raw.context !== undefined && !Array.isArray(raw.context)) {
    throw new Refusal("`context` must be a list");
  }
  const keys = ["parent", "field", "parent_field", "type", "ancestor"];
  const context = (raw.context || []).map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Refusal(`context row ${index} must be an object`);
    }
    if (typeof source.scope !== "string") {
      throw new Refusal(`scope for context row ${index} must be a string`);
    }
    const rule = { scope: source.scope };
    for (const key of keys) {
      if (source[key] !== undefined) {
        if (typeof source[key] !== "string") {
          throw new Refusal(`\`${key}\` in context row ${index} must be a string`);
        }
        rule[key] = source[key];
      }
    }
    return rule;
  });

  for (const scope of [...Object.values(leaf), ...context.map((rule) => rule.scope)]) {
    if (!scopes.has(scope)) throw new Refusal(`emitted scope \`${scope}\` is not in \`scopes\``);
  }
  return { scopes, leaf, context };
}

function highlight(tree, pkg) {
  const spans = [];
  const ancestors = [];

  const emit = (start, end, scope) => {
    if (start < end) spans.push({ start, end, scope });
  };

  const matches = (rule, node, parent) => {
    if (rule.parent !== undefined && rule.parent !== parent?.type) return false;
    if (rule.field !== undefined && rule.field !== node.field) return false;
    if (rule.parent_field !== undefined && rule.parent_field !== parent?.field) return false;
    if (rule.type !== undefined && rule.type !== node.type) return false;
    return rule.ancestor === undefined || ancestors.some((item) => item.type === rule.ancestor);
  };

  const visit = (node, parent) => {
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0) {
      if (node.type === "ERROR" || node.type === "MISSING") {
        emit(node.start, node.end, "error");
        return;
      }
      const contextual = pkg.context.find((rule) => matches(rule, node, parent));
      const scope = contextual?.scope ?? pkg.leaf[node.type];
      if (scope !== undefined) emit(node.start, node.end, scope);
      return;
    }

    ancestors.push(node);
    for (const child of children) visit(child, node);
    ancestors.pop();

    // An interior default is a background whose direct children refine it.
    // Python uses this for string_content around escape_sequence children.
    const background = node.type === "ERROR" ? "error" : pkg.leaf[node.type];
    if (background !== undefined && node.start < node.end) {
      const covered = children
        .map((child) => [Math.max(child.start, node.start), Math.min(child.end, node.end)])
        .filter(([start, end]) => start < end)
        .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
      let cursor = node.start;
      for (const [start, end] of covered) {
        emit(cursor, start, background);
        cursor = Math.max(cursor, end);
      }
      emit(cursor, node.end, background);
    }
  };

  visit(tree.root, undefined);
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && previous.end === span.start && previous.scope === span.scope) {
      previous.end = span.end;
    } else {
      merged.push(span);
    }
  }
  return merged;
}

module.exports = { highlight, loadPackage, Refusal };
