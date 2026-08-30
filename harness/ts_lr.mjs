// A table-driven parser that consumes the data blob `harness/ts_transcode.py`
// emits and produces the same trees tree-sitter does.
//
// Route C3 in `docs/parse-layer.md`: same tables, same algorithm, therefore the
// same trees -- with no wasm and no code in the shipped package. This file is
// the "same algorithm" half, ported from tree-sitter 0.26.0's `lib/src`
// (`parser.c`, `stack.c`, `subtree.c`, `node.c`, `lexer.c`, `language.c`).
//
// Deliberately NOT implemented, because the spike does not need them and the
// corpus cannot see them (see `docs/parse-tables-spike.md`):
//
//   * error recovery      -- ts_parser__handle_error / __recover / __breakdown
//   * incremental reparse -- old-tree reuse, ReusableNode, __breakdown_top_of_stack
//   * external scanners   -- the transcoder refuses grammars that have one
//   * repeat rebalancing  -- ts_parser__balance_subtree, a rotation among
//                            same-symbol invisible repeat nodes that preserves
//                            leaf order and so cannot change the visible tree
//   * row/column tracking -- only byte offsets reach the output, and the two
//                            consumers of extents (get_column, error rows) are
//                            scanner and error-recovery paths
//
// Every one of those is a place a reimplementation is green on clean full
// parses and wrong in production. Reaching one throws rather than guessing.

const ERROR_STATE = 0;
const TS_TREE_STATE_NONE = 0xffff;
const NO_LEX_STATE = 0xffff;
const TS_BUILTIN_SYM_END = 0;
const TS_BUILTIN_SYM_ERROR = 0xffff;
const TS_BUILTIN_SYM_ERROR_REPEAT = 0xfffe;
const MAX_VERSION_COUNT = 6;
const MAX_VERSION_COUNT_OVERFLOW = 4;
const MAX_LINK_COUNT = 8;
const MAX_ITERATOR_COUNT = 64;
const MAX_COST_DIFFERENCE = 18 * 100; // 18 * ERROR_COST_PER_SKIPPED_TREE
const TS_DECODE_ERROR = -1;
const BYTE_ORDER_MARK = 0xfeff;

class Unsupported extends Error {}

// ---------------------------------------------------------------------------
// Language: accessors over the blob, mirroring lib/src/language.{c,h}
// ---------------------------------------------------------------------------

export class Language {
  constructor(blob) {
    this.b = blob;
    this.symbolCount = blob.symbolCount;
    this.tokenCount = blob.tokenCount;
    this.largeStateCount = blob.largeStateCount;
    this.maxAliasSequenceLength = blob.maxAliasSequenceLength;
    this.maxReservedWordSetSize = blob.maxReservedWordSetSize;
    this.fieldCount = blob.fieldCount;
    this.keywordCaptureToken = blob.keywordCaptureToken;
  }

  // ts_language_lookup
  lookup(state, symbol) {
    const b = this.b;
    if (state >= this.largeStateCount) {
      let i = b.smallParseTableMap[state - this.largeStateCount];
      const t = b.smallParseTable;
      const groupCount = t[i++];
      for (let g = 0; g < groupCount; g++) {
        const sectionValue = t[i++];
        const symbolCount = t[i++];
        for (let j = 0; j < symbolCount; j++) {
          if (t[i++] === symbol) return sectionValue;
        }
      }
      return 0;
    }
    return b.parseTable[state * this.symbolCount + symbol];
  }

  // ts_language_table_entry
  tableEntry(state, symbol) {
    if (symbol === TS_BUILTIN_SYM_ERROR || symbol === TS_BUILTIN_SYM_ERROR_REPEAT) {
      return EMPTY_ENTRY;
    }
    const entry = this.b.parseActions[this.lookup(state, symbol)];
    return entry === null || entry === undefined ? EMPTY_ENTRY : entry;
  }

  hasActions(state, symbol) {
    return this.lookup(state, symbol) !== 0;
  }

  // ts_language_next_state
  nextState(state, symbol) {
    if (symbol === TS_BUILTIN_SYM_ERROR || symbol === TS_BUILTIN_SYM_ERROR_REPEAT) return 0;
    if (symbol < this.tokenCount) {
      const entry = this.tableEntry(state, symbol);
      if (entry.c > 0) {
        const action = entry.a[entry.c - 1];
        if (action[0] === 0) return action[2] ? state : action[1];
      }
      return 0;
    }
    return this.lookup(state, symbol);
  }

  lexState(state) {
    return this.b.lexStates[state];
  }

  externalLexState(state) {
    return this.b.externalLexStates[state];
  }

  reservedWordSetId(state) {
    return this.b.reservedWordSetIds[state];
  }

  // ts_language_is_reserved_word
  isReservedWord(state, symbol) {
    const setId = this.b.reservedWordSetIds[state];
    if (setId > 0) {
      const start = setId * this.maxReservedWordSetSize;
      for (let i = start; i < start + this.maxReservedWordSetSize; i++) {
        const w = this.b.reservedWords[i];
        if (w === symbol) return true;
        if (w === 0) break;
      }
    }
    return false;
  }

  // ts_language_symbol_metadata: bit 0 visible, bit 1 named, bit 2 supertype
  visible(symbol) {
    if (symbol === TS_BUILTIN_SYM_ERROR) return true;
    if (symbol === TS_BUILTIN_SYM_ERROR_REPEAT) return false;
    return (this.b.symbolMetadata[symbol] & 1) !== 0;
  }

  named(symbol) {
    if (symbol === TS_BUILTIN_SYM_ERROR) return true;
    if (symbol === TS_BUILTIN_SYM_ERROR_REPEAT) return false;
    return (this.b.symbolMetadata[symbol] & 2) !== 0;
  }

  symbolName(symbol) {
    if (symbol === TS_BUILTIN_SYM_ERROR) return "ERROR";
    return this.b.symbolNames[symbol];
  }

  // ts_language_alias_at
  aliasAt(productionId, childIndex) {
    if (!productionId) return 0;
    return this.b.aliasSequences[productionId * this.maxAliasSequenceLength + childIndex];
  }

