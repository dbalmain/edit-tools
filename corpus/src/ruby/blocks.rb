# Block forms that are stable at both 80 and 40. The width-dependent
# conversion lives in block_conversion.rb.

# Short brace blocks stay braces at both widths.
xs.each { |x| x } # identity

# Nested braces that still fit at 40.
xs.each { |x| ys.each { |y| x + y } }

# Multi-statement blocks stay do/end at both widths.
xs.each do |x|
  handle(x)
  log(x)
end

# A block as the last argument of a parenthesised call keeps braces.
foo(1, 2) { |x| x }

# A block after a bare call must be do/end: braces would bind to the last arg.
foo 1, 2 do |x|
  x
end

# Block-local variables.
xs.each { |x; acc| acc = x }
