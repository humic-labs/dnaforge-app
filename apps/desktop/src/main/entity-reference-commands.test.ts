import { molecularDocumentReferenceLocator } from '../shared/molecular-document-reference';
import { createHash } from 'node:crypto';
/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  sender: null as (EventEmitter & { id: number }) | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler),
  },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
}));
vi.mock('../db/index', () => ({
  getConnection: () => ({
    createEntityReference: (row: unknown) =>
      state.handlers.get('db:createEntityReference')!({ sender: state.sender }, row),
    updateEntityReference: (id: string, updates: unknown) =>
      state.handlers.get('db:updateEntityReference')!({ sender: state.sender }, id, updates),
    deleteEntityReference: (id: string) =>
      state.handlers.get('db:deleteEntityReference')!({ sender: state.sender }, id),
    recordEntityReferenceRevision: (input: unknown) =>
      state.handlers.get('db:recordEntityReferenceRevision')!({ sender: state.sender }, input),
    setEntityReferenceWorkspaceRootPathIfMissing: (id: string, root: string) =>
      state.handlers.get('db:setEntityReferenceWorkspaceRootPathIfMissing')!(
        { sender: state.sender },
        id,
        root
      ),
    select: (sql: string, params?: unknown[]) =>
      state.handlers.get('db:select')!({ sender: state.sender }, sql, params),
  }),
}));
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  registerDatabaseHandlers,
  commitChatTurnTerminalStateInDb,
  createChatTurnWithUserMessageInDb,
} from './ipc/database';
import {
  createEntityReference,
  updateEntityReference,
  getEntityReference,
  recordRevision,
  setEntityReferenceWorkspaceRootPathIfMissing,
} from '../db/entity-references';
import { prepareEntityReferenceRow } from '../shared/entity-reference-ipc';
import { createLimsBridgeForDb } from './__tests__/lims-bridge-for-db';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { rememberOriginalDefaultProject } from './original-default-project';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { replacePrimerLegacyProjectionInDb } from './primer-projection';
import {
  buildPrimerArtifact,
  serializePrimerArtifact,
  primerRegistryFieldsFromArtifact,
  primerLegacyProjectionFromArtifact,
} from '../features/primers/public/primer-artifact';

let root: string;
const external = (id: string = crypto.randomUUID()) => ({
  id,
  entity_type: 'external',
  display_label: 'External snapshot',
  locator: 'https://example.org/record/one',
  deep_link_params: null,
  data: JSON.stringify({ kind: 'external-result', value: 1 }),
  source: 'user',
  status: 'created',
  workspace_scope: null,
  workspace_root_path: null,
  created_at: 1,
  updated_at: 1,
});
function execute(sql: string) {
  return Promise.resolve().then(() =>
    state.handlers.get('db:execute')!({ sender: state.sender }, sql)
  );
}