  hasAliasSequence(productionId) {
    return productionId !== 0;
  }

  // ts_language_field_map
  fieldNameFor(productionId, structuralChildIndex) {
    if (this.fieldCount === 0) return null;
    const index = this.b.fieldMapSlices[2 * productionId];
    const length = this.b.fieldMapSlices[2 * productionId + 1];
    const e = this.b.fieldMapEntries;
    for (let i = index; i < index + length; i++) {
      // [fieldId, childIndex, inherited]
      if (!e[3 * i + 2] && e[3 * i + 1] === structuralChildIndex) {
        return this.b.fieldNames[e[3 * i]];
      }
    }
    return null;
  }
}

const EMPTY_ENTRY = { c: 0, r: 0, a: [] };

// ---------------------------------------------------------------------------
// Lexer, mirroring lib/src/lexer.c for a single default included range and a
// whole-buffer string input (which is what ts_parser_parse_string gives it).
// ---------------------------------------------------------------------------

class Lexer {
  constructor(bytes) {
    this.buf = bytes;
    this.len = bytes.length;
    this.pos = 0;
    this.chunkStart = 0;
    this.chunkSize = 0;
    this.hasChunk = false;
    this.atEof = false;
    this.lookahead = 0;
    this.lookaheadSize = 0;
    this.tokenStart = 0;
    this.tokenEnd = -1;
    this.resultSymbol = 0;
  }

  // ts_lexer__get_chunk: the input callback returns 0 bytes at or past the end,
  // and that -- not a position comparison -- is what sets EOF.
  getChunk() {
    this.chunkStart = this.pos;
    this.chunkSize = this.pos >= this.len ? 0 : this.len - this.pos;
    if (this.chunkSize === 0) {
      this.atEof = true;
      this.hasChunk = false;
    } else {
      this.hasChunk = true;
    }
  }

  getLookahead() {
    const positionInChunk = this.pos - this.chunkStart;
    const size = this.chunkSize - positionInChunk;
    if (size === 0) {
      this.lookaheadSize = 1;
      this.lookahead = 0;
      return;
    }
    decodeUtf8(this.buf, this.pos, this.len, this);
  }

  // ts_lexer_goto, specialised to the single default range: it always finds
  // range 0, so it always clears EOF and invalidates the chunk.
  gotoPos(position) {
    this.pos = position;
    this.atEof = false;
    if (this.hasChunk && (this.pos < this.chunkStart || this.pos >= this.chunkStart + this.chunkSize)) {
      this.hasChunk = false;
      this.chunkSize = 0;
      this.chunkStart = 0;
    }
    this.lookaheadSize = 0;
    this.lookahead = 0;
  }

  reset(position) {
    if (position !== this.pos) this.gotoPos(position);
  }

  start() {
    this.tokenStart = this.pos;
    this.tokenEnd = -1;
    this.resultSymbol = 0;
    if (!this.atEof) {
      if (!this.chunkSize) this.getChunk();
      if (!this.lookaheadSize) this.getLookahead();
      if (this.pos === 0 && this.lookahead === BYTE_ORDER_MARK) this.advance(true);
    }
  }

  finish() {
    if (this.tokenEnd < 0) this.markEnd();
    if (this.tokenEnd < this.tokenStart) this.tokenStart = this.tokenEnd;
  }

  // ts_lexer__mark_end, specialised: with one included range the boundary
  // special case cannot fire.
  markEnd() {
    this.tokenEnd = this.pos;
  }

  advance(skip) {
    if (!this.hasChunk) return;
    if (this.lookaheadSize) this.pos += this.lookaheadSize;
    // The included-range walk in ts_lexer__do_advance cannot fire here: the
    // default range's end_byte is UINT32_MAX.
    if (skip) this.tokenStart = this.pos;
    if (this.pos < this.chunkStart || this.pos >= this.chunkStart + this.chunkSize) {
      this.getChunk();
    }
    this.getLookahead();
  }

  // START_LEXER()'s loop, driven by the recovered DFA rather than by C control
  // flow. Returns whether a token was accepted; the symbol is in resultSymbol.
  run(states, startState) {
    let state = startState;
    let result = false;
    let skip = false;
    let first = true;
    for (;;) {
      if (!first) this.advance(skip);
      first = false;
      skip = false;
      const lookahead = this.lookahead;
      const eof = this.atEof;
      const st = states[state];
      if (st === undefined) return false; // `default: return false;`
      const ops = st.o;
      let advanced = false;
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const kind = op[0];
        if (kind === 0) {
          // ACCEPT_TOKEN(sym)
          result = true;
          this.resultSymbol = op[1];
          this.markEnd();
          continue;
        }
        if (kind === 1) {
          // ADVANCE_MAP(...)
          const map = op[1];
          for (let j = 0; j < map.length; j += 2) {
            if (map[j] === lookahead) {
              state = map[j + 1];
              advanced = true;
              break;
            }
          }
          if (advanced) break;
          continue;
        }
        let act, target;
        if (kind === 2) {
          const eofMode = op[1];
          if (eofMode === 1 && !eof) continue;
          if (eofMode === 2 && eof) continue;
          const ranges = op[2];
          if (ranges.length && !inRanges(ranges, lookahead)) continue;
          act = op[3];
          target = op[4];
        } else if (kind === 3) {
          act = op[1];
          target = op[2];
        } else if (kind === 4) {
          // Guard whose truth differs at EOF: one interval set for each.
          const ranges = eof ? op[2] : op[1];
          if (!inRanges(ranges, lookahead)) continue;
          act = op[3];
          target = op[4];
        } else {
          throw new Unsupported(`lex op kind ${kind}`);
        }
        if (act === 0) {
          state = target;
          advanced = true;
        } else if (act === 1) {
          state = target;
          skip = true;
          advanced = true;
        } else if (act === 2) {
          return result; // END_STATE()
        } else if (act === 3) {
          result = true;
          this.resultSymbol = target;
          this.markEnd();
          continue;
        } else {
          throw new Unsupported(`lex action ${act}`);
        }
        break;
      }
      if (!advanced) return result; // fell through to END_STATE()
    }
  }
}

