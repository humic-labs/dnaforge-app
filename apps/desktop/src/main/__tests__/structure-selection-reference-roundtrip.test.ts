// @vitest-environment jsdom
import type Database from 'better-sqlite3';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatEntityReferenceIpcRow } from '../../shared/chat-turn-ipc';

const native = vi.hoisted(() => ({
  db: null as Database.Database | null,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test', exit: vi.fn() },
}));
vi.mock('../ipc/database', () => ({ getDb: () => native.db }));
vi.mock('../../db/index', () => ({
  getConnection: () => ({
    createEntityReference: async (row: ChatEntityReferenceIpcRow) =>
      createEntityReferenceInDb(native.db!, row),
    select: async (sql: string, params: unknown[] = []) => native.db!.prepare(sql).all(...params),
  }),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, params: unknown[] = []) => native.db!.prepare(sql).all(...params),
    },
    entityNavigation: { getScheme: async () => 'dnaforge-dev' },
  }),
}));
vi.mock('../../features/ai/hooks/useChat', () => ({
  useChatStore: {
    getState: () => {
      throw new Error('Reference persistence must not start chat transport.');
    },
  },
}));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { createEntityReferenceInDb } from '../entity-reference-commands';
import { ensureWorkspaceOwnerInDb } from '../catalog-projection-commands';
import { createAskAiSelectionReference } from '../../features/ai/ask-ai-about-selection';
import { createCreateReferenceTool } from '../../features/ai/tools/create-reference';
import { execTool } from '../../features/ai/tools/test-helpers';
import { getEntityReference } from '../../db/entity-references';
import { resolveMolecularReference } from '../../shared/molecular-reference';
import { resolveEntityNavigationTarget } from '../../services/entity-navigation';
import { resolveReference } from '../../features/ai/references/resolver';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { workspaceScopeKey } from '../../shared/workspace-scoped-identity';

let root = '';
let projectId = '';
const structureId = 'data:3oaa';
const residues = [
  { chain: 'A', authAsymId: 'A', position: 57, labelCompId: 'GLY' },
  { chain: 'A', authAsymId: 'A', position: 102, labelCompId: 'GLY' },
  { chain: 'A', authAsymId: 'A', position: 195, labelCompId: 'TYR' },
];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-structure-selection-reference-')));
  native.db = createTestDb();
  ensureSchema(native.db, ':memory:');
  const workspaceId = ensureWorkspaceOwnerInDb(native.db, root);
  projectId = workspaceScopeKey(null, workspaceId)!;
  useWorkspaceStore.setState({ folders: [{ path: root, name: 'Structure project', addedAt: 1 }] });
});

afterEach(async () => {
  native.db?.close();
  await rm(root, { recursive: true, force: true });
});

