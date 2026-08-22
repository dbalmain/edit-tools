-- File-level comment at the very top of the file.

module Comments where

import Data.List (sort) -- trailing comment on an import

-- | Haddock on a binding.
documented :: Int -> Int
documented a =
  -- leading comment inside the body
  a + 1 -- trailing comment on an equation

values =
  [ 1 -- first
  , 2 -- second
  -- own-line comment inside a list
  , 3
  ]

config =
  Node
    { value = 1 -- trailing on a field
    -- own-line comment inside a record
    , children = []
    -- comment before the closing brace
    }

blocky = do
  {- a block comment on its own line -}
  x <- pure 1
  -- comment before the closing of the do
  pure x

data Node = Node {value :: Int, children :: [Node]}

-- Comment at the end of the file.
