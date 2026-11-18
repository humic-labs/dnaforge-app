import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

vi.mock('../../main/auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type { PlatformBridge } from '../../platform';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  emitChanged: vi.fn(),
  namespace: vi.fn(),
  publish: vi.fn(),
  read: vi.fn(),
  completed: vi.fn(),
  failed: vi.fn(),
  registerCatalogEntity: vi.fn(),
  bindCatalogEntityToFile: vi.fn(),
  sourceWrites: vi.fn(),
}));

let limsBridge: PlatformBridge['lims'];
let workspaceRoot: string;
let mutationTransport:
  | Pick<PlatformBridge['fs'], 'beginWorkspaceMutation' | 'endWorkspaceMutation'>
  | undefined;

vi.mock('../../platform', () => ({
  platform: () => ({
    lims: limsBridge,
    db: {
      settleEntityProjectionSource: (
        input: Parameters<typeof settleEntityProjectionSourceInMain>[1]
      ) => settleEntityProjectionSourceInMain(openDbs[0], input),
      execute: async (sql: string, params: unknown[] = []) =>
        openDbs[0].prepare(sql).run(...params),
      select: async (sql: string, params: unknown[] = []) => openDbs[0].prepare(sql).all(...params),
    },
    fs: {
      ...mutationTransport,
      exists: async (path: string) =>
        access(path).then(
          () => true,
          () => false
        ),
      readTextFile: (path: string) => readFile(path, 'utf8'),
      stat: async (path: string) => {
        const entry = await stat(path);
        return {
          size: entry.size,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
          mtime: entry.mtimeMs,
          ctime: entry.ctimeMs,
        };
      },
      writeWorkspaceTextFileAtomic: async (
        input: Parameters<PlatformBridge['fs']['writeWorkspaceTextFileAtomic']>[0]
      ) => {
        mocks.sourceWrites(input);
        await mkdir(dirname(input.path), { recursive: true });
        await writeFile(input.path, input.content, { flag: input.mode === 'create' ? 'wx' : 'w' });
        mocks.files.set(input.path, input.content);
        return {
          path: input.path,
          contentHash: `sha256:${createHash('sha256').update(input.content).digest('hex')}`,
        };
      },
    },
  }),
}));

vi.mock('../workspace/git', () => ({
  isGitRepo: vi.fn().mockResolvedValue(false),
  gitCommitPaths: vi.fn(),
  gitStatus: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../db/workspace-catalog', () => ({
  resolveWorkspaceId: vi.fn().mockResolvedValue(7),
  registerCatalogEntity: mocks.registerCatalogEntity,
  bindCatalogEntityToFile: mocks.bindCatalogEntityToFile,
}));

vi.mock('./events', () => ({
  emitLimsRegistrationChanged: mocks.emitChanged,
}));
vi.mock('../../services/read-scientific-namespace', () => ({
  readScientificNamespace: mocks.namespace,
}));
vi.mock('../scientific-document/services/read-scientific-text', () => ({
  readScientificText: mocks.read,
}));
vi.mock('../../services/publish-native-artifact', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/publish-native-artifact')>()),
  publishNativeArtifact: mocks.publish,
}));

vi.mock('../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: () => ({ complete: mocks.completed, fail: mocks.failed }),
  runWorkflowAction: async (
    _input: unknown,
    operation: () => Promise<unknown>,
    metadata: (result: unknown) => unknown
  ): Promise<unknown> => {
    const result = await operation();
    mocks.completed(metadata(result));
    return result;
  },
}));

import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { settleEntityProjectionSourceInMain } from '../../main/entity-projection-receipts';
import { registerCatalogEntityInDb } from '../../main/catalog-entity-registration';
import { reconcileEntityFile } from '../../db/entity-substrate/adapter';
import { limsEntityArtifactAdapter } from '../../db/entity-substrate/lims-entity-adapter';
import { parseEntityArtifact } from './entity-artifact';
import { defineLimsSchemaInDb, registerLimsEntityInDb } from '../../main/lims';
import {
  EntityArtifactCreationProjectionError,
  resolveEntityArtifactSchemaSnapshot,
  EntityArtifactAcceptedSavePendingError,
  recordEntityArtifact,
} from './record-entity-artifact';
import { NativeArtifactPublicationPendingError } from '../../services/publish-native-artifact';
import { acquireWorkspaceMutationShared } from '../../main/workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from '../../main/ipc/workspace-mutation-capability';
import { withDeclaredRendererWorkspaceMutation } from '../../main/ipc/workspace-mutation-authority';

const openDbs: Array<ReturnType<typeof createLimsTestBridge>['db']> = [];

