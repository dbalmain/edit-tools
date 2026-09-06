// tree-sitter-html 0.23.2's scanner, hand-compiled to scanner-VM bytecode.
// Upstream source is reproduced in comments so the two can be diffed by eye;
// that is the only review this port gets.
//
// Two files: `src/scanner.c` and the `src/tag.h` it includes -- 747 lines
// together, the largest port so far. It is the second scanner holding a stack
// of tag names, so it reuses xml's encoding (see `xml.program.js`) with one
// extra dimension: html's stack element is a *tag type* plus, only for an
// unrecognised tag, a name. Three persistent stacks carry it:
//
//   stack 0  the TagType of each open tag
//   stack 1  the stored-name length of each open tag, 0 for a known tag
//   stack 2  those names' bytes, concatenated flat
//   stack 3  (transient) the name currently being scanned
//
// which is all four the ISA has. That is not a coincidence and it is worth
// noticing: html is the first scanner to use the whole stack file.
//
// ## Why the VM gained an instruction for this
//
// html stores `towupper(lexer->lookahead)` -- not the character -- so which
// two tag names count as the same is decided by the host's case mapping, in
// exactly the way `docs/host-ctype-divergence.md` shows whitespace is. A port
// that called the runtime's own upper-casing would inherit that divergence
// into both runtimes, differently.
//
// It cannot be approximated. Folding only ASCII gets `<DIV>` right and gets
// U+017F (LATIN SMALL LETTER LONG S, which glibc upper-cases to plain `S`)
// wrong, silently. And it cannot be spelled with the existing class tables:
// those answer a membership question, and this is a function. So the ISA gained
// `MAP` -- a table of `[lo, hi, delta]` runs, identity outside them, pinned by
// `harness/ts_ctype_tables.py` from the same glibc that froze the corpus.
// glibc moves 1,477 code points; as runs that is 690 triples.
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('../../spike/scanner-vm/asm.js');

const CTYPE = path.join(__dirname, '..', 'ctype', 'wctype.utf8.json');

// scanner.c's `enum TokenType`.
const START_TAG_NAME = 0;
const SCRIPT_START_TAG_NAME = 1;
const STYLE_START_TAG_NAME = 2;
const END_TAG_NAME = 3;
const ERRONEOUS_END_TAG_NAME = 4;
const SELF_CLOSING_TAG_DELIMITER = 5;
const IMPLICIT_END_TAG = 6;
const RAW_TEXT = 7;
const COMMENT = 8;

// tag.h's `TagType`, in order. The void tags come first so that `tag_is_void`
// can be `type < END_OF_VOID_TAGS`, which is load-bearing below.
const VOID_TAGS = [
  'AREA', 'BASE', 'BASEFONT', 'BGSOUND', 'BR', 'COL', 'COMMAND', 'EMBED',
  'FRAME', 'HR', 'IMAGE', 'IMG', 'INPUT', 'ISINDEX', 'KEYGEN', 'LINK',
  'MENUITEM', 'META', 'NEXTID', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
];
const NORMAL_TAGS = [
  'A', 'ABBR', 'ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'B', 'BDI', 'BDO',
  'BLOCKQUOTE', 'BODY', 'BUTTON', 'CANVAS', 'CAPTION', 'CITE', 'CODE',
  'COLGROUP', 'DATA', 'DATALIST', 'DD', 'DEL', 'DETAILS', 'DFN', 'DIALOG',
  'DIV', 'DL', 'DT', 'EM', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEAD', 'HEADER', 'HGROUP',
  'HTML', 'I', 'IFRAME', 'INS', 'KBD', 'LABEL', 'LEGEND', 'LI', 'MAIN', 'MAP',
  'MARK', 'MATH', 'MENU', 'METER', 'NAV', 'NOSCRIPT', 'OBJECT', 'OL',
  'OPTGROUP', 'OPTION', 'OUTPUT', 'P', 'PICTURE', 'PRE', 'PROGRESS', 'Q', 'RB',
  'RP', 'RT', 'RTC', 'RUBY', 'S', 'SAMP', 'SCRIPT', 'SECTION', 'SELECT',
  'SLOT', 'SMALL', 'SPAN', 'STRONG', 'STYLE', 'SUB', 'SUMMARY', 'SUP', 'SVG',
  'TABLE', 'TBODY', 'TD', 'TEMPLATE', 'TEXTAREA', 'TFOOT', 'TH', 'THEAD',
  'TIME', 'TITLE', 'TR', 'U', 'UL', 'VAR', 'VIDEO',
];

