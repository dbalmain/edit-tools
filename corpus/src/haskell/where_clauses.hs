module WhereClauses where

-- where hangs off a declaration and indents relative to it, not the line
f x = y + z -- uses both locals
  where
    y = x + 1
    z = x * 2

g x = outer
  where
    outer = inner + 1
      where
        inner = x * 3 -- nested where

h x = a
  where
    a | x < 0 = 0
      | otherwise = b
      where
        b = x + 1 -- where hanging off a guarded equation

k x =
  let y = x + 1
   in y * 2 -- let/in next to where, for contrast
    where
      -- a where on a let-in equation
      unused = True
