// A table-driven parser that consumes the data blob `harness/ts_transcode.py`
// emits and produces the same trees tree-sitter does.
//
// Route C3 in `docs/parse-layer.md`: same tables, same algorithm, therefore the
// same trees -- with no wasm and no code in the shipped package. This file is
// the "same algorithm" half, ported from tree-sitter 0.26.0's `lib/src`
// (`parser.c`, `stack.c`, `subtree.c`, `node.c`, `lexer.c`, `language.c`).
//
// What this supports is one projection: **byte offsets, and the visible tree**,
// for a full parse of any input -- broken input included. Not implemented (see
// `docs/parse-tables-spike.md`):
//
//   * incremental reparse -- old-tree reuse, ReusableNode, __breakdown_top_of_stack
//   * external scanners   -- the transcoder refuses grammars that have one
//   * repeat rebalancing  -- ts_parser__balance_subtree, a rotation among
//                            same-symbol invisible repeat nodes that preserves
//                            leaf order and so cannot change the visible tree
//
// Row and column tracking **is** implemented, as of the scanner slice, even
// though nothing in the emitted trees reads it: they carry byte offsets only.
// It is here because upstream's `ts_lexer__do_advance` maintains the extent on
// every advance, so a port that skipped it would have to diverge deliberately,
// and because one of the two consumers that read extents -- `get_column`, for
// external scanners -- is being built now. Recovery, upstream's other consumer,
// charges per skipped line by counting newlines in the source (`rowsIn`) rather
// than by reading an extent. The corpus cannot check any of the row/column
// state; the evidence for it is `harness/ts_lr.test.mjs`.
//
// The guarantee is narrower than "reaching any of them throws", and the precise
// claim matters: **unsupported behaviour that can affect this projection is
// rejected.** External scanners throw, because reaching them would change the
// tree. Repeat rebalancing does not: it is skipped at parser completion and
// cannot change the visible tree by construction. Incremental reparse has no
// entry point at all rather than a throwing one -- there is nowhere to pass an
// old tree.
//
// Error recovery IS implemented, and is checked the same way the clean parse is:
// `ts_check_trees.mjs --edited` requires byte-identical roots against
// `corpus/trees-edited/`, ERROR and MISSING included. That is 44 fixtures across
// json, scheme and go -- a much narrower oracle than the 7,940-file differential
// behind clean parses, since no differential over broken input exists yet.
//
// Each remains a place a reimplementation is green on the corpus and wrong in
// production; that is a statement about scope, not about throwing.

import { ScannerVM } from "./ts_scanner_vm.mjs";
import { decode as decodeScannerPackage } from "./ts_scanner_pack.mjs";

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
const MAX_SUMMARY_DEPTH = 16;
const TS_DECODE_ERROR = -1;
const BYTE_ORDER_MARK = 0xfeff;

// lib/src/error_costs.h. Recovery is entirely a cost-minimisation, and these
// five integers are the whole objective function -- so they are the numbers a
// second runtime has to agree with exactly, not approximately.
const ERROR_COST_PER_RECOVERY = 500;
const ERROR_COST_PER_MISSING_TREE = 110;
const ERROR_COST_PER_SKIPPED_TREE = 100;
const ERROR_COST_PER_SKIPPED_LINE = 30;
const ERROR_COST_PER_SKIPPED_CHAR = 1;
const MAX_COST_DIFFERENCE = 18 * ERROR_COST_PER_SKIPPED_TREE;

class Unsupported extends Error {}