// The enum. `END_OF_VOID_TAGS` sits between the two groups and is a boundary,
// not a tag; `CUSTOM` and `END_` follow the named ones.
const T = {};
VOID_TAGS.forEach((n, i) => { T[n] = i; });
const END_OF_VOID_TAGS = VOID_TAGS.length;
NORMAL_TAGS.forEach((n, i) => { T[n] = END_OF_VOID_TAGS + 1 + i; });
const CUSTOM = END_OF_VOID_TAGS + 1 + NORMAL_TAGS.length;

// `TAG_TYPES_BY_TAG_NAME`, whose order is void tags, then the rest, then a
// literal "CUSTOM" mapping to CUSTOM -- so `<custom>` and `<xyzzy>` reach the
// same type by two different routes. 126 entries; the count is upstream's own
// array bound and worth asserting rather than trusting.
const TAG_NAMES = [...VOID_TAGS, ...NORMAL_TAGS, 'CUSTOM'];
if (TAG_NAMES.length !== 126) {
  throw new Error(`tag table is ${TAG_NAMES.length} entries, upstream declares 126`);
}

// `TAG_TYPES_NOT_ALLOWED_IN_PARAGRAPHS`, upstream's 26.
const NOT_IN_P = [
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
  'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'MAIN',
  'NAV', 'OL', 'P', 'PRE', 'SECTION',
].map((n) => T[n]);
if (NOT_IN_P.length !== 26) throw new Error('upstream iterates exactly 26 entries');

// Class and map table slots.
const C_SPACE = 0;
const C_NAME = 1;                         // iswalnum || '-' || ':'
const M_UPPER = 0;

// Stacks.
const S_TYPES = 0;                        // persistent
const S_LENS = 1;                         // persistent
const S_NAMES = 2;                        // persistent
const S_CUR = 3;                          // transient

// Registers, all transient.
const R_SYM = 0;                          // upstream's lexer->result_symbol
const R_TYPE = 1;                         // next_tag.type
const R_N = 2;
const R_I = 3;
const R_J = 4;
const R_TMP = 5;                          // also every subroutine's return slot
const R_LA = 6;
const R_PTYPE = 7;                        // parent->type, or -1 for NULL
const R_CLOSING = 8;                      // is_closing_tag
const R_BASE = 9;
const R_DASH = 10;
const R_K = 11;

const CH = (c) => c.codePointAt(0);
const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));

