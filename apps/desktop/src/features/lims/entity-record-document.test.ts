// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  parseScientificDocumentIdentity,
  parseWorkspaceIdentity,
  type ScientificDocumentReadResult,
} from '@waypoint/domain-services';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  readScientificDocument: vi.fn(),
  stat: vi.fn(),
  bindings: vi.fn(),
  workspaceRoot: vi.fn(),
  workspaceId: vi.fn(),
  entity: vi.fn(),
  preview: vi.fn(),
  reconcile: vi.fn(),
  folders: [{ path: '/project', name: 'Home' }],
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { readTextFile: mocks.readTextFile, stat: mocks.stat } }),
}));
vi.mock('../../db/workspace-catalog', () => ({
  getCatalogFilesForEntity: mocks.bindings,
  getWorkspaceRootById: mocks.workspaceRoot,
  resolveWorkspaceId: mocks.workspaceId,
}));
vi.mock('../../db/entity-substrate/adapter', () => ({ reconcileEntityFile: mocks.reconcile }));
vi.mock('../../db/entity-substrate/lims-entity-adapter', () => ({ limsEntityArtifactAdapter: {} }));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: mocks.folders }) },
}));
vi.mock('./open-target', () => ({ getLimsEntityById: mocks.entity }));
vi.mock('./operations', () => ({ getLimsRegistryPreview: mocks.preview }));
vi.mock('../scientific-document/public/read-desktop-scientific-document', () => ({
  readDesktopScientificDocument: mocks.readScientificDocument,
}));

import { loadSavedEntityRecord } from './entity-record-document';

function scientificDocument(artifact: unknown): ScientificDocumentReadResult {
  const content = JSON.stringify(artifact);
  return {
    ok: true,
    document: {
      workspace: parseWorkspaceIdentity('home-project'),
      document: parseScientificDocumentIdentity('moved.entity.json'),
      name: 'moved.entity.json',
      format: 'scientific-json',
      content,
      byteLength: Buffer.byteLength(content, 'utf8'),
      revision: {
        kind: 'local-file',
        contentSha256: createHash('sha256').update(content).digest('hex'),
      },
      support: { route: 'desktop', access: 'read-write' },
    },
  };
}

function fixture() {
  const schemaSnapshot = {
    schemaId: 'custom-schema',
    schemaRevisionId: 'custom-v1',
    name: 'custom',
    displayName: 'Custom record',
    baseKind: 'record',
    version: 1,
    fields: [{ key: 'lot', label: 'Lot', type: 'text' }],
  };
  const artifact = {
    schema: 'waypoint.entity.v2',
    id: 'record-1',
    kind: 'custom',
    name: 'Saved record',
    fields: {
      lot: 'A',
      futureMetadata: { retained: [false, 42] },
      artifact: { schema: 'waypoint.entity.v2', relativePath: 'record.entity.json' },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    archived: false,
    schemaRevisionId: schemaSnapshot.schemaRevisionId,
    schemaSnapshot,
    source: { type: 'manual', values: {} },
    relationships: [],
  };
  const entity = {
    ...artifact,
    schemaId: schemaSnapshot.schemaId,
    workspaceId: 7,
    registryId: 'REC1',
    eventSeq: 12,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    actor: null,
  };
  return {
    artifact,
    entity,
    preview: { entity, schemaSnapshot, incomingLinks: [], outgoingLinks: [] },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.folders = [{ path: '/project', name: 'Home' }];
  const { artifact, entity, preview } = fixture();
  mocks.readScientificDocument.mockResolvedValue(scientificDocument(artifact));
  mocks.stat.mockResolvedValue({ mtime: 1 });
  mocks.bindings.mockResolvedValue([
    { path: '/project/moved.entity.json', workspace_id: 7, status: 'current' },
  ]);
  mocks.workspaceRoot.mockResolvedValue('/project');
  mocks.workspaceId.mockResolvedValue(7);
  mocks.entity.mockResolvedValue(entity);
  mocks.preview.mockResolvedValue(preview);
});

describe('saved record identity and home authority', () => {
  it('reads the verified saved home while another project is shown in Files', async () => {
    mocks.folders = [{ path: '/other-project', name: 'Other' }];

    const result = await loadSavedEntityRecord('record-1');

    expect(result.artifact).toEqual(fixture().artifact);
    expect(result.workspaceRoot).toBe('/project');
    expect(result.preview.entity.workspaceId).toBe(7);
    expect(mocks.readScientificDocument).toHaveBeenCalledWith({
      filePath: '/project/moved.entity.json',
      workspaceRoot: '/project',
      signal: undefined,
    });
    expect(mocks.folders).toEqual([{ path: '/other-project', name: 'Other' }]);
    expect(mocks.readTextFile).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('uses the current catalog path and retains the complete frozen record without a projection write', async () => {
    const controller = new AbortController();
    const result = await loadSavedEntityRecord('record-1', controller.signal);
    expect(result.path).toBe('/project/moved.entity.json');
    expect(result.artifact).toEqual(fixture().artifact);
    expect(result.preview.entity.workspaceId).toBe(7);
    expect(mocks.readScientificDocument).toHaveBeenCalledWith({
      filePath: '/project/moved.entity.json',
      workspaceRoot: '/project',
      signal: controller.signal,
    });
    expect(mocks.readTextFile).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('refuses another identity at the current path before any projection can be written', async () => {
    mocks.readScientificDocument.mockResolvedValue(
      scientificDocument({ ...fixture().artifact, id: 'other-record' })
    );
    await expect(loadSavedEntityRecord('record-1')).rejects.toThrow('identity does not match');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('refuses a current binding in another home before reading its bytes', async () => {
    mocks.bindings.mockResolvedValue([
      { path: '/other/record.entity.json', workspace_id: 8, status: 'current' },
    ]);
    await expect(loadSavedEntityRecord('record-1')).rejects.toThrow('home project do not agree');
    expect(mocks.readScientificDocument).not.toHaveBeenCalled();
    expect(mocks.readTextFile).not.toHaveBeenCalled();
  });

  it('refuses conflicting current bindings rather than selecting one', async () => {
    mocks.bindings.mockResolvedValue([
      { path: '/project/one.entity.json', workspace_id: 7, status: 'current' },
      { path: '/project/two.entity.json', workspace_id: 7, status: 'current' },
    ]);
    await expect(loadSavedEntityRecord('record-1')).rejects.toThrow(
      'conflicting current file bindings'
    );
    expect(mocks.readScientificDocument).not.toHaveBeenCalled();
    expect(mocks.readTextFile).not.toHaveBeenCalled();
  });

  it('does not present divergent saved content as an editable current projection', async () => {
    mocks.readScientificDocument.mockResolvedValue(
      scientificDocument({ ...fixture().artifact, name: 'External edit' })
    );
    await expect(loadSavedEntityRecord('record-1')).rejects.toThrow(
      'Registry projection do not agree'
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('preserves a scientific document access refusal without a raw-file fallback', async () => {
    mocks.readScientificDocument.mockResolvedValue({
      ok: false,
      error: { code: 'ACCESS_DENIED', message: 'This project no longer permits record access.' },
    } satisfies ScientificDocumentReadResult);

    await expect(loadSavedEntityRecord('record-1')).rejects.toThrow(
      'This project no longer permits record access.'
    );
    expect(mocks.readTextFile).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
