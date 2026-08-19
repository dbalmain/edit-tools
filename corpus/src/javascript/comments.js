// Module-level comment at the very top of the file.

const value = 1; // trailing comment on a statement

// Own-line comment before a declaration, separated by nothing.
const documented = 2;

const arr = [
  1, // trailing on the first item
  // own-line comment between items
  2,
  /* block comment inline */ 3,
  4, // another trailing, forcing the layout open
  // comment before the closing bracket
];

const obj = {
  // comment before the first pair
  first: 1,
  second: 2, // trailing on a pair
};

const collapsed = [ // comment right after the opening bracket
  alpha,
  beta,
  gamma,
];

function f(a, b) {
  // leading comment inside the body
  const result = a + b; // trailing on an assignment
  // comment before the return
  return result;
}

// A comment between two declarations, before a blank line.

// Comment at the end of the file.
