# Multi-branch forms so syntax_tree cannot collapse them to a modifier or
# a ternary. Single-statement `if`/`while` become modifiers; those rewrites
# are recorded in the report and written here already in canonical form.

if condition_one
  first_branch
elsif condition_two
  second_branch
else
  fallback
end

case value
when 1
  :one
when 2, 3
  :few
else
  :many
end

for x in xs
  p x
end

work while busy
wait until ready

begin
  risky
rescue StandardError => e
  handle(e)
rescue OtherError
  retry
ensure
  cleanup
end

1 if condition_one and condition_two
1 if condition_one && condition_two
