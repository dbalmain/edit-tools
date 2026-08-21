module Operators where

-- infix chains, application, composition, prefix operators
arith = 1 + 2 * 3 - 4 / 5 -- mixed precedence, no extra parens

logic = a && b || c

piped = f $ g $ h x -- right-assoc dollar

composed = f . g . h -- right-assoc compose

appended = xs ++ ys ++ zs

broken =
  a
    +++ b
    +++ c -- hanging infix; ormolu keeps this shape at default fixity

prefixPlus = (+) 1 2

a = True
b = False
c = True
f = id
g = id
h = id
x = True
xs = []
ys = []
zs = []
