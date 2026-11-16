import { describe, expect, it, vi } from 'vitest';
import {
  JsonNumberLexeme,
  parseUniqueJson,
  parseUniqueJsonWithNumberLexemes,
  UNIQUE_JSON_NUMBER_LIMIT_MESSAGE,
} from './unique-json';

describe('unique JSON numeric boundaries', () => {
  it('preserves ordinary reader results and negative zero', () => {
    const source = '{"text":"1.20","flag":true,"nil":null,"list":[1,-0,1.20,3e2]}';
    expect(parseUniqueJson(source)).toEqual(JSON.parse(source));
    expect(Object.is((parseUniqueJson('[-0]') as number[])[0], -0)).toBe(true);
  });

  it('passes original tokens and only one argument to the existing numeric callback', () => {
    const numberReader = vi.fn((text: string) => Number(text) * 2);
    expect(parseUniqueJson('[1.20,-0,3e2]', { numberReader })).toEqual([2.4, -0, 600]);
    expect(numberReader.mock.calls).toEqual([['1.20'], ['-0'], ['3e2']]);
  });

  it('preserves callback failures and refuses its nonfinite or nonnumeric results', () => {
    const failure = new Error('unsupported source precision');
    expect(() =>
      parseUniqueJson('1', {
        numberReader: () => {
          throw failure;
        },
      })
    ).toThrow(failure);
    for (const value of [Infinity, -Infinity, NaN, '1', null, undefined]) {
      expect(() => parseUniqueJson('1', { numberReader: () => value as number })).toThrow(
        'Invalid JSON at offset 1.'
      );
    }
    expect(() => parseUniqueJson('1e400')).toThrow('Invalid JSON at offset 5.');
  });

  it('retains large integers, trailing decimal zeros and exponents without numeric conversion', () => {
    const source = '[9007199254740993,0.10000000000000001,-0,1.2300,1e400,1e-400,7E+02]';
    const parsed = parseUniqueJsonWithNumberLexemes(source);
    const expected = [
      '9007199254740993',
      '0.10000000000000001',
      '-0',
      '1.2300',
      '1e400',
      '1e-400',
      '7E+02',
    ];
    expect(parsed.value).toEqual(expected.map((lexeme) => new JsonNumberLexeme(lexeme)));
    expect([...parsed.numberLexemes]).toEqual(expected.map((lexeme, i) => [`/${i}`, lexeme]));
    for (const value of parsed.value as JsonNumberLexeme[]) {
      expect(value).toBeInstanceOf(JsonNumberLexeme);
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('does not call numeric conversion for an exact source number', () => {
    const number = vi.spyOn(globalThis, 'Number').mockImplementation(() => {
      throw new Error('numeric conversion attempted');
    });
    let parsed;
    try {
      parsed = parseUniqueJsonWithNumberLexemes('[1e400,9007199254740993]');
    } finally {
      number.mockRestore();
    }
    expect([...parsed.numberLexemes]).toEqual([
      ['/0', '1e400'],
      ['/1', '9007199254740993'],
    ]);
  });

  it('permits a zero numeric budget only when no numeric tokens are present', () => {
    expect(
      parseUniqueJsonWithNumberLexemes('{"value":"0","other":null}', { maxNumbers: 0 })
    ).toEqual({
      value: { value: '0', other: null },
      numberLexemes: new Map(),
    });
    expect(() => parseUniqueJsonWithNumberLexemes('0', { maxNumbers: 0 })).toThrow(
      'JSON contains too many numeric tokens.'
    );
  });

  it('allows exactly the configured number of tokens across nested values', () => {
    const source = '{"a":[1,2],"b":3}';
    expect([...parseUniqueJsonWithNumberLexemes(source, { maxNumbers: 3 }).numberLexemes]).toEqual([
      ['/a/0', '1'],
      ['/a/1', '2'],
      ['/b', '3'],
    ]);
    expect(() => parseUniqueJsonWithNumberLexemes(source, { maxNumbers: 2 })).toThrow(
      'JSON contains too many numeric tokens.'
    );
    expect(() => parseUniqueJsonWithNumberLexemes('[1,2,3]')).not.toThrow();
  });

  it('reports numeric budget overflow through the configured failure function', () => {
    const fail = vi.fn((message: string): never => {
      throw new RangeError(message);
    });
    expect(() => parseUniqueJsonWithNumberLexemes('[1,2]', { maxNumbers: 1, fail })).toThrow(
      RangeError
    );
    expect(fail).toHaveBeenCalledExactlyOnceWith(UNIQUE_JSON_NUMBER_LIMIT_MESSAGE);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'refuses invalid numeric budget %j before parsing',
    (maxNumbers) => {
      const fail = vi.fn((message: string): never => {
        throw new RangeError(message);
      });
      expect(() =>
        parseUniqueJsonWithNumberLexemes('{', { maxNumbers: maxNumbers as number, fail })
      ).toThrow('JSON numeric token limit is invalid.');
      expect(fail).toHaveBeenCalledExactlyOnceWith('JSON numeric token limit is invalid.');
    }
  );

  it('distinguishes source objects and strings from numeric instances', () => {
    const parsed = parseUniqueJsonWithNumberLexemes(
      '{"object":{"lexeme":"1"},"string":"1","number":1,"null":null}'
    );
    expect(parsed.value).toEqual({
      object: { lexeme: '1' },
      string: '1',
      number: new JsonNumberLexeme('1'),
      null: null,
    });
    const values = parsed.value as Record<string, unknown>;
    expect(values.object).not.toBeInstanceOf(JsonNumberLexeme);
    expect(values.string).not.toBeInstanceOf(JsonNumberLexeme);
    expect(values.number).toBeInstanceOf(JsonNumberLexeme);
    expect([...parsed.numberLexemes]).toEqual([['/number', '1']]);
  });

  it('indexes decoded keys, empty keys, escaped pointer characters and nested arrays', () => {
    const parsed = parseUniqueJsonWithNumberLexemes(
      '{"a/b":{"~":[{"":1}]},"\\u0061":2,"~1":3,"":4,"01":5}'
    );
    expect([...parsed.numberLexemes]).toEqual([
      ['/a~1b/~0/0/', '1'],
      ['/a', '2'],
      ['/~01', '3'],
      ['/', '4'],
      ['/01', '5'],
    ]);
  });

  it('uses the empty pointer for a numeric root and no entries for numeric-looking strings', () => {
    expect([...parseUniqueJsonWithNumberLexemes('-0').numberLexemes]).toEqual([['', '-0']]);
    expect(parseUniqueJsonWithNumberLexemes('"1e400"')).toEqual({
      value: '1e400',
      numberLexemes: new Map(),
    });
  });

  for (const read of [parseUniqueJson, parseUniqueJsonWithNumberLexemes]) {
    describe(read.name, () => {
      it.each([
        '{"a":1,"a":2}',
        '{"a":1,"\\u0061":2}',
        '{"x":{"a":1,"a":2}}',
        '{"__proto__":{},"__proto__":{}}',
      ])('rejects duplicate decoded keys in %s', (source) => {
        expect(() => read(source)).toThrow(/duplicated/);
      });

      it.each([
        '',
        '01',
        '-01',
        '+1',
        '.1',
        '1.',
        '1e',
        '1e+',
        'NaN',
        'Infinity',
        '[1,]',
        '{"a":1,}',
        '{"a" 1}',
        'true false',
        '"unterminated',
        '"\\x00"',
        '"\n"',
      ])('rejects malformed JSON %j', (source) => {
        expect(() => read(source)).toThrow(/Invalid JSON/);
      });

      it('preserves safe own prototype-named keys', () => {
        const parsed = read('{"__proto__":{"polluted":true},"constructor":"source"}');
        const value = read === parseUniqueJson ? parsed : (parsed as { value: unknown }).value;
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
        expect(value).toEqual({
          ['__proto__']: { polluted: true },
          constructor: 'source',
        });
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
      });

      it('enforces the configured and default depth boundaries', () => {
        expect(() => read('[[0]]', { maxDepth: 1 })).toThrow('JSON is nested too deeply.');
        expect(() => read('[[0]]', { maxDepth: 2 })).not.toThrow();
        expect(() => read('['.repeat(17) + '0' + ']'.repeat(17))).toThrow(
          'JSON is nested too deeply.'
        );
        expect(() => read('['.repeat(16) + '0' + ']'.repeat(16))).not.toThrow();
      });

      it('delivers syntax and duplicate failures through the configured failure function', () => {
        const fail = (message: string): never => {
          throw new RangeError(`source: ${message}`);
        };
        expect(() => read('1e+', { fail })).toThrow(RangeError);
        expect(() => read('{"a":1,"a":2}', { fail })).toThrow('source: JSON key a is duplicated.');
      });
    });
  }
});
