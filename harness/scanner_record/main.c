/* Parse one file with the instrumented grammar, writing a scanner-call trace.
 *
 *     trace <source-file> <trace-out.jsonl>
 *
 * The s-expression on stdout is not the product -- `ts_check_trees.mjs` is the
 * tree oracle. It is here so a recording run fails loudly if the grammar was
 * built wrong, rather than emitting a plausible trace of a parse that did not
 * happen.
 */
#include <stdio.h>
#include <stdlib.h>
#include "tree_sitter/api.h"

const TSLanguage *TS_LANGUAGE_FN(void);
extern FILE *trace_out;

static void print_sexp(TSNode n, FILE *o) {
    if (ts_node_child_count(n) == 0) {
        if (ts_node_is_named(n)) fprintf(o, "(%s)", ts_node_type(n));
        return;
    }
    if (ts_node_is_named(n)) fprintf(o, "(%s", ts_node_type(n));
    for (uint32_t i = 0; i < ts_node_child_count(n); i++) {
        TSNode c = ts_node_child(n, i);
        if (!ts_node_is_named(c) && ts_node_child_count(c) == 0) continue;
        fprintf(o, " ");
        print_sexp(c, o);
    }
    if (ts_node_is_named(n)) fprintf(o, ")");
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s <src> <trace-out>\n", argv[0]); return 2; }
    FILE *f = fopen(argv[1], "rb");
    if (!f) { perror("open"); return 2; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc(n + 1);
    if (fread(buf, 1, n, f) != (size_t)n) { perror("read"); return 2; }
    buf[n] = 0;
    fclose(f);

    trace_out = fopen(argv[2], "w");
    if (!trace_out) { perror("trace"); return 2; }
    TSParser *p = ts_parser_new();
    if (!ts_parser_set_language(p, TS_LANGUAGE_FN())) {
        fprintf(stderr, "language rejected: ABI mismatch with the linked core\n");
        return 2;
    }
    TSTree *t = ts_parser_parse_string(p, NULL, buf, (uint32_t)n);
    fclose(trace_out);
    trace_out = NULL;

    print_sexp(ts_tree_root_node(t), stdout);
    fputc('\n', stdout);
    ts_tree_delete(t);
    ts_parser_delete(p);
    free(buf);
    return 0;
}
