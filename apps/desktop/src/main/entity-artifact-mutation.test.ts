import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => 'test', getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
import { createLimsTestBridge } from './__tests__/lims-bridge-for-db';
import { readEntitySchemaSnapshotInDb } from './entity-schema-snapshot';
import { mutateEntityArtifact } from './entity-artifact-mutation';
import * as artifactFiles from './primer-artifact-files';
import {
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifactV1,
} from '../shared/entity-artifact';

describe('file-authoritative Registry commands', () => {
  let bridge: ReturnType<typeof createLimsTestBridge>;
  let root: string;
  let artifact: EntityArtifactV1;
  const entity = async () =>
    (await bridge.lims.queryEntities({ id: 'record', includeArchived: true }))[0];
  const edit = async (operationId: string, expectedEventSeq?: number, name = 'Reviewed reagent') =>
    mutateEntityArtifact({
      db: bridge.db,
      runDatabase: (action) => action(),
      action: 'update',
      input: {
        id: 'record',
        expectedEventSeq: expectedEventSeq ?? (await entity()).eventSeq!,
        operationId,
        name,
      },
    });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-record-'));
    bridge = createLimsTestBridge();
    bridge.db
      .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES (7,?,?,1)')
      .run('Records', root);
    artifact = {
      schema: 'waypoint.entity.v1',
      id: 'record',
      kind: 'strain',
      name: 'Initial reagent',
      fields: {
        genotypeCanonical: 'fixture',
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'record.entity.json' },
      },
      registrationStatus: 'registered',
      domainStatus: null,
      relationships: [],
      source: { type: 'manual', values: {} },
    };
    await writeFile(join(root, 'record.entity.json'), serializeEntityArtifact(artifact));
    await bridge.lims.registerEntity({
      id: artifact.id,
      kind: artifact.kind,
      name: artifact.name,
      fields: artifact.fields,
      workspaceId: 7,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    bridge.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('persists edits, archive/restore and undo using the same native event history', async () => {
    await edit('edit');
    expect(parseEntityArtifact(await readFile(join(root, 'record.entity.json'), 'utf8')).name).toBe(
      'Reviewed reagent'
    );
    for (const action of ['archive', 'restore'] as const) {
      await mutateEntityArtifact({
        db: bridge.db,
        runDatabase: (action) => action(),
        action,
        input: { id: 'record', expectedEventSeq: (await entity()).eventSeq!, operationId: action },
      });
      const disk = parseEntityArtifact(await readFile(join(root, 'record.entity.json'), 'utf8'));
      expect(disk.archived).toBe(action === 'archive');
      expect((await entity()).tombstone).toBe(disk.archived);
    }
    await mutateEntityArtifact({
      db: bridge.db,
      runDatabase: (action) => action(),
      action: 'revert',
      input: { id: 'record', expectedEventSeq: (await entity()).eventSeq!, operationId: 'undo' },
    });
    expect(
      parseEntityArtifact(await readFile(join(root, 'record.entity.json'), 'utf8')).archived
    ).toBe(true);
    expect((await entity()).tombstone).toBe(true);
  });
  it.each([false, true])(
    'refuses a modified immutable definition before or after upgrade (%s)',
    async (upgraded) => {
      artifact.schemaSnapshot = readEntitySchemaSnapshotInDb(bridge.db, artifact.id);
      await writeFile(join(root, 'record.entity.json'), serializeEntityArtifact(artifact));
      if (upgraded) await edit('portable-edit');
      const saved = parseEntityArtifact(await readFile(join(root, 'record.entity.json'), 'utf8'));
      expect(saved.schemaSnapshot).toEqual(artifact.schemaSnapshot);
      if (!saved.schemaSnapshot) throw new Error('Fixture lost its schema snapshot.');
      saved.schemaSnapshot.fields[0].label = 'Tampered field';
      const changedBytes = serializeEntityArtifact(saved);
      await writeFile(join(root, 'record.entity.json'), changedBytes);
      const before = await entity();
      await expect(edit('tampered-definition')).rejects.toThrow(
        'Registry file and projection disagree'
      );
      expect(await entity()).toEqual(before);
      expect(await readFile(join(root, 'record.entity.json'), 'utf8')).toBe(changedBytes);
    }
  );

  it('returns the original receipt for an identical retry and rejects reused operation IDs', async () => {
    const seq = (await entity()).eventSeq!;
    const first = await edit('retry', seq);
    expect(await edit('retry', seq)).toEqual(first);
    await expect(edit('retry', seq, 'Different')).rejects.toThrow(/reused/);
  });
  it('captures a custom relationship definition, preserves it after head advance and restores it on undo', async () => {
    const definition = await bridge.lims.defineSchema({
      id: 'custom-relation',
      kind: 'relationship_type',
      name: 'custom_relation',
      displayName: 'Custom relation',
      fields: [],
    });
    if (
      !definition ||
      typeof definition !== 'object' ||
      !('id' in definition) ||
      typeof definition.id !== 'string' ||
      !('current_revision_id' in definition) ||
      typeof definition.current_revision_id !== 'string'
    ) {
      throw new Error(
        'The real defined relationship schema must return its ID and current revision.'
      );
    }
    const parent = await bridge.lims.registerEntity({
      id: 'parent',
      kind: 'strain',
      name: 'Parent',
      workspaceId: 7,
      fields: {
        genotypeCanonical: 'parent',
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'parent.entity.json' },
      },
    });
    await writeFile(
      join(root, 'parent.entity.json'),
      serializeEntityArtifact({
        ...artifact,
        id: parent.id,
        name: parent.name,
        fields: parent.fields,
      })
    );
    const relationships = [
      { toEntityId: parent.id, type: 'custom_relation', payload: { evidence: 'Original' } },
    ];
    const change = async (operationId: string, values = relationships) =>
      mutateEntityArtifact({
        db: bridge.db,
        runDatabase: (action) => action(),
        action: 'relationships',
        input: {
          id: artifact.id,
          expectedEventSeq: (await entity()).eventSeq!,
          operationId,
          relationships: values,
        },
      });
    const disk = async () =>
      parseEntityArtifact(await readFile(join(root, 'record.entity.json'), 'utf8'));
    await change('capture-definition');
    const captured = (await disk()).relationshipSchemaSnapshots;
    expect(captured).toMatchObject([
      {
        schemaKind: 'relationship_type',
        schemaId: definition.id,
        schemaRevisionId: definition.current_revision_id,
        version: 1,
        fields: [],
      },
    ]);
    await mutateEntityArtifact({
      db: bridge.db,
      runDatabase: (action) => action(),
      action: 'revert',
      input: {
        id: artifact.id,
        expectedEventSeq: (await entity()).eventSeq!,
        operationId: 'undo-capture',
      },
    });
    expect((await disk()).relationships).toEqual([]);
    expect((await disk()).relationshipSchemaSnapshots).toEqual([]);
    await change('recapture-definition');
    await bridge.lims.refineSchema({
      schemaId: definition.id,
      expectedRevisionId: definition.current_revision_id!,
      fields: [{ key: 'later', label: 'Later', type: 'text' }],
    });
    await change('change-payload', [{ ...relationships[0], payload: { evidence: 'Changed' } }]);
    expect((await disk()).relationshipSchemaSnapshots).toEqual(captured);
    await change('remove-links', []);
    expect((await disk()).relationshipSchemaSnapshots).toEqual([]);
    await mutateEntityArtifact({
      db: bridge.db,
      runDatabase: (action) => action(),
      action: 'revert',
      input: {
        id: artifact.id,
        expectedEventSeq: (await entity()).eventSeq!,
        operationId: 'undo-remove',
      },
    });
    const restored = await disk();
    expect(restored.relationshipSchemaSnapshots).toEqual(captured);
    expect(restored.relationships[0].payload).toEqual({ evidence: 'Changed' });
    restored.relationshipSchemaSnapshots![0].fields.push({
      key: 'forged',
      label: 'Forged',
      type: 'text',
    });
    const bytes = serializeEntityArtifact(restored),
      before = await entity();
    await writeFile(join(root, 'record.entity.json'), bytes);
    await expect(edit('forged-relationship-definition')).rejects.toThrow(
      /relationship schema and Registry differ/
    );
    expect(await entity()).toEqual(before);
    expect(await readFile(join(root, 'record.entity.json'), 'utf8')).toBe(bytes);
  });
  it('publishes exact outgoing relationships and native graph changes as one checked record edit', async () => {
    await bridge.lims.registerEntity({
      id: 'parent',
      kind: 'strain',
      name: 'Parent',
      workspaceId: 7,
      fields: {
        genotypeCanonical: 'parent',
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'parent.entity.json' },
      },
    });
    await writeFile(
      join(root, 'parent.entity.json'),
      serializeEntityArtifact({
        ...artifact,
        id: 'parent',
        name: 'Parent',
        fields: (await bridge.lims.queryEntities({ id: 'parent' }))[0].fields,
      })
    );
    const input = {
      id: 'record',
      expectedEventSeq: (await entity()).eventSeq!,
      operationId: 'relationships',
      relationships: [
        { toEntityId: 'parent', type: 'derives_from', payload: { evidence: 'fixture' } },
      ],
    };
    const request = {
      db: bridge.db,
      runDatabase: <T>(action: () => T) => action(),
      action: 'relationships' as const,
      input,
    };
    const result = await mutateEntityArtifact(request);
    expect(await mutateEntityArtifact(request)).toEqual(result);
    expect(
      parseEntityArtifact(await readFile(join(root, 'record.entity.json'), 'utf8')).relationships
    ).toEqual([{ fromEntityId: 'record', ...input.relationships[0] }]);
    expect(
      (await bridge.lims.getRegistryPreview({ entityId: 'record' })).outgoingLinks
    ).toHaveLength(1);
    expect(result.entity.eventSeq).toBeGreaterThan(input.expectedEventSeq);
    await expect(
      mutateEntityArtifact({ ...request, input: { ...input, operationId: 'stale' } })
    ).rejects.toThrow(/changed/);
    await mutateEntityArtifact({
      db: bridge.db,
      runDatabase: (action) => action(),
      action: 'revert',
      input: {
        id: 'record',
        expectedEventSeq: (await entity()).eventSeq!,
        operationId: 'undo-relationships',
      },
    });
    expect(
      parseEntityArtifact(await readFile(join(root, 'record.entity.json'), 'utf8')).relationships
    ).toEqual([]);
    expect((await bridge.lims.getRegistryPreview({ entityId: 'record' })).outgoingLinks).toEqual(
      []
    );
  });
  it('rejects stale versions and changed source bytes before mutating either owner', async () => {
    const seq = (await entity()).eventSeq!;
    await edit('first');
    const saved = await readFile(join(root, 'record.entity.json'), 'utf8');
    await expect(edit('stale', seq)).rejects.toThrow(/changed/);
    expect(await readFile(join(root, 'record.entity.json'), 'utf8')).toBe(saved);
    await writeFile(
      join(root, 'record.entity.json'),
      serializeEntityArtifact({ ...parseEntityArtifact(saved), name: 'External edit' })
    );
    await expect(edit('external')).rejects.toThrow(/Registry file and projection disagree/);
    expect((await entity()).name).toBe('Reviewed reagent');
  });
  it('refuses a relationship target replaced during publication without changing the source or graph', async () => {
    await bridge.lims.registerEntity({
      id: 'parent',
      kind: 'strain',
      name: 'Parent',
      workspaceId: 7,
      fields: {
        genotypeCanonical: 'parent',
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'parent.entity.json' },
      },
    });
    const parentPath = join(root, 'parent.entity.json');
    const parent = {
      ...artifact,
      id: 'parent',
      name: 'Parent',
      fields: (await bridge.lims.queryEntities({ id: 'parent' }))[0].fields,
    };
    await writeFile(parentPath, serializeEntityArtifact(parent));
    const sourceBytes = await readFile(join(root, 'record.entity.json'), 'utf8');
    const audit = bridge.db.prepare('SELECT count(*) AS count FROM lims_audit').get();
    const originalWrite = artifactFiles.writeWorkspaceTextFileAtomicInMain;
    vi.spyOn(artifactFiles, 'writeWorkspaceTextFileAtomicInMain').mockImplementationOnce(
      (input, options) =>
        originalWrite(input, {
          ...options,
          beforePublish: () => {
            writeFileSync(parentPath, serializeEntityArtifact({ ...parent, id: 'replacement' }));
            options?.beforePublish?.();
          },
        })
    );
    await expect(
      mutateEntityArtifact({
        db: bridge.db,
        runDatabase: (action) => action(),
        action: 'relationships',
        input: {
          id: 'record',
          expectedEventSeq: (await entity()).eventSeq!,
          operationId: 'changed-target',
          relationships: [{ toEntityId: 'parent', type: 'derives_from' }],
        },
      })
    ).rejects.toThrow(/target.*changed/i);
    expect(await readFile(join(root, 'record.entity.json'), 'utf8')).toBe(sourceBytes);
    expect((await bridge.lims.getRegistryPreview({ entityId: 'record' })).outgoingLinks).toEqual(
      []
    );
    expect(bridge.db.prepare('SELECT count(*) AS count FROM lims_audit').get()).toEqual(audit);
    expect(parseEntityArtifact(await readFile(parentPath, 'utf8')).id).toBe('replacement');
  });
  it('rolls back real schema validation without any file or audit effect', async () => {
    const before = await readFile(join(root, 'record.entity.json'), 'utf8');
    const auditBefore = bridge.db.prepare('SELECT count(*) AS count FROM lims_audit').get();
    await expect(
      mutateEntityArtifact({
        db: bridge.db,
        runDatabase: (action) => action(),
        action: 'update',
        input: {
          id: 'record',
          operationId: 'invalid',
          expectedEventSeq: (await entity()).eventSeq!,
          fields: { genotypeCanonical: { invalid: true } },
        },
      })
    ).rejects.toThrow();
    expect(await readFile(join(root, 'record.entity.json'), 'utf8')).toBe(before);
    expect(bridge.db.prepare('SELECT count(*) AS count FROM lims_audit').get()).toEqual(
      auditBefore
    );
  });
});
