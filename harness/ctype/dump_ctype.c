/* Dump <wctype.h>'s classification as int32 interval sets, under one locale.
 *
 *     dump_ctype <locale>        e.g. C.UTF-8, en_AU.UTF-8, C
 *
 * Every scanner that classifies characters calls these, and they are a
 * property of the *host process*, not of the grammar -- which is the finding
 * in docs/host-ctype-divergence.md. A port that calls the host's isw* inherits
 * that divergence; a port that carries the answer as data does not. This
 * produces the data.
 *
 * Emitted as JSON: {"locale": ..., "resolved": ..., "classes": {name: [lo, hi, ...]}}
 * with inclusive ranges, which is the same shape ts_transcode.py already uses
 * for lexer charsets.
 */
#include <locale.h>
#include <stdio.h>
#include <string.h>
#include <wctype.h>

/* Unicode's last code point. tree-sitter's lookahead is an int32 that is 0 at
 * EOF and -1 on a UTF-8 decode error; neither is a character, and glibc's
 * behaviour on them is not something a port should be reproducing, so the
 * domain stops here and the two sentinels stay the VM's business. */
#define MAX_CP 0x10FFFF

typedef int (*predicate)(wint_t);

static const struct { const char *name; predicate fn; } CLASSES[] = {
    {"alnum", iswalnum}, {"alpha", iswalpha}, {"blank", iswblank},
    {"cntrl", iswcntrl}, {"digit", iswdigit}, {"graph", iswgraph},
    {"lower", iswlower}, {"print", iswprint}, {"punct", iswpunct},
    {"space", iswspace}, {"upper", iswupper}, {"xdigit", iswxdigit},
};

static void dump(const char *name, predicate fn, int last) {
    printf("  \"%s\": [", name);
    long start = -1, count = 0;
    for (long c = 0; c <= MAX_CP; c++) {
        int in = fn((wint_t)c) != 0;
        if (in && start < 0) start = c;
        if (!in && start >= 0) {
            printf("%s%ld,%ld", count++ ? "," : "", start, c - 1);
            start = -1;
        }
    }
    if (start >= 0) printf("%s%ld,%ld", count++ ? "," : "", start, (long)MAX_CP);
    printf("]%s\n", last ? "" : ",");
}

int main(int argc, char **argv) {
    const char *want = argc > 1 ? argv[1] : "C.UTF-8";
    const char *got = setlocale(LC_CTYPE, want);
    if (got == NULL) {
        fprintf(stderr, "dump_ctype: locale %s unavailable\n", want);
        return 1;
    }
    int n = (int)(sizeof CLASSES / sizeof CLASSES[0]);
    printf("{\n \"locale\": \"%s\",\n \"resolved\": \"%s\",\n \"classes\": {\n", want, got);
    for (int i = 0; i < n; i++) dump(CLASSES[i].name, CLASSES[i].fn, i == n - 1);
    printf(" }\n}\n");
    return 0;
}