function inRanges(ranges, value) {
  for (let i = 0; i < ranges.length; i += 2) {
    if (value < ranges[i]) return false; // ranges are sorted and disjoint
    if (value <= ranges[i + 1]) return true;
  }
  return false;
}

// ts_decode_utf8: writes lookahead/lookaheadSize onto the lexer. Invalid input
// yields TS_DECODE_ERROR with a size of 1, which is what lexer.c forces.
function decodeUtf8(buf, pos, len, out) {
  const b0 = buf[pos];
  if (b0 < 0x80) {
    out.lookahead = b0;
    out.lookaheadSize = 1;
    return;
  }
  let need, cp, lo;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    need = 1;
    cp = b0 & 0x1f;
    lo = 0x80;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    need = 2;
    cp = b0 & 0x0f;
    lo = 0x800;
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    need = 3;
    cp = b0 & 0x07;
    lo = 0x10000;
  } else {
    out.lookahead = TS_DECODE_ERROR;
    out.lookaheadSize = 1;
    return;
  }
  if (pos + need >= len + 1 && pos + need > len - 1) {
    if (pos + need > len - 1) {
      out.lookahead = TS_DECODE_ERROR;
      out.lookaheadSize = 1;
      return;
    }
  }
  for (let i = 1; i <= need; i++) {
    const b = buf[pos + i];
    if ((b & 0xc0) !== 0x80) {
      out.lookahead = TS_DECODE_ERROR;
      out.lookaheadSize = 1;
      return;
    }
    cp = (cp << 6) | (b & 0x3f);
  }
  if (cp < lo || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    out.lookahead = TS_DECODE_ERROR;
    out.lookaheadSize = 1;
    return;
  }
  out.lookahead = cp;
  out.lookaheadSize = need + 1;
}

// ---------------------------------------------------------------------------
// Subtree, mirroring lib/src/subtree.c
// ---------------------------------------------------------------------------

class Subtree {
  constructor() {
    this.symbol = 0;
    this.children = null;
    this.childCount = 0;
    this.padding = 0;
    this.size = 0;
    this.lookaheadBytes = 0;
    this.visible = false;
    this.named = false;
    this.extra = false;
    this.isKeyword = false;
    this.isMissing = false;
    this.errorCost = 0;
    this.dynamicPrecedence = 0;
    this.productionId = 0;
    this.visibleChildCount = 0;
    this.namedChildCount = 0;
    this.visibleDescendantCount = 0;
    this.fragileLeft = false;
    this.fragileRight = false;
    this.parseState = 0;
    this.repeatDepth = 0;
    this.firstLeafSymbol = 0;
    this.firstLeafParseState = 0;
  }

  get totalSize() {
    return this.padding + this.size;
  }

  get leafSymbol() {
    return this.childCount === 0 ? this.symbol : this.firstLeafSymbol;
  }

  get leafParseState() {
    return this.childCount === 0 ? this.parseState : this.firstLeafParseState;
  }

  clone() {
    return Object.assign(new Subtree(), this);
  }
}

function newLeaf(lang, symbol, padding, size, lookaheadBytes, parseState, isKeyword) {
  const t = new Subtree();
  t.symbol = symbol;
  t.padding = padding;
  t.size = size;
  t.lookaheadBytes = lookaheadBytes;
  t.parseState = parseState;
  t.visible = lang.visible(symbol);
  t.named = lang.named(symbol);
  t.extra = symbol === TS_BUILTIN_SYM_END;
  t.isKeyword = isKeyword;
  return t;
}

// ts_subtree_summarize_children
function summarizeChildren(self, lang) {
  self.namedChildCount = 0;
  self.visibleChildCount = 0;
  self.errorCost = 0;
  self.repeatDepth = 0;
  self.visibleDescendantCount = 0;
  self.dynamicPrecedence = 0;

  let structuralIndex = 0;
  const hasAliases = lang.hasAliasSequence(self.productionId);
  let lookaheadEndByte = 0;
  const children = self.children;

  for (let i = 0; i < self.childCount; i++) {
    const child = children[i];
    if (i === 0) {
      self.padding = child.padding;
      self.size = child.size;
    } else {
      self.size += child.totalSize;
    }

    const childLookaheadEnd = self.padding + self.size + child.lookaheadBytes;
    if (childLookaheadEnd > lookaheadEndByte) lookaheadEndByte = childLookaheadEnd;

    if (child.symbol !== TS_BUILTIN_SYM_ERROR_REPEAT) self.errorCost += child.errorCost;

    const grandchildCount = child.childCount;
    if (self.symbol === TS_BUILTIN_SYM_ERROR || self.symbol === TS_BUILTIN_SYM_ERROR_REPEAT) {
      throw new Unsupported("error node construction: error recovery is out of scope");
    }

    self.dynamicPrecedence += child.dynamicPrecedence;
    self.visibleDescendantCount += child.visibleDescendantCount;

    const alias = hasAliases && !child.extra && child.symbol !== 0
      ? lang.aliasAt(self.productionId, structuralIndex)
      : 0;
    if (alias !== 0) {
      self.visibleDescendantCount++;
      self.visibleChildCount++;
      if (lang.named(alias)) self.namedChildCount++;
    } else if (child.visible) {
      self.visibleDescendantCount++;
      self.visibleChildCount++;
      if (child.named) self.namedChildCount++;
    } else if (grandchildCount > 0) {
      self.visibleChildCount += child.visibleChildCount;
      self.namedChildCount += child.namedChildCount;
    }

    if (child.symbol === TS_BUILTIN_SYM_ERROR || child.isMissing) {
      self.fragileLeft = true;
      self.fragileRight = true;
      self.parseState = TS_TREE_STATE_NONE;
    }

    if (!child.extra) structuralIndex++;
  }

  self.lookaheadBytes = lookaheadEndByte - self.size - self.padding;

  if (self.childCount > 0) {
    const firstChild = children[0];
    const lastChild = children[self.childCount - 1];
    self.firstLeafSymbol = firstChild.leafSymbol;
    self.firstLeafParseState = firstChild.leafParseState;
    if (firstChild.fragileLeft) self.fragileLeft = true;
    if (lastChild.fragileRight) self.fragileRight = true;
    if (
      self.childCount >= 2 &&
      !self.visible &&
      !self.named &&
      firstChild.symbol === self.symbol
    ) {
      self.repeatDepth = Math.max(firstChild.repeatDepth, lastChild.repeatDepth) + 1;
    }
  }
}

