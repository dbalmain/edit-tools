"use strict";
// The JavaScript runtime: package + tree -> text. Single file, no dependencies.
//
// Width is counted in Unicode scalar values throughout -- `[...s].length`,
// never `.length`, which counts UTF-16 code units and would put an astral
// character at two columns here and one in Rust.

class Refusal extends Error {}

const PACKAGE_FORMAT = "et-doc-rules/1";
const MAX_MACRO_DEPTH = 32;

function validatePackageFormat(pkg) {
  if (pkg.format !== PACKAGE_FORMAT) {
    throw new Refusal(
      `unknown package format ${JSON.stringify(pkg.format)}; expected ${JSON.stringify(PACKAGE_FORMAT)}`,
    );
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function macroIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Refusal(`\`$\` hole index must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function macroArity(value, holesAllowed) {
  if (!Array.isArray(value)) return 0;
  if (value[0] === "$") {
    if (!holesAllowed) throw new Refusal("`$` hole is only valid inside a `defs` body");
    if (value.length !== 2) {
      throw new Refusal(`\`$\` hole takes 1 operand, got ${Math.max(value.length - 1, 0)}`);
    }
    return macroIndex(value[1]) + 1;
  }
  return value.reduce((arity, part) => Math.max(arity, macroArity(part, holesAllowed)), 0);
}

function useName(value) {
  if (typeof value[1] !== "string") {
    throw new Refusal("`use` requires a definition name as its first operand");
  }
  return value[1];
}

function validateUses(value, arities) {
  if (!Array.isArray(value)) return;
  if (value[0] === "use") {
    const name = useName(value);
    if (!arities.has(name)) throw new Refusal(`unknown definition \`${name}\``);
    const expected = arities.get(name);
    const actual = Math.max(value.length - 2, 0);
    if (actual < expected) {
      throw new Refusal(
        `\`$\` hole ${expected - 1} in definition \`${name}\` is out of range for ${actual} arguments`,
      );
    }
    if (actual > expected) {
      throw new Refusal(`definition \`${name}\` expects ${expected} arguments, got ${actual}`);
    }
  }
  value.forEach((part) => validateUses(part, arities));
}

function directUses(value, names) {
  if (!Array.isArray(value)) return;
  if (value[0] === "use" && typeof value[1] === "string") names.push(value[1]);
  value.forEach((part) => directUses(part, names));
}

function validateMacroPath(name, defs, stack) {
  const at = stack.indexOf(name);
  if (at >= 0) {
    throw new Refusal(`definition cycle: ${[...stack.slice(at), name].join(" -> ")}`);
  }
  if (stack.length >= MAX_MACRO_DEPTH) {
    throw new Refusal(`definition nesting exceeds the maximum depth of ${MAX_MACRO_DEPTH}`);
  }
  stack.push(name);
  const nested = [];
  directUses(defs[name], nested);
  nested.forEach((next) => validateMacroPath(next, defs, stack));
  stack.pop();
}

function expandValue(value, defs, arities, stack, args) {
  if (!Array.isArray(value)) return value;
  if (value[0] === "$") {
    const index = macroIndex(value[1]);
    if (!args || index >= args.length) {
      throw new Refusal(`\`$\` hole ${index} is out of range outside a definition expansion`);
    }
    return args[index];
  }
  if (value[0] === "use") {
    const name = useName(value);
    const expandedArgs = value.slice(2).map((arg) => expandValue(arg, defs, arities, stack, args));
    const expected = arities.get(name);
    if (expandedArgs.length !== expected) {
      throw new Refusal(`definition \`${name}\` expects ${expected} arguments, got ${expandedArgs.length}`);
    }
    const at = stack.indexOf(name);
    if (at >= 0) {
      throw new Refusal(`definition cycle: ${[...stack.slice(at), name].join(" -> ")}`);
    }
    if (stack.length >= MAX_MACRO_DEPTH) {
      throw new Refusal(`definition nesting exceeds the maximum depth of ${MAX_MACRO_DEPTH}`);
    }
    stack.push(name);
    const expanded = expandValue(defs[name], defs, arities, stack, expandedArgs);
    stack.pop();
    return expanded;
  }
  return value.map((part) => expandValue(part, defs, arities, stack, args));
}

