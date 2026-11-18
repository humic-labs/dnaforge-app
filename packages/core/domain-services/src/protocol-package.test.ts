import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  canonicalProtocolJson,
  parseProtocolPackage,
  parseProtocolPackageForDisplay,
  protocolExecutionDefinition,
  protocolSavedSourceSha256,
} from './protocol-package';
import { finalizePaperProtocolWorkflow, reopenPaperProtocolWorkflow } from './paper-protocol-model';
import { inventoryTableSha256 } from './inventory-table-binding';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/native-protocol-compat-v1.json', import.meta.url), 'utf8')
);
function protocol() {
  return {
    ...structuredClone(fixture.protocol),
    provenance: {
      immutableSource: false,
      provider: 'dnaforge',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
    executionExtension: { instruction: 'Retain this unknown extension exactly', numeric: 1.25 },
  };
}
function run() {
  const originalText = JSON.stringify(protocol()),
    definition = protocolExecutionDefinition(originalText),
    packet = {
      schema: 'dnaforge.protocol-saved-source.v1' as const,
      projectId: 'project',
      workspaceScope: 'project',
      protocolId: 'project::protocol-fixture',
      fileObjectUuid: 'protocol-file',
      title: 'Synthetic protocol',
      originalText,
    },
    frozenProtocol = {
      schema: 'dnaforge.protocol-execution-snapshot.v1',
      source: {
        kind: 'native-observed-saved-source',
        projectId: packet.projectId,
        workspaceScope: packet.workspaceScope,
        protocolId: packet.protocolId,
        fileObjectUuid: packet.fileObjectUuid,
        sourceSha256: protocolSavedSourceSha256(packet),
        fileSha256: inventoryTableSha256(originalText),
        originalText,
      },
      definitionSha256: definition.definitionSha256,
      declaredVersion: definition.declaredVersion,
      paperAcceptedVersion: definition.paperAcceptedVersion,
    };
  return {
    ...structuredClone(fixture.originalRunProjection.document),
    id: 'run-native',
    protocol: {
      sourceId: 'protocol-fixture',
      destinationId: packet.protocolId,
      name: packet.title,
      pinnedVersionId: `saved-${definition.definitionSha256.slice(7)}`,
      pinnedVersionHash: definition.definitionSha256,
    },
    provenance: {
      immutableSource: false,
      provider: 'dnaforge',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
    frozenProtocol,
    creation: {
      schema: 'dnaforge.protocol-run-creation.v1',
      requestId: 'create-run-once',
      intentSha256: `sha256:${'b'.repeat(64)}`,
      portableId: 'run-native',
      fileObjectUuid: 'run-file',
      createdAt: '2026-01-01T00:00:00.000Z',
      actor: 'local',
      frozenProtocolSha256: inventoryTableSha256(canonicalProtocolJson(frozenProtocol)),
    },
  };
}

it('retains unknown execution fields and distinguishes actual saved definition from stale declarations', () => {
  const first = protocol(),
    text = JSON.stringify(first),
    captured = protocolExecutionDefinition(text);
  expect(captured.definition).toEqual(first);
  expect(captured.declaredVersion).toEqual(first.version);
  const changed = protocol();
  changed.steps[0].content.content[0].content[0].text = 'Use 20 µL instead';
  expect(changed.version).toEqual(first.version);
  expect(protocolExecutionDefinition(JSON.stringify(changed)).definitionSha256).not.toBe(
    captured.definitionSha256
  );
  expect(parseProtocolPackage(text).raw).toEqual(first);
});

it('validates the retained native Run preimages, actual execution pin and creation anchor independently of later templates', () => {
  const original = run(),
    text = JSON.stringify(original);
  expect(parseProtocolPackage(text).raw).toEqual(original);
  const changedTemplate = protocol();
  changedTemplate.title = 'Later protocol';
  protocolExecutionDefinition(JSON.stringify(changedTemplate));
  expect(parseProtocolPackage(text).raw).toEqual(original);
  for (const mutate of [
    (value: ReturnType<typeof run>) => {
      value.frozenProtocol.source.originalText += ' ';
    },
    (value: ReturnType<typeof run>) => {
      value.protocol.pinnedVersionHash = `sha256:${'c'.repeat(64)}`;
    },
    (value: ReturnType<typeof run>) => {
      value.frozenProtocol.declaredVersion = {};
    },
    (value: ReturnType<typeof run>) => {
      value.creation.portableId = 'different';
    },
  ]) {
    const value = run();
    mutate(value);
    expect(() => parseProtocolPackage(JSON.stringify(value))).toThrow();
  }
});

it('keeps legacy display readable while refusing its incomplete values for native source admission', () => {
  const legacy = structuredClone(fixture.originalRunProjection.document);
  legacy.inputs = [
    { key: 'sample', label: 'Sample', value: { type: 'record', label: 'Historical label only' } },
  ];
  const original = JSON.stringify(legacy);
  expect(parseProtocolPackageForDisplay(original).raw).toEqual(legacy);
  expect(() => parseProtocolPackage(original)).toThrow(/source ID/);
  expect(JSON.stringify(legacy)).toBe(original);
});

it('rejects duplicate keys, lossy numeric meanings and invalid UTF8 while retaining exact source lexemes', () => {
  const original = JSON.stringify(protocol());
  expect(() =>
    parseProtocolPackage(original.replace('"numeric":1.25', '"numeric":9007199254740993'))
  ).toThrow(/precision/);
  expect(() =>
    parseProtocolPackage(original.replace('"numeric":1.25', '"numeric":0.100000000000000000001'))
  ).toThrow(/precision/);
  expect(() =>
    parseProtocolPackage(original.replace('"numeric":1.25', '"numeric":1.25,"numeric":2'))
  ).toThrow(/duplicated/);
  expect(() =>
    parseProtocolPackage(original.replace('"instruction":', '"invalid":"\ud800","instruction":'))
  ).toThrow(/UTF-8/);
  const exact = original.replace('"numeric":1.25', '"numeric":125e-2');
  expect(parseProtocolPackage(exact).raw).toEqual(protocol());
  expect(inventoryTableSha256(exact)).not.toBe(inventoryTableSha256(original));
});

it('uses the existing finalized paper review payload and refuses drafts, reopened papers and changed accepted content', async () => {
  const raw = {
    ...protocol(),
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: 'set',
        candidateId: 'candidate',
        ordinal: 1,
        label: 'Synthetic candidate',
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
  expect(() => protocolExecutionDefinition(JSON.stringify(raw))).toThrow(/Finalize/);
  const finalized = await finalizePaperProtocolWorkflow(raw, {
      expectedRevision: 1,
      finalizedAt: '2026-01-01T00:00:00.000Z',
      idempotencyKey: 'finalize-once',
      previewFingerprint: `sha256:${'a'.repeat(64)}`,
    }),
    captured = protocolExecutionDefinition(JSON.stringify(finalized.raw));
  expect(captured.paperAcceptedVersion).toEqual({
    acceptedVersionId: finalized.acceptedVersion.acceptedVersionId,
    contentHash: finalized.acceptedVersion.contentHash,
  });
  expect(captured.definitionSha256).toBe(finalized.acceptedVersion.contentHash);
  const changed = structuredClone(finalized.raw);
  changed.title = 'Changed after acceptance';
  expect(() => protocolExecutionDefinition(JSON.stringify(changed))).toThrow(
    /accepted execution payload/
  );
  const reopened = await reopenPaperProtocolWorkflow(finalized.raw, {
    acceptedVersionId: finalized.acceptedVersion.acceptedVersionId,
    idempotencyKey: 'reopen-once',
  });
  expect(() => protocolExecutionDefinition(JSON.stringify(reopened.raw))).toThrow(/Finalize/);
});