function union(...lists) {
  const pairs = [];
  for (const l of lists) for (let i = 0; i < l.length; i += 2) pairs.push([l[i], l[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [lo, hi] of pairs) {
    if (out.length && lo <= out[out.length - 1] + 1) {
      if (hi > out[out.length - 1]) out[out.length - 1] = hi;
    } else {
      out.push(lo, hi);
    }
  }
  return out;
}
const one = (c) => [CH(c), CH(c)];

function build() {
  const ctype = JSON.parse(fs.readFileSync(CTYPE, 'utf8'));
  const a = new Asm();

  // `towupper(lexer->lookahead)` into R_LA. Two call sites, both of which are
  // comparing against a byte, so both truncate afterwards.
  const upper = () => { a.lookahead(R_LA); a.map(M_UPPER, R_LA, R_LA); };

  // ======================================================================
  // scan
  // ======================================================================

  //   if (valid[RAW_TEXT] && !valid[START_TAG_NAME] && !valid[END_TAG_NAME])
  //     return scan_raw_text(scanner, lexer);
  a.label('entry');
  a.ifNValid(RAW_TEXT, 'ws');
  a.ifValid(START_TAG_NAME, 'ws');
  a.ifValid(END_TAG_NAME, 'ws');
  a.jmp('raw_text');

  //   while (iswspace(lexer->lookahead)) skip(lexer);
  a.label('ws');
  a.ifNClass(C_SPACE, 'sw');
  a.skip();
  a.jmp('ws');

  //   switch (lexer->lookahead) {
  a.label('sw');
  a.ifChar(CH('<'), 'sw_lt');
  // `case '\0'` is EOF as well as a literal NUL: tree-sitter reports lookahead
  // 0 at end of input.
  a.ifChar(0, 'sw_nul');
  a.ifChar(CH('/'), 'sw_slash');
  //     default:
  //       if ((valid[START_TAG_NAME] || valid[END_TAG_NAME]) && !valid[RAW_TEXT])
  //         return valid[START_TAG_NAME] ? scan_start_tag_name(...)
  //                                      : scan_end_tag_name(...);
  a.ifValid(START_TAG_NAME, 'sw_names');
  a.ifValid(END_TAG_NAME, 'sw_names');
  a.jmp('fail');
  a.label('sw_names');
  a.ifValid(RAW_TEXT, 'fail');
  a.ifValid(START_TAG_NAME, 'start_tag');
  a.jmp('end_tag');

  //     case '<':
  //       mark_end; advance;
  //       if (lookahead == '!') { advance; return scan_comment(lexer); }
  //       if (valid[IMPLICIT_END_TAG]) return scan_implicit_end_tag(...);
  //       break;
  a.label('sw_lt');
  a.markEnd();
  a.advance();
  a.ifNChar(CH('!'), 'sw_nul');
  a.advance();
  a.jmp('comment');

  //     case '\0':
  //       if (valid[IMPLICIT_END_TAG]) return scan_implicit_end_tag(...);
  //       break;
  // Shared with the '<' fall-through above, which does the same two lines.
  a.label('sw_nul');
  a.ifValid(IMPLICIT_END_TAG, 'implicit_end');
  a.jmp('fail');

  //     case '/':
  //       if (valid[SELF_CLOSING_TAG_DELIMITER])
  //         return scan_self_closing_tag_delimiter(...);
  //       break;
  a.label('sw_slash');
  a.ifNValid(SELF_CLOSING_TAG_DELIMITER, 'fail');

  // ---- scan_self_closing_tag_delimiter ----------------------------------
  //   advance(lexer);
  //   if (lexer->lookahead == '>') {
  //     advance(lexer);
  //     if (scanner->tags.size > 0) { pop_tag(scanner); result = SELF_CLOSING...; }
  //     return true;
  //   }
  //   return false;
  a.advance();
  a.ifNChar(CH('>'), 'fail');
  a.advance();
  a.len(S_TYPES, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'sc_emit');
  a.call('pop_tag');
  a.const_(R_SYM, SELF_CLOSING_TAG_DELIMITER);
  // With no open tag upstream returns true leaving result_symbol at 0 from
  // ts_lexer_start, which is START_TAG_NAME. R_SYM models that field.
  a.label('sc_emit');
  a.emitR(R_SYM);

  // ---- scan_comment -----------------------------------------------------
  //   if (lookahead != '-') return false;  advance;
  //   if (lookahead != '-') return false;  advance;
  a.label('comment');
  a.ifNChar(CH('-'), 'fail');
  a.advance();
  a.ifNChar(CH('-'), 'fail');
  a.advance();
  //   unsigned dashes = 0;
  //   while (lexer->lookahead) {
  //     switch (lexer->lookahead) {
  //       case '-': ++dashes; break;
  //       case '>': if (dashes >= 2) { result = COMMENT; advance; mark_end; return true; }
  //       default:  dashes = 0;          // '>' falls through to here
  //     }
  //     advance(lexer);
  //   }
  //   return false;
  a.const_(R_DASH, 0);
  a.label('cm_loop');
  a.ifChar(0, 'fail');
  a.ifNChar(CH('-'), 'cm_gt');
  a.alui('add', R_DASH, 1);
  a.jmp('cm_next');
  a.label('cm_gt');
  a.ifNChar(CH('>'), 'cm_reset');
  a.ifCmpI('ge', R_DASH, 2, 'cm_emit');
  // The missing `break` on `case '>'` is upstream's, and it matters: a '>' with
  // fewer than two dashes resets the counter rather than leaving it.
  a.label('cm_reset');
  a.const_(R_DASH, 0);
  a.label('cm_next');
  a.advance();
  a.jmp('cm_loop');
  a.label('cm_emit');
  a.advance();
  a.markEnd();
  a.const_(R_SYM, COMMENT);
  a.emit(COMMENT);

  // ---- scan_raw_text ----------------------------------------------------
  //   if (scanner->tags.size == 0) return false;
  //   lexer->mark_end(lexer);
  //   const char *end = array_back(&tags)->type == SCRIPT ? "</SCRIPT" : "</STYLE";
  //   unsigned di = 0;
  //   while (lexer->lookahead) {
  //     if (towupper(lookahead) == end[di]) {
  //       di++;
  //       if (di == strlen(end)) break;
  //       advance;
  //     } else { di = 0; advance; mark_end; }
  //   }
  //   result = RAW_TEXT; return true;
  //
  // `end[di]` is an indexed read of a constant string, which the ISA has no
  // instruction for -- IF_BUF_EQ compares the whole buffer against a whole
  // constant. Unrolling is the answer, and it is exact rather than approximate:
  // both delimiters are fixed, and the match never backtracks. On a mismatch
  // upstream resets to index 0 and advances *past* the current character
  // without re-testing it, which the jump back to `d0` reproduces.
  a.label('raw_text');
  a.len(S_TYPES, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'fail');
  a.markEnd();
  a.peek(S_TYPES, R_TMP, 0);
  a.ifCmpI('eq', R_TMP, T.SCRIPT, 'rt_script_0');

  for (const [tag, word] of [['style', '</STYLE'], ['script', '</SCRIPT']]) {
    for (let i = 0; i < word.length; i++) {
      a.label(`rt_${tag}_${i}`);
      a.ifChar(0, 'rt_done');
      upper();
      a.ifCmpI('ne', R_LA, word.charCodeAt(i), `rt_${tag}_miss`);
      if (i === word.length - 1) {
        a.jmp('rt_done');               // di == strlen(end): break, without advancing
      } else {
        a.advance();
        a.jmp(`rt_${tag}_${i + 1}`);
      }
    }
    a.label(`rt_${tag}_miss`);
    a.advance();
    a.markEnd();
    a.jmp(`rt_${tag}_0`);
  }

  // Reached at EOF too, and upstream returns true there as well.
  a.label('rt_done');
  a.const_(R_SYM, RAW_TEXT);
  a.emit(RAW_TEXT);

  // ---- scan_start_tag_name ----------------------------------------------
  //   String tag_name = scan_tag_name(lexer);
  //   if (tag_name.size == 0) return false;
  //   Tag tag = tag_for_name(tag_name);
  //   array_push(&scanner->tags, tag);
  //   switch (tag.type) {
  //     case SCRIPT: result = SCRIPT_START_TAG_NAME; break;
  //     case STYLE:  result = STYLE_START_TAG_NAME;  break;
  //     default:     result = START_TAG_NAME;        break;
  //   }
  //   return true;
  a.label('start_tag');
  a.call('tag_name');
  a.len(S_CUR, R_N);
  a.ifCmpI('eq', R_N, 0, 'fail');
  a.call('for_name');
  a.call('push_tag');
  a.ifCmpI('eq', R_TYPE, T.SCRIPT, 'st_script');
  a.ifCmpI('eq', R_TYPE, T.STYLE, 'st_style');
  a.const_(R_SYM, START_TAG_NAME);
  a.emit(START_TAG_NAME);
  a.label('st_script');
  a.const_(R_SYM, SCRIPT_START_TAG_NAME);
  a.emit(SCRIPT_START_TAG_NAME);
  a.label('st_style');
  a.const_(R_SYM, STYLE_START_TAG_NAME);
  a.emit(STYLE_START_TAG_NAME);

  // ---- scan_end_tag_name ------------------------------------------------
  //   String tag_name = scan_tag_name(lexer);
  //   if (tag_name.size == 0) return false;
  //   Tag tag = tag_for_name(tag_name);
  //   if (tags.size > 0 && tag_eq(array_back(&tags), &tag)) {
  //     pop_tag(scanner); result = END_TAG_NAME;
  //   } else {
  //     result = ERRONEOUS_END_TAG_NAME;
  //   }
  //   return true;
  //
  // Note the unconditional `true`: unlike xml, html really does emit its
  // erroneous-end-tag token rather than setting it and returning false.
  a.label('end_tag');
  a.call('tag_name');
  a.len(S_CUR, R_N);
  a.ifCmpI('eq', R_N, 0, 'fail');
  a.call('for_name');
  a.len(S_TYPES, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'et_bad');
  a.call('tag_eq');
  a.ifCmpI('eq', R_TMP, 0, 'et_bad');
  a.call('pop_tag');
  a.const_(R_SYM, END_TAG_NAME);
  a.emit(END_TAG_NAME);
  a.label('et_bad');
  a.const_(R_SYM, ERRONEOUS_END_TAG_NAME);
  a.emit(ERRONEOUS_END_TAG_NAME);

  // ---- scan_implicit_end_tag --------------------------------------------
  //   Tag *parent = tags.size == 0 ? NULL : array_back(&tags);
  //   bool is_closing_tag = false;
  //   if (lexer->lookahead == '/') { is_closing_tag = true; advance; }
  //   else if (parent && tag_is_void(parent)) {
  //     pop_tag; result = IMPLICIT_END_TAG; return true;
  //   }
  //
  // `parent` is captured before anything pops, and nothing pops before its
  // last use, so a type in a register is faithful. -1 stands for NULL.
  a.label('implicit_end');
  a.const_(R_PTYPE, -1);
  a.len(S_TYPES, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'ie_noparent');
  a.peek(S_TYPES, R_PTYPE, 0);
  a.label('ie_noparent');
  a.const_(R_CLOSING, 0);
  a.ifNChar(CH('/'), 'ie_notclose');
  a.const_(R_CLOSING, 1);
  a.advance();
  a.jmp('ie_name');
  a.label('ie_notclose');
  a.ifCmpI('lt', R_PTYPE, 0, 'ie_name');
  // tag_is_void is `type < END_OF_VOID_TAGS`, which is why the enum orders the
  // void tags first.
  a.ifCmpI('ge', R_PTYPE, END_OF_VOID_TAGS, 'ie_name');
  a.call('pop_tag');
  a.const_(R_SYM, IMPLICIT_END_TAG);
  a.emit(IMPLICIT_END_TAG);

  //   String tag_name = scan_tag_name(lexer);
  //   if (tag_name.size == 0 && !lexer->eof(lexer)) return false;
  //   Tag next_tag = tag_for_name(tag_name);
  //
  // An empty name at EOF is allowed through, and `tag_type_for_name` finds no
  // zero-length entry, so it becomes CUSTOM with an empty name.
  a.label('ie_name');
  a.call('tag_name');
  a.len(S_CUR, R_N);
  a.ifCmpI('ne', R_N, 0, 'ie_have');
  a.ifNEof('fail');
  a.label('ie_have');
  a.call('for_name');
  a.ifCmpI('eq', R_CLOSING, 0, 'ie_open');

  //   if (is_closing_tag) {
  //     if (tags.size > 0 && tag_eq(array_back(&tags), &next_tag)) return false;
  //     for (unsigned i = tags.size; i > 0; i--) {
  //       if (tags.contents[i - 1].type == next_tag.type) {
  //         pop_tag; result = IMPLICIT_END_TAG; return true;
  //       }
  //     }
  //   }
  //
  // The loop searches from the top down but pops the *top* regardless of where
  // it found the match. Upstream's behaviour, and deliberate -- it queues one
  // implicit end tag per call and is re-entered.
  a.len(S_TYPES, R_TMP);
  a.ifCmpI('eq', R_TMP, 0, 'ie_dig');
  a.call('tag_eq');
  a.ifCmpI('ne', R_TMP, 0, 'fail');
  a.label('ie_dig');
  a.len(S_TYPES, R_I);
  a.label('ie_dig_loop');
  a.ifCmpI('eq', R_I, 0, 'fail');
  a.alui('sub', R_I, 1);
  a.getidx(S_TYPES, R_TMP, R_I);
  a.ifCmp('ne', R_TMP, R_TYPE, 'ie_dig_loop');
  a.call('pop_tag');
  a.const_(R_SYM, IMPLICIT_END_TAG);
  a.emit(IMPLICIT_END_TAG);

  //   } else if (parent && (!tag_can_contain(parent, &next_tag) ||
  //              ((parent->type == HTML || HEAD || BODY) && lexer->eof(lexer)))) {
  //     pop_tag; result = IMPLICIT_END_TAG; return true;
  //   }
  //   return false;
  a.label('ie_open');
  a.ifCmpI('lt', R_PTYPE, 0, 'fail');
  a.call('can_contain');
  a.ifCmpI('eq', R_TMP, 0, 'ie_pop');
  a.ifCmpI('eq', R_PTYPE, T.HTML, 'ie_chk_eof');
  a.ifCmpI('eq', R_PTYPE, T.HEAD, 'ie_chk_eof');
  a.ifCmpI('eq', R_PTYPE, T.BODY, 'ie_chk_eof');
  a.jmp('fail');
  a.label('ie_chk_eof');
  a.ifNEof('fail');
  a.label('ie_pop');
  a.call('pop_tag');
  a.const_(R_SYM, IMPLICIT_END_TAG);
  a.emit(IMPLICIT_END_TAG);

  a.label('fail');
  a.fail();

  // ======================================================================
  // tag.h, as subroutines
  // ======================================================================

  // ---- scan_tag_name ----------------------------------------------------
  //   while (iswalnum(lookahead) || lookahead == '-' || lookahead == ':') {
  //     array_push(&tag_name, towupper(lexer->lookahead));
  //     advance(lexer);
  //   }
  //
  // The push is into a `Array(char)`, so the mapped code point is truncated to
  // its low 8 bits and two names differing only above U+00FF can compare equal
  // upstream. Masking reproduces that.
  //
  // The name goes into both the scratch buffer (for the 126-way name lookup)
  // and stack 3 (for everything else). The buffer stops at BUF_MAX, which is
  // harmless: no tag name in the table is longer than ten bytes, so a name that
  // overflowed the buffer could not have matched one anyway.
  a.label('tag_name');
  a.clear(S_CUR);
  a.bufClr();
  a.label('tn_loop');
  a.ifNClass(C_NAME, 'tn_done');
  upper();
  a.alui('and', R_LA, 0xff);
  a.push(S_CUR, R_LA);
  a.bufLen(R_TMP);
  a.ifCmpI('ge', R_TMP, 32, 'tn_nobuf');
  a.bufPush(R_LA);
  a.label('tn_nobuf');
  a.advance();
  a.jmp('tn_loop');
  a.label('tn_done');
  a.ret();

  // ---- tag_type_for_name / tag_for_name ---------------------------------
  //   for (int i = 0; i < 126; i++)
  //     if (strlen(entry->tag_name) == tag_name->size &&
  //         memcmp(tag_name->contents, entry->tag_name, tag_name->size) == 0)
  //       return entry->tag_type;
  //   return CUSTOM;
  //
  // IF_BUF_EQ is exactly this comparison, length included, so the linear scan
  // transcribes one-for-one. Generated rather than written out: 126 tests plus
  // 126 two-instruction stubs is the bulk of this program's code section, and
  // hand-typing it would be 378 lines of nothing.
  a.label('for_name');
  for (let i = 0; i < TAG_NAMES.length; i++) a.ifBufEq(i, `ty${i}`);
  a.const_(R_TYPE, CUSTOM);
  a.ret();
  for (let i = 0; i < TAG_NAMES.length; i++) {
    a.label(`ty${i}`);
    a.const_(R_TYPE, TAG_NAMES[i] === 'CUSTOM' ? CUSTOM : T[TAG_NAMES[i]]);
    a.ret();
  }

  // ---- array_push(&tags, tag) -------------------------------------------
  // The name is stored only for CUSTOM, matching `tag_for_name`, which deletes
  // the string for a recognised tag. A zero length keeps stacks 0 and 1
  // parallel so one pop can undo one push.
  a.label('push_tag');
  a.push(S_TYPES, R_TYPE);
  a.ifCmpI('ne', R_TYPE, CUSTOM, 'pt_noname');
  a.len(S_CUR, R_N);
  a.const_(R_I, 0);
  a.label('pt_copy');
  a.ifCmp('ge', R_I, R_N, 'pt_len');
  a.getidx(S_CUR, R_TMP, R_I);
  a.push(S_NAMES, R_TMP);
  a.alui('add', R_I, 1);
  a.jmp('pt_copy');
  a.label('pt_len');
  a.push(S_LENS, R_N);
  a.ret();
  a.label('pt_noname');
  a.const_(R_TMP, 0);
  a.push(S_LENS, R_TMP);
  a.ret();

  // ---- pop_tag ----------------------------------------------------------
  a.label('pop_tag');
  a.pop(S_TYPES, R_TMP);
  a.pop(S_LENS, R_N);
  a.label('pop_trim');
  a.ifCmpI('eq', R_N, 0, 'pop_done');
  a.pop(S_NAMES, R_TMP);
  a.alui('sub', R_N, 1);
  a.jmp('pop_trim');
  a.label('pop_done');
  a.ret();

  // ---- tag_eq(array_back(&tags), &next_tag) -> R_TMP --------------------
  //   if (self->type != other->type) return false;
  //   if (self->type == CUSTOM) { compare the two names }
  //   return true;
  //
  // Only ever called against the top of the stack, which is what lets stack 2
  // stay flat: the top name's slice starts at len(names) - top length.
  a.label('tag_eq');
  a.const_(R_TMP, 0);
  a.peek(S_TYPES, R_J, 0);
  a.ifCmp('ne', R_J, R_TYPE, 'eq_done');
  a.ifCmpI('ne', R_TYPE, CUSTOM, 'eq_true');
  a.peek(S_LENS, R_J, 0);
  a.len(S_CUR, R_N);
  a.ifCmp('ne', R_J, R_N, 'eq_done');
  a.len(S_NAMES, R_BASE);
  a.alu('sub', R_BASE, R_N);
  a.const_(R_I, 0);
  a.label('eq_cmp');
  a.ifCmp('ge', R_I, R_N, 'eq_true');
  a.mov(R_J, R_BASE);
  a.alu('add', R_J, R_I);
  a.getidx(S_NAMES, R_K, R_J);
  a.getidx(S_CUR, R_LA, R_I);
  a.ifCmp('ne', R_K, R_LA, 'eq_done');
  a.alui('add', R_I, 1);
  a.jmp('eq_cmp');
  a.label('eq_true');
  a.const_(R_TMP, 1);
  a.label('eq_done');
  a.ret();

  // ---- tag_can_contain(parent, next) -> R_TMP ---------------------------
  //   switch (self->type) {
  //     case LI: return child != LI;
  //     case DT: case DD: return child != DT && child != DD;
  //     case P:  return child not in TAG_TYPES_NOT_ALLOWED_IN_PARAGRAPHS;
  //     case COLGROUP: return child == COL;
  //     case RB: case RT: case RP: return child not in {RB, RT, RP};
  //     case OPTGROUP: return child != OPTGROUP;
  //     case TR: return child != TR;
  //     case TD: case TH: return child not in {TD, TH, TR};
  //     default: return true;
  //   }
  //
  // The P arm is 26 comparisons rather than one class test because IF_CLASS
  // reads the *lookahead*, not a register -- an IF_CLASS_R would collapse this
  // and would be the obvious next instruction, but nothing yet forces it.
  const notIn = (...types) => {
    for (const t of types) a.ifCmpI('eq', R_TYPE, t, 'cc_false');
    a.ret();
  };
  a.label('can_contain');
  a.const_(R_TMP, 1);
  a.ifCmpI('eq', R_PTYPE, T.LI, 'cc_li');
  a.ifCmpI('eq', R_PTYPE, T.DT, 'cc_dtdd');
  a.ifCmpI('eq', R_PTYPE, T.DD, 'cc_dtdd');
  a.ifCmpI('eq', R_PTYPE, T.P, 'cc_p');
  a.ifCmpI('eq', R_PTYPE, T.COLGROUP, 'cc_colgroup');
  a.ifCmpI('eq', R_PTYPE, T.RB, 'cc_ruby');
  a.ifCmpI('eq', R_PTYPE, T.RT, 'cc_ruby');
  a.ifCmpI('eq', R_PTYPE, T.RP, 'cc_ruby');
  a.ifCmpI('eq', R_PTYPE, T.OPTGROUP, 'cc_optgroup');
  a.ifCmpI('eq', R_PTYPE, T.TR, 'cc_tr');
  a.ifCmpI('eq', R_PTYPE, T.TD, 'cc_cell');
  a.ifCmpI('eq', R_PTYPE, T.TH, 'cc_cell');
  a.ret();
  a.label('cc_li'); notIn(T.LI);
  a.label('cc_dtdd'); notIn(T.DT, T.DD);
  a.label('cc_p'); notIn(...NOT_IN_P);
  a.label('cc_colgroup');
  a.ifCmpI('ne', R_TYPE, T.COL, 'cc_false');
  a.ret();
  a.label('cc_ruby'); notIn(T.RB, T.RT, T.RP);
  a.label('cc_optgroup'); notIn(T.OPTGROUP);
  a.label('cc_tr'); notIn(T.TR);
  a.label('cc_cell'); notIn(T.TD, T.TH, T.TR);
  a.label('cc_false');
  a.const_(R_TMP, 0);
  a.ret();

  return {
    entry: 0,
    regPersist: 0,
    stacks: [
      { persist: true },   // types
      { persist: true },   // stored-name lengths
      { persist: true },   // stored-name bytes
      { persist: false },  // the name being scanned
    ],
    stackInit: [],
    classes: [
      ctype.classes.space,
      union(ctype.classes.alnum, one('-'), one(':')),
    ],
    maps: [ctype.maps.upper],
    strings: TAG_NAMES.map(bytes),
    validSets: [],
    jumpTable: [],
    code: a.build(),
  };
}

module.exports = { build, T, CUSTOM };
