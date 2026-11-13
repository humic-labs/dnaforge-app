import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../platform/types';
import type { DBEntityReference } from '../db/entity-references';
import type { OpenDocumentRequest } from '../features/document-opening/types';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: null as (EventEmitter & { id: number }) | null,
  platform: vi.fn(),
  open: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = state.handlers.get(channel);
      if (!handler) throw new Error(`Missing native handler: ${channel}`);
      return handler({ sender: state.sender }, ...args);
    },
  },
  app: { getPath: () => '/tmp/dnaforge-test-app-data', getVersion: () => 'test', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../platform', () => ({ platform: state.platform }));
vi.mock('../features/document-opening/open-document', () => ({ openDocument: state.open }));

import { createFileTestDb } from '../main/__tests__/test-db';
import { createLimsBridgeForDb } from '../main/__tests__/lims-bridge-for-db';
import { ensureSchema } from '../main/schema';
import { registerDatabaseHandlers } from '../main/ipc/database';
import { createClient } from '../shared/ipc-contract';
import { dbContract } from '../shared/ipc/db.contract';
import { prepareEntityReferenceRow } from '../shared/entity-reference-ipc';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { ENTITY_ARTIFACT_SCHEMA, serializeEntityArtifact } from '../shared/entity-artifact';
import { buildInlineProteinSequenceRef } from '../features/lims/protein-sequence';
import { createCreateReferenceTool } from '../features/ai/tools/create-reference';
import { createGetEntityLinkTool } from '../features/ai/tools/entity-link';
import { execTool } from '../features/ai/tools/test-helpers';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useCanvasStore } from '../features/canvas/store';
import { openEntityNavigationTarget, referenceNavigationLinks } from './entity-navigation';

let fixture: ReturnType<typeof createFileTestDb>;
let client: PlatformBridge['db'];
let root: string;
let path: string;
let entityId: string;
let projectId: string;
async function createReference() {
  return execTool<{
    referenceId: string;
    target: { entityId: string; projectId: string; referenceId: string };
    error?: string;
  }>(createCreateReferenceTool([{ name: 'Project', path: root, addedAt: 1 }]), {
    entityType: 'protein',
    filePath: path,
    displayLabel: 'Protein',
    deepLinkParams: { start: 2, end: 3 },
  });
}
async function getLink(referenceId: string, id = entityId, workspace = root) {
  return execTool<{
    ok: boolean;
    error?: string;
    target: { entityId: string; projectId: string; referenceId: string };
  }>(createGetEntityLinkTool(useWorkspaceStore.getState().folders), {
    entityId: id,
    workspace,
    referenceId,
  });
}
function saved(id: string) {
  return fixture.db
    .prepare('SELECT * FROM entity_references WHERE id=?')
    .get(id) as DBEntityReference;
}
beforeEach(async () => {
  fixture = createFileTestDb('native-protein-reference');
  mkdirSync(join(fixture.tmpDir, 'Project'));
  root = realpathSync(join(fixture.tmpDir, 'Project'));
  path = join(root, 'Legacy.faa');
  writeFileSync(path, '>Legacy\nMKTW\n');
  ensureSchema(fixture.db, fixture.dbPath);
  state.handlers.clear();
  state.sender = Object.assign(new EventEmitter(), { id: 366181 });
  registerDatabaseHandlers(() => fixture.db);
  client = {
    ...createClient(dbContract),
    select: async <T>(sql: string, params: unknown[] = []): Promise<T> => {
      const handler = state.handlers.get('db:select');
      if (!handler) throw new Error('Missing native select handler');
      return (await handler({ sender: state.sender }, sql, params)) as T;
    },
  };
  state.platform.mockReturnValue({
    db: client,
    entityNavigation: { getScheme: async () => 'dnaforge-dev' },
    fs: {
      exists: async (source: string) => existsSync(source),
      readTextFile: async (source: string) => readFileSync(source, 'utf8'),
      readTextFileSlice: async (source: string, limit: number) => {
        const text = readFileSync(source, 'utf8').slice(0, limit);
        return { text, bytesRead: text.length };
      },
    },
  });
  const owner = await client.ensureWorkspaceOwner(root);
  projectId = workspaceScopeKey(null, owner)!;
  const entity = await client.registerWorkspaceFile({
    path,
    workspaceRoot: root,
    entityType: 'sequence',
    fileKind: 'fasta',
  });
  entityId = entity.id;
  const inspected = await client.getFastaKindAuthority({ path, workspaceRoot: root });
  await client.classifyFasta({
    path,
    workspaceRoot: root,
    kind: 'protein',
    expectedRevision: inspected.revision,
  });
  useWorkspaceStore.setState({
    folders: [{ name: 'Project', path: root, addedAt: 1 }],
    activeWorkspaceFile: null,
  });
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
  state.open.mockReset().mockImplementation(async (request: OpenDocumentRequest) => {
    const source =
      request.target.kind === 'file'
        ? request.target.path
        : request.target.kind === 'record'
          ? request.target.entityId
          : 'unsupported';
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'protein-view',
              type: 'protein',
              entityId: source,
              label: request.label ?? 'Protein',
            },
          ],
          activeTabId: 'protein-view',
        },
      },
    });
    return {
      status: 'presented',
      panelId: 'main',
      tabId: 'protein-view',
      tabType: 'protein',
      content: 'loading',
      disposition: 'created',
    };
  });
});
afterEach(() => {
  state.sender?.removeAllListeners();
  useWorkspaceStore.setState({ folders: [], activeWorkspaceFile: null });
  state.platform.mockReset();
  fixture.cleanup();
});

