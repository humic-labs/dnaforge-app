/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  app: {
    getPath: (name: string) => join(state.root, name),
    getVersion: () => '1.0.0',
    exit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../ipc/database', () => ({ getDb: () => state.db! }));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerLimsIpcHandlers, registerLimsEntityInDb } from '../lims';
import {
  buildPrimerArtifact,
  primerRegistryFieldsFromArtifact,
  serializePrimerArtifact,
} from '../../features/primers/public/primer-artifact';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';

describe('generic Registry IPC respects primer file authority', () => {
  const sender = Object.assign(new EventEmitter(), { id: 366164 });
  let path: string;
  let content: string;
  let fields: Record<string, unknown>;
  let artifact: Awaited<ReturnType<typeof buildPrimerArtifact>>;

  beforeEach(async () => {
    state.root = mkdtempSync(join(tmpdir(), 'dnaforge-lims-primer-authority-'));
    state.db = createTestDb();
    ensureSchema(state.db, ':memory:');
    state.db
      .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)')
      .run('Primer fixture', state.root);
    state.handlers.clear();
    registerLimsIpcHandlers();
    path = join(state.root, 'Canonical.primer.json');
    artifact = await buildPrimerArtifact({
      id: 'canonical-primer',
      catalogNumber: 'P901',
      name: 'Canonical',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: state.root,
      artifactPath: path,
    });
    content = serializePrimerArtifact(artifact);
    writeFileSync(path, content);
    fields = primerRegistryFieldsFromArtifact(
      artifact,
      createHash('sha256').update(content).digest('hex')
    );
    registerLimsEntityInDb(state.db, {
      id: artifact.id,
      kind: 'oligo',
      name: artifact.name,
      fields,
      workspaceId: 7,
      domainStatus: 'designed',
    });
  });

  afterEach(() => {
    workspaceMutationCapabilities.releaseOwner(sender.id);
    state.db?.close();
    state.db = null;
    rmSync(state.root, { recursive: true, force: true });
  });

  function invoke(channel: string, input: unknown) {
    return Promise.resolve(state.handlers.get(channel)!({ sender }, input));
  }

  it('rejects a claimed file-backed oligo whose authoritative file does not exist', async () => {
    await expect(
      invoke('lims:registerEntity', {
        id: 'phantom-primer',
        kind: 'oligo',
        name: 'Phantom',
        fields: {
          ...fields,
          artifact: { schema: 'dnaforge.primer', relativePath: 'Missing.primer.json' },
        },
        workspaceId: 7,
      })
    ).rejects.toThrow(/primer|artifact|source/i);
    expect(
      state.db!.prepare("SELECT id FROM lims_entity WHERE id='phantom-primer'").get()
    ).toBeUndefined();
  });

  it('rejects a generic semantic edit without changing file bytes or the Registry projection', async () => {
    const before = state.db!.prepare('SELECT * FROM lims_entity').all();
    await expect(
      invoke('lims:updateEntity', {
        id: 'canonical-primer',
        name: 'Bypass',
        actor: 'workspace-reconcile',
      })
    ).rejects.toThrow(/primer|artifact|source/i);
    expect(state.db!.prepare('SELECT * FROM lims_entity').all()).toEqual(before);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('rejects generic archive while the authoritative primer file still exists', async () => {
    await expect(
      invoke('lims:archiveEntity', { id: 'canonical-primer', actor: 'agent' })
    ).rejects.toThrow(/primer|artifact|source/i);
    expect(
      state.db!.prepare("SELECT tombstone FROM lims_entity WHERE id='canonical-primer'").get()
    ).toEqual({ tombstone: 0 });
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('refuses new database-owned authoring in a reference project', async () => {
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    await expect(
      invoke('lims:registerEntity', {
        id: 'new-db-oligo',
        kind: 'oligo',
        name: 'New',
        fields: { sequence: { mode: 'inline', bases: 'ATCG', length: 4, topology: 'linear' } },
        workspaceId: 7,
      })
    ).rejects.toThrow(/WORKSPACE_READ_ONLY/);
    expect(
      state.db!.prepare("SELECT id FROM lims_entity WHERE id='new-db-oligo'").get()
    ).toBeUndefined();
  });

  it('retains ordinary native database-owned editing for a writable project', async () => {
    registerLimsEntityInDb(state.db!, {
      id: 'database-oligo',
      kind: 'oligo',
      name: 'Before',
      fields: { sequence: { mode: 'inline', bases: 'ATCG', length: 4, topology: 'linear' } },
      workspaceId: 7,
    });
    await expect(
      invoke('lims:updateEntity', { id: 'database-oligo', name: 'After' })
    ).resolves.toMatchObject({ name: 'After' });
  });

  it('accepts an exact projection after an actual authoritative file revision', async () => {
    const revised = { ...artifact, name: 'Revised primer', artifactRevision: 2 };
    const revisedContent = serializePrimerArtifact(revised);
    writeFileSync(path, revisedContent);
    const revisedFields = primerRegistryFieldsFromArtifact(
      revised,
      createHash('sha256').update(revisedContent).digest('hex')
    );
    await expect(
      invoke('lims:updateEntity', {
        id: artifact.id,
        name: revised.name,
        fields: revisedFields,
        replaceFields: true,
      })
    ).resolves.toMatchObject({ name: revised.name, fields: revisedFields });
    expect(readFileSync(path, 'utf8')).toBe(revisedContent);
  });

  it('permits exact read-model repair from reference source bytes', async () => {
    state.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    state.db!.prepare("UPDATE lims_entity SET name='Stale projection' WHERE id=?").run(artifact.id);
    const exportPath = join(state.root, '.waypoint', 'lims', 'manifest.json');
    const exportBefore = readFileSync(exportPath, 'utf8');
    await expect(
      invoke('lims:updateEntity', {
        id: artifact.id,
        name: artifact.name,
        fields,
        replaceFields: true,
      })
    ).resolves.toMatchObject({ name: artifact.name });
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(readFileSync(exportPath, 'utf8')).toBe(exportBefore);
  });

  it('permits projection retirement after the actual primer source is removed', async () => {
    unlinkSync(path);
    await expect(invoke('lims:archiveEntity', { id: artifact.id })).resolves.toMatchObject({
      tombstone: true,
    });
  });

  it('refuses a queued Registry edit when its durable owner changes before admission', async () => {
    registerLimsEntityInDb(state.db!, {
      id: 'moving-oligo',
      kind: 'oligo',
      name: 'Before',
      fields: { sequence: { mode: 'inline', bases: 'ATCG', length: 4, topology: 'linear' } },
      workspaceId: 7,
    });
    state
      .db!.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)')
      .run('Other', join(state.root, 'Other'));
    const release = await acquireWorkspaceSyncMutationLease(state.root);
    const pending = invoke('lims:updateEntity', { id: 'moving-oligo', name: 'Bypass' });
    await Promise.resolve();
    state.db!.prepare("UPDATE lims_entity SET workspace_id=8 WHERE id='moving-oligo'").run();
    release();
    await expect(pending).rejects.toThrow('WORKSPACE_MUTATION_OWNER_CHANGED');
    expect(
      state.db!.prepare("SELECT name,workspace_id FROM lims_entity WHERE id='moving-oligo'").get()
    ).toEqual({ name: 'Before', workspace_id: 8 });
  });

  it('rejects a generic database-owned identity transfer between writable projects', async () => {
    registerLimsEntityInDb(state.db!, {
      id: 'owned-oligo',
      kind: 'oligo',
      name: 'Before',
      fields: { sequence: { mode: 'inline', bases: 'ATCG', length: 4, topology: 'linear' } },
      workspaceId: 7,
    });
    state
      .db!.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)')
      .run('Other', join(state.root, 'Other'));
    await expect(
      invoke('lims:updateEntity', { id: 'owned-oligo', workspaceId: 8 })
    ).rejects.toThrow('REGISTRY_OWNER_REQUIRES_NATIVE_LIFECYCLE');
    expect(
      state.db!.prepare("SELECT workspace_id FROM lims_entity WHERE id='owned-oligo'").get()
    ).toEqual({ workspace_id: 7 });
  });
});