beforeEach(async () => {
  mutationTransport = undefined;
  workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'record-entity-authority-')));
  mocks.files.clear();
  mocks.emitChanged.mockReset();
  mocks.namespace.mockReset().mockResolvedValue(null);
  mocks.publish.mockReset();
  mocks.read.mockReset();
  mocks.completed.mockReset();
  mocks.failed.mockReset();
  mocks.registerCatalogEntity.mockReset().mockImplementation(async (input: { id: string }) => ({
    id: input.id,
    workspace_id: 7,
  }));
  mocks.bindCatalogEntityToFile.mockReset().mockResolvedValue({});
  mocks.sourceWrites.mockReset();
  const bridge = createLimsTestBridge();
  openDbs.push(bridge.db);
  limsBridge = bridge.lims;
  bridge.db
    .prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(7, 'Workspace', workspaceRoot, 1, 1);
});

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('recordEntityArtifact', () => {
  it('keeps native catalog file identity through the Registry search projection', async () => {
    mocks.registerCatalogEntity.mockImplementation(async (input) =>
      registerCatalogEntityInDb(openDbs[0], input)
    );
    const result = await recordEntityArtifact({
      kind: 'strain',
      name: 'Native catalog owner',
      fields: { genotypeCanonical: 'recA1' },
      workspaceRoot,
      destinationDir: workspaceRoot,
    });
    expect(
      openDbs[0]
        .prepare('SELECT type,locator,storage_type,workspace_id FROM catalog_entities WHERE id=?')
        .get(result.artifact.id)
    ).toEqual({
      type: 'file',
      locator: `file://${result.artifactPath}`,
      storage_type: 'file',
      workspace_id: 7,
    });
    expect(await limsBridge.queryEntities({ id: result.artifact.id })).toHaveLength(1);
    expect(() =>
      registerCatalogEntityInDb(openDbs[0], {
        id: result.artifact.id,
        type: 'file',
        name: result.artifact.name,
        locator: `file://${result.artifactPath}.different`,
        storageType: 'file',
        workspaceRoot,
      })
    ).toThrow('Catalog identity has a different locator');
  });

  it('resolves the explicitly selected definition when type names collide', async () => {
    const schemas = await limsBridge.listSchemas();
    const original = schemas.find((schema) => schema.entityKind === 'organism')!;
    const selected = {
      ...original,
      schemaId: 'selected-organism',
      currentRevisionId: 'selected-organism-v1',
    };
    vi.spyOn(limsBridge, 'listSchemas').mockResolvedValue([...schemas, selected]);
    await expect(
      resolveEntityArtifactSchemaSnapshot('organism', {
        schemaId: selected.schemaId,
        expectedRevisionId: selected.currentRevisionId,
      })
    ).resolves.toMatchObject({
      schemaId: selected.schemaId,
      schemaRevisionId: selected.currentRevisionId,
    });
  });

  it('rejects a creation form whose selected schema version changed before any file is written', async () => {
    const schema = (await limsBridge.listSchemas()).find((item) => item.entityKind === 'organism')!;
    await expect(
      recordEntityArtifact({
        kind: 'organism',
        schemaId: schema.schemaId,
        expectedSchemaRevisionId: 'stale-schema-revision',
        name: 'Stale form',
        fields: { taxid: '562', scientificName: 'Escherichia coli' },
        workspaceRoot: '/ws',
        destinationDir: '/ws',
      })
    ).rejects.toThrow('This schema changed');
    expect(mocks.files.size).toBe(0);
  });

  it('creates a required entity-link field with canonical target labels and rebuildable graph bytes', async () => {
    defineLimsSchemaInDb(openDbs[0], {
      kind: 'entity',
      name: 'linked_record',
      displayName: 'Linked record',
      fields: [
        { key: 'parent', label: 'Parent entity', type: 'record_relationship', required: true },
      ],
    });
    registerLimsEntityInDb(openDbs[0], {
      id: 'parent-target',
      kind: 'strain',
      name: 'Actual parent name',
      fields: {},
      workspaceId: 7,
    });
    const result = await recordEntityArtifact({
      kind: 'linked_record',
      name: 'Linked child',
      fields: {
        parent: {
          origin: 'native',
          destinationEntityId: 'parent-target',
          relationType: 'references',
          label: 'Stale client name',
          resolution: 'exact',
        },
      },
      workspaceRoot,
      destinationDir: join(workspaceRoot, 'records'),
    });
    expect(result.artifact.fields.parent).toMatchObject({
      destinationEntityId: 'parent-target',
      label: 'Actual parent name',
    });
    expect(result.artifact.relationships).toEqual([
      expect.objectContaining({
        type: 'references',
        fromEntityId: result.artifact.id,
        toEntityId: 'parent-target',
        payload: expect.objectContaining({ fieldKeys: ['parent'] }),
      }),
    ]);
    const preview = await limsBridge.getRegistryPreview({ entityId: result.artifact.id });
    expect(preview!.outgoingLinks).toHaveLength(1);
    expect(preview!.outgoingLinks[0].entity.id).toBe('parent-target');
  });

  it('retains the accepted strain identity when the required Registry query fails after acceptance', async () => {
    mocks.namespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    const accepted = {
      kind: 'accepted-object' as const,
      resourceId: 'query-pending-strain',
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'c'.repeat(64)}`,
      contentSha256: 'd'.repeat(64),
      sequenceEditParentEventId: null,
    };
    mocks.publish.mockResolvedValue(accepted);
    limsBridge = {
      ...limsBridge,
      queryEntities: async () => {
        throw new Error('Registry temporarily unavailable');
      },
    };
    const error = await recordEntityArtifact({
      id: accepted.resourceId,
      kind: 'strain',
      name: 'Query pending stock',
      fields: { genotypeCanonical: 'wild type' },
      workspaceRoot: '/ws',
      destinationDir: '/ws',
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(EntityArtifactAcceptedSavePendingError);
    expect(error).toMatchObject({
      acceptedRevision: accepted,
      artifact: { id: accepted.resourceId },
      message: expect.stringContaining('Registry temporarily unavailable'),
    });
    expect(mocks.completed).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenLastCalledWith(
      'projection',
      expect.objectContaining({
        recordWriteStatus: 'written',
        recordProjectionStatus: 'failed',
        recordHistoryStatus: 'not_attempted',
        affectedCount: 1,
      })
    );
    expect(mocks.files.size).toBe(0);
    expect(mocks.emitChanged).not.toHaveBeenCalled();
  });

  it('preserves an unenrolled working file at a new strain path instead of accepting or projecting over it', async () => {
    mocks.namespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    const path = join(workspaceRoot, 'strains', 'occupied.entity.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'unsubmitted working draft');
    await expect(
      recordEntityArtifact({
        id: 'new-strain',
        artifactStem: 'occupied',
        kind: 'strain',
        name: 'New stock',
        fields: { genotypeCanonical: 'wild type' },
        workspaceRoot,
        destinationDir: join(workspaceRoot, 'strains'),
      })
    ).rejects.toThrow('A working file already exists');
    expect(await readFile(path, 'utf8')).toBe('unsubmitted working draft');
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(await limsBridge.queryEntities({ id: 'new-strain' })).toHaveLength(0);
    expect(mocks.emitChanged).not.toHaveBeenCalled();
  });

  it('retains accepted strain authority on incomplete publication without a file-first fallback or success event', async () => {
    mocks.namespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    const accepted = {
      kind: 'accepted-object' as const,
      resourceId: 'pending-strain',
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'c'.repeat(64)}`,
      contentSha256: 'd'.repeat(64),
      sequenceEditParentEventId: null,
    };
    mocks.publish.mockRejectedValue(
      new NativeArtifactPublicationPendingError(
        accepted,
        'file delivery is blocked by a working edit.'
      )
    );
    const error = await recordEntityArtifact({
      id: 'pending-strain',
      kind: 'strain',
      name: 'Pending stock',
      fields: { genotypeCanonical: 'wild type' },
      workspaceRoot: '/ws',
      destinationDir: '/ws',
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(EntityArtifactAcceptedSavePendingError);
    expect(error).toMatchObject({
      acceptedRevision: accepted,
      artifact: { id: 'pending-strain' },
      message: expect.stringContaining('working edit'),
    });
    expect(mocks.completed).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenLastCalledWith(
      'unknown',
      expect.objectContaining({
        recordWriteStatus: 'written',
        recordProjectionStatus: 'not_attempted',
        recordHistoryStatus: 'not_attempted',
        affectedCount: 1,
      })
    );
    expect(mocks.files.size).toBe(0);
    expect(mocks.emitChanged).not.toHaveBeenCalled();
    expect(await limsBridge.queryEntities({ id: 'pending-strain' })).toHaveLength(0);
  });

  it('publishes a new strain from the accepted namespace before any renderer file write or independent projection', async () => {
    const head = `wv_${'a'.repeat(64)}`;
    mocks.namespace.mockResolvedValue({ head, entries: [] });
    mocks.publish.mockImplementation(async ({ resourceId, representation }) => {
      expect(mocks.files.size).toBe(0);
      const artifact = parseEntityArtifact(representation.text);
      await limsBridge.registerEntity({
        id: resourceId,
        kind: 'strain',
        name: artifact.name,
        fields: artifact.fields,
        registrationStatus: artifact.registrationStatus,
        domainStatus: artifact.domainStatus,
        workspaceId: 7,
        actor: 'workspace-reconcile',
      });
      return {
        kind: 'accepted-object',
        resourceId,
        resourceRevisionId: `rr_${'b'.repeat(64)}`,
        workspaceVersionId: `wv_${'c'.repeat(64)}`,
        contentSha256: 'd'.repeat(64),
        sequenceEditParentEventId: null,
      };
    });
    const saved = await recordEntityArtifact({
      id: 'planned-by4741',
      kind: 'strain',
      name: 'BY4741 planning background',
      fields: { genotypeCanonical: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0' },
      workspaceRoot: '/ws',
      destinationDir: '/ws/strains',
      domainStatus: 'planned',
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        prior: null,
        expectedHead: head,
        resourceId: 'planned-by4741',
        representation: expect.objectContaining({ format: 'strain-entity-v1' }),
      })
    );
    expect(mocks.files.size).toBe(0);
    expect(saved).toMatchObject({
      created: true,
      acceptedRevision: { resourceId: 'planned-by4741' },
    });
    expect(await limsBridge.queryEntities({ id: 'planned-by4741' })).toHaveLength(1);
    mocks.namespace.mockResolvedValue({
      head: saved.acceptedRevision!.workspaceVersionId,
      entries: [
        {
          resourceId: saved.artifact.id,
          revisionId: saved.acceptedRevision!.resourceRevisionId,
          path: saved.relativePath,
          lastPath: saved.relativePath,
          tombstone: false,
        },
      ],
    });
    mocks.read.mockResolvedValue({
      content: mocks.publish.mock.calls[0][0].representation.text,
      acceptedRevision: saved.acceptedRevision,
    });
    mocks.publish.mockResolvedValueOnce(saved.acceptedRevision);
    const retried = await recordEntityArtifact({
      id: 'planned-by4741',
      kind: 'strain',
      name: 'BY4741 planning background',
      fields: { genotypeCanonical: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0' },
      workspaceRoot: '/ws',
      destinationDir: '/ws/strains',
      domainStatus: 'planned',
    });
    expect(retried).toMatchObject({
      created: false,
      artifact: { id: saved.artifact.id },
      acceptedRevision: saved.acceptedRevision,
    });
    expect(mocks.publish.mock.calls[1][0]).toMatchObject({ prior: saved.acceptedRevision });
    expect(mocks.files.size).toBe(0);
    expect(await limsBridge.queryEntities({ id: 'planned-by4741' })).toHaveLength(1);
  });

  it('retains the authoritative file and reports an incomplete projection when catalog binding fails', async () => {
    mocks.bindCatalogEntityToFile.mockRejectedValueOnce(new Error('Native binding unavailable'));
    await expect(
      recordEntityArtifact({
        id: 'binding-outage',
        artifactStem: 'Binding-outage',
        kind: 'strain',
        name: 'Binding outage',
        fields: { genotypeCanonical: 'recA1' },
        workspaceRoot: workspaceRoot,
        destinationDir: join(workspaceRoot, 'strains'),
      })
    ).rejects.toBeInstanceOf(EntityArtifactCreationProjectionError);
    expect(
      parseEntityArtifact(
        mocks.files.get(join(workspaceRoot, 'strains', 'Binding-outage.entity.json'))!
      )
    ).toMatchObject({
      id: 'binding-outage',
      name: 'Binding outage',
    });
    expect(mocks.emitChanged).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      'projection',
      expect.objectContaining({ recordWriteStatus: 'written', recordProjectionStatus: 'failed' })
    );
  });

  it('writes one manual strain authority before projecting it and rebuilds a deleted projection', async () => {
    const ownerId = 3346;
    mutationTransport = {
      beginWorkspaceMutation: async (root) =>
        workspaceMutationCapabilities.issue(
          ownerId,
          root,
          await acquireWorkspaceMutationShared(root)
        ),
      endWorkspaceMutation: async (token) => {
        workspaceMutationCapabilities.release(token, ownerId);
      },
    };
    mocks.bindCatalogEntityToFile.mockImplementation(
      (input: { workspaceRoot: string; path: string; mutationToken?: string }) =>
        withDeclaredRendererWorkspaceMutation({
          db: openDbs[0],
          ownerId,
          workspaceRoot: input.workspaceRoot,
          mutationPaths: [input.path],
          mutationToken: input.mutationToken,
          operation: async () => ({}),
        })
    );
    const originalRegister = limsBridge.registerEntity;
    limsBridge = {
      ...limsBridge,
      registerEntity: async (input) => {
        expect(mocks.files.size).toBe(1);
        return originalRegister(input);
      },
    };

    const saving = recordEntityArtifact({
      kind: 'strain',
      name: 'DH5alpha',
      fields: { genotypeCanonical: 'recA1 endA1' },
      workspaceRoot: workspaceRoot,
      destinationDir: join(workspaceRoot, 'strains'),
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Strain Save waited on its own project mutation.')),
        1_000
      );
    });
    const result = await Promise.race([saving, deadline]).finally(async () => {
      clearTimeout(timeout);
      workspaceMutationCapabilities.releaseOwner(ownerId);
      await saving.catch(() => undefined);
    });

    expect(dirname(result.artifactPath)).toBe(join(workspaceRoot, 'strains'));
    expect(basename(result.artifactPath)).toMatch(/^DH5alpha-[0-9a-f]{8}\.entity\.json$/);
    const content = await readFile(result.artifactPath, 'utf8');
    expect(content).toBe(mocks.files.get(result.artifactPath));
    const artifact = parseEntityArtifact(content);
    const originalRegistryId = (await limsBridge.queryEntities({ id: artifact.id }))[0].registryId;
    expect(artifact).toMatchObject({
      id: result.artifact.id,
      kind: 'strain',
      name: 'DH5alpha',
      fields: {
        genotypeCanonical: 'recA1 endA1',
        artifact: { relativePath: result.relativePath },
        sourceMetadata: { origin: { type: 'manual' } },
      },
      source: { type: 'manual', values: {} },
    });
    expect(await limsBridge.queryEntities({ id: artifact.id })).toHaveLength(1);
    expect(mocks.registerCatalogEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: artifact.id, locator: `file://${result.artifactPath}` })
    );
    expect(mocks.bindCatalogEntityToFile).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: artifact.id,
        path: result.artifactPath,
        fileKind: 'waypoint-entity',
        workspaceRoot: workspaceRoot,
      })
    );

    openDbs[0].prepare('DELETE FROM lims_entity WHERE id = ?').run(artifact.id);
    expect(await limsBridge.queryEntities({ id: artifact.id })).toHaveLength(0);
    const rebuilt = await reconcileEntityFile(
      limsEntityArtifactAdapter,
      content,
      result.artifactPath,
      Date.now() + 1_000,
      { workspaceRoot: workspaceRoot, workspaceId: 7 }
    );
    expect(rebuilt).toEqual({ id: artifact.id, outcome: 'created' });
    expect(await limsBridge.queryEntities({ id: artifact.id })).toEqual([
      expect.objectContaining({
        id: artifact.id,
        registryId: originalRegistryId,
        name: 'DH5alpha',
        fields: expect.objectContaining({ genotypeCanonical: 'recA1 endA1' }),
      }),
    ]);
    expect(mocks.emitChanged).toHaveBeenCalledWith({
      filePath: result.artifactPath,
      entityId: artifact.id,
    });
  });

  it('rejects an incomplete strain before writing any file', async () => {
    await expect(
      recordEntityArtifact({
        kind: 'strain',
        name: 'Incomplete',
        fields: {},
        workspaceRoot: workspaceRoot,
        destinationDir: workspaceRoot,
      })
    ).rejects.toThrow('genotypeCanonical is required');
    expect(mocks.files.size).toBe(0);
  });

  it('preserves the file and reports a projection-specific error when Registry is unavailable', async () => {
    limsBridge = {
      ...limsBridge,
      registerEntity: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };

    const error = await recordEntityArtifact({
      kind: 'strain',
      name: 'File first',
      fields: { genotypeCanonical: 'wild type' },
      workspaceRoot: workspaceRoot,
      destinationDir: workspaceRoot,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EntityArtifactCreationProjectionError);
    expect(error).toMatchObject({
      artifactPath: expect.stringMatching(/File_first-.*\.entity\.json$/),
      relativePath: expect.stringMatching(/File_first-.*\.entity\.json$/),
      artifact: expect.objectContaining({ kind: 'strain', name: 'File first' }),
      created: true,
    });
    expect(mocks.files.size).toBe(1);
    expect(mocks.failed).toHaveBeenLastCalledWith(
      'projection',
      expect.objectContaining({
        recordWriteStatus: 'written',
        recordProjectionStatus: 'failed',
        recordHistoryStatus: 'not_attempted',
        affectedCount: 1,
      })
    );
  });

  it('creates a new local planned strain link after versioned design setup without enrolling its target', async () => {
    await limsBridge.registerEntity({
      id: 'legacy-parent',
      kind: 'strain',
      name: 'Legacy parent',
      fields: { genotypeCanonical: 'recA1' },
      workspaceId: 7,
    });
    mocks.namespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    mocks.publish.mockRejectedValue(
      new TypeError(
        'Native strain link requires an exact accepted or submitted target of the right kind.'
      )
    );
    const input = {
      id: 'new-local-child',
      artifactStem: 'new-local-child',
      kind: 'strain',
      name: 'Local planned child',
      fields: { genotypeCanonical: 'recA2' },
      relationships: [
        {
          type: 'derives_from',
          fromEntityId: 'new-local-child',
          toEntityId: 'legacy-parent',
          payload: { assertion: 'planned', method: 'retain original details' },
        },
      ],
      workspaceRoot,
      destinationDir: workspaceRoot,
    };

    const saved = await recordEntityArtifact(input);

    expect(saved).toMatchObject({
      created: true,
      artifact: { id: input.id, relationships: input.relationships },
    });
    expect(saved.acceptedRevision).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
    const link = openDbs[0]
      .prepare('SELECT type,payload FROM lims_link WHERE from_entity_id=? AND tombstone=0')
      .get(input.id) as { type: string; payload: string };
    expect(link.type).toBe('derives_from');
    expect(JSON.parse(link.payload)).toEqual(input.relationships[0].payload);
    const content = await readFile(saved.artifactPath, 'utf8');
    await expect(recordEntityArtifact(input)).resolves.toMatchObject({ created: false });
    expect(await readFile(saved.artifactPath, 'utf8')).toBe(content);
  });

  it('creates a new local structured strain reference after versioned design setup', async () => {
    await limsBridge.registerEntity({
      id: 'legacy-reference',
      kind: 'strain',
      name: 'Current target name',
      fields: { genotypeCanonical: 'recA1' },
      workspaceId: 7,
    });
    const schema = (await limsBridge.listSchemas()).find((entry) => entry.entityKind === 'strain')!;
    await limsBridge.refineSchema({
      schemaId: schema.schemaId,
      fields: [
        ...schema.fields,
        {
          key: 'relatedRecord',
          label: 'Related record',
          type: 'record_relationship',
          required: true,
        },
      ],
    });
    mocks.namespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    mocks.publish.mockRejectedValue(
      new TypeError(
        'Native strain relationships require explicit pinned relationship migration: unsupported references'
      )
    );

    const saved = await recordEntityArtifact({
      id: 'new-local-reference',
      artifactStem: 'new-local-reference',
      kind: 'strain',
      name: 'Local reference',
      fields: {
        genotypeCanonical: 'recA2',
        relatedRecord: {
          origin: 'native',
          destinationEntityId: 'legacy-reference',
          relationType: 'references',
          label: 'Old label',
          resolution: 'exact',
        },
      },
      workspaceRoot,
      destinationDir: workspaceRoot,
    });

    expect(saved.acceptedRevision).toBeUndefined();
    expect(saved.artifact.fields.relatedRecord).toMatchObject({
      destinationEntityId: 'legacy-reference',
      label: 'Current target name',
    });
    expect(saved.artifact.relationships).toEqual([
      expect.objectContaining({
        type: 'references',
        fromEntityId: saved.artifact.id,
        toEntityId: 'legacy-reference',
        payload: expect.objectContaining({ fieldKeys: ['relatedRecord'] }),
      }),
    ]);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(
      openDbs[0]
        .prepare('SELECT type,to_entity_id FROM lims_link WHERE from_entity_id=? AND tombstone=0')
        .get(saved.artifact.id)
    ).toEqual({ type: 'references', to_entity_id: 'legacy-reference' });
  });

  it.each([
    { name: 'omitted assertion', type: 'derives_from', payload: {}, acceptedTarget: false },
    {
      name: 'observed assertion',
      type: 'derives_from',
      payload: { assertion: 'observed', retained: [false, 0] },
      acceptedTarget: false,
    },
    {
      name: 'association to accepted target',
      type: 'associated_with',
      payload: { legacy: 'metadata' },
      acceptedTarget: true,
    },
    {
      name: 'opaque revision',
      type: 'derives_from',
      payload: { assertion: 'planned', targetRevisionId: 'legacy revision' },
      acceptedTarget: false,
    },
  ])(
    'preserves new local strain relationship semantics: $name',
    async ({ type, payload, acceptedTarget }) => {
      await limsBridge.registerEntity({
        id: 'old-peer',
        kind: 'strain',
        name: 'Old peer',
        fields: { genotypeCanonical: 'recA1' },
        workspaceId: 7,
      });
      mocks.namespace.mockResolvedValue({
        head: `wv_${'a'.repeat(64)}`,
        entries: acceptedTarget
          ? [
              {
                resourceId: 'old-peer',
                revisionId: `rr_${'b'.repeat(64)}`,
                path: 'peer.entity.json',
                lastPath: 'peer.entity.json',
                tombstone: false,
              },
            ]
          : [],
      });
      mocks.publish.mockRejectedValue(
        new Error('Legacy metadata must not be published as native evidence')
      );
      const relationship = { type, fromEntityId: 'new-peer', toEntityId: 'old-peer', payload };

      const saved = await recordEntityArtifact({
        id: 'new-peer',
        artifactStem: 'new-peer',
        kind: 'strain',
        name: 'New peer',
        fields: { genotypeCanonical: 'recA2' },
        relationships: [relationship],
        workspaceRoot,
        destinationDir: workspaceRoot,
      });

      expect(saved.acceptedRevision).toBeUndefined();
      expect(saved.artifact.relationships).toEqual([relationship]);
      const row = openDbs[0]
        .prepare('SELECT type,payload FROM lims_link WHERE from_entity_id=? AND tombstone=0')
        .get(saved.artifact.id) as { type: string; payload: string };
      expect(row.type).toBe(type);
      expect(JSON.parse(row.payload)).toEqual(payload);
      expect(mocks.publish).not.toHaveBeenCalled();
    }
  );

  it('keeps a new planned strain with an accepted target on native publication after refusal', async () => {
    mocks.namespace.mockResolvedValue({
      head: `wv_${'a'.repeat(64)}`,
      entries: [
        {
          resourceId: 'accepted-parent',
          revisionId: `rr_${'b'.repeat(64)}`,
          path: 'parent.entity.json',
          lastPath: 'parent.entity.json',
          tombstone: false,
        },
      ],
    });
    const failure = new Error('Native current-source refusal');
    mocks.publish.mockRejectedValue(failure);
    const relationship = {
      type: 'derives_from',
      fromEntityId: 'accepted-new-child',
      toEntityId: 'accepted-parent',
      payload: { assertion: 'planned' },
    };

    await expect(
      recordEntityArtifact({
        id: 'accepted-new-child',
        artifactStem: 'accepted-new-child',
        kind: 'strain',
        name: 'Accepted child',
        fields: { genotypeCanonical: 'recA2' },
        relationships: [relationship],
        workspaceRoot,
        destinationDir: workspaceRoot,
      })
    ).rejects.toBe(failure);

    expect(
      parseEntityArtifact(mocks.publish.mock.calls[0][0].representation.text).relationships
    ).toEqual([relationship]);
    expect(mocks.sourceWrites).not.toHaveBeenCalled();
    expect(mocks.registerCatalogEntity).not.toHaveBeenCalled();
  });

  it('protects an accepted carried-by owner from a new local strain relationship', async () => {
    mocks.namespace.mockResolvedValue({
      head: `wv_${'a'.repeat(64)}`,
      entries: [
        {
          resourceId: 'accepted-owner',
          revisionId: `rr_${'b'.repeat(64)}`,
          path: 'owner.entity.json',
          lastPath: 'owner.entity.json',
          tombstone: false,
        },
      ],
    });

    await expect(
      recordEntityArtifact({
        id: 'new-carrier',
        artifactStem: 'new-carrier',
        kind: 'strain',
        name: 'New carrier',
        fields: { genotypeCanonical: 'recA2' },
        relationships: [
          {
            type: 'carried_by',
            fromEntityId: 'new-carrier',
            toEntityId: 'accepted-owner',
            payload: { assertion: 'observed' },
          },
        ],
        workspaceRoot,
        destinationDir: workspaceRoot,
      })
    ).rejects.toThrow('owned by an accepted or removed record');

    expect(mocks.sourceWrites).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.registerCatalogEntity).not.toHaveBeenCalled();
  });

  it('refuses new local strain creation when its dependency authority changes at the final read', async () => {
    mocks.namespace
      .mockResolvedValueOnce({ head: `wv_${'a'.repeat(64)}`, entries: [] })
      .mockResolvedValue({
        head: `wv_${'b'.repeat(64)}`,
        entries: [
          {
            resourceId: 'now-accepted-parent',
            revisionId: `rr_${'c'.repeat(64)}`,
            path: 'parent.entity.json',
            lastPath: 'parent.entity.json',
            tombstone: false,
          },
        ],
      });

    await expect(
      recordEntityArtifact({
        id: 'new-fenced-child',
        artifactStem: 'new-fenced-child',
        kind: 'strain',
        name: 'Fenced child',
        fields: { genotypeCanonical: 'recA2' },
        relationships: [
          {
            type: 'derives_from',
            fromEntityId: 'new-fenced-child',
            toEntityId: 'now-accepted-parent',
            payload: { assertion: 'planned' },
          },
        ],
        workspaceRoot,
        destinationDir: workspaceRoot,
      })
    ).rejects.toThrow('publication owner changed');

    expect(mocks.sourceWrites).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('keeps an accepted strain output out of local classification for unsupported new links', async () => {
    const input = {
      id: 'owned-output',
      artifactStem: 'owned-output',
      kind: 'strain',
      name: 'Owned output',
      fields: { genotypeCanonical: 'recA1' },
      workspaceRoot,
      destinationDir: workspaceRoot,
    };
    const first = await recordEntityArtifact(input);
    const content = await readFile(first.artifactPath, 'utf8');
    const acceptedRevision = {
      kind: 'accepted-object' as const,
      resourceId: input.id,
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'a'.repeat(64)}`,
      contentSha256: 'c'.repeat(64),
      sequenceEditParentEventId: null,
    };
    mocks.namespace.mockResolvedValue({
      head: acceptedRevision.workspaceVersionId,
      entries: [
        {
          resourceId: input.id,
          revisionId: acceptedRevision.resourceRevisionId,
          path: first.relativePath,
          lastPath: first.relativePath,
          tombstone: false,
        },
      ],
    });
    mocks.read.mockResolvedValue({ content, acceptedRevision });
    mocks.sourceWrites.mockClear();
    mocks.registerCatalogEntity.mockClear();

    await expect(
      recordEntityArtifact({
        ...input,
        relationships: [
          { type: 'associated_with', fromEntityId: input.id, toEntityId: 'peer', payload: {} },
        ],
      })
    ).rejects.toThrow('different accepted strain');

    expect(await readFile(first.artifactPath, 'utf8')).toBe(content);
    expect(mocks.sourceWrites).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.registerCatalogEntity).not.toHaveBeenCalled();
  });

  it('refuses a fresh local strain at a removed accepted path before source creation', async () => {
    mocks.namespace.mockResolvedValue({
      head: `wv_${'a'.repeat(64)}`,
      entries: [
        {
          resourceId: 'removed-strain',
          revisionId: `rr_${'b'.repeat(64)}`,
          path: null,
          lastPath: 'removed.entity.json',
          tombstone: true,
        },
      ],
    });

    await expect(
      recordEntityArtifact({
        id: 'fresh-local-strain',
        artifactStem: 'removed',
        kind: 'strain',
        name: 'Fresh local',
        fields: { genotypeCanonical: 'recA1' },
        relationships: [
          {
            type: 'associated_with',
            fromEntityId: 'fresh-local-strain',
            toEntityId: 'legacy-target',
            payload: {},
          },
        ],
        workspaceRoot,
        destinationDir: workspaceRoot,
      })
    ).rejects.toThrow('already accepted');

    expect(mocks.sourceWrites).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('recovers an exact legacy strain creation after an unrelated accepted namespace appears', async () => {
    const input = {
      id: 'legacy-strain',
      artifactStem: 'legacy-strain',
      kind: 'strain',
      name: 'Legacy strain',
      fields: { genotypeCanonical: 'recA1' },
      workspaceRoot,
      destinationDir: join(workspaceRoot, 'strains'),
    };
    const first = await recordEntityArtifact(input);
    const original = await readFile(first.artifactPath, 'utf8');
    const schema = (await limsBridge.listSchemas()).find((entry) => entry.entityKind === 'strain')!;
    await limsBridge.refineSchema({
      schemaId: schema.schemaId,
      fields: [
        ...schema.fields,
        { key: 'later_required', label: 'Later', type: 'text', required: true },
      ],
    });
    openDbs[0].prepare('DELETE FROM lims_entity WHERE id=?').run(input.id);
    mocks.namespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    mocks.sourceWrites.mockClear();

    const recovered = await recordEntityArtifact(input);

    expect(recovered).toMatchObject({
      created: false,
      artifact: { id: first.artifact.id, schemaSnapshot: first.artifact.schemaSnapshot },
    });
    expect(await readFile(first.artifactPath, 'utf8')).toBe(original);
    expect(mocks.sourceWrites).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(await limsBridge.queryEntities({ id: input.id })).toEqual([
      expect.objectContaining({ id: input.id, schemaRevisionId: first.artifact.schemaRevisionId }),
    ]);
  });

  it.each([
    'moved',
    'removed',
    'claimed-path',
    'collision-path',
    'removed-path',
    'changed',
    'late-claim',
  ])('guards legacy strain creation after namespace change: %s', async (kind) => {
    const input = {
      id: 'guarded-strain',
      artifactStem: 'guarded-strain',
      kind: 'strain',
      name: 'Guarded strain',
      fields: { genotypeCanonical: 'recA1' },
      workspaceRoot,
      destinationDir: workspaceRoot,
    };
    const first = await recordEntityArtifact(input);
    const original = await readFile(first.artifactPath, 'utf8');
    const entry = {
      resourceId:
        kind === 'moved' || kind === 'removed' || kind === 'late-claim'
          ? input.id
          : 'another-owner',
      revisionId: `rr_${'b'.repeat(64)}`,
      path:
        kind === 'moved'
          ? 'moved.entity.json'
          : kind === 'collision-path'
            ? first.relativePath.toUpperCase()
            : first.relativePath,
      lastPath: first.relativePath,
      tombstone: kind === 'removed' || kind === 'removed-path',
    };
    const unclaimed = { head: `wv_${'a'.repeat(64)}`, entries: [] };
    mocks.namespace.mockResolvedValue(
      kind === 'changed' ? unclaimed : { ...unclaimed, entries: [entry] }
    );
    if (kind === 'late-claim') mocks.namespace.mockResolvedValueOnce(unclaimed);
    mocks.sourceWrites.mockClear();
    mocks.registerCatalogEntity.mockClear();
    mocks.bindCatalogEntityToFile.mockClear();

    await expect(
      recordEntityArtifact(
        kind === 'changed' ? { ...input, fields: { genotypeCanonical: 'recA2' } } : input
      )
    ).rejects.toThrow();

    expect(await readFile(first.artifactPath, 'utf8')).toBe(original);
    expect(mocks.sourceWrites).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.registerCatalogEntity).not.toHaveBeenCalled();
    expect(mocks.bindCatalogEntityToFile).not.toHaveBeenCalled();
  });

  it('keeps new missing-file strain creation on the accepted owner at a reusable path', async () => {
    const head = `wv_${'a'.repeat(64)}`;
    const acceptedRevision = {
      kind: 'accepted-object' as const,
      resourceId: 'new-strain',
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'c'.repeat(64)}`,
      contentSha256: 'd'.repeat(64),
      sequenceEditParentEventId: null,
    };
    mocks.namespace.mockResolvedValue({
      head,
      entries: [
        {
          resourceId: 'removed-owner',
          revisionId: `rr_${'e'.repeat(64)}`,
          path: null,
          lastPath: 'reusable.entity.json',
          tombstone: true,
        },
      ],
    });
    mocks.publish.mockRejectedValue(
      new NativeArtifactPublicationPendingError(acceptedRevision, 'delivery pending')
    );

    await expect(
      recordEntityArtifact({
        id: acceptedRevision.resourceId,
        artifactStem: 'reusable',
        kind: 'strain',
        name: 'New strain',
        fields: { genotypeCanonical: 'recA1' },
        workspaceRoot,
        destinationDir: workspaceRoot,
      })
    ).rejects.toMatchObject({ acceptedRevision });

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        prior: null,
        expectedHead: head,
        resourceId: acceptedRevision.resourceId,
      })
    );
    expect(mocks.sourceWrites).not.toHaveBeenCalled();
  });

  it('reuses an identical deterministic artifact and rebuilds its missing projection', async () => {
    const input = {
      id: 'protein-stable-id',
      artifactStem: 'GFP-stable',
      kind: 'protein',
      name: 'GFP',
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'MSKX*', length: 5 },
      },
      workspaceRoot: workspaceRoot,
      destinationDir: join(workspaceRoot, 'proteins'),
    } as const;
    const first = await recordEntityArtifact(input);
    openDbs[0].prepare('DELETE FROM lims_entity WHERE id = ?').run(first.artifact.id);

    const second = await recordEntityArtifact(input);

    expect(second.artifactPath).toBe(first.artifactPath);
    expect(second.created).toBe(false);
    expect(mocks.completed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcomeKind: 'record_existing',
        recordWriteStatus: 'existing',
        recordProjectionStatus: 'ready',
        recordHistoryStatus: 'not_applicable',
        affectedCount: 0,
      })
    );
    expect(mocks.files.size).toBe(1);
    expect(await limsBridge.queryEntities({ id: first.artifact.id })).toEqual([
      expect.objectContaining({ id: 'protein-stable-id', kind: 'protein', name: 'GFP' }),
    ]);
  });

  it('reports unchanged history without trying another commit for identical authority', async () => {
    const { isGitRepo, gitCommitPaths, gitStatus } = await import('../workspace/public/git');
    const request = {
      id: 'stable-record',
      artifactStem: 'stable-record',
      kind: 'strain',
      name: 'Stable',
      fields: { genotypeCanonical: 'wild type' },
      workspaceRoot: workspaceRoot,
      destinationDir: workspaceRoot,
    };
    await recordEntityArtifact(request);
    vi.mocked(isGitRepo).mockResolvedValueOnce(true);
    vi.mocked(gitStatus).mockResolvedValueOnce(new Map());
    vi.mocked(gitCommitPaths).mockClear();
    await recordEntityArtifact(request);
    expect(gitCommitPaths).not.toHaveBeenCalled();
    expect(mocks.completed).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordWriteStatus: 'existing', recordHistoryStatus: 'unchanged' })
    );
  });

  it('leaves the registry event to the batch owner when the commit is deferred', async () => {
    const result = await recordEntityArtifact({
      kind: 'strain',
      name: 'Batch member',
      fields: { genotypeCanonical: 'wild type' },
      workspaceRoot,
      destinationDir: workspaceRoot,
      deferCommit: true,
    });
    expect(result.created).toBe(true);
    expect(mocks.files.size).toBe(1);
    expect(mocks.completed).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('reports persisted creation separately from failed Git history', async () => {
    const { isGitRepo, gitCommitPaths, gitStatus } = await import('../workspace/public/git');
    vi.mocked(isGitRepo).mockResolvedValueOnce(true);
    vi.mocked(gitStatus).mockResolvedValueOnce(
      new Map([['.waypoint/lims/manifest.json', 'modified' as const]])
    );
    vi.mocked(gitCommitPaths).mockRejectedValueOnce(new Error('index locked'));
    const result = await recordEntityArtifact({
      kind: 'strain',
      name: 'History recovery',
      fields: { genotypeCanonical: 'wild type' },
      workspaceRoot: workspaceRoot,
      destinationDir: workspaceRoot,
    });
    expect(result).toMatchObject({ created: true, gitCommitted: false });
    expect(mocks.files.size).toBe(1);
    expect(await limsBridge.queryEntities({ id: result.artifact.id })).toHaveLength(1);
    expect(mocks.completed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcomeKind: 'record_created',
        recordWriteStatus: 'written',
        recordProjectionStatus: 'ready',
        recordHistoryStatus: 'failed',
        affectedCount: 1,
      })
    );
  });

  it('refuses to overwrite a different artifact at a deterministic path', async () => {
    const firstInput = {
      id: 'protein-stable-id',
      artifactStem: 'GFP-stable',
      kind: 'protein',
      name: 'GFP',
      fields: { sequence: { mode: 'inline', aminoAcids: 'MSK', length: 3 } },
      workspaceRoot: workspaceRoot,
      destinationDir: join(workspaceRoot, 'proteins'),
    } as const;
    await recordEntityArtifact(firstInput);

    await expect(
      recordEntityArtifact({
        ...firstInput,
        fields: { sequence: { mode: 'inline', aminoAcids: 'WQH', length: 3 } },
      })
    ).rejects.toThrow('A different record file already exists');
  });

  it('retries the existing frozen artifact after the schema head adds a required field', async () => {
    const input = {
      id: 'frozen-retry',
      artifactStem: 'Frozen-retry',
      kind: 'strain',
      name: 'Frozen retry',
      fields: { genotypeCanonical: 'recA1' },
      workspaceRoot: workspaceRoot,
      destinationDir: join(workspaceRoot, 'strains'),
    };
    const first = await recordEntityArtifact(input);
    const bytes = mocks.files.get(first.artifactPath);
    const definition = (await limsBridge.listSchemas()).find(
      (schema) => schema.entityKind === 'strain'
    )!;
    await limsBridge.refineSchema({
      schemaId: definition.schemaId,
      fields: [
        ...definition.fields,
        { key: 'new_required', label: 'New required', type: 'text', required: true },
      ],
    });
    const result = await recordEntityArtifact(input);
    expect(result.created).toBe(false);
    expect(result.artifact.schemaRevisionId).toBe(first.artifact.schemaRevisionId);
    expect(mocks.files.get(first.artifactPath)).toBe(bytes);
    expect((await limsBridge.queryEntities({ id: input.id }))[0].schemaRevisionId).toBe(
      first.artifact.schemaRevisionId
    );
  });
});