describe('file-backed protein saved reference identity', () => {
  it('uses one native stable target for create_reference, the persisted row and get_entity_link', async () => {
    const result = await createReference();
    expect(result.error).toBeUndefined();
    expect(result.target.entityId).toBe(entityId);
    expect(result.referenceId).not.toBe(entityId);
    const reference = saved(result.referenceId);
    expect(JSON.parse(reference.data!)).toMatchObject({ documentId: entityId });
    expect(reference.workspace_root_path).toBe(root);
    expect(JSON.parse(reference.deep_link_params!)).toEqual({ start: 2, end: 3 });
    expect(await getLink(reference.id)).toMatchObject({
      ok: true,
      target: { entityId, projectId, referenceId: reference.id },
    });
    expect(await referenceNavigationLinks(reference)).toMatchObject({ target: result.target });
  });

  it('retains the canonical identity of a non-FASTA protein record through the same native file owner', async () => {
    path = join(root, 'Protein.entity.json');
    entityId = 'native-protein-record';
    const fields = { sequence: await buildInlineProteinSequenceRef('MKTW') };
    const owner = await client.ensureWorkspaceOwner(root);
    const lims = createLimsBridgeForDb(fixture.db);
    state.platform.mockReturnValue({ ...state.platform(), lims });
    const protein = await lims.registerEntity({
      id: entityId,
      kind: 'protein',
      name: 'Protein record',
      fields: {
        ...fields,
        artifact: { schema: 'waypoint.entity.v2', relativePath: 'Protein.entity.json' },
      },
      workspaceId: owner,
      actor: 'user',
    });
    writeFileSync(
      path,
      serializeEntityArtifact({
        schema: ENTITY_ARTIFACT_SCHEMA,
        id: entityId,
        kind: 'protein',
        name: protein.name,
        fields,
        registrationStatus: protein.registrationStatus,
        domainStatus: protein.domainStatus,
        relationships: [],
        source: { type: 'manual', values: {} },
      })
    );
    await client.registerCatalogEntity({
      id: entityId,
      type: 'record',
      name: protein.name,
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    await client.bindCatalogEntityFile({
      entityId,
      path,
      workspaceRoot: root,
      fileKind: 'waypoint-entity',
    });
    const result = await createReference();
    expect(result.error).toBeUndefined();
    expect(result.target.entityId).toBe(entityId);
    expect(JSON.parse(saved(result.referenceId).data!)).toMatchObject({ documentId: entityId });
    expect(await getLink(result.referenceId)).toMatchObject({ ok: true, target: result.target });
    await openEntityNavigationTarget(result.target);
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'record', tabType: 'record', entityId },
      })
    );
  });

  it('preserves the explicit historical identity for a file with no native canonical target', async () => {
    path = join(root, 'Historical protein.txt');
    writeFileSync(path, 'MKTW');
    const result = await createReference();
    expect(result.error).toBeUndefined();
    expect(result.target.entityId).toBe(result.referenceId);
    expect(saved(result.referenceId).data).toBeNull();
    expect(fixture.db.prepare('SELECT * FROM catalog_entity_files WHERE path=?').all(path)).toEqual(
      []
    );
  });

  it('opens the current native binding after a real move while preserving the saved identity and selection', async () => {
    const reference = await client.createEntityReference(
      prepareEntityReferenceRow({
        entityType: 'protein',
        displayLabel: 'Protein selection',
        locator: 'git://Project/Legacy.faa',
        data: { documentId: entityId },
        deepLinkParams: { start: 2, end: 3 },
        source: 'user',
        workspaceScope: projectId,
        workspaceRootPath: root,
      })
    );
    const original = saved(reference.id);
    const moved = join(root, 'Protein moved.faa');
    renameSync(path, moved);
    await client.rebindCatalogFiles({ oldPath: path, newPath: moved, workspaceRoot: root });
    writeFileSync(path, '>Replacement\nAAAA\n');
    const replacement = await client.registerWorkspaceFile({
      path,
      workspaceRoot: root,
      entityType: 'protein',
      fileKind: 'fasta',
    });
    expect(replacement.id).not.toBe(entityId);
    expect(await getLink(reference.id)).toMatchObject({
      ok: true,
      target: { entityId, referenceId: reference.id },
    });
    await openEntityNavigationTarget({ entityId, projectId, referenceId: reference.id });
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'file', path: moved, tabType: 'protein' } })
    );
    expect(useCanvasStore.getState().panels.main.tabs[0].viewState).toEqual({ start: 2, end: 3 });
    expect(saved(reference.id)).toEqual(original);
    expect((await getLink(reference.id, replacement.id)).ok).toBe(false);
  });

  it('refuses a forged stable target rather than trusting data on an otherwise valid file locator', async () => {
    await expect(
      client.createEntityReference(
        prepareEntityReferenceRow({
          entityType: 'protein',
          displayLabel: 'Wrong target',
          locator: 'git://Project/Legacy.faa',
          data: { documentId: 'another-protein' },
          deepLinkParams: null,
          source: 'user',
          workspaceScope: projectId,
          workspaceRootPath: root,
        })
      )
    ).rejects.toThrow(/target|identity/);
    expect(fixture.db.prepare('SELECT * FROM entity_references').all()).toEqual([]);
  });

  it('refuses a mismatched owning project and a later conflicting native kind without opening', async () => {
    const result = await createReference();
    const other = join(fixture.tmpDir, 'Other');
    mkdirSync(other);
    await client.ensureWorkspaceOwner(other);
    useWorkspaceStore.setState({
      folders: [
        { name: 'Project', path: root, addedAt: 1 },
        { name: 'Other', path: other, addedAt: 1 },
      ],
    });
    expect(await getLink(result.referenceId, entityId, other)).toMatchObject({ ok: false });
    const inspected = await client.getFastaKindAuthority({ path, workspaceRoot: root });
    await client.classifyFasta({
      path,
      workspaceRoot: root,
      kind: 'sequence',
      expectedRevision: inspected.revision,
    });
    expect(await getLink(result.referenceId)).toMatchObject({ ok: false });
    expect(state.open).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('>Legacy\nMKTW\n');
  });
});