function literal(value) {
  if (typeof value !== "string") {
    throw new Refusal(`expected a string, got ${JSON.stringify(value)}`);
  }
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Refusal(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

function nodeTypes(value) {
  if (!Array.isArray(value)) {
    throw new Refusal(`expected a list of node types, got ${JSON.stringify(value)}`);
  }
  value.forEach(literal);
}

function validatePredicate(value) {
  if (!Array.isArray(value)) {
    throw new Refusal(`predicate must be an array, got ${JSON.stringify(value)}`);
  }
  if (value[0] === "count" && value.length === 3) {
    parseSelector(value[1]);
    count(value[2]);
    return;
  }
  if (value[0] === "child-count" && value.length === 4) {
    parseSelector(value[1]);
    parseSelector(value[2]);
    count(value[3]);
    return;
  }
  if (value[0] === "all" && value.length === 3) {
    parseSelector(value[1]);
    nodeTypes(value[2]);
    return;
  }
  throw new Refusal(`unknown predicate ${JSON.stringify(value)}`);
}

function validateExpr(value) {
  if (!Array.isArray(value)) {
    throw new Refusal(`expression must be an array, got ${JSON.stringify(value)}`);
  }
  if (value.length === 0) return;
  const [op, ...rest] = value;
  if (typeof op !== "string") {
    throw new Refusal(`opcode must be a string, got ${JSON.stringify(op)}`);
  }
  const arity = (n) => {
    if (rest.length !== n) throw new Refusal(`\`${op}\` takes ${n} operands, got ${rest.length}`);
  };
  switch (op) {
    case "seq":
    case "indent":
    case "paren":
    case "cellblock":
      rest.forEach(validateExpr);
      return;
    case "group": {
      const body = typeof rest[0] === "number" ? (parseGroupMax(rest[0]), rest.slice(1)) : rest;
      body.forEach(validateExpr);
      return;
    }
    case "line":
    case "soft":
    case "hard":
    case "sp":
    case "verbatim":
    case "srcline":
    case "srcsoft":
    case "cell":
      arity(0);
      return;
    case "child":
    case "autoparen":
      arity(1);
      parseSelector(rest[0]);
      return;
    case "tok":
      arity(1);
      literal(rest[0]);
      return;
    case "trail":
      arity(2);
      literal(rest[0]);
      parseSelector(rest[1]);
      return;
    case "srctrail":
      arity(1);
      literal(rest[0]);
      return;
    case "blank":
      if (rest.length < 1 || rest.length > 3) {
        throw new Refusal(`\`blank\` takes 1 to 3 operands, got ${rest.length}`);
      }
      count(rest[0]);
      if (rest.length === 2) nodeTypes(rest[1]);
      if (rest.length === 3) {
        nodeTypes(rest[1]);
        nodeTypes(rest[2]);
      }
      return;
    case "each":
    case "fill":
    case "opt":
      arity(2);
      parseSelector(rest[0]);
      validateExpr(rest[1]);
      return;
    case "flatten":
      arity(2);
      literal(rest[0]);
      validateExpr(rest[1]);
      return;
    case "when":
      arity(3);
      validatePredicate(rest[0]);
      validateExpr(rest[1]);
      validateExpr(rest[2]);
      return;
    default:
      throw new Refusal(`unknown opcode \`${op}\``);
  }
}

/** Expansion is work proportional to the package, not the tree, and Rust does
 *  it once in `Package::load`. Memoising keeps the same shape here without
 *  changing an entry point that takes a raw package. A throw is never cached,
 *  so a malformed package refuses every call. */
const loaded = new WeakMap();

function loadPackage(pkg) {
  const hit = loaded.get(pkg);
  if (hit !== undefined) return hit;
  const ready = buildPackage(pkg);
  loaded.set(pkg, ready);
  return ready;
}

// Whitespace-shaped header fields: a count, never a string, so no package can
// put arbitrary text in the output. `MAX_GAP` makes a typo a named error.
const MAX_GAP = 8;

function gapField(pkg, name) {
  const value = pkg[name] === undefined ? 1 : pkg[name];
  if (!Number.isInteger(value) || value < 0) {
    throw new Refusal(`\`${name}\` must be a non-negative integer, got ${value}`);
  }
  if (value > MAX_GAP) {
    throw new Refusal(`\`${name}\` is ${value}; the most allowed is ${MAX_GAP}`);
  }
  return value;
}

// Field names of a left-nested operator spine. A package that says nothing
// gets tree-sitter's usual three, which is today's behaviour exactly.
const FLATTEN_FIELD_KEYS = ["left", "operator", "right"];

function flattenFields(pkg) {
  const value = pkg.flatten_fields;
  if (value === undefined) {
    return { left: "left", operator: "operator", right: "right" };
  }
  if (!isObject(value)) {
    throw new Refusal(`\`flatten_fields\` must be an object, got ${JSON.stringify(value)}`);
  }
  const unknown = Object.keys(value)
    .filter((key) => !FLATTEN_FIELD_KEYS.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw new Refusal(`\`flatten_fields\` has unknown field \`${unknown[0]}\``);
  }
  const names = {};
  for (const key of FLATTEN_FIELD_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new Refusal(`\`flatten_fields\` is missing \`${key}\``);
    }
    const raw = value[key];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Refusal(
        `\`flatten_fields.${key}\` must be a non-empty string, got ${JSON.stringify(raw)}`,
      );
    }
    names[key] = raw;
  }
  if (names.left === names.operator || names.left === names.right || names.operator === names.right) {
    throw new Refusal("`flatten_fields` field names must be distinct");
  }
  return names;
}

function buildPackage(pkg) {
  validatePackageFormat(pkg);
  const comment_gap = gapField(pkg, "comment_gap");
  const blank_cap = gapField(pkg, "blank_cap");
  const flatten_fields = flattenFields(pkg);
  const defs = pkg.defs === undefined ? {} : pkg.defs;
  if (!isObject(defs)) throw new Refusal("`defs` must be an object");
  if (!isObject(pkg.rules)) throw new Refusal("`rules` must be an object");

  const arities = new Map();
  Object.entries(defs).forEach(([name, body]) => {
    if (!Array.isArray(body)) throw new Refusal(`definition \`${name}\` body must be an array`);
    arities.set(name, macroArity(body, true));
  });
  Object.values(pkg.rules).forEach((rule) => macroArity(rule, false));
  [...Object.values(defs), ...Object.values(pkg.rules)].forEach((body) =>
    validateUses(body, arities),
  );
  Object.keys(defs).forEach((name) => validateMacroPath(name, defs, []));

  const rules = Object.fromEntries(
    Object.entries(pkg.rules).map(([name, rule]) => {
      const expanded = expandValue(rule, defs, arities, [], undefined);
      validateExpr(expanded);
      return [name, expanded];
    }),
  );
  return { ...pkg, comment_gap, blank_cap, flatten_fields, rules };
}

// ---------------------------------------------------------------- the Doc IR

