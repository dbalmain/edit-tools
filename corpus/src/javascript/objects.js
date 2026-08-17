// Object literals and destructuring: shorthand, spread, computed keys, methods.
const simple = { host: "localhost", port: 8080, debug: true };

const longObject = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5, zeta: 6, eta: 7 };

const shorthand = { alpha, beta, gamma, delta };

const computed = { ["key-" + suffix]: 1, [dynamic]: 2 };

const methods = {
  plain() {
    return this;
  },
  async fetch(url) {
    return await load(url);
  },
};

// objectWrap defaults to "preserve": an object whose source has a line break
// after `{` stays expanded even when it would fit flat. The array below is the
// control -- arrays have no such rule and collapse.
const preservedBySource = {
  alpha: 1, beta: 2
};

const collapsedBySource = [
  1, 2, 3
];

const spread = { ...base, ...override, extra: true };

const nested = { outer: { inner: { deep: [1, 2, 3] } }, list: [4, 5, 6] };

const { first, second, ...remaining } = source;

const [head, , third = "default", ...tail] = items;

const { a: renamed, b = 2 } = options;
