import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  parseProtocolPackage,
  protocolExecutionDefinition,
  protocolSavedSourceSha256,
} from '@waypoint/domain-services/protocol-package';

import {
  protocolCreateSchema,
  protocolPackageSaveSchema,
  protocolStartRunSchema,
  type NativeProtocolClient,
  type NativeProtocolCreationResult,
  type NativeProtocolPackageSnapshot,
} from '../../shared/protocol-packages';
import {
  appendProtocolRunTextAmendment,
  parseScientificDocument,
  renameScientificDocument,
  serializeScientificDocument,
  updateProtocolOverview,
} from './model';
import {
  createNativePaperProtocolPackage,
  createNativeProtocolPackage,
  createNativeProtocolRunPackage,
  saveNativeScientificPackage,
} from './native-package';

const boundary = vi.hoisted(() => ({
  native: {
    createProtocol: vi.fn<NativeProtocolClient['createProtocol']>(),
    startRun: vi.fn<NativeProtocolClient['startRun']>(),
    inspectCreation: vi.fn<NativeProtocolClient['inspectCreation']>(),
    recoverCreation: vi.fn<NativeProtocolClient['recoverCreation']>(),
    readPackage: vi.fn<NativeProtocolClient['readPackage']>(),
    readSavedProtocol: vi.fn<NativeProtocolClient['readSavedProtocol']>(),
    listPackages: vi.fn<NativeProtocolClient['listPackages']>(),
    savePackage: vi.fn<NativeProtocolClient['savePackage']>(),
    editProtocolDeclarations: vi.fn<NativeProtocolClient['editProtocolDeclarations']>(),
    recordRunValues: vi.fn<NativeProtocolClient['recordRunValues']>(),
  },
  resolveWorkspaceScope: vi.fn<(root: string) => Promise<string | null>>(),
  resolveCatalogEntityIdForWorkspace: vi.fn<(root: string, id: string) => Promise<string>>(),
  getCatalogEntityForFilePath: vi.fn<(path: string) => Promise<{ id: string } | null>>(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ protocols: boundary.native }) }));
vi.mock('../../db/workspace-catalog', () => ({
  resolveWorkspaceScope: boundary.resolveWorkspaceScope,
  resolveCatalogEntityIdForWorkspace: boundary.resolveCatalogEntityIdForWorkspace,
  getCatalogEntityForFilePath: boundary.getCatalogEntityForFilePath,
}));

const project = 'project-lab';
const protocolPath = '/lab/Protocols/PCR-native/.forge/protocol.json';
const paperPath = '/lab/Protocols/Paper-native/.forge/protocol.json';