it('persists the real staged structure producer through the native owner and reuses its exact selection without a live viewer', async () => {
  const staged = await createAskAiSelectionReference({
    entityType: 'structure',
    displayLabel: '3OAA A57/A102/A195',
    locator: structureId,
    workspaceRootPath: root,
    structure: { residues, visibleRepresentations: [] },
    deepLinkParams: {
      highlightGroups: [
        {
          id: 'selected-residues',
          label: 'Exact residues',
          selections: [
            {
              chain: 'A',
              ranges: [
                [57, 57],
                [102, 102],
                [195, 195],
              ],
            },
          ],
        },
      ],
    },
  });
  expect(staged.locator).toBe(`entity://structure/${structureId}`);
  expect(JSON.parse(staged.data!)).toMatchObject({
    locator: { path: structureId },
    measured: {
      structureRef: structureId,
      residueCount: 3,
      residueIdentityKnownCount: 3,
      residueIdentityUnknownCount: 0,
    },
  });
  const persisted = await getEntityReference(staged.id);
  expect(persisted).toEqual(staged);
  expect(native.db!.prepare('SELECT * FROM entity_references').all()).toEqual([staged]);
  const getStructureContext = vi.fn().mockRejectedValue(new Error('MolStar is not mounted'));
  const tool = createCreateReferenceTool([{ path: root, name: 'Structure project', addedAt: 1 }], {
    getStructureContext,
  });
  const result = await execTool<{ referenceId: string | null; reused?: boolean; error?: string }>(
    tool,
    {
      entityType: 'structure',
      displayLabel: 'Exact selection',
      locator: staged.locator,
      data: {},
      deepLinkParams: {},
      selection: { kind: 'existing_reference', referenceId: staged.id },
    }
  );
  expect(result).toMatchObject({ referenceId: staged.id, reused: true });
  expect(result.error).toBeUndefined();
  expect(getStructureContext).not.toHaveBeenCalled();
  const resolved = await resolveEntityNavigationTarget({
    entityId: structureId,
    projectId,
    referenceId: staged.id,
  });
  expect(resolved).toEqual({ kind: 'reference', reference: staged });
  expect(resolveMolecularReference(staged)).toMatchObject({
    kind: 'selection',
    descriptor: { measured: { structureRef: structureId } },
  });
  expect(resolveMolecularReference({ ...staged, locator: structureId })).toMatchObject({
    kind: 'selection',
    descriptor: { measured: { structureRef: structureId } },
  });
  expect(resolveReference(staged)).toMatchObject({
    tabType: 'structure',
    entityId: structureId,
    viewState: {
      highlightGroups: [
        {
          renderMode: 'selection',
          selections: [
            {
              chain: 'A',
              ranges: [
                [57, 57],
                [102, 102],
                [195, 195],
              ],
            },
          ],
        },
      ],
    },
  });
  await expect(
    Promise.resolve().then(() =>
      createEntityReferenceInDb(native.db!, {
        ...staged,
        id: crypto.randomUUID(),
        locator: 'entity://sequence/not-the-structure',
      })
    )
  ).rejects.toThrow('The molecular reference type disagrees with its route');
  expect(native.db!.prepare('SELECT * FROM entity_references').all()).toEqual([staged]);
});

async function stagedStructureSelection() {
  return createAskAiSelectionReference({
    entityType: 'structure',
    displayLabel: '3OAA exact selection',
    locator: structureId,
    workspaceRootPath: root,
    structure: { residues, visibleRepresentations: [] },
    deepLinkParams: { highlightGroups: [] },
  });
}

it('refuses a canonical structure locator naming another source before native insertion', async () => {
  const staged = await stagedStructureSelection();
  const rows = native.db!.prepare('SELECT * FROM entity_references').all();
  expect(() =>
    createEntityReferenceInDb(native.db!, {
      ...staged,
      id: crypto.randomUUID(),
      locator: 'entity://structure/data:another-structure',
    })
  ).toThrow(/structure selection.*source/i);
  expect(native.db!.prepare('SELECT * FROM entity_references').all()).toEqual(rows);
});

it('refuses to reuse a retained structure selection whose canonical locator names another source', async () => {
  const staged = await stagedStructureSelection();
  const historical = {
    ...staged,
    id: crypto.randomUUID(),
    locator: 'entity://structure/data:another-structure',
  };
  native
    .db!.prepare(
      `INSERT INTO entity_references (
    id,entity_type,display_label,locator,deep_link_params,data,source,status,
    workspace_scope,workspace_root_path,created_at,updated_at
  ) VALUES (
    @id,@entity_type,@display_label,@locator,@deep_link_params,@data,@source,@status,
    @workspace_scope,@workspace_root_path,@created_at,@updated_at
  )`
    )
    .run(historical);
  const rows = native.db!.prepare('SELECT * FROM entity_references').all();
  const tool = createCreateReferenceTool([{ path: root, name: 'Structure project', addedAt: 1 }]);
  const result = await execTool<{ referenceId: string | null; reused?: boolean; error?: string }>(
    tool,
    {
      entityType: 'structure',
      displayLabel: 'Conflicting selection',
      locator: historical.locator,
      data: {},
      deepLinkParams: {},
      selection: { kind: 'existing_reference', referenceId: historical.id },
    }
  );
  expect(result).toMatchObject({
    referenceId: null,
    error: expect.stringMatching(/identity-complete/),
  });
  expect(result.reused).not.toBe(true);
  expect(native.db!.prepare('SELECT * FROM entity_references').all()).toEqual(rows);
});
