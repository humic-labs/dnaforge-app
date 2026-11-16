export function parseUniqueJson(
  text: string,
  options: {
    fail?: (message: string) => never;
    numberReader?: (text: string) => number;
    maxDepth?: number;
  } = {}
): unknown {
  const numberReader = options.numberReader ?? Number;
  return new DuplicateRejectingJsonReader(
    text,
    options.fail ??
      ((message) => {
        throw new Error(message);
      }),
    (lexeme) => numberReader(lexeme),
    Number.isFinite,
    options.maxDepth ?? 16
  ).parse();
}

export class JsonNumberLexeme {
  constructor(readonly lexeme: string) {
    Object.freeze(this);
  }
}

type ParsedJsonValue<TNumber> =
  | null
  | boolean
  | string
  | TNumber
  | ParsedJsonValue<TNumber>[]
  | { [key: string]: ParsedJsonValue<TNumber> };

export type ExactJsonValue = ParsedJsonValue<JsonNumberLexeme>;

export const UNIQUE_JSON_NUMBER_LIMIT_MESSAGE = 'JSON contains too many numeric tokens.';

export function parseUniqueJsonWithNumberLexemes(
  text: string,
  options: {
    fail?: (message: string) => never;
    maxDepth?: number;
    maxNumbers?: number;
  } = {}
): { value: ExactJsonValue; numberLexemes: ReadonlyMap<string, string> } {
  const fail =
    options.fail ??
    ((message: string) => {
      throw new Error(message);
    });
  const maxNumbers = options.maxNumbers;
  if (maxNumbers !== undefined && (!Number.isSafeInteger(maxNumbers) || maxNumbers < 0))
    fail('JSON numeric token limit is invalid.');
  const numberLexemes = new Map<string, string>();
  const value = new DuplicateRejectingJsonReader(
    text,
    fail,
    (lexeme, pointer) => {
      if (maxNumbers !== undefined && numberLexemes.size >= maxNumbers)
        fail(UNIQUE_JSON_NUMBER_LIMIT_MESSAGE);
      numberLexemes.set(pointer, lexeme);
      return new JsonNumberLexeme(lexeme);
    },
    () => true,
    options.maxDepth ?? 16
  ).parse();
  return { value, numberLexemes };
}

class DuplicateRejectingJsonReader<TNumber> {
  private offset = 0;

  constructor(
    private readonly source: string,
    private readonly fail: (message: string) => never,
    private readonly numberReader: (text: string, pointer: string) => TNumber,
    private readonly validNumber: (value: TNumber) => boolean,
    private readonly maxDepth: number
  ) {}

  parse(): ParsedJsonValue<TNumber> {
    this.skipWhitespace();
    const value = this.readValue(0, '');
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.syntaxError();
    return value;
  }

  private readValue(depth: number, pointer: string): ParsedJsonValue<TNumber> {
    if (depth > this.maxDepth) this.fail('JSON is nested too deeply.');
    const token = this.source[this.offset];
    if (token === '{') return this.readObject(depth + 1, pointer);
    if (token === '[') return this.readArray(depth + 1, pointer);
    if (token === '"') return this.readString();
    if (token === 't') return this.readLiteral('true', true);
    if (token === 'f') return this.readLiteral('false', false);
    if (token === 'n') return this.readLiteral('null', null);
    if (token === '-' || (token >= '0' && token <= '9')) return this.readNumber(pointer);
    this.syntaxError();
  }

  private readObject(depth: number, pointer: string): Record<string, ParsedJsonValue<TNumber>> {
    this.offset += 1;
    this.skipWhitespace();
    const values: Array<[string, ParsedJsonValue<TNumber>]> = [];
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
      const escapedKey = key.replace(/~/g, '~0').replace(/\//g, '~1');
      values.push([key, this.readValue(depth, `${pointer}/${escapedKey}`)]);
      this.skipWhitespace();
      if (this.consume('}')) return Object.fromEntries(values);
      if (!this.consume(',')) this.syntaxError();
      this.skipWhitespace();
    }
    this.syntaxError();
  }

  private readArray(depth: number, pointer: string): ParsedJsonValue<TNumber>[] {
    this.offset += 1;
    this.skipWhitespace();
    const values: ParsedJsonValue<TNumber>[] = [];
    if (this.consume(']')) return values;
    while (this.offset < this.source.length) {
      values.push(this.readValue(depth, `${pointer}/${values.length}`));
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

  private readNumber(pointer: string): TNumber {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.offset)
    );
    if (!match) this.syntaxError();
    this.offset += match[0].length;
    const value = this.numberReader(match[0], pointer);
    if (!this.validNumber(value)) this.syntaxError();
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
