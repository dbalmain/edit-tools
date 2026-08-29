/* Instrumented wrapper around tree-sitter-toml's external scanner.
   Records every scan invocation *and every lexer call it makes*, by swapping
   the TSLexer function pointers before delegating.  Byte offsets come from the
   internal Lexer struct (TSLexer is its first member, so the cast is legal). */
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>

#define tree_sitter_toml_external_scanner_scan real_toml_scan
#include "scanner.c"
#undef tree_sitter_toml_external_scanner_scan

#include "lexer.h"

FILE *trace_out = NULL;
#define NUM_EXT 5

static void (*orig_advance)(TSLexer *, bool);
static void (*orig_mark_end)(TSLexer *);
static char opbuf[4096];
static int oplen;

static void emit_op(const char *s) {
    while (*s && oplen < (int)sizeof(opbuf) - 1) opbuf[oplen++] = *s++;
    opbuf[oplen] = 0;
}

static void wrap_advance(TSLexer *lexer, bool skip) {
    char tmp[32];
    snprintf(tmp, sizeof tmp, "%s%u;", skip ? "S" : "A", ((Lexer *)lexer)->current_position.bytes);
    emit_op(tmp);
    orig_advance(lexer, skip);
}

static void wrap_mark_end(TSLexer *lexer) {
    char tmp[32];
    snprintf(tmp, sizeof tmp, "M%u;", ((Lexer *)lexer)->current_position.bytes);
    emit_op(tmp);
    orig_mark_end(lexer);
}

bool tree_sitter_toml_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Lexer *L = (Lexer *)lexer;
    uint32_t entry_cur = L->current_position.bytes;
    int32_t entry_la = lexer->lookahead;
    bool valid[NUM_EXT];
    for (int i = 0; i < NUM_EXT; i++) valid[i] = valid_symbols[i];

    oplen = 0; opbuf[0] = 0;
    orig_advance = lexer->advance;
    orig_mark_end = lexer->mark_end;
    lexer->advance = wrap_advance;
    lexer->mark_end = wrap_mark_end;

    bool ret = real_toml_scan(payload, lexer, valid_symbols);

    lexer->advance = orig_advance;
    lexer->mark_end = orig_mark_end;

    if (trace_out) {
        fprintf(trace_out,
            "{\"cur0\":%u,\"la0\":%d,\"valid\":[%d,%d,%d,%d,%d],"
            "\"ret\":%d,\"sym\":%d,\"ops\":\"%s\",\"cur1\":%u}\n",
            entry_cur, entry_la,
            valid[0], valid[1], valid[2], valid[3], valid[4],
            (int)ret, ret ? (int)lexer->result_symbol : -1,
            opbuf, L->current_position.bytes);
    }
    return ret;
}
