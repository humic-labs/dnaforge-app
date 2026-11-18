import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertProtocolDocument, serializeProtocolDocument } from './protocol-document';
import { assertProtocolRunDocument, buildProtocolRunProjection } from './protocol-run-projection';
import { parseProtocolPackage } from '@waypoint/domain-services';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../packages/core/domain-services/fixtures/native-protocol-compat-v1.json',
      import.meta.url
    ),
    'utf8'
  )
);
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

it('preserves the frozen original imported Protocol and Run serialization bytes through shared extraction', () => {
  expect(serializeProtocolDocument(fixture.protocol)).toBe(fixture.originalProtocolText);
  expect(sha(serializeProtocolDocument(fixture.protocol))).toBe(
    'sha256:3c838e21045435e811e24e7f7e4d049f0735a00fcc178ab5adb973feaf851224'
  );
  const run = buildProtocolRunProjection(fixture.runSource, {
    capturedAt: '2026-01-01T01:00:00.000Z',
    converterVersion: 'fixture-v1',
  });
  expect(run).toEqual(fixture.originalRunProjection);
  expect(sha(run.text)).toBe(
    'sha256:679e6a77a950fa18deddd68e192c05617f03c79ae6551ecd689a080d0c2c9601'
  );
});

it('keeps Benchling-only provenance, required declarations and imported completed-run rules strict', () => {
  const native = structuredClone(fixture.protocol);
  native.provenance = { provider: 'dnaforge', immutableSource: false };
  expect(parseProtocolPackage(JSON.stringify(native)).kind).toBe('protocol');
  expect(() => assertProtocolDocument(native)).toThrow(/immutable Benchling/);
  const partial = structuredClone(fixture.protocol);
  delete partial.links;
  partial.paperProtocol = {};
  expect(() => assertProtocolDocument(partial)).toThrow(/links must/);
  const run = structuredClone(fixture.originalRunProjection.document);
  run.provenance = { provider: 'dnaforge', immutableSource: false };
  expect(() => assertProtocolRunDocument(run)).toThrow(/immutable Benchling/);
  run.provenance = fixture.originalRunProjection.document.provenance;
  run.status = 'completed';
  run.immutable = true;
  run.completedAt = '2026-01-01T02:00:00.000Z';
  run.amendments = [
    {
      id: 'amendment',
      sequence: 1,
      at: '2026-01-01T01:00:00.000Z',
      actor: null,
      reason: 'Historical correction',
      path: '/measurements/yield',
      value: { type: 'text', value: '1' },
    },
  ];
  expect(() => assertProtocolRunDocument(run)).toThrow(/Completed imported protocol runs/);
});