describe('native protocol compatibility client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    boundary.resolveWorkspaceScope.mockResolvedValue(project);
    boundary.resolveCatalogEntityIdForWorkspace.mockResolvedValue(`${project}::protocol-pcr`);
    boundary.getCatalogEntityForFilePath.mockResolvedValue({ id: `${project}::protocol-pcr` });
  });

  it('delegates an authored provider-neutral protocol and an expected-source save to the native client', async () => {
    const original = nativeSnapshot(protocolDocument(), protocolPath);
    queueReady(boundary.native.createProtocol, original);
    boundary.native.readPackage.mockResolvedValueOnce(original);
    const created = await createNativeProtocolPackage({
      workspaceRoot: '/lab',
      packagePath: 'Protocols/PCR',
      rawId: 'protocol-pcr',
      title: 'PCR',
      createdAt: '2026-08-16T00:00:00.000Z',
    });

    const request = protocolCreateSchema.parse(boundary.native.createProtocol.mock.calls[0]![0]);
    expect(request).toMatchObject({ project, title: 'PCR', parentPath: '/lab/Protocols' });
    expect(request.requestId).toMatch(/^protocol:protocol-pcr:[a-f0-9]{64}$/);
    expect(JSON.parse(request.initialProtocolText!)).toMatchObject({
      schema: 'dnaforge.protocol.v1',
      kind: 'protocol',
      id: 'protocol-pcr',
      title: 'PCR',
      editable: true,
      steps: [{ id: 'protocol-pcr-step-1', ordinal: 1, title: 'Step 1' }],
      inputs: [],
      outputs: [],
      links: [],
      version: { sourceVersionId: 'local-v1', immutable: true },
      provenance: { provider: 'dnaforge', capturedAt: '2026-08-16T00:00:00.000Z' },
    });
    expect(parseProtocolPackage(request.initialProtocolText!).id).toBe('protocol-pcr');
    expect(created).toMatchObject({
      rawId: original.portableId,
      entityId: original.entityId,
      metaPath: original.path,
      document: { kind: 'protocol', title: 'PCR', mutable: true },
    });
    expect(boundary.native.readPackage).toHaveBeenCalledWith({
      project,
      entityId: original.entityId,
    });

    const renamed = renameScientificDocument(created.document, 'PCR v2');
    if (renamed.kind !== 'protocol') throw new Error('Expected a protocol.');
    const edited = updateProtocolOverview(renamed, 'Updated native overview');
    const text = serializeScientificDocument(edited);
    const saved = nativeSnapshot(JSON.parse(text), original.path);
    boundary.native.readPackage.mockResolvedValueOnce(original);
    queueReady(boundary.native.savePackage, saved);
    await expect(
      saveNativeScientificPackage({
        workspaceRoot: '/lab',
        metaPath: original.path,
        document: edited,
        expectedText: original.originalText,
      })
    ).resolves.toBe(saved.originalText);
    expect(boundary.getCatalogEntityForFilePath).toHaveBeenCalledWith(original.path);
    expect(protocolPackageSaveSchema.parse(boundary.native.savePackage.mock.calls[0]![0])).toEqual({
      project,
      entityId: original.entityId,
      requestId: expect.stringMatching(/^save:[a-f0-9]{64}$/),
      expectedSourceSha256: original.sourceSha256,
      originalText: text,
    });
  });

  it('starts from a native saved Protocol and retains the exact amendment save when its reply is lost', async () => {
    const savedProtocol = nativeSnapshot(protocolDocument(), protocolPath);
    const run = nativeSnapshot(
      protocolRunDocument(savedProtocol),
      '/lab/Protocol Runs/PCR-run-native/.forge/protocol-run.json'
    );
    boundary.native.readSavedProtocol.mockResolvedValueOnce(savedProtocol);
    queueReady(boundary.native.startRun, run);
    boundary.native.readPackage.mockResolvedValueOnce(run);
    const created = await createNativeProtocolRunPackage({
      workspaceRoot: '/lab',
      packagePath: 'Protocol Runs/PCR run 1',
      rawId: 'compatibility-run-request',
      title: 'PCR run 1',
      protocol: {
        rawId: 'protocol-pcr',
        name: 'Old caller label',
        pinnedVersionId: 'old-caller-version',
        pinnedVersionHash: `sha256:${'f'.repeat(64)}`,
      },
    });
    expect(boundary.resolveCatalogEntityIdForWorkspace).toHaveBeenCalledWith(
      '/lab',
      'protocol-pcr'
    );
    expect(boundary.native.readSavedProtocol).toHaveBeenCalledWith({
      project,
      entityId: savedProtocol.entityId,
    });
    expect(protocolStartRunSchema.parse(boundary.native.startRun.mock.calls[0]![0])).toEqual({
      project,
      requestId: 'start:compatibility-run-request',
      protocolId: savedProtocol.entityId,
      expectedSourceSha256: savedProtocol.sourceSha256,
      title: 'PCR run 1',
      parentPath: '/lab/Protocol Runs',
    });
    expect(created).toMatchObject({
      rawId: run.portableId,
      entityId: run.entityId,
      metaPath: run.path,
      document: { kind: 'protocol_run', title: 'PCR run 1', mutable: true, status: 'in_progress' },
    });
    if (created.document.kind !== 'protocol_run') throw new Error('Expected a protocol run.');
    expect(created.document.raw.frozenProtocol).toEqual(
      JSON.parse(run.originalText).frozenProtocol
    );

    const amended = await appendProtocolRunTextAmendment(created.document, {
      path: '/measurements/temperature',
      reason: 'Correct the recorded temperature',
      value: '37 C',
      at: '2026-08-16T01:30:00.000Z',
    });
    boundary.getCatalogEntityForFilePath.mockResolvedValue({ id: run.entityId });
    boundary.native.readPackage.mockResolvedValueOnce(run);
    boundary.native.savePackage.mockRejectedValueOnce(Error('Lost save reply'));
    const input = {
      workspaceRoot: '/lab',
      metaPath: run.path,
      document: amended,
      expectedText: run.originalText,
    };
    await expect(saveNativeScientificPackage(input)).rejects.toThrow(/needs confirmation/i);
    const firstRequest = boundary.native.savePackage.mock.calls[0]![0];
    expect(protocolPackageSaveSchema.parse(firstRequest)).toMatchObject({
      project,
      entityId: run.entityId,
      expectedSourceSha256: run.sourceSha256,
    });
    const authored = JSON.parse(firstRequest.originalText);
    expect(authored.amendments).toEqual([
      expect.objectContaining({
        sequence: 1,
        reason: 'Correct the recorded temperature',
        path: '/measurements/temperature',
        value: { type: 'text', value: '37 C' },
      }),
    ]);
    expect(authored.frozenProtocol).toEqual(created.document.raw.frozenProtocol);
    const savedRun = nativeSnapshot(authored, run.path);
    queueReady(boundary.native.savePackage, savedRun);
    await expect(saveNativeScientificPackage(input)).resolves.toBe(savedRun.originalText);
    expect(boundary.native.savePackage).toHaveBeenNthCalledWith(2, firstRequest);
    expect(boundary.native.readPackage).toHaveBeenCalledTimes(2);
    expect(boundary.getCatalogEntityForFilePath.mock.calls).toEqual([
      [created.metaPath],
      [created.metaPath],
      [created.metaPath],
    ]);
  });

  it('preserves the authored paper payload and stable intent across capture timestamps while reopening the current package', async () => {
    const originalRaw = paperProtocolDocument();
    const original = nativeSnapshot(originalRaw, paperPath);
    queueReady(boundary.native.createProtocol, original);
    boundary.native.readPackage.mockResolvedValueOnce(original);
    const created = await createPaper(originalRaw);
    const firstRequest = protocolCreateSchema.parse(
      boundary.native.createProtocol.mock.calls[0]![0]
    );
    expect(JSON.parse(firstRequest.initialProtocolText!)).toEqual(originalRaw);
    expect(created).toMatchObject({
      rawId: 'paper-protocol-source-a',
      entityId: original.entityId,
      metaPath: original.path,
      document: { kind: 'protocol', paperProtocol: { draft: { revision: 1, state: 'draft' } } },
    });

    const laterRaw = paperWithLaterCapture();
    const movedRaw = { ...originalRaw, title: 'Paper protocol renamed after creation' };
    const current = nativeSnapshot(movedRaw, '/lab/Protocols/Moved/.forge/protocol.json');
    queueReady(boundary.native.createProtocol, original);
    boundary.native.readPackage.mockResolvedValueOnce(current);
    const replay = await createPaper(laterRaw);
    const secondRequest = boundary.native.createProtocol.mock.calls[1]![0];
    expect(secondRequest.requestId).toBe(firstRequest.requestId);
    expect(JSON.parse(secondRequest.initialProtocolText!)).toEqual(laterRaw);
    expect(replay).toMatchObject({
      rawId: original.portableId,
      entityId: original.entityId,
      metaPath: current.path,
      document: { title: current.title },
    });
    expect(boundary.native.readPackage).toHaveBeenNthCalledWith(2, {
      project,
      entityId: original.entityId,
    });
  });

  it('retains original paper creation bytes across a lost reply and rejects a changed unresolved intent without RPC', async () => {
    const originalRaw = paperProtocolDocument();
    const original = nativeSnapshot(originalRaw, paperPath);
    boundary.native.createProtocol.mockRejectedValueOnce(Error('Lost creation reply'));
    await expect(createPaper(originalRaw)).rejects.toThrow(/needs confirmation/i);
    const firstRequest = boundary.native.createProtocol.mock.calls[0]![0];

    await expect(
      createPaper({ ...originalRaw, title: 'Different candidate intent' })
    ).rejects.toThrow(/confirm the previous scientific operation/i);
    expect(boundary.native.createProtocol).toHaveBeenCalledTimes(1);
    expect(boundary.native.readPackage).not.toHaveBeenCalled();

    queueReady(boundary.native.createProtocol, original);
    boundary.native.readPackage.mockResolvedValueOnce(original);
    await expect(createPaper(paperWithLaterCapture())).resolves.toMatchObject({
      entityId: original.entityId,
      metaPath: original.path,
    });
    expect(boundary.native.createProtocol).toHaveBeenNthCalledWith(2, firstRequest);
    expect(
      JSON.parse(boundary.native.createProtocol.mock.calls[1]![0].initialProtocolText!)
    ).toEqual(originalRaw);
  });

  it('surfaces the native refusal for a different paper candidate intent', async () => {
    const original = nativeSnapshot(paperProtocolDocument(), paperPath);
    queueReady(boundary.native.createProtocol, original);
    boundary.native.readPackage.mockResolvedValueOnce(original);
    await createPaper(paperProtocolDocument());
    boundary.native.createProtocol.mockImplementationOnce(async (request) => ({
      kind: 'refused',
      requestId: request.requestId,
      entityId: original.entityId,
      path: original.path,
      message: 'The existing paper Protocol has a different candidate intent.',
    }));
    await expect(
      createPaper({ ...paperProtocolDocument(), title: 'Different candidate intent' })
    ).rejects.toThrow(/different candidate intent/i);
    expect(boundary.native.readPackage).toHaveBeenCalledTimes(1);
    expect(boundary.native.savePackage).not.toHaveBeenCalled();
  });

  it('sends no save RPC for an unregistered package or changed saved source', async () => {
    const original = nativeSnapshot(protocolDocument(), protocolPath);
    const document = parseScientificDocument(original.path, original.originalText);
    const input = {
      workspaceRoot: '/lab',
      metaPath: original.path,
      document: renameScientificDocument(document, 'Changed title'),
      expectedText: original.originalText,
    };
    boundary.getCatalogEntityForFilePath.mockResolvedValueOnce(null);
    await expect(saveNativeScientificPackage(input)).rejects.toThrow(
      'The scientific package is not registered in this project.'
    );
    expect(boundary.native.readPackage).not.toHaveBeenCalled();
    expect(boundary.native.savePackage).not.toHaveBeenCalled();

    boundary.native.readPackage.mockResolvedValueOnce(
      nativeSnapshot({ ...protocolDocument(), title: 'Changed elsewhere' }, protocolPath)
    );
    await expect(saveNativeScientificPackage(input)).rejects.toThrow(/source changed.*reload/i);
    expect(boundary.native.savePackage).not.toHaveBeenCalled();
    expect(boundary.native.createProtocol).not.toHaveBeenCalled();
    expect(boundary.native.startRun).not.toHaveBeenCalled();
  });
});

