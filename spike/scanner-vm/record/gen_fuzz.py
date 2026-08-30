#!/usr/bin/env python3
"""Generate TOML-ish inputs that actually exercise the scanner.

The frozen corpus fires 3 of tree-sitter-toml's 5 external tokens and takes a
non-trivial path in 20 of 230 calls, so a green replay against it is weak
evidence.  This produces two things the corpus does not:

  * hand-written cases aimed at every branch of the multiline-string helper --
    runs of 1..6 delimiters, at EOF, nested, both quote flavours;
  * mutations, including malformed input, which is the only way to reach the
    scanner's error-recovery behaviour at all (gen_trees.py refuses to emit a
    tree containing ERROR, so no corpus file can).

Usage: gen_fuzz.py <out-dir> [count]
"""
import pathlib
import random
import sys

HAND = [
    # multiline basic: delimiter runs of every length, which is the whole point
    # of scan_multiline_string_end's three-deep lookahead
    'a = """x"""\n',
    'a = """x""""\n',
    'a = """x"""""\n',
    'a = """x""""""\n',
    'a = """"x"""\n',
    'a = """""x"""\n',
    'a = """\n"""\n',
    'a = """"""\n',
    'a = """',
    'a = """"',
    'a = """""',
    # multiline literal: the same, single-quoted
    "a = '''x'''\n",
    "a = '''x''''\n",
    "a = '''x'''''\n",
    "a = '''x''''''\n",
    "a = ''''x'''\n",
    "a = '''''x'''\n",
    "a = '''\n'''\n",
    "a = ''''''\n",
    "a = '''",
    "a = ''''",
    # mixed flavours, so the second helper call is reached with state from the first
    'a = """\'\'\'"""\n',
    "a = '''\"\"\"'''\n",
    # line-ending-or-eof: trailing whitespace, CR, CRLF, lone CR, NUL, EOF
    'a = 1',
    'a = 1\n',
    'a = 1\r\n',
    'a = 1\r',
    'a = 1   \n',
    'a = 1\t\t\n',
    'a = 1   \r\n',
    'a = 1   \r',
    'a = 1   ',
    'a = 1 \x00 \n',
    'a = 1\x00',
    '[t]\n\n\n',
    '',
    '\n',
    '\r\n',
    '   ',
]

ALPHABET = list('"\'\n\r\t =[]{}.,abc019\\#') + ['\x00', 'é', ' ', '\U0001d400']


def mutate(rng, src):
    b = list(src)
    for _ in range(rng.randint(1, 6)):
        if not b or rng.random() < 0.34:
            b.insert(rng.randrange(len(b) + 1), rng.choice(ALPHABET))
        elif rng.random() < 0.5:
            del b[rng.randrange(len(b))]
        else:
            b[rng.randrange(len(b))] = rng.choice(ALPHABET)
    return ''.join(b)


def main() -> int:
    out = pathlib.Path(sys.argv[1])
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20260830)

    seeds = list(HAND)
    corpus = pathlib.Path(__file__).resolve().parents[3] / 'corpus' / 'src' / 'toml'
    for f in sorted(corpus.glob('*.toml')):
        seeds.append(f.read_text())

    for i, text in enumerate(HAND):
        (out / f'hand{i:04d}.toml').write_text(text)
    for i in range(count):
        (out / f'fuzz{i:05d}.toml').write_text(mutate(rng, rng.choice(seeds)))
    print(f'wrote {len(HAND)} hand cases + {count} mutations to {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