beforeEach(() => {
  state.db = createTestDb();
  ensureSchema(state.db, ':memory:');
  state.sender = Object.assign(new EventEmitter(), { id: 63329 });
  state.handlers.clear();
  registerDatabaseHandlers(() => state.db!);
  root = mkdtempSync(join(tmpdir(), 'dnaforge-reference-authority-'));
  ensureWorkspaceOwnerInDb(state.db, root);
});
afterEach(() => {
  state.db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('saved references through renderer delegates, native IPC and actual SQLite', () => {
  it('keeps a pinned molecular document reference in its real catalog project', async () => {
    const documentId = '40000000-0000-4000-8000-000000000009';
    const target = {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'molecular-project',
      documentId,
      revisionId: '40000000-0000-4000-8000-000000000008',
      revisionSha256: 'c'.repeat(64),
    };
    state.db!.prepare('UPDATE workspaces SET repo_uuid=? WHERE path=?').run(target.projectId, root);
    registerCatalogEntityInDb(state.db!, {
      id: `${target.projectId}::${documentId}`,
      type: 'molecular-document',
      name: 'Pinned view',
      locator: `entity://molecular-document/${documentId}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    const input = {
      entityType: 'molecular-document',
      displayLabel: 'Pinned view',
      locator: molecularDocumentReferenceLocator(target),
      data: target,
      deepLinkParams: null,
      source: 'user',
      workspaceScope: target.projectId,
      workspaceRootPath: root,
    };
    const created = await createEntityReference(input);
    expect(await getEntityReference(created.id)).toMatchObject({
      locator: input.locator,
      data: JSON.stringify(target),
      workspace_root_path: root,
    });
    await expect(
      createEntityReference({ ...input, workspaceScope: 'other-project' })
    ).rejects.toThrow(/owning project/);
    const retargeted = { ...target, revisionId: '40000000-0000-4000-8000-000000000006' };
    await expect(
      updateEntityReference(created.id, {
        locator: molecularDocumentReferenceLocator(retargeted),
        data: retargeted,
      })
    ).rejects.toThrow(/immutable/);
    expect(await getEntityReference(created.id)).toEqual(created);
    const forged = { ...target, documentId: '40000000-0000-4000-8000-000000000007' };
    await expect(
      createEntityReference({
        ...input,
        locator: molecularDocumentReferenceLocator(forged),
        data: forged,
      })
    ).rejects.toThrow(/target is unavailable/);
    expect(state.db!.prepare('SELECT count(*) AS count FROM entity_references').get()).toEqual({
      count: 1,
    });
  });

  it('creates and retries the exact same reference without permitting ID takeover', async () => {
    const input = {
      entityType: 'external',
      displayLabel: 'External snapshot',
      locator: 'https://example.org/record/one',
      deepLinkParams: null,
      data: { kind: 'external-result', value: 1 },
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: null,
    };
    const first = await createEntityReference(input, { id: 'stable-reference', now: 1 });
    expect(await createEntityReference(input, { id: first.id, now: 2 })).toEqual(first);
    await expect(
      createEntityReference(
        { ...input, locator: 'https://example.org/record/two' },
        { id: first.id }
      )
    ).rejects.toThrow(/already belongs/);
    expect(await getEntityReference(first.id)).toEqual(first);
  });

  it.each([
    "UPDATE entity_references SET locator='entity://primer/phantom' WHERE id='raw-ref'",
    "DELETE FROM entity_references WHERE id='raw-ref'",
    "INSERT INTO entity_references(id,entity_type,display_label,locator,source,status,created_at,updated_at) VALUES('phantom','primer','Phantom','entity://primer/phantom','ai','created',1,1)",
  ])('refuses raw saved-reference authority mutation: %s', async (sql) => {
    state
      .db!.prepare(
        'INSERT INTO entity_references(id,entity_type,display_label,locator,deep_link_params,data,source,status,workspace_scope,workspace_root_path,created_at,updated_at) VALUES(@id,@entity_type,@display_label,@locator,@deep_link_params,@data,@source,@status,@workspace_scope,@workspace_root_path,@created_at,@updated_at)'
      )
      .run(external('raw-ref'));
    const before = state.db!.prepare('SELECT * FROM entity_references').all();
    await expect(execute(sql)).rejects.toThrow(/REQUIRES_NATIVE_COMMAND/);
    expect(state.db!.prepare('SELECT * FROM entity_references').all()).toEqual(before);
  });

  it('refuses phantom oligos through the standalone native authoring route', async () => {
    await expect(
      createEntityReference({
        entityType: 'primer',
        displayLabel: 'Phantom',
        locator: 'entity://primer/phantom',
        deepLinkParams: null,
        data: { registryEntityId: 'phantom', localOnly: true },
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: null,
      })
    ).rejects.toThrow(/existing active canonical oligo/);
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM entity_references').get()).toEqual({
      count: 0,
    });
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
  });

  it('uses the same canonical-target refusal for proposed references in an atomic chat terminal commit', () => {
    const db = state.db!;
    db.prepare(
      "INSERT INTO conversations(id,title,created_at,updated_at) VALUES('conversation','Reference refusal',1,1)"
    ).run();
    createChatTurnWithUserMessageInDb(db, {
      turn: {
        id: 'turn',
        conversation_id: 'conversation',
        route_kind: 'desktop',
        host_id: 'builtin',
        provider: null,
        model: null,
        transport: null,
        authority_profile_id: null,
        permission_mode: null,
        route_snapshot_json: '{}',
        status: 'running',
        terminal_reason: null,
        error: null,
        started_at: 1,
        completed_at: null,
      },
      message: {
        id: 'user-message',
        conversation_id: 'conversation',
        role: 'user',
        content: 'Reference the saved oligo',
        tool_name: null,
        tool_call_id: null,
        created_at: 1,
      },
    });
    const reference = {
      ...external('phantom-chat-reference'),
      entity_type: 'primer',
      locator: 'entity://primer/phantom',
      data: JSON.stringify({ registryEntityId: 'phantom', localOnly: true }),
      source: 'ai',
    };
    expect(() =>
      commitChatTurnTerminalStateInDb(db, {
        turn_id: 'turn',
        conversation_id: 'conversation',
        status: 'completed',
        terminal_reason: 'complete',
        error: null,
        completed_at: 2,
        messages: [
          {
            message: {
              id: 'assistant-message',
              turn_id: 'turn',
              conversation_id: 'conversation',
              role: 'assistant',
              content: 'A phantom oligo',
              tool_name: null,
              tool_call_id: null,
              created_at: 2,
            },
            reference_ids: [reference.id],
          },
        ],
        proposed_entity_references: [reference],
      })
    ).toThrow(/existing active canonical oligo/);
    expect(db.prepare("SELECT status FROM chat_turns WHERE id='turn'").get()).toEqual({
      status: 'running',
    });
    expect(
      db.prepare("SELECT id FROM messages WHERE id='assistant-message'").get()
    ).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM entity_references').get()).toEqual({
      count: 0,
    });
  });

  it('references an existing database-native canonical oligo without inventing a primer artifact', async () => {
    const project = state.db!.prepare('SELECT id FROM workspaces WHERE path=?').get(root) as {
      id: number;
    };
    state
      .db!.prepare("UPDATE workspaces SET repo_uuid='original-project' WHERE id=?")
      .run(project.id);
    rememberOriginalDefaultProject(state.db!, project.id);
    const lims = createLimsBridgeForDb(state.db!);
    const entity = await lims.registerEntity({
      kind: 'oligo',
      name: 'Existing oligo',
      fields: { sequence: { mode: 'inline', bases: 'ATCGATCG', length: 8, topology: 'linear' } },
    });
    const saved = await createEntityReference({
      entityType: 'primer',
      displayLabel: entity.name,
      locator: `entity://primer/${entity.id}`,
      deepLinkParams: null,
      data: { registryEntityId: entity.id, localOnly: true },
      source: 'ai',
      workspaceScope: 'original-project',
      workspaceRootPath: root,
    });
    expect(saved.entity_type).toBe('primer');
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
    await expect(
      updateEntityReference(saved.id, { data: { registryEntityId: 'another', localOnly: true } })
    ).rejects.toThrow(/immutable/);
  });

  it('retains a database-only oligo provenance project without requiring a primer artifact', async () => {
    const workspaceId = ensureWorkspaceOwnerInDb(state.db!, root);
    const lims = createLimsBridgeForDb(state.db!);
    const entity = await lims.registerEntity({
      kind: 'oligo',
      name: 'Legacy database oligo',
      fields: { sequence: { mode: 'inline', bases: 'ATCGATCG', length: 8, topology: 'linear' } },
      workspaceId,
    });
    const input = {
      entityType: 'primer',
      displayLabel: entity.name,
      locator: `entity://primer/${entity.id}`,
      deepLinkParams: null,
      data: { registryEntityId: entity.id, localOnly: true },
      source: 'ai',
      workspaceScope: null,
    };
    await expect(createEntityReference({ ...input, workspaceRootPath: null })).rejects.toThrow(
      /provenance project/
    );
    const saved = await createEntityReference({ ...input, workspaceRootPath: root });
    expect(saved.workspace_root_path).toBe(root);
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
  });

  it('retains the artifact owner of a project primer instead of accepting a local-only disguise', async () => {
    const artifactPath = join(root, 'Owned.primer.json');
    const artifact = await buildPrimerArtifact({
      id: 'owned-primer',
      catalogNumber: 'P901',
      name: 'Owned primer',
      sequence: 'ATCGATCGATCG',
      workspaceRoot: root,
      artifactPath,
    });
    const content = serializePrimerArtifact(artifact);
    writeFileSync(artifactPath, content);
    const hash = createHash('sha256').update(content).digest('hex');
    const workspaceId = ensureWorkspaceOwnerInDb(state.db!, root);
    const lims = createLimsBridgeForDb(state.db!);
    await lims.registerEntity({
      id: artifact.registry.entityId,
      kind: artifact.registry.kind,
      name: artifact.name,
      fields: primerRegistryFieldsFromArtifact(artifact, hash),
      workspaceId,
      registrationStatus: 'registered',
      domainStatus: 'designed',
    });
    registerCatalogEntityInDb(state.db!, {
      id: artifact.id,
      type: 'primer',
      name: artifact.name,
      locator: `waypoint://primer/${artifact.id}`,
      storageType: 'file',
      workspaceRoot: root,
      metadata: { artifactRevision: artifact.artifactRevision },
    });
    bindCatalogEntityFileInDb(state.db!, {
      entityId: artifact.id,
      path: artifactPath,
      fileKind: 'primer-artifact',
      workspaceRoot: root,
      contentHash: `sha256:${hash}`,
    });
    replacePrimerLegacyProjectionInDb(
      state.db!,
      primerLegacyProjectionFromArtifact(artifact, workspaceId, [])
    );
    const input = {
      entityType: 'primer',
      displayLabel: artifact.name,
      locator: `entity://primer/${artifact.registry.entityId}`,
      deepLinkParams: null,
      source: 'ai',
      workspaceScope: null,
    };
    await expect(
      createEntityReference({
        ...input,
        data: { registryEntityId: artifact.registry.entityId, localOnly: true },
        workspaceRootPath: null,
      })
    ).rejects.toThrow(/artifact owner|project-owned/);
    const saved = await createEntityReference({
      ...input,
      data: { registryEntityId: artifact.registry.entityId, primerId: artifact.id },
      workspaceRootPath: root,
    });
    expect(saved.workspace_root_path).toBe(root);
  });

  it('keeps canonical target ownership and saved selection immutable', async () => {
    registerCatalogEntityInDb(state.db!, {
      id: 'sequence-one',
      type: 'sequence',
      name: 'Sequence',
      locator: 'file:///sequence-one.gb',
      storageType: 'file',
      workspaceRoot: root,
    });
    const params = {
      entityType: 'sequence_region',
      displayLabel: 'Selected bases',
      locator: 'sequence-one',
      deepLinkParams: { start: 2, end: 8 },
      data: { documentId: 'sequence-one' },
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: root,
    };
    const saved = await createEntityReference(params);
    await expect(
      createEntityReference({ ...params, workspaceRootPath: join(root, 'other') })
    ).rejects.toThrow(/project owner/);
    await expect(
      updateEntityReference(saved.id, { deepLinkParams: { start: 3, end: 9 } })
    ).rejects.toThrow(/immutable/);
    await expect(updateEntityReference(saved.id, { locator: 'sequence-two' })).rejects.toThrow(
      /immutable/
    );
    expect((await getEntityReference(saved.id))?.deep_link_params).toBe(
      JSON.stringify({ start: 2, end: 8 })
    );
  });

  it('refuses an unregistered authored type that disguises a missing canonical sequence', async () => {
    await expect(
      createEntityReference({
        entityType: 'forged-entity-kind',
        displayLabel: 'Missing',
        locator: 'entity://sequence/missing',
        deepLinkParams: null,
        data: null,
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: null,
      })
    ).rejects.toThrow(/unsupported|unregistered|type/i);
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM entity_references').get()).toEqual({
      count: 0,
    });
  });

  it('refuses a canonical route whose entity kind disagrees even when the claimed sequence exists', async () => {
    registerCatalogEntityInDb(state.db!, {
      id: 'existing-sequence',
      type: 'sequence',
      name: 'Sequence',
      locator: 'file:///existing-sequence.gb',
      storageType: 'file',
      workspaceRoot: root,
    });
    await expect(
      createEntityReference({
        entityType: 'sequence',
        displayLabel: 'Mismatched',
        locator: 'entity://notebook/existing-sequence',
        deepLinkParams: null,
        data: null,
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: root,
      })
    ).rejects.toThrow(/route|kind|type/i);
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM entity_references').get()).toEqual({
      count: 0,
    });
  });

  it('recovers only a historical root retained by the reference and never rewrites it later', async () => {
    const row = {
      ...external('historical'),
      entity_type: 'sequence',
      locator: 'git://Original/target.gb',
      data: null,
      workspace_scope: `folders:${JSON.stringify([root])}`,
    };
    state
      .db!.prepare(
        'INSERT INTO entity_references(id,entity_type,display_label,locator,deep_link_params,data,source,status,workspace_scope,workspace_root_path,created_at,updated_at) VALUES(@id,@entity_type,@display_label,@locator,@deep_link_params,@data,@source,@status,@workspace_scope,@workspace_root_path,@created_at,@updated_at)'
      )
      .run(row);
    await expect(
      setEntityReferenceWorkspaceRootPathIfMissing(row.id, join(root, 'forged'))
    ).rejects.toThrow(/saved ownership/);
    expect(await setEntityReferenceWorkspaceRootPathIfMissing(row.id, root)).toBe(root);
    expect(await setEntityReferenceWorkspaceRootPathIfMissing(row.id, '/replacement')).toBe(root);
  });

  it('allocates revisions atomically and refuses raw revision replacement', async () => {
    const row = external('revised');
    await state.handlers.get('db:createEntityReference')!({ sender: state.sender }, row);
    const input = {
      referenceId: row.id,
      changedBy: 'user',
      changeType: 'note',
      previousState: null,
      newState: { note: 'First' },
    };
    const revisions = await Promise.all([
      recordRevision(input),
      recordRevision({ ...input, newState: { note: 'Second' } }),
    ]);
    expect(revisions.map((row) => row.revision_number)).toEqual([1, 2]);
    await expect(execute("UPDATE entity_reference_revisions SET new_state='{}'")).rejects.toThrow(
      /REQUIRES_NATIVE_COMMAND/
    );
    expect(
      state
        .db!.prepare(
          'SELECT revision_number FROM entity_reference_revisions ORDER BY revision_number'
        )
        .all()
    ).toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
  });
});