// Each node caches `brk`: does it force enclosing groups to break? A line
// suffix deliberately does not propagate -- trailing comments break their
// parent through an explicit `breakParent` instead.
const text = (s) => ({ k: "text", s, brk: false });
const concat = (parts) => ({ k: "concat", parts, brk: parts.some((p) => p.brk) });
const group = (d, max) => (max == null ? { k: "group", d, brk: d.brk } : { k: "group", d, brk: d.brk, max });

function parseGroupMax(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Refusal(`\`group\` max must be a fraction in (0, 1], got ${JSON.stringify(value)}`);
  }
  return value;
}
const indent = (unit, d) => ({ k: "indent", unit, d, brk: d.brk });
const line = { k: "line", brk: false };
const soft = { k: "soft", brk: false };
const hard = { k: "hard", brk: true };
const breakParent = { k: "breakParent", brk: true };
const nil = concat([]);
const ifBreak = (b, f) => ({ k: "ifBreak", b, f, brk: false });
const suffix = (d) => ({ k: "suffix", d, brk: false });
const cell = { k: "cell", brk: false };
const cellBreak = { k: "cellBreak", brk: false };
const fillDoc = (parts) => {
  if (parts.length === 0) return nil;
  let next = { k: "fill", content: parts.at(-1), tail: undefined, brk: parts.at(-1).brk };
  for (let i = parts.length - 2; i >= 0; i -= 2) {
    const whitespace = parts[i];
    const content = parts[i - 1];
    next = {
      k: "fill",
      content,
      tail: { whitespace, next },
      brk: content.brk || whitespace.brk || next.brk,
    };
  }
  return next;
};

const width = (s) => [...s].length;

// ----------------------------------------------------------------- the printer

const FLAT = 0;
const BREAK = 1;

/** Does `next` fit in `rem` columns, given the work still on the printer's
 *  stack? Measuring the rest of the line -- not just the group -- is what
 *  makes a trailing `)` or a trailing comment count against the budget. */
function fits(next, rest, rem, mustBeFlat = false) {
  const stack = [next];
  let restAt = rest.length;
  for (;;) {
    if (rem < 0) return false;
    let cmd = stack.pop();
    if (cmd === undefined) {
      if (restAt === 0) return true;
      cmd = rest[--restAt];
    }
    const [ind, mode, doc] = cmd;
    switch (doc.k) {
      case "text": {
        const nl = doc.s.indexOf("\n");
        rem -= width(nl < 0 ? doc.s : doc.s.slice(0, nl));
        if (nl >= 0) return rem >= 0;
        break;
      }
      case "concat":
        for (let i = doc.parts.length - 1; i >= 0; i--) stack.push([ind, mode, doc.parts[i]]);
        break;
      case "group":
        if (mustBeFlat && doc.brk) return false;
        stack.push([ind, doc.brk ? BREAK : mode, doc.d]);
        break;
      case "fill":
        if (doc.tail !== undefined) {
          stack.push([ind, mode, doc.tail.next], [ind, mode, doc.tail.whitespace]);
        }
        stack.push([ind, mode, doc.content]);
        break;
      case "indent":
        stack.push([ind + doc.unit, mode, doc.d]);
        break;
      case "line":
        if (mode === BREAK) return true;
        rem -= 1;
        break;
      case "soft":
        if (mode === BREAK) return true;
        break;
      case "hard":
        return true;
      case "ifBreak":
        stack.push([ind, mode, mode === BREAK ? doc.b : doc.f]);
        break;
      // Black counts a trailing comment against the line budget, and so do we.
      case "suffix":
        stack.push([ind, FLAT, doc.d]);
        break;
      case "cell":
      case "cellBreak":
        break;
    }
  }
}

/** Indentation is written lazily, so a blank line is genuinely empty. */
function print(doc, cols) {
  const out = [];
  let pos = 0;
  let pending = "";
  let suffixes = [];
  let stack = [["", BREAK, doc]];

  const write = (s) => {
    if (pending.length > 0) {
      out.push(pending);
      pending = "";
    }
    out.push(s);
  };

  for (;;) {
    let cmd;
    while ((cmd = stack.pop()) !== undefined) {
      const [ind, mode, d] = cmd;
      switch (d.k) {
        case "text": {
          if (d.s === "") break;
          write(d.s);
          const nl = d.s.lastIndexOf("\n");
          pos = nl < 0 ? pos + width(d.s) : width(d.s.slice(nl + 1));
          break;
        }
        case "concat":
          for (let i = d.parts.length - 1; i >= 0; i--) stack.push([ind, mode, d.parts[i]]);
          break;
        case "indent":
          stack.push([ind + d.unit, mode, d.d]);
          break;
        case "group": {
          let flat = !d.brk && fits([ind, FLAT, d.d], stack, cols - pos);
          if (flat && d.max != null) {
            flat = fits([ind, FLAT, d.d], [], Math.round(d.max * cols));
          }
          stack.push([ind, flat ? FLAT : BREAK, d.d]);
          break;
        }
        case "fill": {
          const rem = cols - pos;
          const contentFits = fits([ind, FLAT, d.content], [], rem, true);
          if (d.tail === undefined) {
            stack.push([ind, contentFits ? FLAT : BREAK, d.content]);
            break;
          }
          const bothFit = fits(
            [
              ind,
              FLAT,
              concat([d.content, d.tail.whitespace, d.tail.next.content]),
            ],
            [],
            rem,
            true,
          );
          stack.push(
            [ind, mode, d.tail.next],
            [ind, bothFit ? FLAT : BREAK, d.tail.whitespace],
            [ind, contentFits ? FLAT : BREAK, d.content],
          );
          break;
        }
        case "line":
        case "soft":
        case "hard": {
          const breaking = mode === BREAK || d.k === "hard";
          if (breaking && suffixes.length > 0) {
            stack.push(cmd, ...suffixes.reverse());
            suffixes = [];
            break;
          }
          if (breaking) {
            out.push("\n");
            pending = ind;
            pos = width(ind);
          } else if (d.k === "line") {
            write(" ");
            pos += 1;
          }
          break;
        }
        case "ifBreak":
          stack.push([ind, mode, mode === BREAK ? d.b : d.f]);
          break;
        case "suffix":
          suffixes.push([ind, BREAK, d.d]);
          break;
        case "cell":
          write("\v");
          break;
        case "cellBreak":
          if (suffixes.length > 0) {
            stack.push(cmd, ...suffixes.reverse());
            suffixes = [];
            break;
          }
          write("\f");
          break;
      }
    }
    if (suffixes.length === 0) return out.join("");
    stack = suffixes.reverse();
    suffixes = [];
  }
}

