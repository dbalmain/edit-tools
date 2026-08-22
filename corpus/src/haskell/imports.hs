module Imports where

-- unsorted on purpose: ormolu reorders these alphabetically by module name
import Data.Maybe (fromMaybe, isJust)
import Control.Monad (guard, when)
import Data.List (foldl', sort)
import System.IO (hPutStrLn, stderr)

used = (fromMaybe, isJust, guard, when, foldl', sort, hPutStrLn, stderr) -- keep them used
