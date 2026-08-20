// Overload signatures: functions, methods, and constructors. The
// implementation signature is the last one and is the only one with a body.
function read(path: string): string;
function read(path: string, encoding: string): Buffer;
function read(path: string, encoding?: string): string | Buffer {
  return encoding === undefined ? loadText(path) : loadBytes(path, encoding);
}

function parse(input: string): object;
function parse(input: number): object;
function parse(input: string | number): object {
  return JSON.parse(String(input));
}

class Loader {
  constructor(url: string);
  constructor(url: string, timeout: number);
  constructor(url: string, timeout?: number) {
    this.url = url;
  }
  url: string;

  load(): Promise<string>;
  load(force: boolean): Promise<string>;
  load(force?: boolean): Promise<string> {
    return fetch(this.url);
  }
}