// ------------------------------------------------ cell alignment
// print() emits vertical tabs for ["cell"] and formfeeds for ["cellblock"].
// The pass aligns marked runs; outside a cellblock only a trailing comment
// cell participates.

const CELL_MARK = "\v";

function cellTabwrite(lines, at, rows, indents) {
  const columns = Math.max(0, ...rows.map((cells) => cells.length)) - 1;
  const pad = rows.map((cells) => Array(cells.length).fill(0));
  for (let c = 0; c < columns; c++) {
    let block = [];
    const close = () => {
      let wide = 0;
      for (const row of block) wide = Math.max(wide, width(rows[row][c]));
      if (wide > 0) for (const row of block) pad[row][c] = wide + 1;
      block = [];
    };
    for (let row = 0; row < rows.length; row++) {
      if (rows[row].length > c + 1) block.push(row);
      else close();
    }
    close();
  }
  rows.forEach((cells, row) => {
    let out = indents[row];
    cells.forEach((cell, c) => {
      out += cell;
      if (c + 1 < cells.length) out += " ".repeat(pad[row][c] - width(cell));
    });
    lines[at[row]] = out;
  });
}

function joinNonempty(cells) {
  return cells.filter((cell) => cell !== "").join(" ");
}

function collapseToCommentCells(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(CELL_MARK)) continue;
    let at = 0;
    while (line[at] === " " || line[at] === "\t") at++;
    const cells = line.slice(at).split(CELL_MARK);
    const last = cells[cells.length - 1] ?? "";
    const comment = last.startsWith("//") || last.startsWith("/*");
    const body = joinNonempty(comment ? cells.slice(0, -1) : cells);
    lines[i] = comment
      ? `${line.slice(0, at)}${body}${CELL_MARK}${last}`
      : `${line.slice(0, at)}${body}`;
  }
}

function alignChunk(chunk, commentOnly) {
  if (!chunk.includes(CELL_MARK)) return chunk;
  const lines = chunk.split("\n");
  if (commentOnly) collapseToCommentCells(lines);
  const parsed = lines.map((line) => {
    if (!line.includes(CELL_MARK)) return null;
    let at = 0;
    while (line[at] === " " || line[at] === "\t") at++;
    const cells = line.slice(at).split(CELL_MARK);
    const first = cells[0] ?? "";
    return {
      indent: line.slice(0, at),
      cells,
      closer: first.startsWith("}") || first.startsWith(")"),
    };
  });
  let at = [];
  let rows = [];
  let indents = [];
  const flush = () => {
    if (at.length > 0) cellTabwrite(lines, at, rows, indents);
    at = [];
    rows = [];
    indents = [];
  };
  parsed.forEach((row, i) => {
    if (row === null) {
      flush();
      return;
    }
    if (row.closer) {
      flush();
      cellTabwrite(lines, [i], [row.cells], [row.indent]);
      return;
    }
    if (at.length > 0 && indents[0] !== row.indent) flush();
    at.push(i);
    rows.push(row.cells);
    indents.push(row.indent);
  });
  flush();
  return lines.join("\n");
}

function alignCells(input) {
  if (!input.includes(CELL_MARK) && !input.includes("\f")) return input;
  return input.split("\f").map((chunk, i) => alignChunk(chunk, i % 2 === 0)).join("");
}

// ------------------------------------------------------- comment attachment

// Comments arrive as ordinary children. The runtime -- not the package --
// consumes them, by one language-independent rule: a comment alone on its line
// leads the next sibling that is not punctuation; a comment sharing a line
// with preceding code becomes a line suffix of the sibling before it; a
// comment with nothing left to lead trails the last non-punctuation sibling.
// Each is consumed exactly once and in order, so the partition the linearity
// invariant asks for still holds.

// Comment nodes are usually leaves with `text`. tree-sitter-rust's
// `line_comment` / `block_comment` are interior nodes instead (the `//`
// token is a child; the body is only in the source range). When `text`
// is missing we slice the source range and strip a trailing newline so
// a doc comment whose range includes the line ending does not emit an
// extra blank.
function commentContentEnd(fmt, node) {
  let end = node.end;
  while (end > node.start && (fmt.bytes[end - 1] === 0x0a || fmt.bytes[end - 1] === 0x0d)) {
    end--;
  }
  return end;
}

function commentText(fmt, node) {
  if (typeof node.text === "string") return node.text;
  return fmt.decoder.decode(fmt.bytes.subarray(node.start, commentContentEnd(fmt, node)));
}

function newlinesBetween(bytes, from, to) {
  let n = 0;
  for (let i = Math.max(from, 0); i < Math.min(to, bytes.length); i++) {
    if (bytes[i] === 0x0a) n++;
  }
  return n;
}

/** A node's children, split into items with every comment attached to one of
 *  them -- or, for a node that holds nothing but comments, left dangling. */
