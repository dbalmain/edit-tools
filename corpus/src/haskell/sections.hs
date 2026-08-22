module Sections where

-- operator sections: the parens are structural, not decoration
addOne = (+1) -- right section

addTo = (1+) -- left section

halve = (`div`2) -- backticked right section

ticked = 10`div`3 -- infix identifier, not a section

plus = (+) -- prefix form of an operator

append = (++) -- prefix form of a multi-character operator

composed = map (+1) . filter (>0) -- sections as arguments
