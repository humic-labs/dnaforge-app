import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createImportSequenceTool as originalCreateImportSequenceTool } from './import-sequence';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { importSequenceOutputSchema } from './sequence-output-schemas';
const createImportSequenceTool = checkedSequenceToolFactory(
  originalCreateImportSequenceTool,
  importSequenceOutputSchema
);

import { execOpts, execTool } from './test-helpers';
import { sequenceResourceUri } from './get-sequence';
import { callRendererTool, type RendererAuditRecord } from '../../agent-bridge/renderer-bridge';
import { ALLOWED_RENDERER_TOOLS } from '../../agent-bridge/renderer-tools';
import { assertToolOperationResult } from '../../agent-bridge/tool-result';
import { dispatchLocally, HostedToolExecutionError } from '../orchestration/hosted-policy-tools';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { defineBlob } from '@waypoint/workspace-revisions';
import { SequenceCreationPendingError } from '../../sequence/public/create-empty-dna-sequence';

vi.mock('../../../services/agent-caller', async () => {
  const { TEST_AGENT_CALLER } = await import('../../../test/fixtures/agent-caller');
  return { resolveCurrentAgentCaller: vi.fn(async () => TEST_AGENT_CALLER) };
});

const mockSettleImportedSequenceBindings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../sequence/public/settle-imported-sequence-bindings', () => ({
  settleImportedSequenceBindings: mockSettleImportedSequenceBindings,
}));

const {
  mockImportSequenceFromContent,
  mockManagedOpenPackage,
  mockManagedFindByMemberPath,
  mockOpenManagedSequenceDocument,
  mockPlatform,
  mockSidecarFetchSequenceBytes,
  mockSidecarFetchSequenceUrlBytes,
  mockNamespace,
  mockCreateSequencePackage,
} = vi.hoisted(() => ({
  mockImportSequenceFromContent: vi.fn(),
  mockManagedOpenPackage: vi.fn(),
  mockManagedFindByMemberPath: vi.fn(),
  mockOpenManagedSequenceDocument: vi.fn(),
  mockPlatform: {
    fs: {
      exists: vi.fn(),
      mkdir: vi.fn(),
      readTextFile: vi.fn(),
      readDir: vi.fn(),
      stat: vi.fn(),
      writeTextFile: vi.fn(),
      packageSequenceFile: vi.fn(),
    },
    workspace: {
      importSequenceFromContent: vi.fn(),
    },
  },
  mockSidecarFetchSequenceBytes: vi.fn(),
  mockSidecarFetchSequenceUrlBytes: vi.fn(),
  mockNamespace: vi.fn(),
  mockCreateSequencePackage: vi.fn(),
}));

vi.mock('../../../services/read-scientific-namespace', () => ({
  readScientificNamespace: mockNamespace,
}));
vi.mock('../../sequence/public/create-empty-dna-sequence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sequence/public/create-empty-dna-sequence')>()),
  createDnaSequencePackage: mockCreateSequencePackage,
}));

beforeEach(() => {
  mockNamespace.mockReset().mockResolvedValue(null);
  mockCreateSequencePackage.mockReset();
});

mockPlatform.workspace.importSequenceFromContent = mockImportSequenceFromContent;

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../document-opening/compat', () => ({
  openManagedSequenceDocument: mockOpenManagedSequenceDocument,
}));

vi.mock('../../sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: {
    openPackage: mockManagedOpenPackage,
    findByMemberPath: mockManagedFindByMemberPath,
  },
}));

vi.mock('./sidecar-client', () => ({
  sidecarFetchSequenceBytes: mockSidecarFetchSequenceBytes,
  sidecarFetchSequenceUrlBytes: mockSidecarFetchSequenceUrlBytes,
}));

const WORKSPACE = '/home/user/lab';
const singleFolder: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

