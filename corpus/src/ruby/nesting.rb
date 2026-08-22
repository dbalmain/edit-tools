# Hashes inside hashes, arrays inside arrays. syntax_tree cascades a broken
# hash into every hash inside it, even ones that would fit with room to spare.

row = { name: "alice", email: "alice@example.test", age: 30, city: "paris" } # flat at 80, stacked at 40

config = {
  database: {
    primary: {
      host: "localhost",
      port: 5432,
      pool: 5,
      adapter: "postgresql"
    },
    replica: {
      host: "backup.example.test",
      port: 5432,
      pool: 2
    }
  },
  cache: {
    redis: {
      url: "redis://localhost:6379/0",
      timeout: 1.5
    }
  }
}

matrix = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
  [10, 11, 12],
  [13, 14, 15],
  [16, 17, 18],
  [19, 20, 21]
]

# Tiny inner hashes: when the parent breaks they break too, unlike the arrays.
nested_tiny = {
  alpha: { a: 1 },
  beta: { b: 2 },
  gamma: { c: 3 },
  delta: { d: 4 },
  epsilon: { e: 5 }
}
