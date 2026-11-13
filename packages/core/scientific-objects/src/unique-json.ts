export function parseUniqueJson(
  text: string,
  options: {
    fail?: (message: string) => never;
    numberReader?: (text: string) => number;
    maxDepth?: number;
  } = {}
): unknown {
  return new DuplicateRejectingJsonReader(
    text,
    options.fail ??
      ((message) => {
        throw new Error(message);
      }),
    options.numberReader ?? Number,
    options.maxDepth ?? 16
  ).parse();
}

class DuplicateRejectingJsonReader {
  private offset = 0;

  constructor(
    private readonly source: string,
    private readonly fail: (message: string) => never,
    private readonly numberReader: (text: string) => number,
    private readonly maxDepth: number
  ) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.syntaxError();
    return value;
  }

  private readValue(depth: number): unknown {
    if (depth > this.maxDepth) this.fail('JSON is nested too deeply.');
    const token = this.source[this.offset];
    if (token === '{') return this.readObject(depth + 1);
    if (token === '[') return this.readArray(depth + 1);
    if (token === '"') return this.readString();
    if (token === 't') return this.readLiteral('true', true);
    if (token === 'f') return this.readLiteral('false', false);
    if (token === 'n') return this.readLiteral('null', null);
    if (token === '-' || (token >= '0' && token <= '9')) return this.readNumber();
    this.syntaxError();
  }

  private readObject(depth: number): Record<string, unknown> {
    this.offset += 1;
    this.skipWhitespace();
    const values: Array<[string, unknown]> = [];
    const keys = new Set<string>();
    if (this.consume('}')) return Object.fromEntries(values);
    while (this.offset < this.source.length) {
      if (this.source[this.offset] !== '"') this.syntaxError();
      const key = this.readString();
      if (keys.has(key)) this.fail(`JSON key ${key} is duplicated.`);
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) this.syntaxError();
      this.skipWhitespace();
      values.push([key, this.readValue(depth)]);
      this.skipWhitespace();
      if (this.consume('}')) return Object.fromEntries(values);
      if (!this.consume(',')) this.syntaxError();
      this.skipWhitespace();
    }
    this.syntaxError();
  }

  private readArray(depth: number): unknown[] {
    this.offset += 1;
    this.skipWhitespace();
    const values: unknown[] = [];
    if (this.consume(']')) return values;
    while (this.offset < this.source.length) {
      values.push(this.readValue(depth));
      this.skipWhitespace();
      if (this.consume(']')) return values;
      if (!this.consume(',')) this.syntaxError();
      this.skipWhitespace();
    }
    this.syntaxError();
  }

  private readString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset);
      if (!escaped && code === 0x22) {
        this.offset += 1;
        try {
          const value: unknown = JSON.parse(this.source.slice(start, this.offset));
          if (typeof value !== 'string') this.syntaxError();
          return value;
        } catch {
          this.syntaxError();
        }
      }
      if (!escaped && code < 0x20) this.syntaxError();
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.offset += 1;
    }
    this.syntaxError();
  }

  private readNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.offset)
    );
    if (!match) this.syntaxError();
    this.offset += match[0].length;
    const value = this.numberReader(match[0]);
    if (!Number.isFinite(value)) this.syntaxError();
    return value;
  }

  private readLiteral<T>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.offset)) this.syntaxError();
    this.offset += literal.length;
    return value;
  }

  private consume(token: string): boolean {
    if (this.source[this.offset] !== token) return false;
    this.offset += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (this.offset < this.source.length) {
      const token = this.source[this.offset];
      if (token !== ' ' && token !== '\t' && token !== '\n' && token !== '\r') return;
      this.offset += 1;
    }
  }

  private syntaxError(): never {
    this.fail(`Invalid JSON at offset ${this.offset}.`);
  }
}
