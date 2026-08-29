/* Incremental-reparse recorder.
 *
 * A full parse of a clean file is the comfortable half of a scanner's job.
 * This drives the other half: parse, apply a random edit, reparse against the
 * old tree, repeat.  Incremental reparse re-enters the scanner at positions and
 * with valid-symbol sets that no full parse produces, and it is where a port
 * can be green on a clean corpus and wrong in production.
 *
 * Each generation gets its own trace file *and* its own buffer snapshot, since
 * the offsets in a trace are only meaningful against the buffer that produced
 * them:  <prefix>.<gen>.jsonl  and  <prefix>.<gen>.toml
 *
 *   incr <src> <out-prefix> <seed> <edits>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tree_sitter/api.h"

const TSLanguage *tree_sitter_toml(void);
extern FILE *trace_out;

static TSPoint point_at(const char *s, uint32_t n, uint32_t off) {
    TSPoint p = {0, 0};
    for (uint32_t i = 0; i < off && i < n; i++) {
        if (s[i] == '\n') { p.row++; p.column = 0; } else { p.column++; }
    }
    return p;
}

static void open_gen(const char *prefix, int gen) {
    char path[4096];
    snprintf(path, sizeof path, "%s.%d.jsonl", prefix, gen);
    trace_out = fopen(path, "w");
}

static void close_gen(const char *prefix, int gen, const char *buf, uint32_t n) {
    if (trace_out) { fclose(trace_out); trace_out = NULL; }
    char path[4096];
    snprintf(path, sizeof path, "%s.%d.toml", prefix, gen);
    FILE *o = fopen(path, "wb");
    fwrite(buf, 1, n, o);
    fclose(o);
}

int main(int argc, char **argv) {
    if (argc < 5) { fprintf(stderr, "usage: %s <src> <out-prefix> <seed> <edits>\n", argv[0]); return 2; }
    FILE *f = fopen(argv[1], "rb");
    if (!f) return 2;
    fseek(f, 0, SEEK_END); long fl = ftell(f); fseek(f, 0, SEEK_SET);
    uint32_t n = (uint32_t)fl;
    uint32_t cap = n + 4096;
    char *buf = malloc(cap);
    if (n && fread(buf, 1, n, f) != n) return 2;
    fclose(f);
    const char *prefix = argv[2];
    srandom((unsigned)strtoul(argv[3], NULL, 10));
    int edits = atoi(argv[4]);

    TSParser *p = ts_parser_new();
    ts_parser_set_language(p, tree_sitter_toml());

    open_gen(prefix, 0);
    TSTree *tree = ts_parser_parse_string(p, NULL, buf, n);
    close_gen(prefix, 0, buf, n);

    static const char POOL[] = "\"'\n\r\t =[]#\\";
    for (int e = 1; e <= edits; e++) {
        uint32_t start = n ? (uint32_t)(random() % (n + 1)) : 0;
        int insert = (random() % 2) == 0 || n == 0;
        TSInputEdit ed;
        ed.start_byte = start;
        ed.start_point = point_at(buf, n, start);
        if (insert) {
            if (n + 1 >= cap) break;
            char c = POOL[random() % (sizeof POOL - 1)];
            memmove(buf + start + 1, buf + start, n - start);
            buf[start] = c;
            n += 1;
            ed.old_end_byte = start;
            ed.old_end_point = ed.start_point;
            ed.new_end_byte = start + 1;
            ed.new_end_point = point_at(buf, n, start + 1);
        } else {
            uint32_t len = 1 + (uint32_t)(random() % 3);
            if (start + len > n) len = n - start;
            if (len == 0) continue;
            ed.old_end_byte = start + len;
            ed.old_end_point = point_at(buf, n, start + len);
            memmove(buf + start, buf + start + len, n - start - len);
            n -= len;
            ed.new_end_byte = start;
            ed.new_end_point = ed.start_point;
        }
        ts_tree_edit(tree, &ed);
        open_gen(prefix, e);
        TSTree *next = ts_parser_parse_string(p, tree, buf, n);
        close_gen(prefix, e, buf, n);
        ts_tree_delete(tree);
        tree = next;
    }

    ts_tree_delete(tree); ts_parser_delete(p); free(buf);
    return 0;
}