function newNode(lang, symbol, children, productionId) {
  const t = new Subtree();
  t.symbol = symbol;
  t.children = children;
  t.childCount = children.length;
  t.visible = lang.visible(symbol);
  t.named = lang.named(symbol);
  t.productionId = productionId;
  const fragile = symbol === TS_BUILTIN_SYM_ERROR || symbol === TS_BUILTIN_SYM_ERROR_REPEAT;
  t.fragileLeft = fragile;
  t.fragileRight = fragile;
  summarizeChildren(t, lang);
  return t;
}

// ts_subtree_compare
function subtreeCompare(left, right) {
  const stack = [left, right];
  while (stack.length > 0) {
    const r = stack.pop();
    const l = stack.pop();
    let result = 0;
    if (l.symbol < r.symbol) result = -1;
    else if (r.symbol < l.symbol) result = 1;
    else if (l.childCount < r.childCount) result = -1;
    else if (r.childCount < l.childCount) result = 1;
    if (result !== 0) return result;
    for (let i = l.childCount; i > 0; i--) {
      stack.push(l.children[i - 1], r.children[i - 1]);
    }
  }
  return 0;
}

function removeTrailingExtras(children) {
  const extras = [];
  while (children.length > 0 && children[children.length - 1].extra) {
    extras.push(children.pop());
  }
  extras.reverse();
  return extras;
}

// ---------------------------------------------------------------------------
// GLR stack, mirroring lib/src/stack.c
// ---------------------------------------------------------------------------

const StackStatus = { Active: 0, Paused: 1, Halted: 2 };

class StackNode {
  constructor(previous, subtree, isPending, state) {
    this.state = state;
    this.links = [];
    this.errorCost = 0;
    this.nodeCount = 0;
    this.dynamicPrecedence = 0;
    if (previous) {
      this.links.push({ node: previous, subtree, isPending });
      this.position = previous.position;
      this.errorCost = previous.errorCost;
      this.dynamicPrecedence = previous.dynamicPrecedence;
      this.nodeCount = previous.nodeCount;
      if (subtree) {
        this.errorCost += subtree.errorCost;
        this.position += subtree.totalSize;
        this.nodeCount += subtreeNodeCount(subtree);
        this.dynamicPrecedence += subtree.dynamicPrecedence;
      }
    } else {
      this.position = 0;
    }
  }
}

function subtreeNodeCount(subtree) {
  let count = subtree.visibleDescendantCount;
  if (subtree.visible) count++;
  if (subtree.symbol === TS_BUILTIN_SYM_ERROR_REPEAT) count++;
  return count;
}

function subtreeIsEquivalent(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.symbol !== right.symbol) return false;
  if (left.errorCost > 0 && right.errorCost > 0) return true;
  return (
    left.padding === right.padding &&
    left.size === right.size &&
    left.childCount === right.childCount &&
    left.extra === right.extra
  );
}

function stackNodeAddLink(self, link) {
  if (link.node === self) return;
  for (let i = 0; i < self.links.length; i++) {
    const existing = self.links[i];
    if (subtreeIsEquivalent(existing.subtree, link.subtree)) {
      if (existing.node === link.node) {
        if (
          (link.subtree ? link.subtree.dynamicPrecedence : 0) >
          (existing.subtree ? existing.subtree.dynamicPrecedence : 0)
        ) {
          existing.subtree = link.subtree;
          self.dynamicPrecedence =
            link.node.dynamicPrecedence + (link.subtree ? link.subtree.dynamicPrecedence : 0);
        }
        return;
      }
      if (
        existing.node.state === link.node.state &&
        existing.node.position === link.node.position &&
        existing.node.errorCost === link.node.errorCost
      ) {
        for (let j = 0; j < link.node.links.length; j++) {
          stackNodeAddLink(existing.node, link.node.links[j]);
        }
        let dp = link.node.dynamicPrecedence;
        if (link.subtree) dp += link.subtree.dynamicPrecedence;
        if (dp > self.dynamicPrecedence) self.dynamicPrecedence = dp;
        return;
      }
    }
  }
  if (self.links.length === MAX_LINK_COUNT) return;
  let nodeCount = link.node.nodeCount;
  let dp = link.node.dynamicPrecedence;
  self.links.push(link);
  if (link.subtree) {
    nodeCount += subtreeNodeCount(link.subtree);
    dp += link.subtree.dynamicPrecedence;
  }
  if (nodeCount > self.nodeCount) self.nodeCount = nodeCount;
  if (dp > self.dynamicPrecedence) self.dynamicPrecedence = dp;
}

class Stack {
  constructor() {
    this.baseNode = new StackNode(null, null, false, 1);
    this.heads = [];
    this.slices = [];
    this.clear();
  }

  clear() {
    this.heads = [
      {
        node: this.baseNode,
        status: StackStatus.Active,
        nodeCountAtLastError: 0,
        lookaheadWhenPaused: null,
      },
    ];
  }

  get versionCount() {
    return this.heads.length;
  }

  state(v) {
    return this.heads[v].node.state;
  }

  position(v) {
    return this.heads[v].node.position;
  }

  dynamicPrecedence(v) {
    return this.heads[v].node.dynamicPrecedence;
  }

  isActive(v) {
    return this.heads[v].status === StackStatus.Active;
  }

  isPaused(v) {
    return this.heads[v].status === StackStatus.Paused;
  }

  isHalted(v) {
    return this.heads[v].status === StackStatus.Halted;
  }

  halt(v) {
    this.heads[v].status = StackStatus.Halted;
  }

