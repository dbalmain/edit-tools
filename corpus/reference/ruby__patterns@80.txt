# Pattern matching: `case`/`in`, hash patterns, array patterns, find patterns.

case value
in { name:, age: Integer => years } if years > 18
  years
in [first, *rest]
  first
in String => s
  s
else
  nil
end

xs in [*, Integer => n, *] # find pattern

case pair
in [Integer => left, Integer => right]
  left + right
in Integer => n if n.even?
  :even
end
