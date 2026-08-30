// Drive the real `ts_lex` through a synthetic TSLexer and fingerprint what it
// does, so the recovered DFA can be compared against it exhaustively.
//
//     cc -O0 -I <grammar>/src -DTS_PARSER_C='"<grammar>/src/parser.c"' \
//        harness/ts_probe_lex.c -o probe && ./probe <lex-state-count> < codepoints
//
// `harness/ts_verify_lex.py` drives this and `harness/ts_probe_lex.mjs` and
// compares their output.
//
// `harness/ts_verify_blob.py` compares every *static table* against compiled
// memory, but the lex DFA has no static array to compare against -- it is
// recovered from generated C, which is the whole point of the spike and the
// part with no oracle. This supplies one: `ts_lex` only ever reads
// `lexer->lookahead` and `lexer->eof(lexer)`, and only ever calls
// `lexer->advance` and `lexer->mark_end`, so a fake lexer over a fixed
// codepoint sequence observes its complete behaviour.
//
// The codepoints come from the recovered DFA's own interval boundaries, so the
// input set is the partition the DFA induces on int32 rather than a sample:
// two codepoints in the same cell cannot be distinguished by any guard, and
// every cell is represented.

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>

#include TS_PARSER_C

#define MAX_STEPS 64

typedef struct {
  TSLexer base;
  const int32_t *input;
  uint32_t len;
  uint32_t pos;
  uint32_t steps;
  uint32_t hash;
} Probe;

static void fold(Probe *p, uint32_t v) {
  p->hash = (p->hash ^ (v & 0xff)) * 16777619u;
  p->hash = (p->hash ^ ((v >> 8) & 0xff)) * 16777619u;
  p->hash = (p->hash ^ ((v >> 16) & 0xff)) * 16777619u;
  p->hash = (p->hash ^ ((v >> 24) & 0xff)) * 16777619u;
}

static void probe_advance(TSLexer *l, bool skip) {
  Probe *p = (Probe *)l;
  fold(p, skip ? 2 : 1);
  if (p->steps++ > MAX_STEPS) return;
  // Mirrors ts_lexer__advance: at EOF the chunk is NULL and the call is a
  // no-op, so the position cannot run past the end.
  if (p->pos < p->len) {
    p->pos++;
    p->base.lookahead = p->pos < p->len ? p->input[p->pos] : 0;
  }
}

static void probe_mark_end(TSLexer *l) {
  Probe *p = (Probe *)l;
  fold(p, 3);
  fold(p, p->pos);
}

static bool probe_eof(const TSLexer *l) {
  const Probe *p = (const Probe *)l;
  return p->pos >= p->len;
}

static uint32_t probe_get_column(TSLexer *l) {
  fold((Probe *)l, 4);
  return 0;
}

static bool probe_included_range_start(const TSLexer *l) {
  (void)l;
  return false;
}

static void probe_log(const TSLexer *l, const char *fmt, ...) {
  (void)l;
  (void)fmt;
}

typedef bool (*LexFn)(TSLexer *, TSStateId);

static uint32_t run_one(LexFn lex, TSStateId state, const int32_t *input, uint32_t len) {
  Probe p;
  p.input = input;
  p.len = len;
  p.pos = 0;
  p.steps = 0;
  p.hash = 2166136261u;
  p.base.lookahead = len > 0 ? input[0] : 0;
  p.base.result_symbol = 0;
  p.base.advance = probe_advance;
  p.base.mark_end = probe_mark_end;
  p.base.get_column = probe_get_column;
  p.base.is_at_included_range_start = probe_included_range_start;
  p.base.eof = probe_eof;
  p.base.log = probe_log;

  bool found = lex(&p.base, state);
  fold(&p, found ? 0x1111u : 0x2222u);
  fold(&p, found ? (uint32_t)p.base.result_symbol : 0u);
  fold(&p, p.pos);
  fold(&p, p.steps > MAX_STEPS ? 0xdeadu : 0u);
  return p.hash;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: probe <lex-state-count> <ts_lex|ts_lex_keywords> < codepoints\n");
    return 2;
  }
  unsigned state_count = (unsigned)strtoul(argv[1], NULL, 10);
  LexFn lex = ts_lex;
#ifdef TS_HAS_KEYWORD_LEX
  if (argv[2][7] == 'k') lex = ts_lex_keywords;
#else
  if (argv[2][7] == 'k') {
    fprintf(stderr, "this grammar has no ts_lex_keywords\n");
    return 2;
  }
#endif

  static int32_t cps[1 << 20];
  uint32_t n = 0;
  long v;
  while (n < (uint32_t)(1 << 20) && scanf("%ld", &v) == 1) cps[n++] = (int32_t)v;

  for (unsigned s = 0; s < state_count; s++) {
    uint32_t h = 2166136261u;
    // EOF first: an empty input, which is the only way eof is true at step 0.
    h ^= run_one(lex, (TSStateId)s, NULL, 0);
    h *= 16777619u;
    for (uint32_t i = 0; i < n; i++) {
      int32_t one[1] = {cps[i]};
      int32_t two[2] = {cps[i], 'a'};
      int32_t three[2] = {cps[i], '\n'};
      h ^= run_one(lex, (TSStateId)s, one, 1);
      h *= 16777619u;
      h ^= run_one(lex, (TSStateId)s, two, 2);
      h *= 16777619u;
      h ^= run_one(lex, (TSStateId)s, three, 2);
      h *= 16777619u;
    }
    printf("%u %u\n", s, h);
  }
  return 0;
}