function splitChildren(fmt, node) {
  const items = [];
  let lead = [];
  let prevEnd = node.start;

  for (const child of node.children ?? []) {
    const gap = newlinesBetween(fmt.bytes, prevEnd, child.start);
    prevEnd = child.end;

    if (fmt.comments.has(child.type)) {
      const last = items[items.length - 1];
      // Suffix only when the comment shares a line with the previous
      // item's content. A node's range can include trailing trivia
      // (tree-sitter-go's statement_list swallows the newline after
      // its last statement), which would make an own-line comment
      // look adjacent if we used node.end.
      const kids = last?.node.children ?? [];
      const contentEnd = kids.length > 0 ? kids[kids.length - 1].end : last?.node.end;
      const shareLine = last && newlinesBetween(fmt.bytes, contentEnd, child.start) === 0;
      const text = commentText(fmt, child);
      if (shareLine) last.suffix.push(text);
      else lead.push({ text, blanks: Math.max(gap - 1, 0) });
      // A rust doc comment's range includes its line ending. That
      // newline belongs to the following gap, not to the comment body.
      prevEnd = commentContentEnd(fmt, child);
      continue;
    }
    // Punctuation cannot carry a leading comment: emitting it there would put
    // the comment at the wrong indent, outside the bracket it closes.
    const lineBreak = gap >= 1 || lead.length > 0;
    let take = [];
    if (!fmt.tokens.has(child.type)) {
      take = lead;
      lead = [];
    }
    items.push({
      node: child,
      lead: take,
      suffix: [],
      after: [],
      blanks: take.length > 0 ? take[0].blanks : Math.max(gap - 1, 0),
      gap: take.length > 0 ? Math.max(gap - 1, 0) : 0,
      lineBreak,
    });
  }

  const host = [...items].reverse().find((i) => !fmt.tokens.has(i.node.type));
  if (lead.length > 0 && host) host.after = lead;
  else if (lead.length > 0 && fmt.descend.has(node.type) && items.length > 0) {
    // A descend node whose only non-token children are comments
    // (a CSS `{ /* empty */ }`) has no named host. Park the comments
    // on the first token so `indent` can flush them inside the
    // brackets; prepending them as dangling would move them outside
    // the node and fail gate 3.
    items[0].after = lead;
    lead = [];
  }
  // A file that is nothing but comments is still a file.
  const trailingBlanks = Math.max(newlinesBetween(fmt.bytes, prevEnd, node.end) - 1, 0);
  return {
    items,
    dangling: lead.length > 0 && !host ? lead : [],
    trailingBlanks,
  };
}

const decorated = (item) =>
  item.lead.length > 0 || item.suffix.length > 0 || item.after.length > 0;

function decorate(fmt, item, inner) {
  if (item.lead.length === 0 && item.suffix.length === 0) return inner;
  let parts = [];
  // A comment leading a suite belongs on the first line *inside* it.
  const sink = fmt.descend.has(item.node.type);
  item.lead.forEach((comment, i) => {
    if (sink) parts.push(hard);
    if (i > 0 && comment.blanks > 0) parts.push(hard);
    parts.push(text(comment.text));
    if (!sink) parts.push(hard);
  });
  if (!sink) {
    for (let i = 0; i < Math.min(item.gap, fmt.blankCap); i++) parts.push(hard);
  }
  if (sink && parts.length > 0) parts = [indent(fmt.indentUnit, concat(parts))];
  parts.push(inner);
  const gap = " ".repeat(fmt.commentGap);
  const commentCells = fmt.pkg.comment_cells === true && !fmt.tokens.has(item.node.type);
  for (const s of item.suffix) {
    parts.push(suffix(commentCells ? concat([cell, text(s)]) : text(`${gap}${s}`)));
  }
  parts.push(breakParent);
  return concat(parts);
}

function afterDocs(fmt, comments) {
  if (comments.length === 0) return nil;
  const parts = [];
  for (const comment of comments) {
    parts.push(hard);
    for (let i = 0; i < Math.min(comment.blanks, fmt.blankCap); i++) parts.push(hard);
    parts.push(text(comment.text));
  }
  parts.push(breakParent);
  return concat(parts);
}

// ---------------------------------------------------------------- evaluation

// Rightmost spine only: a gap after a subtree that merely contains the
// spelling belongs to a later sibling, not to the token.
function endsWithLeafText(node, spellings) {
  const kids = node.children ?? [];
  if (kids.length > 0) return endsWithLeafText(kids[kids.length - 1], spellings);
  return node.text !== undefined && spellings.includes(node.text);
}

function selectorMatches(fmt, node, sel) {
  if (sel.field !== undefined) return node.field === sel.field;
  if (sel.type !== undefined) return node.type === sel.type;
  if (sel.named) return !fmt.tokens.has(node.type);
  return true;
}

function parseSelector(raw) {
  if (typeof raw !== "string") throw new Refusal(`selector must be a string, got ${raw}`);
  if (raw.startsWith("f:")) return { field: raw.slice(2) };
  if (raw.startsWith("t:")) return { type: raw.slice(2) };
  if (raw === "named") return { named: true };
  if (raw === "*") return { any: true };
  throw new Refusal(`unknown selector \`${raw}\``);
}

class Ctx {
  constructor(fmt, node) {
    this.fmt = fmt;
    this.node = node;
    const split = splitChildren(fmt, node);
    this.items = split.items;
    this.dangling = split.dangling;
    this.cursor = 0;
    this.pendingAfter = [];
    this.trailingBlanks = split.trailingBlanks;
  }

  flushAfter() {
    const comments = this.pendingAfter;
    this.pendingAfter = [];
    return afterDocs(this.fmt, comments);
  }

  flushBeforeToken() {
    if (this.pendingAfter.length === 0) return nil;
    return concat([this.flushAfter(), hard]);
  }

