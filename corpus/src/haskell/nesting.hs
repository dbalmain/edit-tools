module Nesting where

-- nested containers: records in lists in records; inner one-liners stay flat
data Tree = Node {value :: Int, children :: [Tree]}

leaf = Node {value = 0, children = []} -- empty children stay on the line

tree =
  Node
    { value = 1
    , children =
        [ Node {value = 2, children = []}
        , Node {value = 3, children = [Node {value = 4, children = []}, Node {value = 5, children = [Node {value = 6, children = []}]}]}
        ]
    }

matrix =
  [ [1, 2, 3]
  , [4, 5, 6]
  , [7, 8, 9]
  ]

pairs =
  [ (1, (2, 3))
  , (4, (5, 6))
  ]
