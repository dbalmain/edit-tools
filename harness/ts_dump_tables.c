// Dump every static table out of a generated `parser.c`, from compiled memory.
//
//     cc -O0 -I <grammar>/src -DTS_PARSER_C='"<grammar>/src/parser.c"' \
//        harness/ts_dump_tables.c -o dump && ./dump > tables.json
//
// `harness/ts_verify_blob.py` drives this and diffs the result against the
// transcoder's blob, entry for entry.
//
// Why compile rather than parse the text again: the mutation sweep can only
// reach table entries some corpus file exercises, which is 44% of the JSON blob
// and 27% of the Go one. Everything else is unverified -- not necessarily
// wrong, just untested, and a transcoder bug there produces a green run. The C
// compiler has no such blind spot. Including `parser.c` in this translation
// unit makes every `static` array visible, `sizeof` gives the true length of
// the ones whose extent the transcoder has to *derive*, and the comparison is
// then exhaustive rather than sampled.
//
// This is the same instinct as reading table sizes out of `wasm_store.c`: use
// upstream's own artifacts as the oracle instead of hand-written inputs.

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include TS_PARSER_C

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

static void emit_string(const char *s) {
  if (s == NULL) {
    printf("null");
    return;
  }
  putchar('"');
  for (const unsigned char *c = (const unsigned char *)s; *c; c++) {
    if (*c == '"' || *c == '\\') printf("\\%c", *c);
    else if (*c < 0x20 || *c == 0x7f) printf("\\u%04x", *c);
    else putchar(*c);
  }
  putchar('"');
}

static void emit_u16(const uint16_t *a, size_t n) {
  putchar('[');
  for (size_t i = 0; i < n; i++) printf(i ? ",%u" : "%u", (unsigned)a[i]);
  putchar(']');
}

