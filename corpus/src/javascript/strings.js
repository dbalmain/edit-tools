// String and template literals: escaping, multi-line form, and the widths at
// which a string interior never reflows.
const plain = "hello world";

const escape = "line one\nline two\ttabbed";

const unicode = "café";

const astral = "🙂🙂🙂🙂🙂 a string whose width counts scalar values, not UTF-16 units";

const template = `a template with ${name} interpolated`;

const multiLine = `first line
  indented second line
    deeper third line
fourth line`;

const tagged = tag`tagged ${value} template`;

const concat = "first " + "second " + "third " + "fourth " + "fifth part of the string";

const long = "this is a very long string literal that the formatter must never reflow";
