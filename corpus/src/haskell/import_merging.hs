module ImportMerging where

-- ormolu collapses repeated imports of one module into a single declaration:
-- an exact duplicate is dropped, and two lists for the same module are unioned.
-- Modules and names are written in the order ormolu already emits them, so this
-- file probes collapsing alone and never statement reordering (imports.hs).
import Control.Monad (when)
import Control.Monad (when)
import Data.List (nub)
import Data.List (sort)

used = (when, nub, sort) -- keep them used