  matches(at, sel) {
    const item = this.items[at];
    if (!item) return false;
    if (sel.field !== undefined) return item.node.field === sel.field;
    if (sel.type !== undefined) return item.node.type === sel.type;
    if (sel.named) return !this.fmt.tokens.has(item.node.type);
    return true;
  }

  refuse(what) {
    const at = this.items[this.cursor];
    const found = at ? `\`${at.node.type}\`` : "end of children";
    return new Refusal(`rule for \`${this.node.type}\` wants ${what} but found ${found}`);
  }

  blanks() {
    const item = this.items[this.cursor];
    return item ? item.blanks : 0;
  }

  /** The separator in `each` runs *between* items and `blanks` reads the
   *  item at the cursor (the following one). A listed type on either side
   *  of the gap must open it — `def f` followed by `x = 1` needs the
   *  blanks too. */
  forcesBlank(kinds) {
    if (!kinds || kinds.length === 0 || this.cursor === 0) return false;
    const next = this.items[this.cursor];
    if (!next) return false;
    const prev = this.items[this.cursor - 1];
    return kinds.includes(prev.node.type) || kinds.includes(next.node.type);
  }

  keepsGap(spellings) {
    if (!spellings || spellings.length === 0 || this.cursor === 0) return false;
    return endsWithLeafText(this.items[this.cursor - 1].node, spellings);
  }

  /** Predicates describe the node, not the cursor: count over every child. */
  tally(sel) {
    let n = 0;
    for (let i = 0; i < this.items.length; i++) if (this.matches(i, sel)) n++;
    return n;
  }

  /** Vacuous: no `sel` child means every one of them has a listed type. */
  allKinds(sel, kinds) {
    for (let i = 0; i < this.items.length; i++) {
      if (!this.matches(i, sel)) continue;
      if (!kinds.includes(this.items[i].node.type)) return false;
    }
    return true;
  }

  eval(expr) {
    if (!Array.isArray(expr)) throw new Refusal(`expression must be an array, got ${expr}`);
    const [op, ...rest] = expr;
    switch (op) {
      case undefined:
        return nil;
      case "seq":
        return concat(rest.map((e) => this.eval(e)));
      case "group": {
        const max = typeof rest[0] === "number" ? parseGroupMax(rest[0]) : undefined;
        const body = max === undefined ? rest : rest.slice(1);
        return group(concat(body.map((e) => this.eval(e))), max);
      }
      case "indent":
        return indent(
          this.fmt.indentUnit,
          concat([...rest.map((e) => this.eval(e)), this.flushAfter()]),
        );
      case "line":
        return line;
      case "soft":
        return soft;
      case "hard":
        return hard;
      case "sp":
        return text(" ");
      case "srcline":
        return this.srcBreak(text(" "));
      case "srcsoft":
        return this.srcBreak(nil);
      case "cell":
        return cell;
      case "cellblock":
        return concat([cellBreak, ...rest.map((e) => this.eval(e)), cellBreak]);
      case "srctrail":
        return this.srctrail(rest[0]);
      case "child":
        return this.child(parseSelector(rest[0]));
      case "each":
        return this.each(parseSelector(rest[0]), rest[1]);
      case "fill":
        return this.fill(parseSelector(rest[0]), rest[1]);
      case "tok":
        return this.tok(rest[0]);
      case "verbatim":
        return this.verbatim();
      case "opt":
        return this.matches(this.cursor, parseSelector(rest[0])) ? this.eval(rest[1]) : nil;
      case "trail":
        return this.trail(rest[0], parseSelector(rest[1]));
      case "paren":
        return this.paren(rest);
      case "autoparen":
        return this.autoparen(parseSelector(rest[0]));
      case "when":
        return this.eval(this.test(rest[0]) ? rest[1] : rest[2]);
      case "flatten":
        return this.flatten(rest[0], rest[1]);
      case "blank": {
        const cap = rest[0];
        const around = rest[1];
        const keepAfter = rest[2];
        if (around !== undefined && !Array.isArray(around)) {
          throw new Refusal(`expected a list of node types, got ${around}`);
        }
        const keep = this.keepsGap(keepAfter);
        if (this.cursor === this.items.length) {
          if (keep && this.node.end === this.fmt.bytes.length) {
            this.fmt.semanticEof = true;
          }
          const blanks = keep ? this.trailingBlanks : Math.min(this.trailingBlanks, cap);
          return concat([
            this.flushAfter(),
            ...Array.from({ length: blanks }, () => hard),
          ]);
        }
        const n = keep
          ? this.blanks()
          : this.forcesBlank(around) ? cap : Math.min(this.blanks(), cap);
        return concat(Array.from({ length: n }, () => hard));
      }
      default:
        throw new Refusal(`unknown opcode \`${op}\``);
    }
  }

  test(pred) {
    if (!Array.isArray(pred)) throw new Refusal(`predicate must be an array, got ${pred}`);
    const [op, raw, childRaw, childN] = pred;
    if (op === "count") return this.tally(parseSelector(raw)) === childRaw;
    if (op === "child-count") {
      const parent = parseSelector(raw);
      const child = parseSelector(childRaw);
      let count = 0;
      for (const item of this.items) {
        if (!selectorMatches(this.fmt, item.node, parent)) continue;
        for (const node of item.node.children ?? []) {
          if (selectorMatches(this.fmt, node, child)) count++;
        }
      }
      return count === childN;
    }
    if (op === "all") return this.allKinds(parseSelector(raw), childRaw);
    throw new Refusal(`unknown predicate \`${op}\``);
  }

  take(sel, what) {
    if (!this.matches(this.cursor, sel)) throw this.refuse(what);
    return this.cursor++;
  }