describe('enrolled GenBank import authority', () => {
  it('uses accepted package creation and awaits it before managed opening', async () => {
    setupGenBankMocks();
    setupManagedPackagingMocks();
    mockNamespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    mockCreateSequencePackage.mockResolvedValue({
      filePath: `${WORKSPACE}/imports/accepted/accepted.gb`,
      tabId: null,
      committed: true,
    });
    const result = await execTool(createImportSequenceTool(singleFolder), {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      name: 'accepted',
      open: true,
    });
    expect(result).toMatchObject({ ok: true, imported: true, opened: true });
    expect(mockCreateSequencePackage).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'accepted',
        destinationPath: `${WORKSPACE}/imports`,
        open: false,
        content: expect.stringContaining('LOCUS'),
      })
    );
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
    expect(mockCreateSequencePackage.mock.invocationCallOrder[0]).toBeLessThan(
      mockManagedOpenPackage.mock.invocationCallOrder[0]
    );
  });

  it('returns captured accepted authority and reuses it unchanged for a blocked import', async () => {
    setupGenBankMocks();
    setupManagedPackagingMocks();
    mockNamespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    const content = await mockPlatform.fs.readTextFile();
    const creation = {
      name: 'accepted',
      destinationPath: `${WORKSPACE}/imports`,
      workspaceRoot: WORKSPACE,
      artifactPath: `${WORKSPACE}/imports/accepted/accepted.gb`,
      resourceId: 'accepted-sequence',
      expectedHead: `wv_${'a'.repeat(64)}`,
      content,
      sequencePackageText: '{"exact":"metadata"}',
    };
    const accepted = {
      kind: 'accepted-object' as const,
      resourceId: creation.resourceId,
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'c'.repeat(64)}`,
      contentSha256: 'd'.repeat(64),
      sequenceEditParentEventId: null,
    };
    mockCreateSequencePackage.mockRejectedValueOnce(
      new SequenceCreationPendingError(creation, accepted, 'EACCES')
    );
    const tool = createImportSequenceTool(singleFolder);
    const pending = await execTool(tool, {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      name: 'accepted',
      open: false,
    });
    expect(pending).toMatchObject({
      ok: false,
      code: 'IMPORT_PUBLICATION_PENDING',
      stateChanged: true,
      retriable: true,
      details: {
        accepted,
        acceptedImport: {
          resourceId: creation.resourceId,
          expectedHead: creation.expectedHead,
          sequencePackageText: creation.sequencePackageText,
          contentSha256: defineBlob(new TextEncoder().encode(content)).hash,
        },
      },
    });
    if (pending.ok) throw Error('Expected pending import');
    mockCreateSequencePackage.mockResolvedValueOnce({
      filePath: creation.artifactPath,
      tabId: null,
      committed: true,
      publication: { creation, accepted },
    });
    await execTool(tool, {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      name: 'accepted',
      open: false,
      acceptedImport: pending.details?.acceptedImport,
    });
    expect(mockCreateSequencePackage.mock.calls[1][0].publication).toEqual(creation);
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });

  it('refuses a changed source receipt and an unavailable accepted project without filesystem fallback', async () => {
    setupGenBankMocks();
    mockNamespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    const args = {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      name: 'accepted',
      acceptedImport: {
        resourceId: 'accepted-sequence',
        expectedHead: `wv_${'a'.repeat(64)}`,
        sequencePackageText: '{}',
        contentSha256: 'sha256:changed',
      },
    };
    expect(await execTool(createImportSequenceTool(singleFolder), args)).toMatchObject({
      ok: false,
      code: 'IMPORT_TARGET_EXISTS',
      stateChanged: false,
    });
    mockNamespace.mockResolvedValue(null);
    expect(await execTool(createImportSequenceTool(singleFolder), args)).toMatchObject({
      ok: false,
      code: 'IMPORT_INVALID_DESTINATION',
      stateChanged: false,
    });
    expect(mockCreateSequencePackage).not.toHaveBeenCalled();
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });
});

function packageStem(packageRoot: string): string {
  return packageRoot.slice(packageRoot.lastIndexOf('/') + 1);
}

function documentIdForPackage(packageRoot: string): string {
  return `sequence-${packageStem(packageRoot)}`;
}

function setupManagedPackagingMocks(tabId = 'tab-1'): void {
  mockImportSequenceFromContent.mockImplementation(
    async (request: {
      targetRoot: string;
      relativePath: string;
      collisionPolicy: 'refuse' | 'replace';
    }) => {
      const loosePath = `${request.targetRoot}/${request.relativePath}`;
      const packageRoot = loosePath.replace(/\.[^./]+$/u, '');
      const stem = packageStem(packageRoot);
      return {
        kind: 'imported',
        destPath: `${packageRoot}/${stem}.gb`,
        relPath: `${request.relativePath.replace(/\.[^./]+$/u, '')}/${stem}.gb`,
        packageRoots: [packageRoot],
        packageProductPaths: [`${packageRoot}/${stem}.gb`],
        committed: true,
        replaced: request.collisionPolicy === 'replace',
        stateChanged: true,
        partialEffects: [],
      };
    }
  );
  mockManagedOpenPackage.mockImplementation(async (packageRoot: string) => {
    const stem = packageStem(packageRoot);
    const packageId = documentIdForPackage(packageRoot);
    return {
      ref: { kind: 'managed-sequence', packageId, packageRoot },
      document: { id: packageId, name: stem },
      productPath: `${packageRoot}/${stem}.gb`,
    };
  });
  mockOpenManagedSequenceDocument.mockResolvedValue(tabId);
}

function setupGenBankMocks() {
  const content = genBankContent('pUC19', 'ATGCGT', [
    { displayName: 'AmpR promoter', type: 'promoter', start: 1, end: 6 },
  ]);
  mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
  mockPlatform.fs.readTextFile.mockResolvedValue(content);
  setupManagedPackagingMocks();
  return content;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockManagedFindByMemberPath.mockResolvedValue(null);
});

describe('one publication owner for project sequences', () => {
  it('reuses the exact managed source instead of importing a second entity', async () => {
    setupGenBankMocks();
    mockManagedFindByMemberPath.mockResolvedValue({
      ref: {
        kind: 'managed-sequence',
        packageId: 'existing-sequence',
        packageRoot: `${WORKSPACE}/pUC19`,
      },
      document: { id: 'existing-sequence', name: 'pUC19' },
      productPath: `${WORKSPACE}/pUC19/contents/pUC19.gb`,
    });
    const result = await execTool(createImportSequenceTool(singleFolder), {
      sourcePath: `${WORKSPACE}/pUC19/contents/pUC19.gb`,
    });
    expect(result).toMatchObject({
      ok: true,
      imported: true,
      reused: true,
      documentId: 'existing-sequence',
    });
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });

  it('refuses a second publication of a loose file already owned by the watched project', async () => {
    setupGenBankMocks();
    const result = await execTool(createImportSequenceTool(singleFolder), {
      sourcePath: `${WORKSPACE}/generated/pUC19.gb`,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'SOURCE_ALREADY_IN_PROJECT',
      stateChanged: false,
    });
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });

  it('permits an explicitly requested distinct copy even when DNA is identical', async () => {
    setupGenBankMocks();
    const result = await execTool(createImportSequenceTool(singleFolder), {
      sourcePath: `${WORKSPACE}/generated/pUC19.gb`,
      copyWithinProject: true,
    });
    expect(result).toMatchObject({ ok: true, imported: true });
    expect(mockImportSequenceFromContent).toHaveBeenCalledOnce();
  });
});

function setupNcbiSidecarMocks(content = genBankContent('E. coli K-12', 'ATGCGTATGC', [])) {
  setupManagedPackagingMocks('tab-ncbi');
  mockSidecarFetchSequenceBytes.mockResolvedValue({
    provider: 'ncbi-nuccore',
    externalId: 'NC_000913.3',
    format: 'genbank',
    content,
    contentSha256: 'a'.repeat(64),
    sourceUrl: 'https://www.ncbi.nlm.nih.gov/nuccore/NC_000913.3',
    license: 'Public domain (NCBI/GenBank)',
    attribution: 'Courtesy of the U.S. National Library of Medicine (NCBI)',
    versionIdentifier: '3',
    etag: undefined,
    metadata: {
      organism: 'Escherichia coli str. K-12 substr. MG1655',
      definition: 'Escherichia coli str. K-12 substr. MG1655, complete genome.',
      taxon_id: '511145',
      length: 4641652,
      topology: 'circular',
    },
  });
}

async function callImport(args: Record<string, unknown> = {}, auditFails = false) {
  const records: RendererAuditRecord[] = [];
  const response = await callRendererTool(
    {
      tool_name: 'import_sequence',
      args: { sourcePath: '/home/user/Downloads/pUC19.gb', ...args },
      agent_identity: 'fixture-test',
      action_id: 'fixture-import',
    },
    {
      folders: singleFolder,
      agentCapabilities: [...ALLOWED_RENDERER_TOOLS.import_sequence.required_capabilities],
      auditSink: {
        write: async (record) => {
          records.push(record);
          if (auditFails && records.length > 1) throw new Error('Audit storage unavailable');
          return `audit-${records.length}`;
        },
      },
    }
  );
  return { response, records };
}

describe('import operation result across consumers', () => {
  it.each([
    ['invalid name', { name: 'pUC19.gb' }, 'IMPORT_INVALID_NAME', () => {}],
    [
      'source read failure',
      {},
      'IMPORT_FAILED',
      () => mockPlatform.fs.readTextFile.mockRejectedValueOnce(new Error('Source unreadable')),
    ],
  ] as const)('classifies %s as failure before any mutation', async (_name, args, code, setup) => {
    setupGenBankMocks();
    setup();
    const { response, records } = await callImport(args);
    expect(response).toMatchObject({
      ok: false,
      error: { code, retriable: false, details: { stateChanged: false, partialEffects: [] } },
    });
    expect(records.map((record) => record.status)).toEqual(['accepted', 'failed']);
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });

  it("preserves the native owner's settled failure result", async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'failed',
      code: 'IMPORT_FAILED',
      error: `Disk write interrupted at ${WORKSPACE}/imports/private.gb`,
      retriable: false,
      stateChanged: 'unknown',
      partialEffects: [],
    });
    const { response, records } = await callImport();
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'IMPORT_FAILED',
        details: {
          stateChanged: 'unknown',
          stateMayHaveChanged: true,
          partialEffects: [],
        },
      },
    });
    expect(records[1].status).toBe('failed');
    expect(JSON.stringify(response)).not.toContain(WORKSPACE);
  });

  it('preserves committed package effects when document opening fails', async () => {
    setupGenBankMocks();
    mockManagedOpenPackage.mockRejectedValueOnce(new Error('Document unavailable'));
    const { response } = await callImport();
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'IMPORT_FAILED',
        retriable: false,
        details: {
          stateChanged: true,
          partialEffects: [{ kind: 'sequence-packages-created', count: 1 }],
        },
      },
    });
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();
  });

  it('preserves committed package effects when tab opening fails', async () => {
    setupGenBankMocks();
    mockOpenManagedSequenceDocument.mockRejectedValueOnce(new Error('Viewer failed'));
    const { response } = await callImport();
    expect(response).toMatchObject({
      ok: false,
      error: {
        details: {
          stateChanged: true,
          partialEffects: expect.arrayContaining([{ kind: 'sequence-packages-created', count: 1 }]),
        },
      },
    });
  });

  it('preserves cancellation when the source throws AbortError', async () => {
    setupGenBankMocks();
    mockPlatform.fs.readTextFile.mockRejectedValueOnce(new DOMException('Stopped', 'AbortError'));
    const { response, records } = await callImport();
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'CANCELED', retriable: true, details: { stateChanged: false } },
    });
    expect(records[1].error?.code).toBe('CANCELED');
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });

  it('keeps terminal audit failure authoritative while preserving the operation refusal', async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      error: 'A managed sequence package named "pUC19" already exists.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
    const { response } = await callImport({}, true);
    expect(response).toMatchObject({
      ok: false,
      audit_id: 'audit-1',
      error: {
        code: 'AUDIT_UNAVAILABLE',
        details: {
          terminalStatus: 'failed',
          handlerError: { code: 'IMPORT_TARGET_EXISTS', details: { stateChanged: false } },
        },
      },
    });
  });

  it('checks actual successful and refused factory outputs against the result contract', async () => {
    setupGenBankMocks();
    const success = await execTool(createImportSequenceTool(singleFolder), {
      sourcePath: '/home/user/Downloads/pUC19.gb',
    });
    assertToolOperationResult(success);
    expect(success).toMatchObject({ ok: true, imported: true, documentId: 'sequence-pUC19' });
    const failure = await execTool(createImportSequenceTool([]), {
      sourcePath: '/home/user/Downloads/pUC19.gb',
    });
    assertToolOperationResult(failure);
    expect(failure).toMatchObject({ ok: false, imported: false, code: 'NO_WORKSPACE' });
  });

  it('keeps an actual empty file listing successful through the same bridge', async () => {
    mockPlatform.fs.readDir.mockResolvedValueOnce([]);
    const records: RendererAuditRecord[] = [];
    const response = await callRendererTool(
      {
        tool_name: 'list_files',
        args: {},
        agent_identity: 'fixture-test',
        action_id: 'empty-read',
      },
      {
        folders: singleFolder,
        agentCapabilities: ['read-workspace'],
        auditSink: {
          write: async (record) => {
            records.push(record);
            return 'empty-audit';
          },
        },
      }
    );
    expect(response).toMatchObject({ ok: true, result: { entries: [], count: 0 } });
    expect(records.map((record) => record.status)).toEqual(['completed']);
  });

  it('makes the local Hosted adapter throw the actual import refusal with its details', async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      error: 'A managed sequence package named "pUC19" already exists.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
    const previousFolders = useWorkspaceStore.getState().folders;
    useWorkspaceStore.setState({ folders: singleFolder });
    try {
      const call = dispatchLocally(
        'import_sequence',
        { sourcePath: '/home/user/Downloads/pUC19.gb' },
        { toolCallId: 'hosted-refusal' }
      );
      await expect(call).rejects.toBeInstanceOf(HostedToolExecutionError);
      await expect(call).rejects.toMatchObject({
        code: 'IMPORT_TARGET_EXISTS',
        retriable: false,
        details: { stateChanged: false },
      });
      expect(mockImportSequenceFromContent).toHaveBeenCalledTimes(1);
    } finally {
      useWorkspaceStore.setState({ folders: previousFolders });
    }
  });
});

describe('import_sequence tool', () => {
  it('reports an existing-target refusal through the actual catalog and failed action audit', async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      error: 'A managed sequence package named "pUC19" already exists.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
    const records: RendererAuditRecord[] = [];
    const response = await callRendererTool(
      {
        tool_name: 'import_sequence',
        args: { sourcePath: '/home/user/Downloads/pUC19.gb', overwrite: false },
        agent_identity: 'fixture-test',
        action_id: 'fixture-refusal',
      },
      {
        folders: singleFolder,
        agentCapabilities: [...ALLOWED_RENDERER_TOOLS.import_sequence.required_capabilities],
        auditSink: {
          write: async (record) => {
            records.push(record);
            return `audit-${records.length}`;
          },
        },
      }
    );
    expect(mockImportSequenceFromContent).toHaveBeenCalledWith(
      expect.objectContaining({ collisionPolicy: 'refuse' })
    );
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'IMPORT_TARGET_EXISTS', retriable: false, details: { stateChanged: false } },
      audit_id: 'audit-2',
    });
    expect(records.map((record) => record.status)).toEqual(['accepted', 'failed']);
    expect(records[1].error).toMatchObject({ code: 'IMPORT_TARGET_EXISTS' });
  });

  it('packages a local GenBank file and opens it by stable document identity', async () => {
    const content = setupGenBankMocks();
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{
      imported: boolean;
      source: { kind: string };
      documentId: string;
      resourceUri: string;
      documents: Array<{ documentId: string; resourceUri: string; name: string }>;
      name: string;
      format: string;
      length: number;
      featureCount: number;
      opened: boolean;
      tabId: string;
    }>(tool, {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      destinationFolder: 'plasmids',
      name: 'pUC19-imported',
    });

    const documentId = 'sequence-pUC19-imported';

    expect(result).toMatchObject({
      imported: true,
      source: { kind: 'local_file' },
      documentId,
      resourceUri: sequenceResourceUri(documentId),
      documents: [
        {
          documentId,
          resourceUri: sequenceResourceUri(documentId),
          name: 'pUC19-imported',
        },
      ],
      name: 'pUC19',
      format: 'genbank',
      length: 6,
      featureCount: 1,
      opened: true,
      tabId: 'tab-1',
    });
    expect(result).not.toHaveProperty('path');
    expect(result).not.toHaveProperty('absolutePath');
    expect(result.source).not.toHaveProperty('path');
    expect(result.source).not.toHaveProperty('absolutePath');
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith('/home/user/Downloads/pUC19.gb');
    expect(mockImportSequenceFromContent).toHaveBeenCalledWith({
      targetRoot: WORKSPACE,
      relativePath: 'plasmids/pUC19-imported.gb',
      content,
      collisionPolicy: 'refuse',
    });
    expect(mockManagedOpenPackage).toHaveBeenCalledWith(`${WORKSPACE}/plasmids/pUC19-imported`);
    expect(mockOpenManagedSequenceDocument).toHaveBeenCalledWith(
      {
        kind: 'managed-sequence',
        packageId: documentId,
        packageRoot: `${WORKSPACE}/plasmids/pUC19-imported`,
      },
      { label: 'pUC19-imported', strategy: { kind: 'smart' } }
    );
  });

  it('uses imports/<source stem> as the default managed package location', async () => {
    setupGenBankMocks();
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ documentId: string; resourceUri: string }>(tool, {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      open: false,
    });

    expect(result.documentId).toBe('sequence-pUC19');
    expect(result.resourceUri).toBe(sequenceResourceUri('sequence-pUC19'));
    expect(mockImportSequenceFromContent).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRoot: WORKSPACE,
        relativePath: 'imports/pUC19.gb',
        collisionPolicy: 'refuse',
      })
    );
    expect(mockManagedOpenPackage).toHaveBeenCalledWith(`${WORKSPACE}/imports/pUC19`);
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();
  });

  it('accepts the canonical local_file source shape', async () => {
    setupGenBankMocks();
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{
      imported: boolean;
      source: { kind: string };
      documentId: string;
    }>(tool, {
      source: { kind: 'local_file', path: '/home/user/Downloads/pUC19.gb' },
      name: 'pUC19-from-source',
    });

    expect(result).toMatchObject({
      imported: true,
      source: { kind: 'local_file' },
      documentId: 'sequence-pUC19-from-source',
    });
    expect(result.source).not.toHaveProperty('path');
    expect(result.source).not.toHaveProperty('absolutePath');
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith('/home/user/Downloads/pUC19.gb');
  });

  it('imports an NCBI accession through the sidecar provider with provenance', async () => {
    const ncbiContent = genBankContent('E. coli K-12', 'ATGCGTATGC', []);
    setupNcbiSidecarMocks(ncbiContent);
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{
      imported: boolean;
      source: {
        kind: string;
        accession: string;
        database: string;
        provenance: {
          provider: string;
          fetchedVia: string;
          sourceUrl: string;
          license: string;
          organism: string;
          contentSha256: string;
        };
      };
      documentId: string;
      resourceUri: string;
      name: string;
      opened: boolean;
      tabId: string;
    }>(tool, {
      source: { kind: 'ncbi', accession: 'nc_000913.3', database: 'nucleotide' },
    });

    expect(result).toMatchObject({
      imported: true,
      source: {
        kind: 'ncbi',
        accession: 'NC_000913.3',
        database: 'nucleotide',
        provenance: {
          provider: 'ncbi-nuccore',
          fetchedVia: 'sidecar',
          sourceUrl: 'https://www.ncbi.nlm.nih.gov/nuccore/NC_000913.3',
          organism: 'Escherichia coli str. K-12 substr. MG1655',
          contentSha256: 'a'.repeat(64),
        },
      },
      documentId: 'sequence-NC_000913.3',
      resourceUri: sequenceResourceUri('sequence-NC_000913.3'),
      name: 'E. coli K-12',
      opened: true,
      tabId: 'tab-ncbi',
    });

    expect(mockSidecarFetchSequenceBytes).toHaveBeenCalledWith({ externalId: 'nc_000913.3' });
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
    expect(mockImportSequenceFromContent).toHaveBeenCalledWith({
      targetRoot: WORKSPACE,
      relativePath: 'imports/NC_000913.3.gb',
      content: ncbiContent,
      collisionPolicy: 'refuse',
    });
  });

  it('surfaces a recoverable error when the sidecar NCBI fetch fails', async () => {
    mockSidecarFetchSequenceBytes.mockRejectedValue(
      new Error('"NX_000000.0" is not a recognized NCBI nucleotide accession (e.g. NC_000913.3).')
    );
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ imported: boolean; error: string }>(tool, {
      source: { kind: 'ncbi', accession: 'NX_000000.0' },
    });

    expect(result.imported).toBe(false);
    expect(result.error).toContain('not a recognized NCBI nucleotide accession');
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });

  it('detects a duplicate NCBI import via its default accession filename', async () => {
    setupNcbiSidecarMocks();
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      error: 'A managed sequence package named "NC_000913.3" already exists.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ imported: boolean; error: string }>(tool, {
      source: { kind: 'ncbi', accession: 'NC_000913.3' },
    });

    expect(result.imported).toBe(false);
    expect(result.error).toContain('managed sequence package');
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();

    expect(mockSidecarFetchSequenceBytes).toHaveBeenCalledWith({ externalId: 'NC_000913.3' });
  });

  it('rejects ambiguous legacy and canonical sources', async () => {
    setupGenBankMocks();
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ imported: boolean; error: string }>(tool, {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      source: { kind: 'local_file', path: '/home/user/Downloads/pUC19.gb' },
    });

    expect(result.imported).toBe(false);
    expect(result.error).toContain('Pass either source or sourcePath');
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing target unless overwrite is true', async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      error: 'A managed sequence package named "pUC19" already exists.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ imported: boolean; error: string }>(tool, {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      destinationFolder: 'plasmids',
    });

    expect(result.imported).toBe(false);
    expect(result.error).toContain('managed sequence package');
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();
  });

  it('imports URL content fetched through the sidecar', async () => {
    setupManagedPackagingMocks();
    mockSidecarFetchSequenceUrlBytes.mockResolvedValueOnce({
      provider: 'public-url',
      externalId: 'https://example.com/pUC19.gb',
      format: 'auto',
      content: genBankContent('pUC19', 'ATGC', []),
      contentSha256: 'e'.repeat(64),
      sourceUrl: 'https://example.com/pUC19.gb',
      attribution: 'Source: example.com',
      metadata: {},
    });
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ imported: boolean; source: { kind: string; url: string } }>(
      tool,
      {
        sourcePath: 'https://example.com/pUC19.gb',
      }
    );

    expect(result.imported).toBe(true);
    expect(result.source).toMatchObject({
      kind: 'url',
      url: 'https://example.com/pUC19.gb',
      provenance: { provider: 'public-url', fetchedVia: 'sidecar' },
    });
    expect(mockSidecarFetchSequenceUrlBytes).toHaveBeenCalledOnce();
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('reserves Addgene source shape without fetching yet', async () => {
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ imported: boolean; error: string }>(tool, {
      source: { kind: 'addgene', plasmidId: '12345' },
    });

    expect(result.imported).toBe(false);
    expect(result.error).toContain("Addgene import isn't available yet");
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('does not read unsupported local file extensions', async () => {
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<{ imported: boolean; error: string }>(tool, {
      sourcePath: '/home/user/.ssh/id_rsa',
    });

    expect(result.imported).toBe(false);
    expect(result.error).toContain('only accepts GenBank or FASTA');
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });
});

function genBankContent(
  name: string,
  sequence: string,
  features: Array<{ displayName: string; type: string; start: number; end: number }>
): string {
  const featureLines = features.flatMap((feature) => [
    `     ${feature.type.padEnd(15)} ${feature.start}..${feature.end}`,
    `                     /label="${feature.displayName}"`,
  ]);
  return [
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(7)} bp    DNA     circular SYN 01-JAN-2026`,
    `DEFINITION  ${name}.`,
    'FEATURES             Location/Qualifiers',
    ...featureLines,
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
  ].join('\n');
}