  pause(v, lookahead) {
    const head = this.heads[v];
    head.status = StackStatus.Paused;
    head.lookaheadWhenPaused = lookahead;
    head.nodeCountAtLastError = head.node.nodeCount;
  }

  haltedVersionCount() {
    let n = 0;
    for (const h of this.heads) if (h.status === StackStatus.Halted) n++;
    return n;
  }

  errorCost(v) {
    const head = this.heads[v];
    let result = head.node.errorCost;
    if (
      head.status === StackStatus.Paused ||
      (head.node.state === ERROR_STATE &&
        head.node.links.length > 0 &&
        !head.node.links[0].subtree)
    ) {
      result += 500; // ERROR_COST_PER_RECOVERY
    }
    return result;
  }

  nodeCountSinceError(v) {
    const head = this.heads[v];
    if (head.node.nodeCount < head.nodeCountAtLastError) {
      head.nodeCountAtLastError = head.node.nodeCount;
    }
    return head.node.nodeCount - head.nodeCountAtLastError;
  }

  push(v, subtree, pending, state) {
    const head = this.heads[v];
    const node = new StackNode(head.node, subtree, pending, state);
    if (!subtree) head.nodeCountAtLastError = node.nodeCount;
    head.node = node;
  }

  addVersion(originalVersion, node) {
    this.heads.push({
      node,
      nodeCountAtLastError: this.heads[originalVersion].nodeCountAtLastError,
      status: StackStatus.Active,
      lookaheadWhenPaused: null,
    });
    return this.heads.length - 1;
  }

  addSlice(originalVersion, node, subtrees) {
    for (let i = this.slices.length - 1; i >= 0; i--) {
      const version = this.slices[i].version;
      if (this.heads[version].node === node) {
        this.slices.splice(i + 1, 0, { subtrees, version });
        return;
      }
    }
    const version = this.addVersion(originalVersion, node);
    this.slices.push({ subtrees, version });
  }

  // stack__iter
  iter(version, callback, includeSubtrees) {
    this.slices = [];
    const iterators = [
      { node: this.heads[version].node, subtrees: [], subtreeCount: 0, isPending: true },
    ];
    while (iterators.length > 0) {
      let size = iterators.length;
      for (let i = 0; i < size; i++) {
        const it = iterators[i];
        const node = it.node;
        const action = callback(it);
        const shouldPop = (action & 2) !== 0;
        const shouldStop = (action & 1) !== 0 || node.links.length === 0;

        if (shouldPop) {
          const subtrees = shouldStop ? it.subtrees : it.subtrees.slice();
          subtrees.reverse();
          this.addSlice(version, node, subtrees);
        }
        if (shouldStop) {
          iterators.splice(i, 1);
          i--;
          size--;
          continue;
        }
        for (let j = 1; j <= node.links.length; j++) {
          let nextIterator, link;
          if (j === node.links.length) {
            link = node.links[0];
            nextIterator = iterators[i];
          } else {
            if (iterators.length >= MAX_ITERATOR_COUNT) continue;
            link = node.links[j];
            const current = iterators[i];
            nextIterator = {
              node: current.node,
              subtrees: current.subtrees.slice(),
              subtreeCount: current.subtreeCount,
              isPending: current.isPending,
            };
            iterators.push(nextIterator);
          }
          nextIterator.node = link.node;
          if (link.subtree) {
            if (includeSubtrees) nextIterator.subtrees.push(link.subtree);
            if (!link.subtree.extra) {
              nextIterator.subtreeCount++;
              if (!link.isPending) nextIterator.isPending = false;
            }
          } else {
            nextIterator.subtreeCount++;
            nextIterator.isPending = false;
          }
        }
      }
    }
    return this.slices;
  }

  popCount(version, count) {
    return this.iter(version, (it) => (it.subtreeCount === count ? 3 : 0), true);
  }

  popAll(version) {
    return this.iter(version, (it) => (it.node.links.length === 0 ? 2 : 0), true);
  }

  canMerge(v1, v2) {
    const h1 = this.heads[v1];
    const h2 = this.heads[v2];
    return (
      h1.status === StackStatus.Active &&
      h2.status === StackStatus.Active &&
      h1.node.state === h2.node.state &&
      h1.node.position === h2.node.position &&
      h1.node.errorCost === h2.node.errorCost
    );
  }

  merge(v1, v2) {
    if (!this.canMerge(v1, v2)) return false;
    const h1 = this.heads[v1];
    const h2 = this.heads[v2];
    for (const link of h2.node.links) stackNodeAddLink(h1.node, link);
    if (h1.node.state === ERROR_STATE) h1.nodeCountAtLastError = h1.node.nodeCount;
    this.removeVersion(v2);
    return true;
  }

  renumberVersion(v1, v2) {
    if (v1 === v2) return;
    this.heads[v2] = this.heads[v1];
    this.heads.splice(v1, 1);
  }

  removeVersion(v) {
    this.heads.splice(v, 1);
  }

  swapVersions(v1, v2) {
    const t = this.heads[v1];
    this.heads[v1] = this.heads[v2];
    this.heads[v2] = t;
  }
}

// ---------------------------------------------------------------------------
// Parser, mirroring lib/src/parser.c
// ---------------------------------------------------------------------------

const Cmp = { TakeLeft: 0, PreferLeft: 1, None: 2, PreferRight: 3, TakeRight: 4 };

class Parser {
  constructor(lang, bytes) {
    this.lang = lang;
    this.lexer = new Lexer(bytes);
    this.stack = new Stack();
    this.finishedTree = null;
    this.acceptCount = 0;
    this.cachedToken = null;
    this.cachedTokenByteIndex = 0;
  }