// The blob carries the packed scanner as base64, because the blob is JSON.
// Decoding to bytes and then through the shared wire-format reader means the
// parser and `spike/scanner-vm/rust/` consume the identical byte string.
function decodeScannerProgram(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decodeScannerPackage(bytes);
}

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
    this.externalTokenCount = blob.externalTokenCount || 0;
    this.externalScannerSymbolMap = blob.externalScannerSymbolMap || [];
  }

  // ts_language_enabled_external_tokens. External lex state 0 means "no
  // external scanning here" and upstream returns NULL; the caller never gets
  // that far, because ts_parser__lex tests the state first.
  enabledExternalTokens(externalLexState) {
    if (externalLexState === 0) return null;
    const n = this.externalTokenCount;
    const base = externalLexState * n;
    return this.b.externalScannerStates.slice(base, base + n);
  }

  // The scanner's own token index -> TSSymbol.
  externalSymbol(resultSymbol) {
    const symbol = this.externalScannerSymbolMap[resultSymbol];
    if (symbol === undefined) {
      throw new Unsupported(
        `scanner returned external token ${resultSymbol}, but the grammar has ` +
        `${this.externalTokenCount}`
      );
    }
    return symbol;
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

  // ts_language_has_reduce_action. Only the *first* action counts: a state that
  // shifts before it reduces is not a state a missing token can unblock.
  hasReduceAction(state, symbol) {
    const entry = this.tableEntry(state, symbol);
    return entry.c > 0 && entry.a[0][0] === 1;
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

  // ts_language_lex_mode_for_state. Read as a unit because error mode replaces
  // the whole mode, external lex state included.
  lexMode(state) {
    return {
      lexState: this.b.lexStates[state],
      externalLexState: this.b.externalLexStates[state],
      reservedWordSetId: this.b.reservedWordSetIds[state],
    };
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
// Length arithmetic, mirroring lib/src/length.h and lib/src/point.h.
//
// A Length is `{bytes, row, column}` -- a byte count paired with the extent it
// spans. **`column` counts bytes within the row, not codepoints**: upstream's
// `ts_lexer__do_advance` does `extent.column += lookahead_size`. The other
// column, the one `get_column` returns, counts *codepoints* and lives in the
// lexer's `columnValue`. Two different numbers with the same name, and the
// distinction is upstream's rather than this port's.
// ---------------------------------------------------------------------------

function len(bytes, row, column) {
  return { bytes, row, column };
}

const LENGTH_ZERO = len(0, 0, 0);

// point_add: a row carried by the right operand resets the column.
function lengthAdd(a, b) {
  return b.row > 0
    ? len(a.bytes + b.bytes, a.row + b.row, b.column)
    : len(a.bytes + b.bytes, a.row, a.column + b.column);
}

// point_sub, with the same saturation on both fields upstream has.
function lengthSub(a, b) {
  const bytes = a.bytes >= b.bytes ? a.bytes - b.bytes : 0;
  return a.row > b.row
    ? len(bytes, a.row - b.row, a.column)
    : len(bytes, 0, a.column >= b.column ? a.column - b.column : 0);
}

// ---------------------------------------------------------------------------
// Lexer, mirroring lib/src/lexer.c for a single default included range and a
// whole-buffer string input (which is what ts_parser_parse_string gives it).
// ---------------------------------------------------------------------------

class Lexer {
  constructor(bytes) {
    this.buf = bytes;
    this.len = bytes.length;
    this.pos = 0;
    this.row = 0;
    this.column = 0;
    this.chunkStart = 0;
    this.chunkSize = 0;
    this.hasChunk = false;
    this.atEof = false;
    this.lookahead = 0;
    this.lookaheadSize = 0;
    this.tokenStart = 0;
    this.tokenStartRow = 0;
    this.tokenStartColumn = 0;
    this.tokenEnd = -1;
    this.tokenEndRow = 0;
    this.tokenEndColumn = 0;
    this.resultSymbol = 0;
    // ColumnData: the *codepoint* column, cached because recomputing it means
    // re-reading the line from its start. `valid` is cleared by any seek,
    // because a seek lands somewhere the running count knows nothing about.
    this.columnValid = false;
    this.columnValue = 0;
    // Set by getColumn(), read once per external scan by ts_parser__lex, and
    // stamped onto the resulting leaf as `dependsOnColumn`.
    this.didGetColumn = false;
  }

  position() {
    return len(this.pos, this.row, this.column);
  }

  tokenStartPosition() {
    return len(this.tokenStart, this.tokenStartRow, this.tokenStartColumn);
  }

  tokenEndPosition() {
    return len(this.tokenEnd, this.tokenEndRow, this.tokenEndColumn);
  }

  setColumnData(value) {
    this.columnValid = true;
    this.columnValue = value;
  }

  incrementColumnData() {
    if (this.columnValid) this.columnValue++;
  }

  invalidateColumnData() {
    this.columnValid = false;
    this.columnValue = 0;
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
  // range 0, so it always clears EOF and invalidates the chunk. Takes a full
  // Length, because a seek has to restore the extent as well as the offset --
  // there is no way to recompute a row from a byte offset alone.
  gotoPos(position) {
    if (position.bytes !== this.pos) this.invalidateColumnData();
    this.pos = position.bytes;
    this.row = position.row;
    this.column = position.column;
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
    if (position.bytes !== this.pos) this.gotoPos(position);
  }

  start() {
    this.tokenStart = this.pos;
    this.tokenStartRow = this.row;
    this.tokenStartColumn = this.column;
    this.tokenEnd = -1;
    this.resultSymbol = 0;
    this.didGetColumn = false;
    if (!this.atEof) {
      if (!this.chunkSize) this.getChunk();
      if (!this.lookaheadSize) this.getLookahead();
      if (this.pos === 0) {
        if (this.lookahead === BYTE_ORDER_MARK) this.advance(true);
        // Unconditional upstream, not an else-branch: at byte 0 the codepoint
        // column is known to be 0 whether or not a BOM was skipped.
        this.setColumnData(0);
      }
    }
  }

  // ts_lexer_finish. Returns the lookahead end byte this pass reached, which
  // the caller maxes into its running value -- upstream passes a pointer.
  finish() {
    if (this.tokenEnd < 0) this.markEnd();
    if (this.tokenEnd < this.tokenStart) {
      this.tokenStart = this.tokenEnd;
      this.tokenStartRow = this.tokenEndRow;
      this.tokenStartColumn = this.tokenEndColumn;
    }
    let end = this.pos + 1;
    // Deciding a byte sequence is invalid took a look at what follows it, so
    // the following bytes are part of what this token depended on. Four is
    // upstream's constant: the most bytes read to reject a code point.
    if (this.lookahead === TS_DECODE_ERROR) end += 4;
    return end;
  }

  // ts_lexer__mark_end, specialised: with one included range the boundary
  // special case cannot fire.
  markEnd() {
    this.tokenEnd = this.pos;
    this.tokenEndRow = this.row;
    this.tokenEndColumn = this.column;
  }

  // ts_lexer__advance: the guarded entry point the DFA and scanners call.
  advance(skip) {
    if (!this.hasChunk) return;
    this.doAdvance(skip);
  }

  // ts_lexer__do_advance, split out because get_column calls it directly and
  // deliberately bypasses the `if (!chunk) return` guard above.
  doAdvance(skip) {
    if (this.lookaheadSize) {
      if (this.lookahead === 0x0a) {
        this.row++;
        this.column = 0;
        this.setColumnData(0);
      } else {
        // A leading BOM is not a character, so it does not advance the
        // codepoint column -- but it does advance the byte column.
        const isBom = this.pos === 0 && this.lookahead === BYTE_ORDER_MARK;
        if (!isBom) this.incrementColumnData();
        this.column += this.lookaheadSize;
      }
      this.pos += this.lookaheadSize;
    }
    // The included-range walk in ts_lexer__do_advance cannot fire here: the
    // default range's end_byte is UINT32_MAX.
    if (skip) {
      this.tokenStart = this.pos;
      this.tokenStartRow = this.row;
      this.tokenStartColumn = this.column;
    }
    if (this.pos < this.chunkStart || this.pos >= this.chunkStart + this.chunkSize) {
      this.getChunk();
    }
    this.getLookahead();
  }

  // ts_lexer__get_column. The one lexer call with a non-trivial cost: when the
  // cache is cold it seeks to the start of the line and re-walks it, counting
  // codepoints. `column` is the *byte* offset within the row, which is exactly
  // what has to be subtracted to find the line start.
  //
  // No scanner in the pinned roster calls this, and the scanner VM has no
  // opcode for it (docs/scanner-vm.md reserves 0x06 and traps). It is here
  // because upstream's lexer has it and because a scanner that did call it
  // would otherwise diverge silently rather than loudly.
  getColumn() {
    this.didGetColumn = true;
    if (!this.columnValid) {
      const goalByte = this.pos;
      this.gotoPos(len(this.pos - this.column, this.row, 0));
      this.setColumnData(0);
      this.getChunk();
      if (!this.atEof) {
        this.getLookahead();
        while (this.pos < goalByte && !this.atEof && this.hasChunk) {
          this.doAdvance(false);
          if (this.atEof) break;
        }
      }
    }
    return this.columnValue;
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
          // Always test the set. An empty set means the guard is false, not
          // that there is no guard -- a predicate false in both eof modes
          // (`lookahead < 0 && lookahead >= 0`) collapses to one, and
          // short-circuiting on length would invert it. Genuinely
          // unconditional actions are op 3, and the full domain has an
          // explicit non-empty representation.
          if (!inRanges(op[2], lookahead)) continue;
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
    // `padding` and `size` stay byte counts, because that is all the emitted
    // trees carry. The row/column halves of the same two Lengths ride
    // alongside as scalars rather than replacing them, so every existing
    // reader of `.padding` / `.size` is untouched.
    this.padding = 0;
    this.paddingRow = 0;
    this.paddingColumn = 0;
    this.size = 0;
    this.sizeRow = 0;
    this.sizeColumn = 0;
    this.dependsOnColumn = false;
    // External scanner bookkeeping. `externalScannerState` is the serialized
    // VM state at the moment this token was produced, and it is only ever set
    // on a leaf -- upstream reads it through ts_subtree_external_scanner_state,
    // which returns the empty state for anything with children.
    this.hasExternalTokens = false;
    this.hasExternalScannerStateChange = false;
    this.externalScannerState = null;
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
    this.lookaheadChar = 0;
  }

  get totalSize() {
    return this.padding + this.size;
  }

  get paddingLength() {
    return len(this.padding, this.paddingRow, this.paddingColumn);
  }

  get sizeLength() {
    return len(this.size, this.sizeRow, this.sizeColumn);
  }

  // ts_subtree_total_size
  get totalSizeLength() {
    return lengthAdd(this.paddingLength, this.sizeLength);
  }

  setPaddingLength(l) {
    this.padding = l.bytes;
    this.paddingRow = l.row;
    this.paddingColumn = l.column;
  }

  setSizeLength(l) {
    this.size = l.bytes;
    this.sizeRow = l.row;
    this.sizeColumn = l.column;
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

function newLeaf(
  lang, symbol, padding, size, lookaheadBytes, parseState, isKeyword,
  dependsOnColumn, hasExternalTokens,
) {
  const t = new Subtree();
  t.symbol = symbol;
  t.setPaddingLength(padding);
  t.setSizeLength(size);
  t.dependsOnColumn = !!dependsOnColumn;
  t.hasExternalTokens = !!hasExternalTokens;
  t.lookaheadBytes = lookaheadBytes;
  t.parseState = parseState;
  t.visible = lang.visible(symbol);
  t.named = lang.named(symbol);
  t.extra = symbol === TS_BUILTIN_SYM_END;
  t.isKeyword = isKeyword;
  return t;
}

// ts_subtree_new_error: the leaf the lexer emits for characters no token rule
// accepts. This is a *leaf* ERROR, and it is not the same thing as the ERROR
// *node* that recovery wraps around already-parsed subtrees -- upstream tells
// them apart by child count in exactly one place, the cost branch below, where
// a childless ERROR child must not be charged twice.
function newError(lang, lookaheadChar, padding, size, lookaheadBytes, parseState) {
  const t = newLeaf(lang, TS_BUILTIN_SYM_ERROR, padding, size, lookaheadBytes, parseState, false);
  t.fragileLeft = true;
  t.fragileRight = true;
  t.lookaheadChar = lookaheadChar;
  return t;
}

// ts_subtree_new_missing_leaf: zero-width, carrying the symbol the parser
// wanted and did not get. `isMissing` is what `corpus/trees-edited/` records as
// `"missing": true`, and it is the only thing separating this from a genuine
// empty leaf.
function newMissingLeaf(lang, symbol, padding, lookaheadBytes) {
  const t = newLeaf(lang, symbol, padding, LENGTH_ZERO, lookaheadBytes, 0, false);
  t.isMissing = true;
  return t;
}

// ts_subtree_error_cost. An *accessor*, not the field, and the difference is
// load-bearing: a MISSING leaf accumulates no cost of its own and is expensive
// anyway, so every comparison that ranks parse versions has to be told. Reading
// the raw field makes an invented token look free, which silently suppresses
// recovery strategy 1 everywhere a missing token was inserted.
function subtreeErrorCost(t) {
  if (t.isMissing) return ERROR_COST_PER_MISSING_TREE + ERROR_COST_PER_RECOVERY;
  return t.errorCost;
}

// ts_subtree_new_error_node
function newErrorNode(lang, children, extra, buf, startByte) {
  const t = newNode(lang, TS_BUILTIN_SYM_ERROR, children, 0, buf, startByte);
  t.extra = extra;
  return t;
}

// `Length.extent.row` over a byte span. Upstream accumulates row and column
// through the lexer; this port tracks byte offsets only, because the visible
// tree never reads extents -- except here, where three error-cost terms charge
// per skipped line.
//
// Counting newlines in the buffer is not an approximation of that number, it is
// the same number by a different route: a subtree's span is contiguous over the
// very bytes the lexer walked, and `\n` is the only thing upstream counts
// (`lexer.c:202`). So this stays exact without the extent plumbing.
//
// TODO: row/column tracking is being added on another branch. When it lands,
// the three callers should read real extents and this should go.
function rowsIn(buf, from, to) {
  if (!buf) return 0;
  let rows = 0;
  for (let i = from; i < to; i++) if (buf[i] === 0x0a) rows++;
  return rows;
}

// ts_subtree_summarize_children
function summarizeChildren(self, lang, buf, startByte) {
  self.namedChildCount = 0;
  self.visibleChildCount = 0;
  self.errorCost = 0;
  self.repeatDepth = 0;
  self.visibleDescendantCount = 0;
  self.dynamicPrecedence = 0;
  self.dependsOnColumn = false;
  self.hasExternalTokens = false;
  self.hasExternalScannerStateChange = false;

  let structuralIndex = 0;
  const hasAliases = lang.hasAliasSequence(self.productionId);
  let lookaheadEndByte = 0;
  const children = self.children;

  for (let i = 0; i < self.childCount; i++) {
    const child = children[i];

    // Read before this child is folded in, exactly as upstream does: a node
    // only inherits a column dependency while it is still on its first row,
    // because past a newline the column no longer depends on what preceded it.
    if (self.sizeRow === 0 && child.dependsOnColumn) self.dependsOnColumn = true;
    if (child.hasExternalScannerStateChange) self.hasExternalScannerStateChange = true;

    if (i === 0) {
      self.setPaddingLength(child.paddingLength);
      self.setSizeLength(child.sizeLength);
    } else {
      self.setSizeLength(lengthAdd(self.sizeLength, child.totalSizeLength));
    }

    const childLookaheadEnd = self.padding + self.size + child.lookaheadBytes;
    if (childLookaheadEnd > lookaheadEndByte) lookaheadEndByte = childLookaheadEnd;

    if (child.symbol !== TS_BUILTIN_SYM_ERROR_REPEAT) self.errorCost += subtreeErrorCost(child);

    const grandchildCount = child.childCount;
    if (self.symbol === TS_BUILTIN_SYM_ERROR || self.symbol === TS_BUILTIN_SYM_ERROR_REPEAT) {
      // What an ERROR wrapper charges for what it swallowed. A childless ERROR
      // child is the lexer's skipped-character leaf, which already paid for
      // itself below; charging it again here would double-count every
      // unrecognised character.
      if (!child.extra && !(child.symbol === TS_BUILTIN_SYM_ERROR && grandchildCount === 0)) {
        if (child.visible) {
          self.errorCost += ERROR_COST_PER_SKIPPED_TREE;
        } else if (grandchildCount > 0) {
          self.errorCost += ERROR_COST_PER_SKIPPED_TREE * child.visibleChildCount;
        }
      }
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

    if (child.hasExternalTokens) self.hasExternalTokens = true;

    // ts_subtree_is_error, which is the symbol test and nothing else. This read
    // `|| child.isMissing` until recovery was written, which was dead while no
    // missing leaf could exist and would have quietly diverged the moment one
    // could: upstream does not make a parent fragile for a MISSING child, in
    // 0.25.2, 0.26.0 or 0.26.8.
    if (child.symbol === TS_BUILTIN_SYM_ERROR) {
      self.fragileLeft = true;
      self.fragileRight = true;
      self.parseState = TS_TREE_STATE_NONE;
    }

    if (!child.extra) structuralIndex++;
  }

  self.lookaheadBytes = lookaheadEndByte - self.size - self.padding;

  // What the wrapper itself costs, charged once. `startByte` is the node's own
  // offset including padding, so the size span is [start + padding, ... + size)
  // -- the same bytes upstream's Length accumulated over.
  if (self.symbol === TS_BUILTIN_SYM_ERROR || self.symbol === TS_BUILTIN_SYM_ERROR_REPEAT) {
    const sizeStart = startByte + self.padding;
    self.errorCost +=
      ERROR_COST_PER_RECOVERY +
      ERROR_COST_PER_SKIPPED_CHAR * self.size +
      ERROR_COST_PER_SKIPPED_LINE * rowsIn(buf, sizeStart, sizeStart + self.size);
  }

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

// `buf` and `startByte` are read only when `symbol` is ERROR or ERROR_REPEAT,
// where the cost of the node depends on how many lines it spans. Callers that
// cannot build an error node need not pass them.
function newNode(lang, symbol, children, productionId, buf, startByte) {
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
  summarizeChildren(t, lang, buf, startByte === undefined ? 0 : startByte);
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

// ts_subtree_external_scanner_state: the empty state for anything that is not
// a leaf carrying one. Returned as a zero-length view so callers never have to
// null-check.
const EMPTY_EXTERNAL_STATE = new Uint8Array(0);

function externalScannerState(tree) {
  if (tree && tree.hasExternalTokens && tree.childCount === 0 && tree.externalScannerState) {
    return tree.externalScannerState;
  }
  return EMPTY_EXTERNAL_STATE;
}

function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ts_external_scanner_state_eq over two subtrees, either of which may be null.
function externalScannerStateEq(left, right) {
  return bytesEq(externalScannerState(left), externalScannerState(right));
}

// ts_subtree_last_external_token: the rightmost leaf that carries scanner
// state, which is the state a later scan has to resume from.
function subtreeLastExternalToken(tree) {
  if (!tree || !tree.hasExternalTokens) return null;
  while (tree.childCount > 0) {
    let next = null;
    for (let i = tree.childCount - 1; i >= 0; i--) {
      if (tree.children[i].hasExternalTokens) {
        next = tree.children[i];
        break;
      }
    }
    if (!next) break;
    tree = next;
  }
  return tree;
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
      // A Length, not a byte count: ts_lexer_reset needs the extent to seek to,
      // and a row cannot be recovered from an offset alone.
      this.position = previous.position;
      this.errorCost = previous.errorCost;
      this.dynamicPrecedence = previous.dynamicPrecedence;
      this.nodeCount = previous.nodeCount;
      if (subtree) {
        this.errorCost += subtreeErrorCost(subtree);
        this.position = lengthAdd(this.position, subtree.totalSizeLength);
        this.nodeCount += subtreeNodeCount(subtree);
        this.dynamicPrecedence += subtree.dynamicPrecedence;
      }
    } else {
      this.position = LENGTH_ZERO;
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
  if (subtreeErrorCost(left) > 0 && subtreeErrorCost(right) > 0) return true;
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
        existing.node.position.bytes === link.node.position.bytes &&
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
        summary: null,
        lastExternalToken: null,
      },
    ];
  }

  get versionCount() {
    return this.heads.length;
  }

  state(v) {
    return this.heads[v].node.state;
  }

  // Bytes, which is what every caller but the lexer wants.
  position(v) {
    return this.heads[v].node.position.bytes;
  }

  // The full Length, for ts_lexer_reset.
  positionLength(v) {
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
      result += ERROR_COST_PER_RECOVERY;
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
      summary: null,
      // Inherited, not reset: a forked version resumes the scanner from
      // wherever the version it forked from had got to.
      lastExternalToken: this.heads[originalVersion].lastExternalToken,
    });
    return this.heads.length - 1;
  }

  // ts_stack_copy_version. The copy deliberately does not inherit the summary:
  // upstream nulls it, because a summary describes one version's own history.
  copyVersion(version) {
    const head = this.heads[version];
    this.heads.push({
      node: head.node,
      nodeCountAtLastError: head.nodeCountAtLastError,
      status: head.status,
      lookaheadWhenPaused: head.lookaheadWhenPaused,
      summary: null,
      lastExternalToken: head.lastExternalToken,
    });
    return this.heads.length - 1;
  }

  // ts_stack_resume
  resume(version) {
    const head = this.heads[version];
    const result = head.lookaheadWhenPaused;
    head.status = StackStatus.Active;
    head.lookaheadWhenPaused = null;
    return result;
  }

  // ts_stack_record_summary, via summarize_stack_callback. The summary is the
  // list of (state, depth, position) triples reachable by walking back down the
  // stack, deduplicated by (depth, state) and cut off at `maxDepth`. It is what
  // recovery strategy 1 searches for a state the lookahead is valid in, so its
  // *order* is load-bearing: the first entry that works wins.
  recordSummary(version, maxDepth) {
    const summary = [];
    this.iter(
      version,
      (it) => {
        const state = it.node.state;
        const depth = it.subtreeCount;
        if (depth > maxDepth) return 1; // StackActionStop
        for (let i = summary.length - 1; i >= 0; i--) {
          const entry = summary[i];
          if (entry.depth < depth) break;
          if (entry.depth === depth && entry.state === state) return 0;
        }
        summary.push({ position: it.node.position.bytes, depth, state });
        return 0;
      },
      false,
    );
    this.heads[version].summary = summary;
  }

  getSummary(version) {
    return this.heads[version].summary;
  }

  // ts_stack_pop_error: pop the one ERROR subtree sitting at the top of this
  // version, if there is one. Upstream asserts the result is a single slice.
  popError(version) {
    const node = this.heads[version].node;
    for (const link of node.links) {
      if (link.subtree && link.subtree.symbol === TS_BUILTIN_SYM_ERROR) {
        let foundError = false;
        const pop = this.iter(
          version,
          (it) => {
            if (it.subtrees.length > 0) {
              if (!foundError && it.subtrees[0].symbol === TS_BUILTIN_SYM_ERROR) {
                foundError = true;
                return 3; // Pop | Stop
              }
              return 1; // Stop
            }
            return 0;
          },
          true,
        );
        if (pop.length > 0) {
          this.renumberVersion(pop[0].version, version);
          return pop[0].subtrees;
        }
        break;
      }
    }
    return [];
  }

  lastExternalToken(v) {
    return this.heads[v].lastExternalToken;
  }

  setLastExternalToken(v, token) {
    this.heads[v].lastExternalToken = token;
  }

  // ts_stack_has_advanced_since_error. Only consulted by the empty-external-
  // token guard, which is what stops a scanner that returns a zero-width token
  // forever from hanging the parse.
  hasAdvancedSinceError(v) {
    const head = this.heads[v];
    let node = head.node;
    if (node.errorCost === 0) return true;
    while (node) {
      if (node.links.length > 0) {
        const subtree = node.links[0].subtree;
        if (subtree) {
          if (subtree.totalSize > 0) return true;
          // The accessor, not the field: upstream reads ts_subtree_error_cost,
          // and a MISSING leaf is expensive without accumulating a cost of its
          // own. Reading `.errorCost` here would walk past an inserted token as
          // though it were free.
          if (node.nodeCount > head.nodeCountAtLastError && subtreeErrorCost(subtree) === 0) {
            node = node.links[0].node;
            continue;
          }
        }
      }
      break;
    }
    return false;
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
      h1.node.position.bytes === h2.node.position.bytes &&
      h1.node.errorCost === h2.node.errorCost &&
      // Two versions that agree on everything visible can still be resuming
      // the scanner from different state, and merging them would silently pick
      // one. Upstream compares here for exactly that reason.
      externalScannerStateEq(h1.lastExternalToken, h2.lastExternalToken)
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
    // The summary is the one part of a head that does not travel with its node.
    // A version created by popping has none, so renumbering it over a version
    // that does would throw away recovery's memory of where it may rewind to --
    // and strategy 1 then silently stops firing. Upstream moves it across.
    const source = this.heads[v1];
    const target = this.heads[v2];
    if (target.summary && !source.summary) source.summary = target.summary;
    this.heads[v2] = source;
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

// ts_reduce_action_set_add: a set keyed on (symbol, count) only -- two
// reductions that agree on those are the same reduction for this purpose, even
// if their precedence or production differs, and the first one wins.
function reduceActionSetAdd(set, symbol, count, dynamicPrecedence, productionId) {
  for (const action of set) {
    if (action.symbol === symbol && action.count === count) return;
  }
  set.push({ symbol, count, dynamicPrecedence, productionId });
}

class Parser {
  constructor(lang, bytes) {
    this.lang = lang;
    this.lexer = new Lexer(bytes);
    this.stack = new Stack();
    this.finishedTree = null;
    this.acceptCount = 0;
    this.cachedToken = null;
    this.cachedTokenByteIndex = 0;
    this.cachedTokenLastExternalToken = null;

    // The external scanner, if the grammar has one. `lib/src/wasm_store.c`
    // copies every data table out of a grammar and leaves the scanner's entry
    // points as code; this is the same split, with bytecode standing in for
    // the code half so that both runtimes execute one artifact.
    this.scanner = null;
    this.vmLexer = null;
    if (lang.externalTokenCount > 0) {
      const packed = lang.b.scannerProgram;
      if (!packed) {
        throw new Unsupported(
          `grammar has ${lang.externalTokenCount} external tokens but the blob ` +
          `carries no scanner program: re-run ts_transcode.py with --scanner`
        );
      }
      this.scanner = new ScannerVM(decodeScannerProgram(packed));
      // The VM's whole host interface, and it really is four methods: the
      // catalogue in docs/scanner-vm.md says no scanner in the roster calls
      // get_column, so there is deliberately no opcode for it.
      const lexer = this.lexer;
      this.vmLexer = {
        lookahead: () => lexer.lookahead,
        advance: (skip) => lexer.advance(skip),
        markEnd: () => lexer.markEnd(),
        atEof: () => lexer.atEof,
      };
    }
  }

  // ts_parser__lex
  lex(version, parseState) {
    const lang = this.lang;
    let lexMode = lang.lexMode(parseState);
    if (lexMode.lexState === NO_LEX_STATE) return null;

    const startPosition = this.stack.positionLength(version);
    // The scanner state this version last left off in. Per stack head, not per
    // parser, because two GLR versions can be mid-way through different
    // constructs -- inside a multiline string on one and not on the other.
    const externalToken = this.stack.lastExternalToken(version);

    let foundExternalToken = false;
    let calledGetColumn = false;
    let errorMode = parseState === ERROR_STATE;
    let lookaheadEndByte = 0;
    let scannerStateBytes = null;
    let scannerStateChanged = false;
    const lexer = this.lexer;
    lexer.reset(startPosition);

    // The skipped-character path. When no token rule matches even in the error
    // lex state, upstream consumes characters one at a time until one of them
    // does, and emits a single ERROR *leaf* covering the run it swallowed. The
    // loop keeps going after that, so the leaf covers only the bad characters
    // and the following token is lexed normally on the next call.
    let skippedError = false;
    let firstErrorCharacter = 0;
    let errorStart = 0;
    let errorEnd = 0;
    // The Length twins of the two offsets above. `padding` and `size` are
    // extents now, and neither can be recovered from a byte offset alone.
    let errorStartLength = LENGTH_ZERO;
    let errorEndLength = LENGTH_ZERO;

    for (;;) {
      let found = false;
      const currentPosition = lexer.position();
      // Saved and restored around a failed external scan: the scanner may have
      // advanced the lexer, and the column cache it left behind describes a
      // position the internal lexer is about to be rewound away from.
      const savedColumnValid = lexer.columnValid;
      const savedColumnValue = lexer.columnValue;

      if (lexMode.externalLexState !== 0) {
        const valid = lang.enabledExternalTokens(lexMode.externalLexState);
        lexer.start();
        this.scanner.deserialize(externalScannerState(externalToken));
        const result = this.scanner.scan(this.vmLexer, valid);
        if (result.ok) lexer.resultSymbol = result.symbol;
        found = result.ok;
        lookaheadEndByte = Math.max(lookaheadEndByte, lexer.finish());

        if (found) {
          scannerStateBytes = this.scanner.serialize();
          scannerStateChanged = !bytesEq(externalScannerState(externalToken), scannerStateBytes);

          // Empty-token guard. A scanner returning a zero-width token that also
          // changes no state would be asked again at the same offset forever.
          // Upstream keeps such a token only when it is genuinely making
          // progress -- Python's indent/dedent tokens are the reason it is a
          // guard rather than a refusal.
          if (lexer.tokenEnd <= currentPosition.bytes && !scannerStateChanged) {
            const symbol = lang.externalSymbol(lexer.resultSymbol);
            const tokenIsExtra = lang.nextState(parseState, symbol) === parseState;
            if (errorMode || !this.stack.hasAdvancedSinceError(version) || tokenIsExtra) {
              found = false;
            }
          }
        }

        if (found) {
          foundExternalToken = true;
          calledGetColumn = lexer.didGetColumn;
          break;
        }

        lexer.reset(currentPosition);
        lexer.columnValid = savedColumnValid;
        lexer.columnValue = savedColumnValue;
      }

      lexer.start();
      found = lexer.run(lang.b.lex, lexMode.lexState);
      lookaheadEndByte = Math.max(lookaheadEndByte, lexer.finish());
      if (found) break;

      if (!errorMode) {
        errorMode = true;
        lexMode = lang.lexMode(ERROR_STATE);
        lexer.reset(startPosition);
        continue;
      }

      if (!skippedError) {
        skippedError = true;
        errorStart = lexer.tokenStart;
        errorEnd = lexer.tokenStart;
        errorStartLength = lexer.tokenStartPosition();
        errorEndLength = errorStartLength;
        firstErrorCharacter = lexer.lookahead;
      }

      if (lexer.pos === errorEnd) {
        if (lexer.atEof) break;
        lexer.advance(false);
      }
      errorEnd = lexer.pos;
      errorEndLength = lexer.position();
    }

    if (skippedError) {
      return newError(
        lang,
        firstErrorCharacter,
        lengthSub(errorStartLength, startPosition),
        lengthSub(errorEndLength, errorStartLength),
        lookaheadEndByte - errorEnd,
        parseState,
      );
    }

    let isKeyword = false;
    let symbol = lexer.resultSymbol;
    const padding = lengthSub(lexer.tokenStartPosition(), startPosition);
    const size = lengthSub(lexer.tokenEndPosition(), lexer.tokenStartPosition());
    const lookaheadBytes = lookaheadEndByte - lexer.tokenEnd;

    if (foundExternalToken) {
      symbol = lang.externalSymbol(symbol);
    } else if (symbol === lang.keywordCaptureToken && symbol !== 0) {
      const endByte = lexer.tokenEnd;
      lexer.reset(lexer.tokenStartPosition());
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

    // `dependsOnColumn` is upstream's `called_get_column`: whether producing
    // this token consulted the codepoint column, which is what makes it
    // unsafe to reuse after an edit earlier on the same line.
    const leaf = newLeaf(
      lang, symbol, padding, size, lookaheadBytes, parseState, isKeyword,
      calledGetColumn, foundExternalToken,
    );
    if (foundExternalToken) {
      leaf.externalScannerState = scannerStateBytes;
      leaf.hasExternalScannerStateChange = scannerStateChanged;
    }
    return leaf;
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

  // ts_parser__get_cached_token. The external-state comparison is load-bearing
  // and not an optimisation: the same bytes at the same offset lex to a
  // different token depending on what the scanner was resuming from.
  getCachedToken(state, position, lastExternalToken) {
    if (
      this.cachedToken &&
      this.cachedTokenByteIndex === position &&
      externalScannerStateEq(this.cachedTokenLastExternalToken, lastExternalToken)
    ) {
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
    if (toPush.hasExternalTokens) {
      this.stack.setLastExternalToken(version, subtreeLastExternalToken(toPush));
    }
  }

  // ts_parser__select_tree
  selectTree(left, right) {
    if (!left) return true;
    if (!right) return false;
    if (subtreeErrorCost(right) < subtreeErrorCost(left)) return true;
    if (subtreeErrorCost(left) < subtreeErrorCost(right)) return false;
    if (right.dynamicPrecedence > left.dynamicPrecedence) return true;
    if (left.dynamicPrecedence > right.dynamicPrecedence) return false;
    if (subtreeErrorCost(left) > 0) return true;
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
      const sliceStart = stack.position(sliceVersion);
      let parent = newNode(this.lang, symbol, children, productionId, this.lexer.buf, sliceStart);

      while (i + 1 < pop.length && pop[i + 1].version === slice.version) {
        i++;
        const nextChildren = pop[i].subtrees;
        const nextTrailingExtras = removeTrailingExtras(nextChildren);
        const candidate = newNode(
          this.lang, symbol, nextChildren, productionId, this.lexer.buf, sliceStart,
        );
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
          // The root begins at byte 0, which is what the error-cost branch of
          // summarizeChildren needs if recovery made this root an ERROR.
          root = newNode(this.lang, tree.symbol, spliced, tree.productionId, this.lexer.buf, 0);
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
    const lastExternalToken = stack.lastExternalToken(version);
    const cached = this.getCachedToken(state, position, lastExternalToken);
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
          this.cachedTokenLastExternalToken = lastExternalToken;
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
            if (lookahead.childCount > 0) {
              throw new Unsupported("breakdown of a non-leaf lookahead needs an old tree");
            }
            this.recover(version, lookahead);
            return;
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

  // ts_parser__better_version_exists: would some other live version already be
  // at least as good as this one would be at `cost`? Every recovery decision is
  // guarded by this, which is what stops recovery exploring the whole space.
  betterVersionExists(version, isInError, cost) {
    if (this.finishedTree && subtreeErrorCost(this.finishedTree) <= cost) return true;

    const stack = this.stack;
    const position = stack.position(version);
    const status = {
      cost,
      isInError,
      dynamicPrecedence: stack.dynamicPrecedence(version),
      nodeCount: stack.nodeCountSinceError(version),
    };

    for (let i = 0, n = stack.versionCount; i < n; i++) {
      if (i === version || !stack.isActive(i) || stack.position(i) < position) continue;
      switch (this.compareVersions(status, this.versionStatus(i))) {
        case Cmp.TakeRight:
          return true;
        case Cmp.PreferRight:
          if (stack.canMerge(i, version)) return true;
          break;
      }
    }
    return false;
  }

  // ts_parser__do_all_potential_reductions: perform every reduction reachable in
  // this state under *any* lookahead, forking a version per reduction. After
  // skipping bad tokens the parser may land on a token that would have allowed a
  // reduction, so this closes over them all in advance.
  //
  // With `lookaheadSymbol` 0 it never removes versions and the return value is
  // meaningless; with a symbol it prunes versions that cannot shift it and
  // returns whether any can. Both callers matter: stage 1 uses the first form,
  // the missing-token search uses the second as its accept test.
  doAllPotentialReductions(startingVersion, lookaheadSymbol) {
    const lang = this.lang;
    const stack = this.stack;
    const initialVersionCount = stack.versionCount;

    let canShiftLookaheadSymbol = false;
    let version = startingVersion;
    for (let i = 0; ; i++) {
      const versionCount = stack.versionCount;
      if (version >= versionCount) break;

      let merged = false;
      for (let j = initialVersionCount; j < version; j++) {
        if (stack.merge(j, version)) {
          merged = true;
          break;
        }
      }
      if (merged) continue;

      const state = stack.state(version);
      let hasShiftAction = false;
      const reduceActions = [];

      const firstSymbol = lookaheadSymbol !== 0 ? lookaheadSymbol : 1;
      const endSymbol = lookaheadSymbol !== 0 ? lookaheadSymbol + 1 : lang.tokenCount;
      for (let symbol = firstSymbol; symbol < endSymbol; symbol++) {
        const entry = lang.tableEntry(state, symbol);
        for (let j = 0; j < entry.c; j++) {
          const action = entry.a[j];
          if (action[0] === 0 || action[0] === 3) {
            // Shift is [0, state, extra, repetition]; RECOVER transcodes to the
            // bare [3], matching C, where the macro zeroes the shift half of the
            // union -- so neither flag is set for it either way.
            if (!action[2] && !action[3]) hasShiftAction = true;
          } else if (action[0] === 1 && action[2] > 0) {
            // reduce: [1, symbol, childCount, dynamicPrecedence, productionId]
            reduceActionSetAdd(reduceActions, action[1], action[2], action[3], action[4]);
          }
        }
      }

      let reductionVersion = -1;
      for (const action of reduceActions) {
        reductionVersion = this.reduce(
          version, action.symbol, action.count,
          action.dynamicPrecedence, action.productionId,
          true, false,
        );
      }

      if (hasShiftAction) {
        canShiftLookaheadSymbol = true;
      } else if (reductionVersion !== -1 && i < MAX_VERSION_COUNT) {
        stack.renumberVersion(reductionVersion, version);
        continue;
      } else if (lookaheadSymbol !== 0) {
        stack.removeVersion(version);
      }

      version = version === startingVersion ? versionCount : version + 1;
    }

    return canShiftLookaheadSymbol;
  }

  // ts_parser__recover_to_state: strategy 1's second half. Pop `depth` subtrees,
  // wrap them in an ERROR node, and leave the version sitting in `goalState`.
  recoverToState(version, depth, goalState) {
    const stack = this.stack;
    const pop = stack.popCount(version, depth);
    let previousVersion = -1;

    for (let i = 0; i < pop.length; i++) {
      const slice = pop[i];

      if (slice.version === previousVersion) {
        pop.splice(i--, 1);
        continue;
      }

      if (stack.state(slice.version) !== goalState) {
        stack.halt(slice.version);
        pop.splice(i--, 1);
        continue;
      }

      // If an ERROR is already on the stack here, splice its children in rather
      // than nesting a second ERROR inside the first.
      const errorTrees = stack.popError(slice.version);
      if (errorTrees.length > 0) {
        const errorTree = errorTrees[0];
        if (errorTree.childCount > 0) {
          slice.subtrees.unshift(...errorTree.children);
        }
      }

      const trailingExtras = removeTrailingExtras(slice.subtrees);

      if (slice.subtrees.length > 0) {
        const start = stack.position(slice.version);
        const error = newErrorNode(this.lang, slice.subtrees, true, this.lexer.buf, start);
        stack.push(slice.version, error, false, goalState);
      }

      for (const tree of trailingExtras) {
        stack.push(slice.version, tree, false, goalState);
      }

      previousVersion = slice.version;
    }

    return previousVersion !== -1;
  }

  // ts_parser__recover: the two strategies, tried in order.
  //
  //   1. find a state further down the stack where this lookahead *would* be
  //      valid, and rewind to it, wrapping everything popped in an ERROR;
  //   2. give up on the token: wrap it in an ERROR and stay in the error state.
  //
  // Both are guarded by the same cost arithmetic, and strategy 1 is searched in
  // summary order, so the first entry that both works and is not clearly worse
  // than an existing version wins.
  recover(version, lookahead) {
    const lang = this.lang;
    const stack = this.stack;
    const buf = this.lexer.buf;
    let didRecover = false;
    const previousVersionCount = stack.versionCount;
    const position = stack.position(version);
    const summary = stack.getSummary(version);
    const nodeCountSinceError = stack.nodeCountSinceError(version);
    const currentErrorCost = stack.errorCost(version);

    if (summary && lookahead.symbol !== TS_BUILTIN_SYM_ERROR) {
      for (const entry of summary) {
        if (entry.state === ERROR_STATE) continue;
        if (entry.position === position) continue;
        let depth = entry.depth;
        if (nodeCountSinceError > 0) depth++;

        // Do not recover in ways that create redundant stack versions.
        let wouldMerge = false;
        for (let j = 0; j < previousVersionCount; j++) {
          if (stack.state(j) === entry.state && stack.position(j) === position) {
            wouldMerge = true;
            break;
          }
        }
        if (wouldMerge) continue;

        const newCost =
          currentErrorCost +
          entry.depth * ERROR_COST_PER_SKIPPED_TREE +
          (position - entry.position) * ERROR_COST_PER_SKIPPED_CHAR +
          rowsIn(buf, entry.position, position) * ERROR_COST_PER_SKIPPED_LINE;
        // `break`, not `continue`: entries are ordered by increasing depth, so
        // once one is too expensive every later one is too.
        if (this.betterVersionExists(version, false, newCost)) break;

        if (lang.hasActions(entry.state, lookahead.symbol)) {
          if (this.recoverToState(version, depth, entry.state)) {
            didRecover = true;
            break;
          }
        }
      }
    }

    // Recovery may have created versions that then halted. Drop them.
    for (let i = previousVersionCount; i < stack.versionCount; i++) {
      if (!stack.isActive(i)) {
        stack.removeVersion(i--);
      }
    }

    // At EOF there is no next token to skip to, so wrap the lot and finish.
    if (lookahead.symbol === TS_BUILTIN_SYM_END) {
      const parent = newErrorNode(this.lang, [], false, buf, position);
      stack.push(version, parent, false, 1);
      this.accept(version, lookahead);
      return;
    }

    if (didRecover && stack.versionCount > MAX_VERSION_COUNT) {
      stack.halt(version);
      return;
    }

    const skipCost =
      currentErrorCost + ERROR_COST_PER_SKIPPED_TREE +
      lookahead.totalSize * ERROR_COST_PER_SKIPPED_CHAR +
      rowsIn(buf, position, position + lookahead.totalSize) * ERROR_COST_PER_SKIPPED_LINE;
    if (this.betterVersionExists(version, false, skipCost)) {
      stack.halt(version);
      return;
    }

    // An extra token skipped during recovery stays extra, so it is not counted
    // against the error cost.
    const actions = lang.tableEntry(1, lookahead.symbol);
    if (actions.c > 0) {
      const last = actions.a[actions.c - 1];
      if (last[0] === 0 && last[2]) {
        lookahead = lookahead.clone();
        lookahead.extra = true;
      }
    }

    let errorRepeat = newNode(
      this.lang, TS_BUILTIN_SYM_ERROR_REPEAT, [lookahead], 0, buf, position,
    );

    // If tokens were already skipped there is an ERROR on top of the stack
    // already; pop it and fold both into one.
    if (nodeCountSinceError > 0) {
      const pop = stack.popCount(version, 1);

      if (pop.length > 1) {
        while (stack.versionCount > pop[0].version + 1) {
          stack.removeVersion(pop[0].version + 1);
        }
      }

      stack.renumberVersion(pop[0].version, version);
      pop[0].subtrees.push(errorRepeat);
      errorRepeat = newNode(
        this.lang, TS_BUILTIN_SYM_ERROR_REPEAT, pop[0].subtrees, 0,
        buf, stack.position(version),
      );
    }

    stack.push(version, errorRepeat, false, ERROR_STATE);
  }

  // ts_parser__handle_error: the entry point, reached when every version is
  // paused. Closes over the reductions available here, tries to invent a single
  // missing token that would unblock the lookahead, records the summary that
  // strategy 1 searches, and then recovers.
  handleError(version, lookahead) {
    const lang = this.lang;
    const stack = this.stack;
    const previousVersionCount = stack.versionCount;

    this.doAllPotentialReductions(version, 0);
    const versionCount = stack.versionCount;
    const position = stack.position(version);
    const positionLength = stack.positionLength(version);

    let didInsertMissingToken = false;
    for (let v = version; v < versionCount; ) {
      if (!didInsertMissingToken) {
        const state = stack.state(v);
        // Symbol order is the tie-break, and it is the most arbitrary choice in
        // the whole subsystem: the winner is whichever candidate the grammar
        // numbered lowest, nothing more principled than that.
        for (let missingSymbol = 1; missingSymbol < lang.tokenCount; missingSymbol++) {
          const stateAfter = lang.nextState(state, missingSymbol);
          if (stateAfter === 0 || stateAfter === state) continue;

          if (lang.hasReduceAction(stateAfter, lookahead.leafSymbol)) {
            this.lexer.reset(positionLength);
            this.lexer.markEnd();
            const padding = lengthSub(this.lexer.tokenEndPosition(), positionLength);
            const lookaheadBytes = lookahead.totalSize + lookahead.lookaheadBytes;

            const versionWithMissingTree = stack.copyVersion(v);
            const missingTree = newMissingLeaf(lang, missingSymbol, padding, lookaheadBytes);
            stack.push(versionWithMissingTree, missingTree, false, stateAfter);

            if (this.doAllPotentialReductions(versionWithMissingTree, lookahead.leafSymbol)) {
              didInsertMissingToken = true;
              break;
            }
          }
        }
      }

      // A null subtree is the discontinuity that marks where the parse broke.
      stack.push(v, null, false, ERROR_STATE);
      v = v === version ? previousVersionCount : v + 1;
    }

    for (let i = previousVersionCount; i < versionCount; i++) {
      stack.merge(version, previousVersionCount);
    }

    stack.recordSummary(version, MAX_SUMMARY_DEPTH);

    if (lookahead.childCount > 0) {
      throw new Unsupported("breakdown of a non-leaf lookahead needs an old tree");
    }
    this.recover(version, lookahead);
  }

  versionStatus(version) {
    const stack = this.stack;
    let cost = stack.errorCost(version);
    const isPaused = stack.isPaused(version);
    if (isPaused) cost += ERROR_COST_PER_SKIPPED_TREE;
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

    // Paused versions. Versions are ordered best-first by this point, so a
    // paused version with no unpaused predecessor is the best one there is:
    // resume it and begin recovery. Every other paused version is ordinary GLR
    // pruning and is simply dropped.
    if (stack.versionCount > 0) {
      let hasUnpausedVersion = false;
      for (let i = 0, n = stack.versionCount; i < n; i++) {
        if (stack.isPaused(i)) {
          if (!hasUnpausedVersion && this.acceptCount < MAX_VERSION_COUNT) {
            minErrorCost = stack.errorCost(i);
            const lookahead = stack.resume(i);
            this.handleError(i, lookahead);
            hasUnpausedVersion = true;
          } else {
            stack.removeVersion(i);
            i--;
            n--;
          }
        } else {
          hasUnpausedVersion = true;
        }
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
      if (this.finishedTree && subtreeErrorCost(this.finishedTree) < minErrorCost) {
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

// Exposed for `harness/ts_lr.test.mjs`: the lexer is where the recovered DFA
// is interpreted, and it is the half the corpus covers least.
export function makeLexer(bytes) {
  return new Lexer(bytes);
}

export { Unsupported };

// Exposed for `harness/ts_lr.test.mjs`, alongside `makeLexer` above. These are
// the four places error recovery hides a special case behind something that
// reads like a plain field or a plain utility -- an accessor that is not the
// field it looks like, a "renumber" that also moves the summary, a cost that
// charges per line, and a fragile-parent test that must ignore MISSING. Each
// was wrong here at some point, and none of them is reachable from a clean
// parse, so the corpus cannot stand in for testing them directly.
export const forTests = {
  Stack,
  len,
  newLeaf,
  newNode,
  newErrorNode,
  newMissingLeaf,
  subtreeErrorCost,
};