function queueReady<Request extends { requestId: string }>(
  command: Mock<(request: Request) => Promise<NativeProtocolCreationResult>>,
  snapshot: NativeProtocolPackageSnapshot
) {
  command.mockImplementationOnce(async (request) => ({
    kind: 'ready',
    requestId: request.requestId,
    package: snapshot,
  }));
}

function nativeSnapshot(raw: Record<string, unknown>, path: string): NativeProtocolPackageSnapshot {
  const originalText = `${JSON.stringify(raw, null, 2)}\n`;
  const parsed = parseProtocolPackage(originalText);
  const hash = `sha256:${createHash('sha256').update(originalText).digest('hex')}` as const;
  return {
    readOnly: false,
    projectId: project,
    workspaceScope: project,
    entityId: `${project}::${parsed.id}`,
    portableId: parsed.id,
    fileObjectUuid: `file-${parsed.id}`,
    kind: parsed.kind === 'protocol' ? 'protocol' : 'protocol-run',
    title: parsed.title,
    path,
    originalText,
    sourceSha256:
      parsed.kind === 'protocol'
        ? protocolSavedSourceSha256({
            schema: 'dnaforge.protocol-saved-source.v1',
            projectId: project,
            workspaceScope: project,
            protocolId: `${project}::${parsed.id}`,
            fileObjectUuid: `file-${parsed.id}`,
            title: parsed.title,
            originalText,
          })
        : hash,
    fileSha256: hash,
    creationRequestId: null,
    definitionSha256:
      parsed.kind === 'protocol' && !raw.paperProtocol
        ? protocolExecutionDefinition(originalText).definitionSha256
        : null,
  };
}