describe('import_sequence — authoritative managed package identity', () => {
  const packaged = (stem: string, folder = 'plasmids') => ({
    kind: 'imported' as const,
    destPath: `${WORKSPACE}/${folder}/${stem}/${stem}.gb`,
    relPath: `${folder}/${stem}/${stem}.gb`,
    packageRoots: [`${WORKSPACE}/${folder}/${stem}`],
    packageProductPaths: [`${WORKSPACE}/${folder}/${stem}/${stem}.gb`],
    committed: true,
    replaced: false,
    stateChanged: true as const,
    partialEffects: [] as const,
  });

  it('reports stable document identity without leaking the private product path', async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValue(packaged('pUC19-imported'));

    const result = await execTool<{
      documentId: string;
      resourceUri: string;
      path?: string;
      absolutePath?: string;
    }>(createImportSequenceTool(singleFolder), {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      destinationFolder: 'plasmids',
      name: 'pUC19-imported',
    });

    expect(result.documentId).toBe('sequence-pUC19-imported');
    expect(result.resourceUri).toBe(sequenceResourceUri('sequence-pUC19-imported'));
    expect(result).not.toHaveProperty('path');
    expect(result).not.toHaveProperty('absolutePath');
  });

  it('opens the managed package reference instead of a filesystem path', async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValue(packaged('pUC19-imported'));

    await execTool(createImportSequenceTool(singleFolder), {
      sourcePath: '/home/user/Downloads/pUC19.gb',
      destinationFolder: 'plasmids',
      name: 'pUC19-imported',
    });

    expect(mockManagedOpenPackage).toHaveBeenCalledWith(`${WORKSPACE}/plasmids/pUC19-imported`);
    expect(mockOpenManagedSequenceDocument).toHaveBeenCalledWith(
      {
        kind: 'managed-sequence',
        packageId: 'sequence-pUC19-imported',
        packageRoot: `${WORKSPACE}/plasmids/pUC19-imported`,
      },
      expect.objectContaining({ strategy: { kind: 'smart' } })
    );
  });

  it('🟥 refuses to clobber an EXISTING package when overwrite is false', async () => {
    setupGenBankMocks();

    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_TARGET_EXISTS',
      error: 'A managed sequence package named "pUC19-imported" already exists.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });

    const result = await execTool<{ imported: boolean; error: string }>(
      createImportSequenceTool(singleFolder),
      {
        sourcePath: '/home/user/Downloads/pUC19.gb',
        destinationFolder: 'plasmids',
        name: 'pUC19-imported',
      }
    );

    expect(result.imported).toBe(false);
    expect(result.error).toMatch(/already exists/i);
    expect(mockImportSequenceFromContent).toHaveBeenCalledWith(
      expect.objectContaining({ collisionPolicy: 'refuse' })
    );
  });

  it('overwrites the existing package product instead of creating a suffixed package', async () => {
    setupGenBankMocks();
    const sourcePath = '/home/user/Downloads/pUC19.gb';
    const importedContent = genBankContent('pUC19', 'ATGCGT', []);
    mockPlatform.fs.readTextFile.mockImplementation(async (path: string) => {
      if (path === sourcePath) return importedContent;
      throw new Error(`unexpected read: ${path}`);
    });
    mockImportSequenceFromContent.mockResolvedValueOnce({
      ...packaged('pUC19-imported'),
      replaced: true,
    });

    const result = await execTool<{ imported: boolean; documentId: string }>(
      createImportSequenceTool(singleFolder),
      {
        sourcePath,
        destinationFolder: 'plasmids',
        name: 'pUC19-imported',
        overwrite: true,
      }
    );

    expect(result).toMatchObject({
      imported: true,
      documentId: 'sequence-pUC19-imported',
    });
    expect(mockImportSequenceFromContent).toHaveBeenCalledWith({
      targetRoot: WORKSPACE,
      relativePath: 'plasmids/pUC19-imported.gb',
      content: importedContent,
      collisionPolicy: 'replace',
    });
  });

  it('re-imports FASTA over the existing GenBank product for the same package stem', async () => {
    const sourcePath = '/home/user/Downloads/foo.fna';
    const packageRoot = `${WORKSPACE}/imports/foo`;
    const productPath = `${packageRoot}/foo.gb`;
    const fasta = '>foo DNA sequence\nACGTACGTACGTACGTACGT\n';
    mockPlatform.fs.stat.mockResolvedValue({ size: fasta.length } as any);
    mockPlatform.fs.readTextFile.mockImplementation(async (path: string) => {
      if (path === sourcePath) return fasta;
      throw new Error(`unexpected read: ${path}`);
    });
    mockImportSequenceFromContent.mockResolvedValueOnce({
      ...packaged('foo', 'imports'),
      packageRoots: [packageRoot],
      packageProductPaths: [productPath],
      destPath: productPath,
      replaced: true,
    });

    const result = await execTool<{ imported: boolean; documentId: string }>(
      createImportSequenceTool(singleFolder),
      { sourcePath, overwrite: true, open: false }
    );

    expect(result).toMatchObject({ imported: true, documentId: 'sequence-foo' });
    expect(mockImportSequenceFromContent).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'imports/foo.fasta',
        content: fasta,
        collisionPolicy: 'replace',
      })
    );
  });

  it('refuses a package name that includes a file extension', async () => {
    const sourcePath = '/home/user/Downloads/foo.fna';
    const fasta = '>foo DNA sequence\nACGTACGTACGTACGTACGT\n';
    mockPlatform.fs.stat.mockResolvedValue({ size: fasta.length } as any);
    mockPlatform.fs.readTextFile.mockResolvedValue(fasta);

    const result = await execTool<{ imported: boolean; error: string }>(
      createImportSequenceTool(singleFolder),
      {
        sourcePath,
        name: 'foo.gb',
        open: false,
      }
    );

    expect(result.imported).toBe(false);
    expect(result.error).toMatch(/name.*file extension/i);
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
  });

  it('refuses an overwrite when a package marker names a different product', async () => {
    setupGenBankMocks();
    mockPlatform.fs.readTextFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/Downloads/pUC19.gb') {
        return genBankContent('pUC19', 'ATGCGT', []);
      }
      throw new Error(`unexpected read: ${path}`);
    });
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_PRODUCT_MISMATCH',
      error:
        'Cannot replace "pUC19-imported": the existing package describes a different product ("different.gb").',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });

    const result = await execTool<{ imported: boolean; error: string }>(
      createImportSequenceTool(singleFolder),
      {
        sourcePath: '/home/user/Downloads/pUC19.gb',
        destinationFolder: 'plasmids',
        name: 'pUC19-imported',
        overwrite: true,
      }
    );

    expect(result.imported).toBe(false);
    expect(result.error).toMatch(/different product/i);
  });

  it('fails closed when authoritative packaging is skipped', async () => {
    setupGenBankMocks();
    mockImportSequenceFromContent.mockResolvedValueOnce({
      kind: 'refused',
      code: 'IMPORT_CONVERSION_REQUIRED',
      error: 'contains gap characters',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });

    const result = await execTool<{ imported: boolean; error: string }>(
      createImportSequenceTool(singleFolder),
      {
        sourcePath: '/home/user/Downloads/pUC19.gb',
        destinationFolder: 'plasmids',
        name: 'pUC19-imported',
      }
    );

    expect(result.imported).toBe(false);
    expect(result.error).toContain('contains gap characters');
    expect(mockManagedOpenPackage).not.toHaveBeenCalled();
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();
  });
});

