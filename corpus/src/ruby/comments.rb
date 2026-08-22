# encoding: utf-8
# frozen_string_literal: true

# Own-line comment at file scope, after the magic comments.

require "json" # trailing comment on a require

# Own-line comment before a definition, separated by a blank line.
def documented(a, b)
  # Leading comment inside the body.
  result = a + b # trailing comment on a statement
  # Comment before return.
  result
end

values = [
  1, # first
  2, # second
  # own-line comment inside a bracketed list
  3
]

config = {
  # comment before the first key
  host: "localhost",
  port: 8080 # trailing on a pair
}

=begin
A block comment, which tree-sitter-ruby also emits as a `comment` extra.
=end

def between
  # trailing comment at the end of a block
end

# Comment at the end of the file.