function protocolDocument(): Record<string, unknown> {
  return {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'protocol-pcr',
    title: 'PCR',
    editable: true,
    overview: { type: 'doc', content: [{ type: 'paragraph' }] },
    steps: [
      {
        id: 'protocol-pcr-step-1',
        sourceStepId: 'local-step-1',
        ordinal: 1,
        title: 'Step 1',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: 'local-v1',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      immutable: true,
      importedAt: '2026-08-16T00:00:00.000Z',
    },
    provenance: {
      immutableSource: false,
      provider: 'dnaforge',
      capturedAt: '2026-08-16T00:00:00.000Z',
    },
  };
}

function protocolRunDocument(protocol: NativeProtocolPackageSnapshot): Record<string, unknown> {
  const definition = protocolExecutionDefinition(protocol.originalText);
  return {
    schema: 'dnaforge.protocol-run.v1',
    kind: 'protocol_run',
    id: 'native-protocol-run-1',
    title: 'PCR run 1',
    status: 'in_progress',
    immutable: false,
    protocol: {
      sourceId: protocol.portableId,
      destinationId: protocol.entityId,
      name: protocol.title,
      pinnedVersionId: `saved-${definition.definitionSha256.slice(7)}`,
      pinnedVersionHash: definition.definitionSha256,
    },
    inputs: [],
    outputs: [],
    measurements: [],
    tables: [],
    links: [],
    startedAt: '2026-08-16T01:00:00.000Z',
    completedAt: null,
    amendments: [],
    provenance: { provider: 'dnaforge', immutableSource: false },
    frozenProtocol: {
      schema: 'dnaforge.protocol-execution-snapshot.v1',
      source: {
        kind: 'native-observed-saved-source',
        projectId: protocol.projectId,
        workspaceScope: protocol.workspaceScope,
        protocolId: protocol.entityId,
        fileObjectUuid: protocol.fileObjectUuid,
        sourceSha256: protocol.sourceSha256,
        fileSha256: protocol.fileSha256,
        originalText: protocol.originalText,
      },
      definitionSha256: definition.definitionSha256,
      declaredVersion: definition.declaredVersion,
      paperAcceptedVersion: definition.paperAcceptedVersion,
    },
  };
}

function createPaper(raw: Record<string, unknown>) {
  const document = parseScientificDocument(paperPath, JSON.stringify(raw));
  if (document.kind !== 'protocol') throw new Error('Expected a protocol.');
  return createNativePaperProtocolPackage({
    workspaceRoot: '/lab',
    packagePath: 'Protocols/Paper',
    document,
  });
}

function paperWithLaterCapture(): Record<string, unknown> {
  const raw = paperProtocolDocument();
  (raw.version as Record<string, unknown>).importedAt = '2026-08-19T00:05:00.000Z';
  (raw.provenance as Record<string, unknown>).capturedAt = '2026-08-19T00:05:00.000Z';
  const workflow = raw.paperProtocol as { sources: Array<Record<string, unknown>> };
  workflow.sources[0]!.capturedAt = '2026-08-19T00:05:00.000Z';
  return raw;
}

function paperProtocolDocument(): Record<string, unknown> {
  const hash = `sha256:${'a'.repeat(64)}`;
  return {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'paper-protocol-source-a',
    title: 'Paper protocol',
    editable: true,
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'paper-step-1',
        sourceStepId: 'paper-step-1',
        ordinal: 1,
        title: 'Lyse cells',
        content: { type: 'doc', content: [] },
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: hash,
      pinnedVersionHash: hash,
      immutable: true,
      importedAt: '2026-08-19T00:00:00.000Z',
    },
    provenance: { provider: 'local-pdf', capturedAt: '2026-08-19T00:00:00.000Z' },
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: 'paper-set-source-a',
        candidateId: 'paper-candidate-source-a-1',
        ordinal: 1,
        label: 'Paper protocol',
        status: 'selected',
      },
      draft: { revision: 1, state: 'draft', reopenedFromAcceptedVersionId: null },
      sources: [
        {
          sourceId: 'source-a',
          kind: 'pdf',
          title: 'Paper PDF',
          mediaType: 'application/pdf',
          sha256: hash,
          capturedAt: '2026-08-19T00:00:00.000Z',
          workspacePath: 'papers/source.pdf',
          pageCount: 1,
        },
      ],
      evidence: [
        {
          evidenceId: 'evidence-1',
          stepId: 'paper-step-1',
          sourceId: 'source-a',
          sourceSha256: hash,
          evidenceClass: 'direct',
          quote: 'Lyse cells.',
          locator: {
            kind: 'pdf_rects',
            page: 1,
            rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.05 }],
          },
        },
      ],
      gaps: [],
      acceptedVersions: [],
    },
  };
}
