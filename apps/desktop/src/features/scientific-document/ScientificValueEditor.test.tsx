import fixture from '../../../../../packages/core/domain-services/fixtures/native-protocol-compat-v1.json';
import { expect, it } from 'vitest';
import type { NativeProtocolPackageSnapshot } from '../../shared/protocol-packages';
import { scientificValueEditRequest } from './ScientificValueEditor';
const source: NativeProtocolPackageSnapshot = {
  readOnly: false,
  projectId: 'project',
  workspaceScope: 'project',
  entityId: 'project::run',
  portableId: 'run',
  fileObjectUuid: 'file',
  kind: 'protocol-run',
  title: 'Run',
  path: '/project/run/.forge/protocol-run.json',
  originalText: JSON.stringify({
    ...fixture.originalRunProjection.document,
    status: 'in_progress',
    immutable: false,
    completedAt: null,
  }),
  sourceSha256: `sha256:${'a'.repeat(64)}`,
  fileSha256: `sha256:${'b'.repeat(64)}`,
  creationRequestId: null,
  definitionSha256: null,
};
const row = (kind: 'text' | 'number' | 'boolean' | 'date', input: string, key: string = kind) => ({
  collection: 'measurements' as const,
  key,
  label: key,
  kind,
  input,
  required: false,
  description: '',
  existing: false,
  origin: { kind: 'local-actual' as const },
});
it('keeps unchosen boolean and invalid date unsavable without defaulting a number or result', () => {
  expect(() =>
    scientificValueEditRequest(source, 'values', [row('boolean', '')], 'Reason', 'operation')
  ).toThrow(/Yes or No/);
  expect(() =>
    scientificValueEditRequest(source, 'values', [row('number', '')], 'Reason', 'operation')
  ).toThrow(/number/);
  expect(() =>
    scientificValueEditRequest(
      source,
      'values',
      [row('date', '2026-02-30T03:04:05.000Z')],
      'Reason',
      'operation'
    )
  ).toThrow(/UTC timestamp/);
});
it('prepares explicit zero, false and canonical date as distinct typed values', () => {
  const prepared = scientificValueEditRequest(
    source,
    'values',
    [
      row('number', '0', 'measurement_zero'),
      row('boolean', 'false', 'measurement_false'),
      row('date', '2026-01-02T03:04:05.000Z', 'measurement_date'),
    ],
    'Reason',
    'operation'
  );
  expect(prepared.kind).toBe('record-values');
  if (prepared.kind !== 'record-values') throw Error('Wrong purpose');
  expect(prepared.request.choices.upserts.map((item) => item.value)).toEqual([
    { type: 'number', value: 0 },
    { type: 'boolean', value: false },
    { type: 'date', value: '2026-01-02T03:04:05.000Z' },
  ]);
});