  child(sel) {
    const flushed = this.flushAfter();
    const at = this.take(sel, `a child matching ${JSON.stringify(sel)}`);
    const item = this.items[at];
    const after = item.after;
    item.after = [];
    const decoratedItem = decorate(this.fmt, item, this.fmt.node(item.node));
    this.pendingAfter = after;
    return concat([flushed, decoratedItem]);
  }

  tok(want) {
    const flushed = this.flushBeforeToken();
    const item = this.items[this.cursor];
    if (!item || item.node.text !== want) throw this.refuse(`the token \`${want}\``);
    this.cursor++;
    const after = item.after;
    item.after = [];
    this.pendingAfter = after;
    return concat([flushed, decorate(this.fmt, item, text(want))]);
  }

  verbatim() {
    if (this.cursor !== 0) {
      throw this.refuse("to be the whole rule (`verbatim` takes every child)");
    }
    if (this.items.some(decorated)) throw this.refuse("no comments inside an opaque node");
    checkVerbatim(this.fmt, this.node);
    this.cursor = this.items.length;
    return this.fmt.slice(this.node);
  }

  /** The trailing-separator policy: adopt a separator the source already has
   *  -- which pins the layout open, black's magic trailing comma -- or add one
   *  when the enclosing group breaks and `sel` picks out a real list. */
  trail(sep, sel) {
    const optional = ifBreak(text(sep), nil);
    const item = this.items[this.cursor];
    // One item is not a list: black splits such a bracket without ever
    // reaching a comma, and so leaves none behind.
    if (!item || item.node.text !== sep) {
      return this.tally(sel) > 1 ? optional : nil;
    }
    this.cursor++;
    return concat([decorate(this.fmt, item, optional), breakParent]);
  }

  /** A break that mirrors the source's line structure rather than the group's
   *  fit: `flat` when the source put the next item on the same line, a hard
   *  break when it did not. */
  srcBreak(flat) {
    const item = this.items[this.cursor];
    return item && item.lineBreak ? hard : flat;
  }

  /** The trailing-separator policy for a source-driven list: adopt a separator
   *  the source has, and emit it only when the following token sits on a fresh
   *  line. gofmt strips a single-line literal's trailing comma and keeps a
   *  broken literal's. */
  srctrail(sep) {
    const at = this.cursor;
    const item = this.items[at];
    const present = item && item.node.text === sep;
    if (present) this.cursor++;
    const next = this.items[this.cursor];
    if (!(next && next.lineBreak)) {
      if (present && decorated(item)) {
        throw this.refuse("no comment on a stripped trailing separator");
      }
      return nil;
    }
    return present ? decorate(this.fmt, item, text(sep)) : text(sep);
  }

  /** The balanced-paren policy: adopt the pair the source already has, or add
   *  one when the region breaks. */
  paren(body) {
    const last = this.items.length - 1;
    const opener = this.cursor;
    const adopt =
      opener + 1 < this.items.length &&
      this.items[opener].node.text === "(" &&
      this.items[last].node.text === ")";

    let open;
    if (adopt) {
      open = this.tok("(");
    } else {
      open = ifBreak(text("("), nil);
    }
    const inner = body.map((e) => this.eval(e));
    // Keep a comment before the adopted closer inside the region's indent,
    // then let tok enforce the ordinary token boundary.
    if (adopt) inner.push(this.flushAfter());
    let close;
    if (adopt) {
      if (this.cursor !== last) throw this.refuse("the closing `)` of the region it wraps");
      close = this.tok(")");
    } else {
      close = ifBreak(text(")"), nil);
    }
    return group(concat([open, indent(this.fmt.indentUnit, concat([soft, ...inner])), soft, close]));
  }

  /** Format a child, adding optional parentheses if its type is one the
   *  package lists as needing them to break. */
  autoparen(sel) {
    if (!this.matches(this.cursor, sel)) throw this.refuse(`a child matching ${JSON.stringify(sel)}`);
    const wrap = this.fmt.optionalParens.has(this.items[this.cursor].node.type);
    const inner = this.child(sel);
    if (!wrap) return inner;
    return group(
      concat([ifBreak(text("("), nil), indent(this.fmt.indentUnit, concat([soft, inner])), soft, ifBreak(text(")"), nil)]),
    );
  }

  each(sel, sep) {
    const parts = [];
    while (this.matches(this.cursor, sel)) {
      parts.push(this.child(sel));
      let next = -1;
      for (let i = this.cursor; i < this.items.length; i++) {
        if (this.matches(i, sel)) {
          next = i;
          break;
        }
      }
      if (next < 0) break;
      parts.push(this.eval(sep));
      if (this.cursor !== next) {
        throw this.refuse("its separator to take the children between items");
      }
    }
    return concat(parts);
  }

  fill(sel, sep) {
    const parts = [];
    while (this.matches(this.cursor, sel)) {
      parts.push(this.child(sel));
      let next = -1;
      for (let i = this.cursor; i < this.items.length; i++) {
        if (this.matches(i, sel)) {
          next = i;
          break;
        }
      }
      if (next < 0) break;
      parts.push(this.eval(sep));
      if (this.cursor !== next) {
        throw this.refuse("its separator to take the children between items");
      }
    }
    return fillDoc(parts);
  }

