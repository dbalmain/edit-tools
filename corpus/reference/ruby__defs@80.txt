# Methods, classes, modules. Headers are already parenthesised: syntax_tree
# adds parens to `def foo a, b` and would make that a token rewrite.

class Widget < Base
  attr_reader :name, :age

  def initialize(name, age)
    @name = name
    @age = age
  end

  def self.build(name, age = 0)
    new(name, age)
  end

  def configure(host:, port: 80, timeout: 30, retries: 3)
    @host = host
    @port = port
  end
end

module Helpers
  module_function

  def shout(text)
    text.upcase # trailing
  end
end

def add(x) = x + 1

def forward(...)
  bar(...)
end

class << self
  def singleton_hook
    1
  end
end