int main(void) {
  printf("{\n");
  printf("\"abi\":%d,", LANGUAGE_VERSION);
  printf("\"symbolCount\":%d,", SYMBOL_COUNT);
  printf("\"aliasCount\":%d,", ALIAS_COUNT);
  printf("\"tokenCount\":%d,", TOKEN_COUNT);
  printf("\"externalTokenCount\":%d,", EXTERNAL_TOKEN_COUNT);
  printf("\"stateCount\":%d,", STATE_COUNT);
  printf("\"largeStateCount\":%d,", LARGE_STATE_COUNT);
  printf("\"productionIdCount\":%d,", PRODUCTION_ID_COUNT);
  printf("\"fieldCount\":%d,", FIELD_COUNT);
  printf("\"maxAliasSequenceLength\":%d,\n", MAX_ALIAS_SEQUENCE_LENGTH);

  // Lengths the transcoder has to derive rather than read. These are the
  // interesting ones: a wrong bound here is invisible to any corpus.
  printf("\"len_parseActions\":%zu,", COUNT(ts_parse_actions));
  printf("\"len_smallParseTable\":%zu,", COUNT(ts_small_parse_table));
  printf("\"len_smallParseTableMap\":%zu,", COUNT(ts_small_parse_table_map));
#if FIELD_COUNT > 0
  printf("\"len_fieldMapEntries\":%zu,", COUNT(ts_field_map_entries));
#else
  // A grammar with no fields gets no field tables at all -- the generator
  // omits ts_field_names, ts_field_map_slices and ts_field_map_entries
  // entirely. tree-sitter-scheme is one.
  printf("\"len_fieldMapEntries\":0,");
#endif
  printf("\"len_aliasMap\":%zu,\n", COUNT(ts_non_terminal_alias_map));

  printf("\"symbolNames\":[");
  for (unsigned i = 0; i < SYMBOL_COUNT + ALIAS_COUNT; i++) {
    if (i) putchar(',');
    emit_string(ts_symbol_names[i]);
  }
  printf("],\n");

  printf("\"symbolMetadata\":[");
  for (unsigned i = 0; i < SYMBOL_COUNT + ALIAS_COUNT; i++) {
    TSSymbolMetadata m = ts_symbol_metadata[i];
    unsigned bits = (m.visible ? 1 : 0) | (m.named ? 2 : 0) | (m.supertype ? 4 : 0);
    printf(i ? ",%u" : "%u", bits);
  }
  printf("],\n");

  printf("\"publicSymbolMap\":");
  emit_u16(ts_symbol_map, SYMBOL_COUNT + ALIAS_COUNT);
  printf(",\n");

#if FIELD_COUNT > 0
  printf("\"fieldNames\":[");
  for (unsigned i = 0; i <= FIELD_COUNT; i++) {
    if (i) putchar(',');
    emit_string(ts_field_names[i]);
  }
  printf("],\n");

  printf("\"fieldMapSlices\":[");
  for (unsigned i = 0; i < PRODUCTION_ID_COUNT; i++) {
    printf(i ? ",%u,%u" : "%u,%u",
           (unsigned)ts_field_map_slices[i].index,
           (unsigned)ts_field_map_slices[i].length);
  }
  printf("],\n");

  printf("\"fieldMapEntries\":[");
  for (unsigned i = 0; i < COUNT(ts_field_map_entries); i++) {
    printf(i ? ",%u,%u,%u" : "%u,%u,%u",
           (unsigned)ts_field_map_entries[i].field_id,
           (unsigned)ts_field_map_entries[i].child_index,
           ts_field_map_entries[i].inherited ? 1u : 0u);
  }
  printf("],\n");
#else
  printf("\"fieldNames\":[null],\"fieldMapSlices\":[");
  for (unsigned i = 0; i < PRODUCTION_ID_COUNT; i++) printf(i ? ",0,0" : "0,0");
  printf("],\"fieldMapEntries\":[],\n");
#endif

  printf("\"aliasSequences\":");
  emit_u16(&ts_alias_sequences[0][0], PRODUCTION_ID_COUNT * MAX_ALIAS_SEQUENCE_LENGTH);
  printf(",\n");

  printf("\"aliasMap\":");
  emit_u16(ts_non_terminal_alias_map, COUNT(ts_non_terminal_alias_map));
  printf(",\n");

  printf("\"parseTable\":");
  emit_u16(&ts_parse_table[0][0], (size_t)LARGE_STATE_COUNT * SYMBOL_COUNT);
  printf(",\n");

  printf("\"smallParseTable\":");
  emit_u16(ts_small_parse_table, COUNT(ts_small_parse_table));
  printf(",\n");

  printf("\"smallParseTableMap\":[");
  for (unsigned i = 0; i < COUNT(ts_small_parse_table_map); i++) {
    printf(i ? ",%u" : "%u", (unsigned)ts_small_parse_table_map[i]);
  }
  printf("],\n");

  // Parse actions are a tagged union walked as (header, action*). Emitting the
  // decoded form is what makes it comparable to the blob.
  printf("\"parseActions\":[");
  for (unsigned i = 0; i < COUNT(ts_parse_actions);) {
    unsigned count = ts_parse_actions[i].entry.count;
    unsigned reusable = ts_parse_actions[i].entry.reusable ? 1 : 0;
    if (i) putchar(',');
    printf("[%u,%u,%u,[", i, count, reusable);
    for (unsigned j = 0; j < count; j++) {
      TSParseAction a = ts_parse_actions[i + 1 + j].action;
      if (j) putchar(',');
      switch (a.type) {
        case TSParseActionTypeShift:
          printf("[0,%u,%u,%u]", (unsigned)a.shift.state,
                 a.shift.extra ? 1u : 0u, a.shift.repetition ? 1u : 0u);
          break;
        case TSParseActionTypeReduce:
          printf("[1,%u,%u,%d,%u]", (unsigned)a.reduce.symbol,
                 (unsigned)a.reduce.child_count, (int)a.reduce.dynamic_precedence,
                 (unsigned)a.reduce.production_id);
          break;
        case TSParseActionTypeAccept: printf("[2]"); break;
        case TSParseActionTypeRecover: printf("[3]"); break;
        default: printf("[99]"); break;
      }
    }
    printf("]]");
    i += 1 + count;
  }
  printf("],\n");

  printf("\"lexStates\":[");
  for (unsigned i = 0; i < STATE_COUNT; i++) printf(i ? ",%u" : "%u", (unsigned)ts_lex_modes[i].lex_state);
  printf("],\n");
  printf("\"externalLexStates\":[");
  for (unsigned i = 0; i < STATE_COUNT; i++) printf(i ? ",%u" : "%u", (unsigned)ts_lex_modes[i].external_lex_state);
  printf("],\n");

#if LANGUAGE_VERSION >= 15
  printf("\"reservedWordSetIds\":[");
  for (unsigned i = 0; i < STATE_COUNT; i++) {
    printf(i ? ",%u" : "%u", (unsigned)ts_lex_modes[i].reserved_word_set_id);
  }
  printf("],\n");
  printf("\"reservedWords\":");
#if MAX_RESERVED_WORD_SET_SIZE > 0
  emit_u16(&ts_reserved_words[0][0],
           COUNT(ts_reserved_words) * MAX_RESERVED_WORD_SET_SIZE);
#else
  printf("[]");
#endif
  printf(",\n");
  printf("\"maxReservedWordSetSize\":%d,\n", MAX_RESERVED_WORD_SET_SIZE);
#else
  printf("\"reservedWordSetIds\":[");
  for (unsigned i = 0; i < STATE_COUNT; i++) printf(i ? ",0" : "0");
  printf("],\n");
  printf("\"reservedWords\":[],\n");
  printf("\"maxReservedWordSetSize\":0,\n");
#endif

  printf("\"ok\":true\n}\n");
  return 0;
}
