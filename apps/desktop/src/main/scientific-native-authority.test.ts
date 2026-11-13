import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { ScientificObjectStore } from './scientific-object-store';
import { readAcceptedScientificStrain } from './scientific-strain-authority';
import { reconstructFileBackedRegistryRelationships } from './file-backed-registry-mutation';
import { registerLimsEntityInDb, replaceLimsOutgoingRelationshipsInDb } from './lims';
import { acquireWorkspaceMutationShared } from './workspace-sync-mutation-lease';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertWorkspaceSyncDatabaseFence,
} from './workspace-sync-database-fence';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: vi.fn(async () => {}),
}));

it('publishes inside the native owner and refuses a revoked owner before acceptance', async () => {
  const fixture = createFileTestDb('scientific-native-authority');
  const { db } = fixture;
  ensureSchema(db, fixture.dbPath);
  const root = join(fixture.tmpDir, 'project');
  await mkdir(root);
  const workspaceId = Number(
    db
      .prepare('INSERT INTO workspaces (name,path,created_at) VALUES (?,?,1)')
      .run('Native owner', root).lastInsertRowid
  );
  const mutationLease = await acquireWorkspaceMutationShared(root);
  const databaseFence = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    const request = {
      operationId: 'native-owner-first',
      expectedHead: null,
      source: {
        kind: 'documents' as const,
        entries: [
          {
            resourceId: 'native-owner-primer',
            path: 'primer.json',
            document: {
              formatVersion: 1 as const,
              kind: 'primer' as const,
              name: 'Native owner primer',
              molecule: 'DNA' as const,
              bases: 'ACGT',
              modifications: [],
              fields: {},
            },
          },
        ],
      },
    };
    const accepted = await submitScientificWorkspace({
      db,
      workspaceId,
      request,
      mutationLease,
      databaseFence,
    });
    expect(accepted.acceptance.kind).toBe('changed');
    expect(accepted.delivery?.kind).toBe('complete');
    expect(() => assertWorkspaceSyncDatabaseFence(db, databaseFence)).not.toThrow();
    const head = new ScientificObjectStore(db, workspaceId).catalog().head;
    await expect(
      submitScientificWorkspace({
        db,
        workspaceId,
        mutationLease,
        databaseFence,
        request: { ...request, operationId: 'native-owner-revoked', expectedHead: head },
        beforeAccept: () => {
          throw new Error('NATIVE_OWNER_REVOKED');
        },
      })
    ).rejects.toThrow('NATIVE_OWNER_REVOKED');
    expect(new ScientificObjectStore(db, workspaceId).catalog().head).toBe(head);
    expect(() => assertWorkspaceSyncDatabaseFence(db, databaseFence)).not.toThrow();
  } finally {
    databaseFence();
    mutationLease();
    fixture.cleanup();
  }
});

it('refuses accepted strain relationships through the file reconstruction owner', async () => {
  const fixture = createFileTestDb('accepted-strain-reconstruction');
  const { db } = fixture;
  ensureSchema(db, fixture.dbPath);
  const root = join(fixture.tmpDir, 'project');
  await mkdir(root);
  const workspaceId = Number(
    db
      .prepare('INSERT INTO workspaces (name,path,created_at) VALUES (?,?,1)')
      .run('Accepted strain', root).lastInsertRowid
  );
  registerLimsEntityInDb(db, {
    id: 'accepted-strain',
    kind: 'strain',
    name: 'Accepted strain',
    fields: {},
    workspaceId,
  });
  const mutationLease = await acquireWorkspaceMutationShared(root);
  const databaseFence = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    const accepted = await submitScientificWorkspace({
      db,
      workspaceId,
      mutationLease,
      databaseFence,
      request: {
        operationId: 'accepted-strain-reconstruction',
        expectedHead: null,
        source: {
          kind: 'documents',
          entries: [
            {
              resourceId: 'accepted-strain',
              path: 'strain.json',
              document: {
                formatVersion: 1,
                kind: 'strain',
                name: 'Accepted strain',
                taxon: null,
                fields: {},
              },
            },
          ],
        },
      },
    });
    expect(accepted.acceptance.kind).toBe('changed');
    expect(accepted.delivery?.kind).toBe('complete');
    const input = { entityId: 'accepted-strain', workspaceId, relationships: [] };
    expect(readAcceptedScientificStrain(db, input.entityId)).not.toBeNull();
    const before = {
      head: new ScientificObjectStore(db, workspaceId).catalog().head,
      audit: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      links: db.prepare('SELECT * FROM lims_link ORDER BY id').all(),
    };
    expect(() => replaceLimsOutgoingRelationshipsInDb(db, input)).toThrow(
      'Open the strain and save its captured relationships.'
    );
    await expect(
      reconstructFileBackedRegistryRelationships(db, input, (work) => work())
    ).rejects.toThrow('Open the strain and save its captured relationships.');
    expect(new ScientificObjectStore(db, workspaceId).catalog().head).toBe(before.head);
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(before.audit);
    expect(db.prepare('SELECT * FROM lims_link ORDER BY id').all()).toEqual(before.links);
  } finally {
    databaseFence();
    mutationLease();
    fixture.cleanup();
  }
});
