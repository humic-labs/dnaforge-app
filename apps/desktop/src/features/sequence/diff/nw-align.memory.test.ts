// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import original from './__fixtures__/nw-align.original.json';
import { alignSequences, type GappedAlignment } from './nw-align';

type AlignmentModule = { full(old: string, next: string): GappedAlignment };
function originalFullAlignment(): AlignmentModule {
  expect(original.commit).toBe('ab3f1636af1cd75f2c9b0ae519062e4dab260173');
  expect(original.blob).toBe('39347df9fa2fa083d9aadcf4a88d90adbda3297a');
  expect(original.sha256).toBe('7fb06a207b005bb498bef7f110352590349f29ce0c35b049d85413f69da03e6c');
  expect(createHash('sha256').update(original.source).digest('hex')).toBe(original.sha256);
  const code = ts.transpileModule(original.source + '\nexports.full = fullAffineNW;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module: AlignmentModule = {
    full: () => {
      throw new Error('Original owner not loaded');
    },
  };
  runInNewContext(code, { exports: module }, { timeout: 1000 });
  return module;
}

function words(alphabet: readonly string[], maximum: number): string[] {
  const all = [''];
  let last = [''];
  for (let length = 1; length <= maximum; length++) {
    last = last.flatMap((prefix) => alphabet.map((base) => prefix + base));
    all.push(...last);
  }
  return all;
}
function assertOriginalAlignment(owner: AlignmentModule, old: string, next: string) {
  const expected = owner.full(old, next);
  const actual = alignSequences(old, next, Math.max(old.length, next.length));
  if (actual.oldGapped !== expected.oldGapped || actual.newGapped !== expected.newGapped)
    throw new Error(JSON.stringify({ old, next, expected, actual }));
}

it.each([
  { name: 'all ACGT strings through length three', alphabet: [...'ACGT'], maximum: 3 },
  {
    name: 'ambiguity, case, RNA and gap symbols through length two',
    alphabet: [...'AaCcNnRYU-'],
    maximum: 2,
  },
  {
    name: 'all DNA IUPAC cases and U aliases',
    alphabet: [...'ACGTRYSWKMBDHVNacgtryswkmbdhvnUu'],
    maximum: 1,
  },
])('retains the immutable full alignment for $name', ({ alphabet, maximum }) => {
  const owner = originalFullAlignment();
  const sequences = words(alphabet, maximum);
  let checked = 0;
  for (const old of sequences)
    for (const next of sequences) {
      assertOriginalAlignment(owner, old, next);
      checked++;
    }
  expect(checked).toBe(sequences.length ** 2);
});

it('retains exact affine-gap traceback for repeated and case-sensitive tie-heavy inputs', () => {
  const owner = originalFullAlignment();
  const sequences = [
    '',
    'A',
    'a',
    'AAAA',
    'AAAAAA',
    'AAaaAA',
    'CCCCCCCC',
    'ATATATATATAT',
    'ATATATAAT',
    'AAAACCCC',
    'CCCCAAAA',
    'NNRRYYNN',
    'A'.repeat(41),
    'AC'.repeat(32),
    'AC'.repeat(31) + 'CC',
    'A'.repeat(12) + 'C' + 'A'.repeat(12),
  ];
  for (const old of sequences)
    for (const next of sequences) assertOriginalAlignment(owner, old, next);
});

it('retains exact unbalanced full-path traceback in both input orientations', () => {
  const owner = originalFullAlignment();
  for (const long of ['acgt'.repeat(35), 'ATATAT'.repeat(25), 'N'.repeat(129)])
    for (const short of ['', 'A', 'a', 'ACG', 'RYN', 'C'.repeat(17)]) {
      assertOriginalAlignment(owner, long, short);
      assertOriginalAlignment(owner, short, long);
    }
});

it('reserves only rolling scores and packed traceback for the exact P10 geometry without allocating it', () => {
  const source = readFileSync(new URL('./nw-align.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const attempted: Array<{ type: string; elements: number }> = [];
  const stop = new Error('DIAGNOSTIC_ALLOCATION_STOP');
  const record = (type: string, elements: number) => {
    attempted.push({ type, elements });
    if (elements > 100_000) throw stop;
  };
  const arrays = new Proxy(Array, {
    construct(target, args) {
      if (typeof args[0] === 'number') record('Array', args[0]);
      return Reflect.construct(target, args);
    },
    get(target, key, receiver) {
      if (key === 'from')
        return (input: { length: number }, map: (value: unknown, index: number) => unknown) => {
          record('Array.from', input.length);
          return Array.from(input, map);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  const typed = <T extends typeof Uint8Array | typeof Float64Array | typeof Int32Array>(
    constructor: T
  ) =>
    new Proxy(constructor, {
      construct(target, args) {
        if (typeof args[0] === 'number') record(target.name, args[0]);
        return Reflect.construct(target, args);
      },
    });
  const module = { alignSequences };
  runInNewContext(
    code,
    {
      exports: module,
      Array: arrays,
      Uint8Array: typed(Uint8Array),
      Float64Array: typed(Float64Array),
      Int32Array: typed(Int32Array),
    },
    { timeout: 1000 }
  );
  const old = ('atg' + 'ccc'.repeat(32) + 'taa').repeat(5001);
  const next = 'CCC' + 'c'.repeat(96) + 'CCCCCC' + 'c'.repeat(18);
  expect(() => module.alignSequences(old, next)).toThrow(stop);
  expect(attempted[attempted.length - 1]).toEqual({
    type: 'Uint8Array',
    elements: (510102 + 1) * (123 + 1),
  });
  expect(attempted.slice(0, -1)).toEqual(
    Array.from({ length: 6 }, () => ({ type: 'Float64Array', elements: 124 }))
  );
});
