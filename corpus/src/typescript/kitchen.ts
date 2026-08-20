// Several TypeScript constructs interacting: the one file allowed to be messy.
import type { Config, RecordRow } from "./types";

interface Options {
  timeout: number;
  retries: number;
  backoff: number;
  verbose: boolean;
}

const defaults = { timeout: 30, retries: 3, backoff: 1.5, verbose: false } satisfies Options;

function process<T extends RecordRow>(records: T[], overrides: Partial<Options> = {}): Array<{ id: T["id"]; value: T["value"] }> {
  const settings = { ...defaults, ...overrides }; // shallow merge is fine
  return records
    .filter((r): r is T & { valid: true } => r.valid && r.id > 0)
    .map((r) => ({ id: r.id, value: r.value as number }))
    .sort((a, b) => (a.id === b.id ? a.value - b.value : a.id - b.id));
}

class Client implements Configurable, Disposable {
  constructor(public readonly name: string, private options: Options) {}
  dispose(): void {}
}

type Result = Success | Failure | Pending;

for (let i = 0; i < 10; i += 1) {
  if (i % 2 === 0) {
    process([{ id: i, value: i * 2, valid: true }]);
  }
}
