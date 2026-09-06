/* Instrumented wrapper around any grammar's external scanner.
 *
 * Records every scan invocation *and every lexer call it makes*, by swapping
 * the TSLexer function pointers before delegating (`advance`, `mark_end`,
 * `get_column`). Byte offsets come from the internal Lexer struct (TSLexer is
 * its first member, so the cast is legal). `get_column` is `C<pos>=<col>;`.
 *
 * **Not a translation unit.** It is included by the generated `shim.c`, which
 * has already pulled in the grammar's `scanner.c` with its three entry points
 * renamed to `real_scan` / `real_serialize` / `real_deserialize`, undefined
 * those renames again, and defined TS_SCAN_FN, TS_SERIALIZE_FN and
 * TS_DESERIALIZE_FN to the public names this file then defines. Doing the
 * renaming out there rather than in here is what keeps this file free of any
 * language's name -- `#undef` does not expand its argument, so a macro cannot
 * scope a rename whose spelling it only knows through another macro.
 *
 * TS_NUM_EXT is EXTERNAL_TOKEN_COUNT, read from the grammar's own parser.c.
 *
 * serialize and deserialize are traced too, unlike the toml-only original.
 * Eight of the twelve remaining scanners carry state across tokens, and a port
 * that scans correctly while serializing differently is wrong in a way only
 * the next token reveals.
 */
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "lexer.h"

FILE *trace_out = NULL;

static void (*orig_advance)(TSLexer *, bool);
static void (*orig_mark_end)(TSLexer *);
static uint32_t (*orig_get_column)(TSLexer *);
static char opbuf[65536];
static int oplen;

static void emit_op(const char *s) {
    while (*s && oplen < (int)sizeof(opbuf) - 1) opbuf[oplen++] = *s++;
    opbuf[oplen] = 0;
}

static void wrap_advance(TSLexer *lexer, bool skip) {
    char tmp[32];
    snprintf(tmp, sizeof tmp, "%s%u;", skip ? "S" : "A",
             ((Lexer *)lexer)->current_position.bytes);
    emit_op(tmp);
    orig_advance(lexer, skip);
}

static void wrap_mark_end(TSLexer *lexer) {
    char tmp[32];
    snprintf(tmp, sizeof tmp, "M%u;", ((Lexer *)lexer)->current_position.bytes);
    emit_op(tmp);
    orig_mark_end(lexer);
}

static uint32_t wrap_get_column(TSLexer *lexer) {
    char tmp[48];
    uint32_t pos = ((Lexer *)lexer)->current_position.bytes;
    uint32_t col = orig_get_column(lexer);
    snprintf(tmp, sizeof tmp, "C%u=%u;", pos, col);
    emit_op(tmp);
    return col;
}

/* The valid-symbols vector is written as a bit string rather than a JSON array
 * of ints: yaml has 113 external tokens, and an array of those per call makes
 * the trace larger than the corpus file that produced it. */
static void emit_valid(const bool *valid) {
    fputc('"', trace_out);
    for (int i = 0; i < TS_NUM_EXT; i++) fputc(valid[i] ? '1' : '0', trace_out);
    fputc('"', trace_out);
}

bool TS_SCAN_FN(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Lexer *L = (Lexer *)lexer;
    uint32_t entry_cur = L->current_position.bytes;
    int32_t entry_la = lexer->lookahead;

    oplen = 0;
    opbuf[0] = 0;
    orig_advance = lexer->advance;
    orig_mark_end = lexer->mark_end;
    orig_get_column = lexer->get_column;
    lexer->advance = wrap_advance;
    lexer->mark_end = wrap_mark_end;
    lexer->get_column = wrap_get_column;

    bool ret = real_scan(payload, lexer, valid_symbols);

    lexer->advance = orig_advance;
    lexer->mark_end = orig_mark_end;
    lexer->get_column = orig_get_column;

    if (trace_out) {
        fprintf(trace_out, "{\"op\":\"scan\",\"cur0\":%u,\"la0\":%d,\"valid\":",
                entry_cur, entry_la);
        emit_valid(valid_symbols);
        fprintf(trace_out, ",\"ret\":%d,\"sym\":%d,\"ops\":\"%s\",\"cur1\":%u}\n",
                (int)ret, ret ? (int)lexer->result_symbol : -1, opbuf,
                L->current_position.bytes);
    }
    return ret;
}

/* Serialized state is hex rather than an int array, for the same size reason,
 * and because its meaning is per-scanner: the trace's job is to say the two
 * implementations produced the same bytes, not to interpret them. */
static void emit_hex(const char *buffer, unsigned length) {
    static const char digits[] = "0123456789abcdef";
    fputc('"', trace_out);
    for (unsigned i = 0; i < length; i++) {
        fputc(digits[(unsigned char)buffer[i] >> 4], trace_out);
        fputc(digits[(unsigned char)buffer[i] & 0xf], trace_out);
    }
    fputc('"', trace_out);
}

unsigned TS_SERIALIZE_FN(void *payload, char *buffer) {
    unsigned n = real_serialize(payload, buffer);
    if (trace_out) {
        fprintf(trace_out, "{\"op\":\"serialize\",\"len\":%u,\"bytes\":", n);
        emit_hex(buffer, n);
        fprintf(trace_out, "}\n");
    }
    return n;
}

void TS_DESERIALIZE_FN(void *payload, const char *buffer, unsigned length) {
    if (trace_out) {
        fprintf(trace_out, "{\"op\":\"deserialize\",\"len\":%u,\"bytes\":", length);
        emit_hex(buffer, length);
        fprintf(trace_out, "}\n");
    }
    real_deserialize(payload, buffer, length);
}
