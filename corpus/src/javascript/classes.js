// Classes: declarations, fields, methods, accessors, inheritance, privacy.
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  distance(other) {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  get magnitude() {
    return this.distance(new Point(0, 0));
  }
  set coords([x, y]) {
    this.x = x;
    this.y = y;
  }
  static origin() {
    return new Point(0, 0);
  }
}

class LabeledPoint extends Point {
  #label = "unlabeled";
  static #count = 0;
  constructor(x, y, label) {
    super(x, y);
    this.#label = label;
    LabeledPoint.#count += 1;
  }
  describe() {
    return `${this.#label} at (${this.x}, ${this.y})`;
  }
}