  // ts_parser__lex
  lex(version, parseState) {
    const lang = this.lang;
    let lexState = lang.lexState(parseState);
    if (lexState === NO_LEX_STATE) return null;
    if (lang.externalLexState(parseState) !== 0) {
      throw new Unsupported("external scanner state reached");
    }
    let reservedWordSetId = lang.reservedWordSetId(parseState);

    const startPosition = this.stack.position(version);
    let errorMode = parseState === ERROR_STATE;
    let lookaheadEndByte = 0;
    const lexer = this.lexer;
    lexer.reset(startPosition);

    for (;;) {
      lexer.start();
      const found = lexer.run(this.lang.b.lex, lexState);
      lexer.finish();
      if (lexer.pos + 1 > lookaheadEndByte) lookaheadEndByte = lexer.pos + 1;
      if (found) break;
      if (!errorMode) {
        errorMode = true;
        lexState = lang.lexState(ERROR_STATE);
        reservedWordSetId = lang.reservedWordSetId(ERROR_STATE);
        lexer.reset(startPosition);
        continue;
      }
      throw new Unsupported(
        `no token at byte ${lexer.pos}: error recovery is out of scope`
      );
    }

    let isKeyword = false;
    let symbol = lexer.resultSymbol;
    const padding = lexer.tokenStart - startPosition;
    const size = lexer.tokenEnd - lexer.tokenStart;
    const lookaheadBytes = lookaheadEndByte - lexer.tokenEnd;

    if (symbol === lang.keywordCaptureToken && symbol !== 0) {
      const endByte = lexer.tokenEnd;
      lexer.reset(lexer.tokenStart);
      lexer.start();
      isKeyword = lexer.run(lang.b.keywordLex, 0);
      lexer.finish();
      if (
        isKeyword &&
        lexer.tokenEnd === endByte &&
        (lang.hasActions(parseState, lexer.resultSymbol) ||
          lang.isReservedWord(parseState, lexer.resultSymbol))
      ) {
        symbol = lexer.resultSymbol;
      } else {
        isKeyword = false;
      }
    }

    return newLeaf(lang, symbol, padding, size, lookaheadBytes, parseState, isKeyword);
  }

  // ts_parser__can_reuse_first_leaf
  canReuseFirstLeaf(state, tree, entry) {
    const lang = this.lang;
    const leafSymbol = tree.leafSymbol;
    const leafState = tree.leafParseState;
    if (lang.lexState(state) === NO_LEX_STATE) return false;
    if (
      entry.c > 0 &&
      lang.lexState(leafState) === lang.lexState(state) &&
      lang.externalLexState(leafState) === lang.externalLexState(state) &&
      lang.reservedWordSetId(leafState) === lang.reservedWordSetId(state) &&
      (leafSymbol !== lang.keywordCaptureToken ||
        (!tree.isKeyword && tree.parseState === state))
    ) {
      return true;
    }
    if (tree.size === 0 && leafSymbol !== TS_BUILTIN_SYM_END) return false;
    return lang.externalLexState(state) === 0 && entry.r !== 0;
  }

  getCachedToken(state, position) {
    if (this.cachedToken && this.cachedTokenByteIndex === position) {
      const entry = this.lang.tableEntry(state, this.cachedToken.symbol);
      if (this.canReuseFirstLeaf(state, this.cachedToken, entry)) {
        return { token: this.cachedToken, entry };
      }
    }
    return null;
  }

  // ts_parser__shift
  shift(version, state, lookahead, extra) {
    const isLeaf = lookahead.childCount === 0;
    let toPush = lookahead;
    if (extra !== lookahead.extra && isLeaf) {
      toPush = lookahead.clone();
      toPush.extra = extra;
    }
    this.stack.push(version, toPush, !isLeaf, state);
  }

  // ts_parser__select_tree
  selectTree(left, right) {
    if (!left) return true;
    if (!right) return false;
    if (right.errorCost < left.errorCost) return true;
    if (left.errorCost < right.errorCost) return false;
    if (right.dynamicPrecedence > left.dynamicPrecedence) return true;
    if (left.dynamicPrecedence > right.dynamicPrecedence) return false;
    if (left.errorCost > 0) return true;
    const comparison = subtreeCompare(left, right);
    if (comparison === -1) return false;
    if (comparison === 1) return true;
    return false;
  }

  // ts_parser__reduce
  reduce(version, symbol, count, dynamicPrecedence, productionId, isFragile, endOfNonTerminalExtra) {
    const stack = this.stack;
    const initialVersionCount = stack.versionCount;
    const pop = stack.popCount(version, count);
    let removedVersionCount = 0;
    const haltedVersionCount = stack.haltedVersionCount();

    for (let i = 0; i < pop.length; i++) {
      const slice = pop[i];
      const sliceVersion = slice.version - removedVersionCount;

      if (sliceVersion > MAX_VERSION_COUNT + MAX_VERSION_COUNT_OVERFLOW + haltedVersionCount) {
        stack.removeVersion(sliceVersion);
        removedVersionCount++;
        while (i + 1 < pop.length && pop[i + 1].version === slice.version) i++;
        continue;
      }

      let children = slice.subtrees;
      let trailingExtras = removeTrailingExtras(children);
      let parent = newNode(this.lang, symbol, children, productionId);

      while (i + 1 < pop.length && pop[i + 1].version === slice.version) {
        i++;
        const nextChildren = pop[i].subtrees;
        const nextTrailingExtras = removeTrailingExtras(nextChildren);
        const candidate = newNode(this.lang, symbol, nextChildren, productionId);
        if (this.selectTree(parent, candidate)) {
          trailingExtras = nextTrailingExtras;
          parent = candidate;
        }
      }

      const state = stack.state(sliceVersion);
      const nextState = this.lang.nextState(state, symbol);
      if (endOfNonTerminalExtra && nextState === state) parent.extra = true;
      if (isFragile || pop.length > 1 || initialVersionCount > 1) {
        parent.fragileLeft = true;
        parent.fragileRight = true;
        parent.parseState = TS_TREE_STATE_NONE;
      } else {
        parent.parseState = state;
      }
      parent.dynamicPrecedence += dynamicPrecedence;

      stack.push(sliceVersion, parent, false, nextState);
      for (const extra of trailingExtras) stack.push(sliceVersion, extra, false, nextState);

      for (let j = 0; j < sliceVersion; j++) {
        if (j === version) continue;
        if (stack.merge(j, sliceVersion)) {
          removedVersionCount++;
          break;
        }
      }
    }

    return stack.versionCount > initialVersionCount ? initialVersionCount : -1;
  }

