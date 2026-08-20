// Enums: numeric, string, const, and computed. prettier expands every enum,
// even a one-member form that fits on a line.
enum Color { Red, Green, Blue }

enum Status { On = 1, // trailing on a member
  Off = 0 }

enum Direction { Up = "up", Down = "down", Left = "left", Right = "right" }

const enum Flags { Read = 1, Write = 2, ReadWrite = Read | Write }

enum Computed { Pair = 1 + 2 }

enum Singleton { Only }
