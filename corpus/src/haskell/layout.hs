module Layout where

-- the layout rule: do / let / case / guards, plus explicit braces ormolu strips
doBlock = do
  x <- pure 1
  y <- pure 2
  pure (x + y) -- last statement of a do

-- explicit braces: ormolu drops { } and keeps or drops the semicolons by shape
braced = do { x <- pure 1; pure x }

letIn x =
  let y = x + 1
      z = x * 2
   in y + z

guards n
  | n < 0 = 0
  | n == 0 = 1
  | otherwise = n

cased x = case x of
  Just a -> a
  Nothing -> 0 -- alternative on its own line
