module Strings where

plain="hello world" -- ordinary string

escaped="line one\nline two\ttabbed \"quoted\""

hexed="caf\xe9"

slashed="back\\slash"

char1 = 'a'

char2 = '\n'

char3 = '\''

unicode="café ☕"

-- astral characters: width must be counted in scalar values, not UTF-16 units
astral = "🙂🙂🙂🙂🙂🙂"

continued =
  "multi\
  \line"

n1 = 1_000

n2 = 0xdead

n3 = 1.5e-2

n4 = 0o10

n5 = 0b1010
