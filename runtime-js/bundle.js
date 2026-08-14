"use strict";
// The JavaScript runtime: package + tree -> text. Single file, no dependencies.
//
// Width is counted in Unicode scalar values throughout -- `[...s].length`,
// never `.length`, which counts UTF-16 code units and would put an astral
// character at two columns here and one in Rust.

class Refusal extends Error {}

// ---------------------------------------------------------------- the Doc IR

// Each node caches `brk`: does it force enclosing groups to break? A line
// suffix deliberately does not propagate -- trailing comments break their
// parent through an explicit `breakParent` instead.
const text = (s) => ({ k: "text", s, brk: false });
const concat = (parts) => ({ k: "concat", parts, brk: parts.some((p) => p.brk) });
const group = (d) => ({ k: "group", d, brk: d.brk });
const indent = (d) => ({ k: "indent", d, brk: d.brk });
const line = { k: "line", brk: false };
const soft = { k: "soft", brk: false };
const hard = { k: "hard", brk: true };
const breakParent = { k: "breakParent", brk: true };
const nil = concat([]);
const ifBreak = (b, f) => ({ k: "ifBreak", b, f, brk: false });
const suffix = (d) => ({ k: "suffix", d, brk: false });

const width = (s) => [...s].length;

// ----------------------------------------------------------------- the printer

const FLAT = 0;
const BREAK = 1;

/** Does `next` fit in `rem` columns, given the work still on the printer's
 *  stack? Measuring the rest of the line -- not just the group -- is what
 *  makes a trailing `)` or a trailing comment count against the budget. */
function fits(next, rest, rem, tab) {
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
        stack.push([ind, doc.brk ? BREAK : mode, doc.d]);
        break;
      case "indent":
        stack.push([ind + tab, mode, doc.d]);
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
    }
  }
}

/** Indentation is written lazily, so a blank line is genuinely empty. */
function print(doc, cols, tab) {
  const out = [];
  let pos = 0;
  let pending = 0;
  let suffixes = [];
  let stack = [[0, BREAK, doc]];

  const write = (s) => {
    if (pending > 0) {
      out.push(" ".repeat(pending));
      pending = 0;
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
          stack.push([ind + tab, mode, d.d]);
          break;
        case "group": {
          const flat = !d.brk && fits([ind, FLAT, d.d], stack, cols - pos, tab);
          stack.push([ind, flat ? FLAT : BREAK, d.d]);
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
            pos = ind;
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
      }
    }
    if (suffixes.length === 0) return out.join("");
    stack = suffixes.reverse();
    suffixes = [];
  }
}

// ------------------------------------------------------- comment attachment

// Comments arrive as ordinary children. The runtime -- not the package --
// consumes them, by one language-independent rule: a comment alone on its line
// leads the next sibling that is not punctuation; a comment sharing a line
// with preceding code becomes a line suffix of the sibling before it; a
// comment with nothing left to lead trails the last non-punctuation sibling.
// Each is consumed exactly once and in order, so the partition the linearity
// invariant asks for still holds.

function newlinesBetween(bytes, from, to) {
  let n = 0;
  for (let i = Math.max(from, 0); i < Math.min(to, bytes.length); i++) {
    if (bytes[i] === 0x0a) n++;
  }
  return n;
}

function splitChildren(fmt, node) {
  const items = [];
  let lead = [];
  let prevEnd = node.start;

  for (const child of node.children ?? []) {
    const gap = newlinesBetween(fmt.bytes, prevEnd, child.start);
    prevEnd = child.end;

    if (fmt.comments.has(child.type)) {
      const last = items[items.length - 1];
      if (last && gap === 0) last.suffix.push(child.text);
      else lead.push({ text: child.text, blanks: Math.max(gap - 1, 0) });
      continue;
    }
    // Punctuation cannot carry a leading comment: emitting it there would put
    // the comment at the wrong indent, outside the bracket it closes.
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
      // Blank lines between the last leading comment and the item itself.
      gap: take.length > 0 ? Math.max(gap - 1, 0) : 0,
    });
  }

  if (lead.length > 0) {
    const host = [...items].reverse().find((i) => !fmt.tokens.has(i.node.type));
    if (!host) {
      throw new Refusal(`\`${node.type}\` holds nothing but comments; nowhere to attach them`);
    }
    host.after = lead;
  }
  return items;
}

const decorated = (item) =>
  item.lead.length > 0 || item.suffix.length > 0 || item.after.length > 0;

function decorate(fmt, item, inner) {
  if (!decorated(item)) return inner;
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
    for (let i = 0; i < Math.min(item.gap, 2); i++) parts.push(hard);
  }
  if (sink && parts.length > 0) parts = [indent(concat(parts))];
  parts.push(inner);
  for (const s of item.suffix) parts.push(suffix(text(`  ${s}`)));
  for (const comment of item.after) {
    parts.push(hard);
    for (let i = 0; i < Math.min(comment.blanks, 2); i++) parts.push(hard);
    parts.push(text(comment.text));
  }
  parts.push(breakParent);
  return concat(parts);
}