  // ts_parser__accept
  accept(version, lookahead) {
    const stack = this.stack;
    stack.push(version, lookahead, false, 1);
    const pop = stack.popAll(version);
    for (const slice of pop) {
      const trees = slice.subtrees;
      let root = null;
      for (let j = trees.length - 1; j >= 0; j--) {
        const tree = trees[j];
        if (!tree.extra) {
          const spliced = trees
            .slice(0, j)
            .concat(tree.children || [], trees.slice(j + 1));
          root = newNode(this.lang, tree.symbol, spliced, tree.productionId);
          break;
        }
      }
      if (!root) throw new Unsupported("accept produced no root");
      this.acceptCount++;
      if (this.finishedTree) {
        if (this.selectTree(this.finishedTree, root)) this.finishedTree = root;
      } else {
        this.finishedTree = root;
      }
    }
    stack.removeVersion(pop[0].version);
    stack.halt(version);
  }

  // ts_parser__advance
  advance(version) {
    const lang = this.lang;
    const stack = this.stack;
    let state = stack.state(version);
    const position = stack.position(version);

    let lookahead = null;
    let tableEntry = EMPTY_ENTRY;
    const cached = this.getCachedToken(state, position);
    if (cached) {
      lookahead = cached.token;
      tableEntry = cached.entry;
    }

    let needsLex = lookahead === null;
    for (;;) {
      if (needsLex) {
        needsLex = false;
        lookahead = this.lex(version, state);
        if (lookahead) {
          this.cachedToken = lookahead;
          this.cachedTokenByteIndex = position;
          tableEntry = lang.tableEntry(state, lookahead.symbol);
        } else {
          tableEntry = lang.tableEntry(state, TS_BUILTIN_SYM_END);
        }
      }

      let didReduce = false;
      let lastReductionVersion = -1;
      for (let i = 0; i < tableEntry.c; i++) {
        const action = tableEntry.a[i];
        switch (action[0]) {
          case 0: {
            // shift: [0, state, extra, repetition]
            if (action[3]) break;
            const nextState = action[2] ? state : action[1];
            if (lookahead.childCount > 0) {
              throw new Unsupported("shifting a non-leaf lookahead needs breakdown");
            }
            this.shift(version, nextState, lookahead, !!action[2]);
            return;
          }
          case 1: {
            // reduce: [1, symbol, childCount, dynamicPrecedence, productionId]
            const isFragile = tableEntry.c > 1;
            const endOfNonTerminalExtra = lookahead === null;
            const reductionVersion = this.reduce(
              version, action[1], action[2], action[3], action[4],
              isFragile, endOfNonTerminalExtra,
            );
            didReduce = true;
            if (reductionVersion !== -1) lastReductionVersion = reductionVersion;
            break;
          }
          case 2:
            this.accept(version, lookahead);
            return;
          case 3:
            throw new Unsupported("RECOVER action: error recovery is out of scope");
          default:
            throw new Unsupported(`parse action ${action[0]}`);
        }
      }

      if (lastReductionVersion !== -1) {
        stack.renumberVersion(lastReductionVersion, version);
        state = stack.state(version);
        if (!lookahead) {
          needsLex = true;
        } else {
          tableEntry = lang.tableEntry(state, lookahead.leafSymbol);
        }
        continue;
      }

      if (didReduce) {
        stack.halt(version);
        return;
      }

      if (
        lookahead.isKeyword &&
        lookahead.symbol !== lang.keywordCaptureToken &&
        !lang.isReservedWord(state, lookahead.symbol)
      ) {
        const entry = lang.tableEntry(state, lang.keywordCaptureToken);
        if (entry.c > 0) {
          const mutable = lookahead.clone();
          mutable.symbol = lang.keywordCaptureToken;
          mutable.visible = lang.visible(mutable.symbol);
          mutable.named = lang.named(mutable.symbol);
          lookahead = mutable;
          tableEntry = entry;
          continue;
        }
      }

      // ts_parser__breakdown_top_of_stack always fails here: it pops *pending*
      // links, and links are only pending when a reused non-leaf subtree was
      // shifted, which needs an old tree.
      //
      // So: this version cannot proceed. That is not an error -- under GLR it
      // is the ordinary way a speculative version dies. Pause it and let the
      // others run; condenseStack discards it once a better version exists,
      // and only escalates to recovery if every version is paused.
      stack.pause(version, lookahead);
      return;
    }
  }

  versionStatus(version) {
    const stack = this.stack;
    let cost = stack.errorCost(version);
    const isPaused = stack.isPaused(version);
    if (isPaused) cost += 100;
    return {
      cost,
      nodeCount: stack.nodeCountSinceError(version),
      dynamicPrecedence: stack.dynamicPrecedence(version),
      isInError: isPaused || stack.state(version) === ERROR_STATE,
    };
  }

  compareVersions(a, b) {
    if (!a.isInError && b.isInError) return a.cost < b.cost ? Cmp.TakeLeft : Cmp.PreferLeft;
    if (a.isInError && !b.isInError) return b.cost < a.cost ? Cmp.TakeRight : Cmp.PreferRight;
    if (a.cost < b.cost) {
      return (b.cost - a.cost) * (1 + a.nodeCount) > MAX_COST_DIFFERENCE
        ? Cmp.TakeLeft
        : Cmp.PreferLeft;
    }
    if (b.cost < a.cost) {
      return (a.cost - b.cost) * (1 + b.nodeCount) > MAX_COST_DIFFERENCE
        ? Cmp.TakeRight
        : Cmp.PreferRight;
    }
    if (a.dynamicPrecedence > b.dynamicPrecedence) return Cmp.PreferLeft;
    if (b.dynamicPrecedence > a.dynamicPrecedence) return Cmp.PreferRight;
    return Cmp.None;
  }

