#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tree_sitter/api.h"

const TSLanguage *tree_sitter_toml(void);
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
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *buf = malloc(n + 1);
    if (fread(buf, 1, n, f) != (size_t)n) { perror("read"); return 2; }
    buf[n] = 0; fclose(f);

    trace_out = fopen(argv[2], "w");
    TSParser *p = ts_parser_new();
    ts_parser_set_language(p, tree_sitter_toml());
    TSTree *t = ts_parser_parse_string(p, NULL, buf, (uint32_t)n);
    fclose(trace_out); trace_out = NULL;

    TSNode root = ts_tree_root_node(t);
    print_sexp(root, stdout);
    printf("\n");
    fprintf(stderr, "has_error=%d\n", ts_node_has_error(root));
    ts_tree_delete(t); ts_parser_delete(p); free(buf);
    return 0;
}
