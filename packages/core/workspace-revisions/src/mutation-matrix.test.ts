import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { executeMutationMatrixCase } from './mutation-matrix-runner.test-support';
import { parseMutationMatrixFixture } from './testing-public';

const rawFixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/mutation-matrix.v1.json', import.meta.url), 'utf8')
);
const decoded = parseMutationMatrixFixture(rawFixture);
if (!decoded.ok) throw new Error(`Invalid mutation matrix: ${JSON.stringify(decoded.error)}`);
const matrix = decoded.value;

describe('workspace revision mutation matrix', () => {
  it.each(matrix.cases)('$id — $operationLabel', (row) => {
    expect(executeMutationMatrixCase(row, matrix.fixedInputs)).toEqual(row.expected);
  });

  it('fails closed on unknown, duplicate, missing, or skipped rows', () => {
    const first = matrix.cases[0];
    if (!first) throw new Error('Expected a nonempty matrix.');
    expect(
      parseMutationMatrixFixture({
        ...matrix,
        cases: [{ ...first, id: 'future-unreviewed-case' }, ...matrix.cases.slice(1)],
      })
    ).toEqual({
      ok: false,
      error: { kind: 'unknown-case', id: 'future-unreviewed-case' },
    });
    expect(parseMutationMatrixFixture({ ...matrix, cases: [...matrix.cases, first] })).toEqual({
      ok: false,
      error: { kind: 'duplicate-case', id: first.id },
    });
    expect(parseMutationMatrixFixture({ ...matrix, cases: matrix.cases.slice(1) })).toEqual({
      ok: false,
      error: { kind: 'missing-case', id: first.id },
    });
    expect(
      parseMutationMatrixFixture({
        ...matrix,
        cases: [{ ...first, execution: 'skipped' }, ...matrix.cases.slice(1)],
      })
    ).toEqual({ ok: false, error: { kind: 'invalid-matrix-fixture' } });
  });
});