  // ts_parser__condense_stack
  condenseStack() {
    const stack = this.stack;
    let minErrorCost = Infinity;
    for (let i = 0; i < stack.versionCount; i++) {
      if (stack.isHalted(i)) {
        stack.removeVersion(i);
        i--;
        continue;
      }
      const statusI = this.versionStatus(i);
      if (!statusI.isInError && statusI.cost < minErrorCost) minErrorCost = statusI.cost;

      for (let j = 0; j < i; j++) {
        const statusJ = this.versionStatus(j);
        switch (this.compareVersions(statusJ, statusI)) {
          case Cmp.TakeLeft:
            stack.removeVersion(i);
            i--;
            j = i;
            break;
          case Cmp.PreferLeft:
          case Cmp.None:
            if (stack.merge(j, i)) {
              i--;
              j = i;
            }
            break;
          case Cmp.PreferRight:
            if (stack.merge(j, i)) {
              i--;
              j = i;
            } else {
              stack.swapVersions(i, j);
            }
            break;
          case Cmp.TakeRight:
            stack.removeVersion(j);
            i--;
            j--;
            break;
        }
      }
    }

    while (stack.versionCount > MAX_VERSION_COUNT) {
      stack.removeVersion(MAX_VERSION_COUNT);
    }

    // Paused versions: upstream resumes the best one into error recovery and
    // drops the rest. Dropping the rest is ordinary GLR pruning and is
    // implemented; resuming one means the whole parse is in error, which is out
    // of scope, so say so instead of inventing a recovery.
    let hasUnpausedVersion = false;
    for (let i = 0, n = stack.versionCount; i < n; i++) {
      if (stack.isPaused(i)) {
        if (!hasUnpausedVersion && this.acceptCount < MAX_VERSION_COUNT) {
          // Upstream resumes the *best-ranked* paused version into recovery.
          // Versions are ordered best-first by this point, so reaching here
          // with no unpaused predecessor is exactly upstream's resume trigger.
          const head = stack.heads[i];
          const tok = head.lookaheadWhenPaused;
          throw new Unsupported(
            `parse needs error recovery at byte ${head.node.position}` +
            (tok ? `, lookahead ${this.lang.symbolName(tok.symbol)}` : "") +
            `, state ${head.node.state}: out of scope`
          );
        }
        stack.removeVersion(i);
        i--;
        n--;
      } else {
        hasUnpausedVersion = true;
      }
    }
    return minErrorCost;
  }

  // ts_parser_parse
  parse() {
    const stack = this.stack;
    let position = 0;
    let lastPosition = 0;
    let versionCount = 0;
    do {
      for (let version = 0; (versionCount = stack.versionCount), version < versionCount; version++) {
        while (stack.isActive(version)) {
          this.advance(version);
          position = stack.position(version);
          if (position > lastPosition || (version > 0 && position === lastPosition)) {
            lastPosition = position;
            break;
          }
        }
      }
      const minErrorCost = this.condenseStack();
      if (this.finishedTree && this.finishedTree.errorCost < minErrorCost) {
        stack.clear();
        break;
      }
    } while (versionCount !== 0);

    if (!this.finishedTree) throw new Unsupported("parse produced no tree");
    // ts_parser__balance_subtree is skipped: it rotates same-symbol invisible
    // repeat nodes, which preserves leaf order and therefore the visible tree.
    return this.finishedTree;
  }
}

// ---------------------------------------------------------------------------
// Node API, mirroring lib/src/node.c -- visible children with invisible nodes
// flattened, aliases applied, and field names resolved through both.
// ---------------------------------------------------------------------------

function isRelevant(subtree, alias) {
  return subtree.visible || alias !== 0;
}

function relevantChildCount(subtree) {
  return subtree.childCount > 0 ? subtree.visibleChildCount : 0;
}

// ts_node_iterate_children, as a generator over {subtree, alias, position}.
function* iterateChildren(lang, subtree, startByte) {
  if (subtree.childCount === 0) return;
  const hasAliases = lang.hasAliasSequence(subtree.productionId);
  let position = startByte;
  let structuralChildIndex = 0;
  for (let i = 0; i < subtree.childCount; i++) {
    const child = subtree.children[i];
    let alias = 0;
    if (!child.extra) {
      if (hasAliases) alias = lang.aliasAt(subtree.productionId, structuralChildIndex);
      structuralChildIndex++;
    }
    if (i > 0) position += child.padding;
    yield { subtree: child, alias, position, structuralChildIndex };
    position += child.size;
  }
}

// The visible children of a node, in order: exactly what py-tree-sitter's
// `node.children` yields, paired with `node.field_name_for_child(i)`.
//
// Iterative on purpose. A `repeat` rule builds a left-nested chain of invisible
// aux nodes one level per element, so descending into them recursively blows
// the JS stack on real files -- found on Go's x86asm/tables.go, a single
// ~10,000-element generated literal. tree-sitter's own ts_node__child is a
// `while (did_descend)` loop for the same reason, and upstream additionally
// rebalances those chains (ts_parser__balance_subtree), which this interpreter
// skips because it cannot change the visible tree. Skipping it is still right;
// it just means every traversal here has to carry its own stack.
export function visibleChildren(lang, subtree, startByte) {
  const out = [];
  const stack = [
    { node: subtree, iter: iterateChildren(lang, subtree, startByte), inherited: null },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const step = frame.iter.next();
    if (step.done) {
      stack.pop();
      continue;
    }
    const child = step.value;
    if (isRelevant(child.subtree, child.alias)) {
      let field = null;
      if (!child.subtree.extra) {
        field = lang.fieldNameFor(frame.node.productionId, child.structuralChildIndex - 1);
        if (field === null) field = frame.inherited;
      }
      out.push({
        subtree: child.subtree,
        alias: child.alias,
        start: child.position,
        field,
      });
    } else if (relevantChildCount(child.subtree) > 0) {
      const field = lang.fieldNameFor(frame.node.productionId, child.structuralChildIndex - 1);
      stack.push({
        node: child.subtree,
        iter: iterateChildren(lang, child.subtree, child.position),
        inherited: field === null ? frame.inherited : field,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(blob, sourceBytes) {
  const lang = new Language(blob);
  const parser = new Parser(lang, sourceBytes);
  const root = parser.parse();
  return { lang, root, startByte: root.padding };
}

export { Unsupported };