describe('import_sequence — Stop before any workspace change ', () => {
  const NCBI_RECORD = {
    provider: 'ncbi-nuccore',
    externalId: 'NC_000913.3',
    format: 'genbank',
    content: genBankContent('E. coli K-12', 'ATGCGTATGC', []),
    contentSha256: 'a'.repeat(64),
    sourceUrl: 'https://www.ncbi.nlm.nih.gov/nuccore/NC_000913.3',
    metadata: {},
  };

  type StopResult = {
    ok?: boolean;
    code?: string;
    imported: boolean;
    canceled?: boolean;
    retriable?: boolean;
    stateChanged?: boolean | 'unknown';
    partialEffects?: unknown[];
    error?: string;
    opened?: boolean;
    tabId?: string | null;
    stopRequested?: boolean;
    documentId?: string;
  };

  function heldSource() {
    let release!: (record: typeof NCBI_RECORD) => void;
    let reached!: () => void;
    const held = new Promise<typeof NCBI_RECORD>((resolve) => {
      release = resolve;
    });
    const reachedFetch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let capturedOptions: { signal?: AbortSignal } | undefined;
    mockSidecarFetchSequenceBytes.mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) => {
        capturedOptions = options;
        reached();
        return held;
      }
    );
    return { release, reachedFetch, options: () => capturedOptions };
  }

  function expectNoWorkspaceEffects(): void {
    expect(mockImportSequenceFromContent).not.toHaveBeenCalled();
    expect(mockManagedOpenPackage).not.toHaveBeenCalled();
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();
  }

  function expectCanceled(result: StopResult): void {
    assertToolOperationResult(result);
    expect(result).toMatchObject({
      ok: false,
      code: 'CANCELED',
      imported: false,
      canceled: true,
      retriable: true,
      stateChanged: false,
      partialEffects: [],
    });
    expect(result.error).toMatch(/stopped/i);
    expect(result.error).not.toMatch(/Failed to import sequence/);
  }

  it('🟥 forwards the stop signal to the download and refuses a source that returns after Stop', async () => {
    setupNcbiSidecarMocks();
    const source = heldSource();
    const controller = new AbortController();
    const tool = createImportSequenceTool(singleFolder);

    const pending = execTool<StopResult>(
      tool,
      { source: { kind: 'ncbi', accession: 'NC_000913.3' } },
      {
        ...execOpts,
        abortSignal: controller.signal,
        grantedCapabilities: ['external-fetch:annotation'],
      }
    );
    await source.reachedFetch;
    expectNoWorkspaceEffects();

    controller.abort();
    source.release(NCBI_RECORD);
    const result = await pending;

    expect(source.options()?.signal).toBe(controller.signal);
    expectCanceled(result);
    expectNoWorkspaceEffects();
  });

  it('🟥 reports cancellation, not a provider failure, when the aborted download rejects', async () => {
    setupNcbiSidecarMocks();
    const controller = new AbortController();
    mockSidecarFetchSequenceBytes.mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
          );
        })
    );
    const tool = createImportSequenceTool(singleFolder);

    const pending = execTool<StopResult>(
      tool,
      { source: { kind: 'ncbi', accession: 'NC_000913.3' } },
      {
        ...execOpts,
        abortSignal: controller.signal,
        grantedCapabilities: ['external-fetch:annotation'],
      }
    );
    await vi.waitFor(() => expect(mockSidecarFetchSequenceBytes).toHaveBeenCalled());
    controller.abort();
    const result = await pending;

    expectCanceled(result);
    expectNoWorkspaceEffects();
  });

  it('🟥 does not start a download for an already-stopped request', async () => {
    setupNcbiSidecarMocks();
    const controller = new AbortController();
    controller.abort();
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<StopResult>(
      tool,
      { source: { kind: 'ncbi', accession: 'NC_000913.3' } },
      {
        ...execOpts,
        abortSignal: controller.signal,
        grantedCapabilities: ['external-fetch:annotation'],
      }
    );

    expectCanceled(result);
    expect(mockSidecarFetchSequenceBytes).not.toHaveBeenCalled();
    expectNoWorkspaceEffects();
  });

  it('🟥 honors Stop after source preparation but before native dispatch', async () => {
    const content = setupGenBankMocks();
    const controller = new AbortController();
    mockPlatform.fs.readTextFile.mockImplementation(async () => {
      controller.abort();
      return content;
    });
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<StopResult>(
      tool,
      { sourcePath: '/home/user/Downloads/pUC19.gb' },
      { ...execOpts, abortSignal: controller.signal }
    );

    expectCanceled(result);
    expectNoWorkspaceEffects();
  });

  it('settles native commit when Stop lands after dispatch and opens no tab', async () => {
    setupGenBankMocks();
    const controller = new AbortController();
    mockImportSequenceFromContent.mockImplementation(async (request) => {
      controller.abort();
      const packageRoot = `${request.targetRoot}/imports/pUC19`;
      return {
        kind: 'imported',
        destPath: `${packageRoot}/pUC19.gb`,
        relPath: 'imports/pUC19/pUC19.gb',
        packageRoots: [packageRoot],
        packageProductPaths: [`${packageRoot}/pUC19.gb`],
        committed: true,
        replaced: false,
        stateChanged: true,
        partialEffects: [],
      };
    });
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<StopResult>(
      tool,
      { sourcePath: '/home/user/Downloads/pUC19.gb' },
      { ...execOpts, abortSignal: controller.signal }
    );

    expect(mockImportSequenceFromContent).toHaveBeenCalledTimes(1);
    expect(mockManagedOpenPackage).toHaveBeenCalledWith(`${WORKSPACE}/imports/pUC19`);
    expect(mockOpenManagedSequenceDocument).not.toHaveBeenCalled();
    assertToolOperationResult(result);
    expect(result).toMatchObject({
      ok: true,
      imported: true,
      documentId: 'sequence-pUC19',
      opened: false,
      tabId: null,
      stopRequested: true,
    });
  });

  it('hands the stop signal to the tab opener so a Stop during the open lands no tab', async () => {
    setupGenBankMocks();
    const controller = new AbortController();

    mockOpenManagedSequenceDocument.mockImplementation(
      async (_ref: unknown, options: { signal?: AbortSignal }) => {
        controller.abort();
        return options.signal?.aborted ? null : 'tab-late';
      }
    );
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<StopResult>(
      tool,
      { sourcePath: '/home/user/Downloads/pUC19.gb' },
      { ...execOpts, abortSignal: controller.signal }
    );

    expect(mockOpenManagedSequenceDocument).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'managed-sequence' }),
      expect.objectContaining({ signal: controller.signal })
    );
    expect(result).toMatchObject({
      ok: true,
      imported: true,
      documentId: 'sequence-pUC19',
      opened: false,
      tabId: null,
      stopRequested: true,
    });
  });

  it('keeps a normal import untouched when the signal is never aborted', async () => {
    setupGenBankMocks();
    const controller = new AbortController();
    const tool = createImportSequenceTool(singleFolder);

    const result = await execTool<StopResult>(
      tool,
      { sourcePath: '/home/user/Downloads/pUC19.gb' },
      { ...execOpts, abortSignal: controller.signal }
    );

    expect(result).toMatchObject({ ok: true, imported: true, opened: true, tabId: 'tab-1' });
    expect(result).not.toHaveProperty('stopRequested');
    expect(mockOpenManagedSequenceDocument).toHaveBeenCalledTimes(1);
  });
});

it('awaits immediate canonical lookup publication before returning a closed-tab import', async () => {
  setupGenBankMocks();
  let finish!: () => void;
  mockSettleImportedSequenceBindings.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  let returned = false;
  const pending = execTool(createImportSequenceTool(singleFolder), {
    sourcePath: '/home/user/Downloads/pUC19.gb',
    open: false,
  }).then((result) => {
    returned = true;
    return result;
  });
  await vi.waitFor(() => expect(mockSettleImportedSequenceBindings).toHaveBeenCalled());
  expect(returned).toBe(false);
  finish();
  await expect(pending).resolves.toMatchObject({ imported: true, opened: false });
});
