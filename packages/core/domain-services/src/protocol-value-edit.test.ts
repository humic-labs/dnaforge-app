import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  canonicalProtocolJson,
  parseProtocolPackage,
  protocolExecutionDefinition,
  protocolSavedSourceSha256,
} from './protocol-package';
import { inventoryTableSha256 } from './inventory-table-binding';
import { finalizePaperProtocolWorkflow } from './paper-protocol-model';
import {
  editProtocolSlotDeclarations,
  editProtocolRunValues,
  readProtocolRunSlotDeclarations,
  ProtocolValueEditError,
  type ProtocolSlotDeclarationUpsert,
  type ProtocolRunValueUpsert,
} from './protocol-value-edit';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/native-protocol-compat-v1.json', import.meta.url), 'utf8')
);
const recordedAt = '2026-11-17T20:00:00.000Z';
const declarationUpserts: readonly ProtocolSlotDeclarationUpsert[] = [
  {
    direction: 'inputs',
    key: 'sample_name',
    label: 'Sample name',
    required: true,
    description: null,
    valueType: { kind: 'text' },
  },
  {
    direction: 'outputs',
    key: 'yield_result',
    label: 'Result',
    required: false,
    description: 'Recorded result',
    valueType: { kind: 'number' },
  },
];
function protocol() {
  return {
    ...structuredClone(fixture.protocol),
    provenance: { provider: 'dnaforge', immutableSource: false },
    extension: { untouched: ['µL', 0, false] },
  };
}
function run(
  protocolText = editProtocolSlotDeclarations(JSON.stringify(protocol()), declarationUpserts)
    .originalText
) {
  const execution = protocolExecutionDefinition(protocolText),
    packet = {
      schema: 'dnaforge.protocol-saved-source.v1' as const,
      projectId: 'project',
      workspaceScope: 'project',
      protocolId: 'project::protocol-fixture',
      fileObjectUuid: 'protocol-file',
      title: 'Synthetic protocol',
      originalText: protocolText,
    };
  const frozenProtocol = {
    schema: 'dnaforge.protocol-execution-snapshot.v1',
    source: {
      kind: 'native-observed-saved-source',
      projectId: packet.projectId,
      workspaceScope: packet.workspaceScope,
      protocolId: packet.protocolId,
      fileObjectUuid: packet.fileObjectUuid,
      sourceSha256: protocolSavedSourceSha256(packet),
      fileSha256: inventoryTableSha256(protocolText),
      originalText: protocolText,
    },
    definitionSha256: execution.definitionSha256,
    declaredVersion: execution.declaredVersion,
    paperAcceptedVersion: execution.paperAcceptedVersion,
  };
  return {
    ...structuredClone(fixture.originalRunProjection.document),
    id: 'native-run',
    protocol: {
      sourceId: 'protocol-fixture',
      destinationId: packet.protocolId,
      name: packet.title,
      pinnedVersionId: `saved-${execution.definitionSha256.slice(7)}`,
      pinnedVersionHash: execution.definitionSha256,
    },
    frozenProtocol,
    creation: {
      schema: 'dnaforge.protocol-run-creation.v1',
      requestId: 'create-once',
      intentSha256: `sha256:${'a'.repeat(64)}`,
      portableId: 'native-run',
      fileObjectUuid: 'run-file',
      createdAt: recordedAt,
      actor: 'local',
      frozenProtocolSha256: inventoryTableSha256(canonicalProtocolJson(frozenProtocol)),
    },
    provenance: { provider: 'dnaforge', immutableSource: false },
    extra: { retain: 'unknown source' },
  };
}
function values(source = run()): readonly ProtocolRunValueUpsert[] {
  const origin = {
    kind: 'frozen-declaration' as const,
    definitionSha256: source.frozenProtocol.definitionSha256,
  };
  return [
    {
      collection: 'inputs',
      key: 'sample_name',
      label: 'Recorded sample',
      value: { type: 'text', value: '' },
      origin,
    },
    {
      collection: 'outputs',
      key: 'yield_result',
      label: 'Recorded result',
      value: { type: 'number', value: 0 },
      origin,
    },
    {
      collection: 'measurements',
      key: 'accepted',
      label: 'Accepted',
      value: { type: 'boolean', value: false },
      origin: { kind: 'local-actual' },
    },
  ];
}
function code(action: () => unknown, expected: ProtocolValueEditError['code']) {
  try {
    action();
    throw new Error('Expected refusal.');
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolValueEditError);
    expect((error as ProtocolValueEditError).code).toBe(expected);
  }
}
it('upserts explicit declarations without deleting, reordering, retyping or dropping raw unsupported fields', () => {
  const raw = protocol();
  raw.inputs = [
    {
      key: 'unsupported',
      label: 'Physical quantity',
      required: false,
      description: null,
      valueType: {
        kind: 'quantity',
        unitDimension: 'volume',
        preferredUnit: 'uL',
        extra: 'retained',
      },
      unknown: { x: 1 },
    },
  ];
  const original = JSON.stringify(raw, null, 3),
    untouched = structuredClone(raw),
    result = editProtocolSlotDeclarations(original, declarationUpserts),
    parsed = parseProtocolPackage(result.originalText).raw;
  expect(raw).toEqual(untouched);
  expect((parsed.inputs as { key: string }[]).map((row) => row.key)).toEqual([
    'unsupported',
    'sample_name',
  ]);
  expect((parsed.inputs as unknown[])[0]).toEqual(raw.inputs[0]);
  expect(parsed.extension).toEqual(raw.extension);
  expect(editProtocolSlotDeclarations(result.originalText, declarationUpserts)).toEqual({
    changed: false,
    originalText: result.originalText,
  });
  const changed = editProtocolSlotDeclarations(result.originalText, [
    { ...declarationUpserts[0], label: 'New label' },
  ]);
  expect(
    (parseProtocolPackage(changed.originalText).raw.inputs as { key: string }[]).map(
      (row) => row.key
    )
  ).toEqual(['unsupported', 'sample_name']);
  code(
    () =>
      editProtocolSlotDeclarations(result.originalText, [
        { ...declarationUpserts[0], valueType: { kind: 'boolean' } },
      ]),
    'TYPE_MISMATCH'
  );
  code(
    () =>
      editProtocolSlotDeclarations(result.originalText, [
        { ...declarationUpserts[0], key: 'unsupported' },
      ]),
    'UNSUPPORTED_TARGET'
  );
  code(
    () => editProtocolSlotDeclarations(original, [declarationUpserts[0], declarationUpserts[0]]),
    'INVALID_EDIT'
  );
});
it('records empty text, numeric zero and false as real actuals with changed-only native measurement time', () => {
  const raw = run(),
    original = JSON.stringify(raw, null, 2),
    upserts = values(raw);
  const result = editProtocolRunValues(original, upserts, { recordedAt }),
    parsed = parseProtocolPackage(result.originalText).raw;
  expect(raw.inputs).toEqual([]);
  expect((parsed.inputs as { value: unknown }[])[0].value).toEqual({ type: 'text', value: '' });
  expect((parsed.outputs as { value: unknown }[])[0].value).toEqual({ type: 'number', value: 0 });
  expect(parsed.measurements).toEqual([
    { key: 'accepted', label: 'Accepted', value: { type: 'boolean', value: false }, recordedAt },
  ]);
  for (const key of [
    'creation',
    'frozenProtocol',
    'protocol',
    'provenance',
    'startedAt',
    'status',
    'immutable',
    'completedAt',
    'amendments',
    'tables',
    'links',
    'extra',
  ])
    expect(parsed[key]).toEqual(raw[key]);
  expect(
    editProtocolRunValues(result.originalText, upserts, { recordedAt: '2026-11-18T20:00:00.000Z' })
  ).toEqual({ changed: false, originalText: result.originalText });
  const changed = editProtocolRunValues(
    result.originalText,
    [{ ...upserts[2], value: { type: 'boolean', value: true } }],
    { recordedAt: '2026-11-18T20:00:00.000Z' }
  );
  expect(
    (parseProtocolPackage(changed.originalText).raw.measurements as { recordedAt: string }[])[0]
      .recordedAt
  ).toBe('2026-11-18T20:00:00.000Z');
  expect(readProtocolRunSlotDeclarations(original)).toMatchObject({
    kind: 'available',
    inputs: [{ key: 'sample_name' }],
    outputs: [{ key: 'yield_result' }],
  });
});
it('uses the frozen origin and saved types while preserving old unsupported values and legacy keys', () => {
  const raw = run();
  raw.inputs = [
    {
      key: 'old_quantity',
      label: 'Old quantity',
      value: {
        type: 'quantity',
        lexical: '4 mystery',
        value: null,
        unit: 'mystery',
        unitCompatibility: 'unrecognized',
        extra: ['raw'],
      },
      rowExtra: true,
    },
    { key: 'legacy_key ', label: 'Legacy spelling', value: { type: 'text', value: 'old' } },
  ];
  const original = JSON.stringify(raw),
    edited = editProtocolRunValues(original, values(raw), { recordedAt }),
    parsed = parseProtocolPackage(edited.originalText).raw;
  expect((parsed.inputs as unknown[]).slice(0, 2)).toEqual(raw.inputs);
  code(
    () =>
      editProtocolRunValues(original, [{ ...values(raw)[0], origin: { kind: 'local-actual' } }]),
    'ORIGIN_MISMATCH'
  );
  code(
    () =>
      editProtocolRunValues(original, [
        {
          ...values(raw)[0],
          origin: { kind: 'frozen-declaration', definitionSha256: `sha256:${'b'.repeat(64)}` },
        },
      ]),
    'ORIGIN_MISMATCH'
  );
  code(
    () =>
      editProtocolRunValues(original, [{ ...values(raw)[0], value: { type: 'number', value: 2 } }]),
    'TYPE_MISMATCH'
  );
  code(
    () =>
      editProtocolRunValues(original, [
        { ...values(raw)[2], collection: 'inputs', key: 'old_quantity' },
      ]),
    'UNSUPPORTED_TARGET'
  );
  code(
    () =>
      editProtocolRunValues(original, [
        {
          ...values(raw)[2],
          collection: 'inputs',
          key: 'legacy_key',
          value: { type: 'text', value: 'new' },
        },
      ]),
    'UNSUPPORTED_TARGET'
  );
  code(
    () =>
      editProtocolRunValues(edited.originalText, [
        { ...values(raw)[2], value: { type: 'text', value: 'false' } },
      ]),
    'TYPE_MISMATCH'
  );
  const legacy = { ...raw };
  delete legacy.frozenProtocol;
  delete legacy.creation;
  expect(readProtocolRunSlotDeclarations(JSON.stringify(legacy))).toMatchObject({
    kind: 'unavailable',
  });
  expect(
    editProtocolRunValues(JSON.stringify(legacy), [values(raw)[2]], { recordedAt }).changed
  ).toBe(true);
});
it('rejects new unsafe numbers, impossible dates, missing booleans and invalid text without narrowing stored v1 values', () => {
  const raw = run();
  raw.measurements = [
    {
      key: 'old_large',
      label: 'Preserved large number',
      value: { type: 'number', value: 9007199254740992 },
    },
  ];
  const original = JSON.stringify(raw),
    base = values(raw)[2];
  expect(editProtocolRunValues(original, [base], { recordedAt }).changed).toBe(true);
  for (const value of [
    { type: 'number', value: NaN },
    { type: 'number', value: Infinity },
    { type: 'number', value: 9007199254740992 },
    { type: 'number', value: '0' },
    { type: 'boolean', value: undefined },
    { type: 'date', value: '2026-02-30T00:00:00.000Z' },
    { type: 'date', value: '2026-01-01' },
    { type: 'text', value: 'bad\0text' },
    { type: 'text', value: '\ud800' },
  ])
    code(
      () =>
        editProtocolRunValues(original, [{ ...base, value } as ProtocolRunValueUpsert], {
          recordedAt,
        }),
      'INVALID_EDIT'
    );
  const date = editProtocolRunValues(
    original,
    [{ ...base, key: 'recorded_date', value: { type: 'date', value: recordedAt } }],
    { recordedAt }
  );
  expect(
    (parseProtocolPackage(date.originalText).raw.measurements as { value: unknown }[])[1].value
  ).toEqual({ type: 'date', value: recordedAt });
  const completed = { ...raw, status: 'completed', immutable: true, completedAt: recordedAt };
  code(
    () => editProtocolRunValues(JSON.stringify(completed), [base], { recordedAt }),
    'IMMUTABLE_DOCUMENT'
  );
});
it('advances a mutable paper draft once and requires explicit reopen for a finalized paper', async () => {
  const raw = {
    ...protocol(),
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: 'set',
        candidateId: 'candidate',
        ordinal: 1,
        label: 'Candidate',
        status: 'selected',
      },
      draft: {
        revision: 1,
        state: 'draft',
        reopenedFromAcceptedVersionId: null,
        reopenIdempotencyKeyHash: null,
      },
      sources: [],
      evidence: [],
      gaps: [],
      acceptedVersions: [],
    },
  };
  const result = editProtocolSlotDeclarations(JSON.stringify(raw), declarationUpserts),
    parsed = parseProtocolPackage(result.originalText).raw;
  expect(parsed.paperProtocol).toEqual({
    ...raw.paperProtocol,
    draft: { ...raw.paperProtocol.draft, revision: 2 },
  });
  expect(editProtocolSlotDeclarations(result.originalText, declarationUpserts)).toEqual({
    changed: false,
    originalText: result.originalText,
  });
  const finalized = await finalizePaperProtocolWorkflow(parsed, {
    expectedRevision: 2,
    finalizedAt: recordedAt,
    idempotencyKey: 'finalize-once',
    previewFingerprint: `sha256:${'a'.repeat(64)}`,
  });
  code(
    () =>
      editProtocolSlotDeclarations(JSON.stringify(finalized.raw), [
        { ...declarationUpserts[0], label: 'Changed label' },
      ]),
    'IMMUTABLE_DOCUMENT'
  );
});