// ---------------------------------------------------------------- evaluation

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
    this.items = splitChildren(fmt, node);
    this.cursor = 0;
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

  /** Predicates describe the node, not the cursor: count over every child. */
  tally(sel) {
    let n = 0;
    for (let i = 0; i < this.items.length; i++) if (this.matches(i, sel)) n++;
    return n;
  }

  eval(expr) {
    if (!Array.isArray(expr)) throw new Refusal(`expression must be an array, got ${expr}`);
    const [op, ...rest] = expr;
    switch (op) {
      case undefined:
        return nil;
      case "seq":
        return concat(rest.map((e) => this.eval(e)));
      case "group":
        return group(concat(rest.map((e) => this.eval(e))));
      case "indent":
        return indent(concat(rest.map((e) => this.eval(e))));
      case "line":
        return line;
      case "soft":
        return soft;
      case "hard":
        return hard;
      case "sp":
        return text(" ");
      case "child":
        return this.child(parseSelector(rest[0]));
      case "each":
        return this.each(parseSelector(rest[0]), rest[1]);
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
        const item = this.items[this.cursor];
        const n = Math.min(item ? item.blanks : 0, rest[0]);
        return concat(Array.from({ length: n }, () => hard));
      }
      default:
        throw new Refusal(`unknown opcode \`${op}\``);
    }
  }

  test(pred) {
    if (!Array.isArray(pred)) throw new Refusal(`predicate must be an array, got ${pred}`);
    const [op, raw, n] = pred;
    switch (op) {
      case "count":
        return this.tally(parseSelector(raw)) === n;
      case "count>":
        return this.tally(parseSelector(raw)) > n;
      case "has":
        return this.tally(parseSelector(raw)) > 0;
      default:
        throw new Refusal(`unknown predicate \`${op}\``);
    }
  }

  take(sel, what) {
    if (!this.matches(this.cursor, sel)) throw this.refuse(what);
    return this.cursor++;
  }

  child(sel) {
    const at = this.take(sel, `a child matching ${JSON.stringify(sel)}`);
    const item = this.items[at];
    return decorate(this.fmt, item, this.fmt.node(item.node));
  }

  tok(want) {
    const item = this.items[this.cursor];
    if (!item || item.node.text !== want) throw this.refuse(`the token \`${want}\``);
    this.cursor++;
    return decorate(this.fmt, item, text(want));
  }

  verbatim() {
    if (this.cursor !== 0) {
      throw this.refuse("to be the whole rule (`verbatim` takes every child)");
    }
    if (this.items.some(decorated)) throw this.refuse("no comments inside an opaque node");
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
    if (!item || item.node.text !== sep) return this.tally(sel) > 1 ? optional : nil;
    this.cursor++;
    return concat([decorate(this.fmt, item, optional), breakParent]);
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
      this.cursor++;
      open = decorate(this.fmt, this.items[opener], text("("));
    } else {
      open = ifBreak(text("("), nil);
    }
    const inner = concat(body.map((e) => this.eval(e)));
    let close;
    if (adopt) {
      if (this.cursor !== last) throw this.refuse("the closing `)` of the region it wraps");
      this.cursor++;
      close = decorate(this.fmt, this.items[last], text(")"));
    } else {
      close = ifBreak(text(")"), nil);
    }
    return group(concat([open, indent(concat([soft, inner])), soft, close]));
  }

  /** Format a child, adding optional parentheses if its type is one the
   *  package lists as needing them to break. */
  autoparen(sel) {
    if (!this.matches(this.cursor, sel)) throw this.refuse(`a child matching ${JSON.stringify(sel)}`);
    const wrap = this.fmt.optionalParens.has(this.items[this.cursor].node.type);
    const inner = this.child(sel);
    if (!wrap) return inner;
    return group(
      concat([ifBreak(text("("), nil), indent(concat([soft, inner])), soft, ifBreak(text(")"), nil)]),
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

  /** Collect a left-nested run of same-type, same-tightness operators into one
   *  flat list, so the whole chain breaks together instead of staircasing.
   *  This is the opcode a per-node fold cannot do without. */
  flatten(kind, sep) {
    const left = { field: "left" };
    const right = { field: "right" };

    const spine = [];
    for (let cur = this.node; ; ) {
      const next = (cur.children ?? []).find((c) => c.field === "left");
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

class Formatter {
  constructor(pkg, source) {
    this.pkg = pkg;
    this.bytes = new TextEncoder().encode(source ?? "");
    this.decoder = new TextDecoder();
    this.tokens = new Set(pkg.tokens ?? []);
    this.comments = new Set(pkg.comments ?? []);
    this.descend = new Set(pkg.descend ?? []);
    this.optionalParens = new Set(pkg.optional_parens ?? []);
    this.precedence = pkg.precedence ?? {};
  }

  tightness(node) {
    const op = (node.children ?? []).find((c) => c.field === "operator");
    return (op && this.precedence[op.text]) ?? 0;
  }

  slice(node) {
    return text(this.decoder.decode(this.bytes.subarray(node.start, node.end)));
  }

  node(node) {
    if (node.text !== undefined) return text(node.text);
    const rule = this.pkg.rules[node.type];
    if (!rule) throw new Refusal(`package has no rule for node type \`${node.type}\``);
    const ctx = new Ctx(this, node);
    const doc = ctx.eval(rule);
    if (ctx.cursor !== ctx.items.length) {
      throw new Refusal(
        `rule for \`${node.type}\` left child \`${ctx.items[ctx.cursor].node.type}\` unconsumed`,
      );
    }
    return doc;
  }
}

/** Format a corpus tree. Throws `Refusal` rather than guessing. */
function format(tree, cols, pkg) {
  const fmt = new Formatter(pkg, tree.source);
  const out = print(fmt.node(tree.root), cols, pkg.indent);
  return `${out.replace(/\n+$/, "")}\n`;
}

module.exports = { format, Refusal };