  /** Collect a left-nested run of same-type, same-tightness operators into one
   *  flat list, so the whole chain breaks together instead of staircasing.
   *  This is the opcode a per-node fold cannot do without. */
  flatten(kind, sep) {
    const fields = this.fmt.flatten;
    const left = { field: fields.left };
    const right = { field: fields.right };

    const spine = [];
    for (let cur = this.node; ; ) {
      const next = (cur.children ?? []).find((c) => c.field === fields.left);
      if (!next || next.type !== kind || this.fmt.tightness(cur) !== this.fmt.tightness(next)) {
        break;
      }
      spine.push(next);
      cur = next;
    }
    const inner = spine.map((n) => new Ctx(this.fmt, n));

    const parts = [];
    if (inner.length === 0) {
      parts.push(this.child(left));
    } else {
      parts.push(inner[inner.length - 1].child(left));
      this.skip(left);
      for (let i = 0; i < inner.length - 1; i++) inner[i].skip(left);
    }
    for (let i = inner.length - 1; i >= 0; i--) {
      parts.push(inner[i].eval(sep), inner[i].child(right));
    }
    parts.push(this.eval(sep), this.child(right));

    for (const ctx of inner) {
      parts.push(ctx.flushAfter());
      if (ctx.cursor !== ctx.items.length) {
        throw new Refusal(`flattened \`${ctx.node.type}\` left a child unconsumed`);
      }
    }
    return concat(parts);
  }

  /** Step over a child the chain emits elsewhere. It is still consumed exactly
   *  once, so long as nothing was attached to it here. */
  skip(sel) {
    const at = this.take(sel, "the left operand of a chain");
    if (decorated(this.items[at])) {
      throw this.refuse("no comment on an operand of a flattened chain");
    }
  }
}

/** `verbatim` is the one opcode that emits source bytes nobody compared
 *  against the tree. Every other path reaches text through a real child, so
 *  the linearity invariant protects it; this walk is the equivalent for a
 *  node whose offsets may be stale. */
function checkVerbatim(fmt, node) {
  const root = node.type;
  const fail = (why) => new Refusal(`verbatim \`${root}\` ${why}`);
  const walk = (n, parent) => {
    if (n.start > n.end) throw fail("has inverted range");
    if (parent == null) {
      if (n.end > fmt.bytes.length) throw fail("runs past the source");
    } else if (n.start < parent.start || n.end > parent.end) {
      throw fail("has a descendant outside its parent");
    }
    if (n.text !== undefined) {
      const got = fmt.bytes.subarray(n.start, n.end);
      const want = new TextEncoder().encode(n.text);
      if (got.length !== want.length || !got.every((b, i) => b === want[i])) {
        throw fail("has a leaf whose text does not match the source");
      }
    }
    const kids = n.children ?? [];
    let prevEnd;
    for (const child of kids) {
      if (prevEnd !== undefined && prevEnd > child.start) {
        throw fail("has overlapping siblings");
      }
      prevEnd = child.end;
      walk(child, n);
    }
  };
  walk(node, null);
}

function packageFor(language, packages) {
  const pkg = packages.get(language);
  if (pkg === undefined) throw new Refusal(`no package for language \`${language}\``);
  return pkg;
}

class Formatter {
  constructor(packages, language, bytes, decoder) {
    this.pkg = loadPackage(packageFor(language, packages));
    this.packages = packages;
    this.bytes = bytes;
    this.decoder = decoder;
    this.tokens = new Set(this.pkg.tokens ?? []);
    this.comments = new Set(this.pkg.comments ?? []);
    this.descend = new Set(this.pkg.descend ?? []);
    this.optionalParens = new Set(this.pkg.optional_parens ?? []);
    this.precedence = this.pkg.precedence ?? {};
    this.commentGap = this.pkg.comment_gap;
    this.blankCap = this.pkg.blank_cap;
    this.flatten = this.pkg.flatten_fields;
    this.semanticEof = false;
    this.indentUnit = this.pkg.tab_indent ? "\t" : " ".repeat(this.pkg.indent ?? 0);
  }

  tightness(node) {
    const op = (node.children ?? []).find((c) => c.field === this.flatten.operator);
    return (op && this.precedence[op.text]) ?? 0;
  }

  slice(node) {
    return text(this.decoder.decode(this.bytes.subarray(node.start, node.end)));
  }

  node(node) {
    if (node.language !== undefined) {
      return new Formatter(this.packages, node.language, this.bytes, this.decoder).nodeCurrent(node);
    }
    return this.nodeCurrent(node);
  }

  nodeCurrent(node) {
    if (node.text !== undefined) return text(node.text);
    const rule = this.pkg.rules[node.type];
    if (!rule) throw new Refusal(`package has no rule for node type \`${node.type}\``);
    const ctx = new Ctx(this, node);
    let doc = concat([ctx.eval(rule), ctx.flushAfter()]);
    if (ctx.dangling.length > 0) {
      const parts = [];
      ctx.dangling.forEach((comment, i) => {
        if (i > 0) for (let n = 0; n < Math.min(comment.blanks, this.blankCap); n++) parts.push(hard);
        parts.push(text(comment.text), hard);
      });
      doc = concat([...parts, doc]);
    }
    if (ctx.cursor !== ctx.items.length) {
      throw new Refusal(
        `rule for \`${node.type}\` left child \`${ctx.items[ctx.cursor].node.type}\` unconsumed`,
      );
    }
    return doc;
  }
}

/** Format a corpus tree. Throws `Refusal` rather than guessing. */
function format(tree, packages, cols) {
  const bytes = new TextEncoder().encode(tree.source ?? "");
  const fmt = new Formatter(packages, tree.language, bytes, new TextDecoder());
  let out = print(fmt.node(tree.root), cols);
  out = alignCells(out);
  if (fmt.semanticEof) {
    const suffix = (tree.source ?? "").match(/(?:\r\n|\r|\n)+$/)?.[0] ?? "";
    return `${out.replace(/[\r\n]+$/, "")}${suffix}`;
  }
  return `${out.replace(/\n+$/, "")}\n`;
}

module.exports = { format, Refusal };
