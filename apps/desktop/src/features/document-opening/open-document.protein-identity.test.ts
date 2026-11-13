import { mkdirSync, realpathSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { ensureWorkspaceOwnerInDb } from '../../main/catalog-projection-commands';
import {
  registerCatalogEntityInDb,
  registerWorkspaceFileInDb,
} from '../../main/catalog-entity-registration';
import {
  getFastaKindAuthorityInMain,
  getFastaKindReadAuthorityInDb,
  classifyFastaInMain,
} from '../../main/fasta-kind-authority';
import { bindCatalogEntityFileInDb } from '../../main/catalog-file-binding';
import { openDocument, resolveFileDocumentKindFromSource } from './open-document';
import { getTabTypeForFile } from '../../utils/fileTypes';
import { resolveExactNativeCatalogDestination } from '../../services/native-catalog-destination';
import { openSelectedDocument } from './open-selected-document';
import { useCanvasStore } from '../canvas/public/store';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  afterRead: null as ((sql: string) => void) | null,
  sequence: vi.fn(),
  session: vi.fn(),
  bind: vi.fn(),
  close: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      stat: async (path: string) => {
        const source = statSync(path);
        return { isFile: source.isFile(), isDirectory: source.isDirectory() };
      },
    },
    db: {
      getFastaKindReadAuthority: (input: Parameters<typeof getFastaKindReadAuthorityInDb>[1]) =>
        getFastaKindReadAuthorityInDb(state.db!, input),
      select: async (sql: string, parameters: unknown[] = []) => {
        const rows = state.db!.prepare(sql).all(...parameters);
        state.afterRead?.(sql);
        return rows;
      },
    },
  }),
}));
vi.mock('../../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
  isDesktopRuntime: () => true,
  isElectron: () => true,
}));
vi.mock('../sequence/openSequenceFile', () => ({ openSequenceFileResult: state.sequence }));
vi.mock('../workspace-session/public/electron-session', () => ({
  openElectronWorkspaceSessionFile: state.session,
  bindElectronWorkspaceSessionTab: state.bind,
  closeElectronWorkspaceSessionFile: state.close,
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: state.toast }) },
}));

let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
let path: string;
let workspaceId: number;
const id = 'protein-project::manifest-protein';

beforeEach(() => {
  vi.clearAllMocks();
  state.afterRead = null;
  fixture = createFileTestDb('protein-open-identity');
  state.db = fixture.db;
  ensureSchema(state.db, fixture.dbPath);
  root = join(realpathSync(fixture.tmpDir), 'workspace');
  mkdirSync(root);
  path = join(root, 'Ambiguous.fasta');
  writeFileSync(path, '>Ambiguous\nMKQL\n');
  workspaceId = ensureWorkspaceOwnerInDb(state.db, root);
  state.db
    .prepare('UPDATE workspaces SET repo_uuid=? WHERE id=?')
    .run('protein-project', workspaceId);
  registerCatalogEntityInDb(state.db, {
    id,
    type: 'protein',
    name: 'Ambiguous protein',
    locator: `file://${path}`,
    storageType: 'file',
    workspaceRoot: root,
  });
  bindCatalogEntityFileInDb(state.db, {
    entityId: id,
    path,
    fileKind: 'fasta',
    workspaceRoot: root,
  });
  state.sequence.mockResolvedValue({ status: 'blocked', message: 'sequence-handler-reached' });
  state.session.mockResolvedValue('Ambiguous.fasta');
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
});
afterEach(() => fixture.cleanup());

describe('checked native protein file opening', () => {
  it('uses the exact native protein identity before an ambiguous FASTA extension', async () => {
    const result = await openDocument({
      target: { kind: 'file', path, tabType: 'sequence' },
      source: 'file_tree',
    });
    expect(result).toMatchObject({ status: 'presented', tabType: 'protein' });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([
      expect.objectContaining({ type: 'protein', entityId: path }),
    ]);
    expect(state.sequence).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'sequence' as const, name: 'Canonical DNA.faa', bases: 'ACGTACGT' },
    { type: 'protein' as const, name: 'Canonical protein.fna', bases: 'MKQL' },
  ])(
    'follows native $type ownership for $name admitted by actual native registration',
    async (source) => {
      const sourcePath = join(root, source.name);
      const entityId = `protein-project::counterexample-${source.type}`;
      writeFileSync(sourcePath, `>${source.name}\n${source.bases}\n`);
      const native = registerCatalogEntityInDb(state.db!, {
        id: entityId,
        type: source.type,
        name: source.name,
        locator: `file://${sourcePath}`,
        storageType: 'file',
        workspaceRoot: root,
      });
      const binding = bindCatalogEntityFileInDb(state.db!, {
        entityId,
        path: sourcePath,
        fileKind: 'fasta',
        workspaceRoot: root,
      });
      expect(native).toMatchObject({ id: entityId, type: source.type, workspace_id: workspaceId });
      expect(binding).toMatchObject({
        entity_id: entityId,
        path: sourcePath,
        file_kind: 'fasta',
        workspace_id: workspaceId,
        status: 'current',
      });
      expect(
        await resolveExactNativeCatalogDestination({ workspaceRoot: root, entityId })
      ).toMatchObject({
        source: 'native_catalog',
        entityId,
        entityType: source.type,
        locator: { kind: 'workspace_path', absolutePath: sourcePath, tabType: source.type },
      });
      const hint = getTabTypeForFile(sourcePath);
      expect(
        await resolveFileDocumentKindFromSource({ kind: 'file', path: sourcePath, tabType: hint })
      ).toBe(source.type);
      const result = await openSelectedDocument(sourcePath, hint);
      if (source.type === 'sequence') {
        expect(result).toMatchObject({ status: 'blocked', message: 'sequence-handler-reached' });
        expect(state.session).toHaveBeenCalledWith(sourcePath);
        expect(state.sequence).toHaveBeenCalledWith(
          expect.objectContaining({ filePath: sourcePath })
        );
      } else {
        expect(result).toMatchObject({ status: 'presented', tabType: 'protein' });
        expect(state.session).not.toHaveBeenCalled();
        expect(state.sequence).not.toHaveBeenCalled();
      }
    }
  );

  it('keeps a faithful historical FAA readable without confusing identical refresh metadata with a native declaration', async () => {
    const legacyPath = join(root, 'Legacy.faa');
    const dnaPath = join(root, 'DNA.faa');
    writeFileSync(legacyPath, '>Legacy\nMKTW\n');
    writeFileSync(dnaPath, '>DNA\nACGTACGT\n');
    const metadata = { discoveredFrom: 'git-head', refreshed: true };
    const originalBytes = [readFileSync(legacyPath, 'utf8'), readFileSync(dnaPath, 'utf8')];
    const legacy = registerWorkspaceFileInDb(state.db!, {
      path: legacyPath,
      workspaceRoot: root,
      entityType: 'sequence',
      fileKind: 'fasta',
      metadata,
    });
    const dna = registerCatalogEntityInDb(state.db!, {
      id: 'protein-project::declared-dna',
      type: 'sequence',
      name: 'DNA',
      locator: `file://${dnaPath}`,
      storageType: 'file',
      workspaceRoot: root,
      metadata,
    });
    const dnaBinding = bindCatalogEntityFileInDb(state.db!, {
      entityId: dna.id,
      path: dnaPath,
      fileKind: 'fasta',
      workspaceRoot: root,
    });
    const legacyBinding = state
      .db!.prepare('SELECT * FROM catalog_entity_files WHERE entity_id=?')
      .get(legacy.id) as { object_uuid: string };
    for (let refresh = 0; refresh < 2; refresh++) {
      for (const sourcePath of [legacyPath, dnaPath])
        registerWorkspaceFileInDb(state.db!, {
          path: sourcePath,
          workspaceRoot: root,
          entityType: 'sequence',
          fileKind: 'fasta',
          metadata,
        });
      for (const [entityId, sourcePath] of [
        [legacy.id, legacyPath],
        [dna.id, dnaPath],
      ])
        registerCatalogEntityInDb(state.db!, {
          id: entityId,
          type: 'sequence',
          name: 'Refreshed FASTA',
          locator: `file://${sourcePath}`,
          storageType: 'file',
          workspaceRoot: root,
          metadata,
        });
      expect(
        state.db!.prepare('SELECT metadata FROM catalog_entities WHERE id=?').get(legacy.id)
      ).toEqual(state.db!.prepare('SELECT metadata FROM catalog_entities WHERE id=?').get(dna.id));
      expect(
        state.db!.prepare('SELECT type FROM catalog_entities WHERE id=?').get(legacy.id)
      ).toEqual({ type: 'sequence' });
      const destination = await resolveExactNativeCatalogDestination({
        workspaceRoot: root,
        entityId: legacy.id,
      });
      expect(destination).toMatchObject({
        entityId: legacy.id,
        entityType: 'file',
        locator: {
          kind: 'legacy_fasta',
          absolutePath: legacyPath,
          authority: {
            status: 'needs-classification',
            storedKind: 'sequence',
            legacyReadView: 'protein',
            readOnly: true,
          },
        },
      });
      expect(
        await resolveExactNativeCatalogDestination({ workspaceRoot: root, entityId: dna.id })
      ).toMatchObject({
        entityType: 'sequence',
        locator: { kind: 'workspace_path', absolutePath: dnaPath, tabType: 'sequence' },
      });
      expect(await openSelectedDocument(legacyPath, 'sequence')).toMatchObject({
        status: 'presented',
        tabType: 'protein',
      });
      expect(
        useCanvasStore.getState().panels.main.tabs.find((tab) => tab.entityId === legacyPath)
      ).toMatchObject({
        readOnly: true,
        legacyFasta: {
          status: 'needs-classification',
          entityId: legacy.id,
          legacyReadView: 'protein',
        },
      });
      expect(state.session).not.toHaveBeenCalled();
      expect(state.sequence).not.toHaveBeenCalled();
      useCanvasStore.setState({ panels: { main: { id: 'main', tabs: [], activeTabId: null } } });
    }
    expect([readFileSync(legacyPath, 'utf8'), readFileSync(dnaPath, 'utf8')]).toEqual(
      originalBytes
    );
    const inspection = await getFastaKindAuthorityInMain(state.db!, {
      path: legacyPath,
      workspaceRoot: root,
    });
    expect(
      await classifyFastaInMain(state.db!, {
        path: legacyPath,
        workspaceRoot: root,
        kind: 'protein',
        expectedRevision: inspection.revision,
      })
    ).toMatchObject({
      status: 'declared',
      kind: 'protein',
      entityId: legacy.id,
      objectUuid: legacyBinding.object_uuid,
    });
    expect(
      await resolveExactNativeCatalogDestination({ workspaceRoot: root, entityId: legacy.id })
    ).toMatchObject({
      entityType: 'protein',
      locator: { kind: 'workspace_path', tabType: 'protein' },
    });
    expect(await openSelectedDocument(legacyPath, 'sequence')).toMatchObject({
      status: 'presented',
      tabType: 'protein',
    });
    expect(
      useCanvasStore.getState().panels.main.tabs.find((tab) => tab.entityId === legacyPath)
        ?.legacyFasta
    ).toBeUndefined();

    expect([readFileSync(legacyPath, 'utf8'), readFileSync(dnaPath, 'utf8')]).toEqual(
      originalBytes
    );
    expect(
      state
        .db!.prepare('SELECT object_uuid FROM catalog_entity_files WHERE entity_id=?')
        .get(dna.id)
    ).toEqual({ object_uuid: dnaBinding.object_uuid });
  });

  it('keeps a nonconflicting legacy DNA source on its readonly sequence reader without declaring its kind', async () => {
    const sourcePath = join(root, 'Legacy.fna');
    writeFileSync(sourcePath, '>Legacy DNA\nACGTACGT\n');
    const entity = registerWorkspaceFileInDb(state.db!, {
      path: sourcePath,
      workspaceRoot: root,
      entityType: 'sequence',
      fileKind: 'fasta',
    });
    expect(
      await resolveExactNativeCatalogDestination({ workspaceRoot: root, entityId: entity.id })
    ).toMatchObject({
      entityType: 'file',
      locator: {
        kind: 'legacy_fasta',
        authority: { status: 'legacy-compatible', legacyReadView: 'sequence', readOnly: true },
      },
    });
    expect(await openSelectedDocument(sourcePath, 'sequence')).toMatchObject({
      status: 'blocked',
      message: 'sequence-handler-reached',
    });
    expect(state.sequence).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: sourcePath, readOnly: true })
    );
    expect(state.session).not.toHaveBeenCalled();
    expect(
      getFastaKindReadAuthorityInDb(state.db!, { path: sourcePath, workspaceRoot: root })
    ).not.toHaveProperty('kind');
  });

  it('uses the native kind before acquiring a DNA workspace session for the Files gesture', async () => {
    expect(await openSelectedDocument(path, 'sequence')).toMatchObject({
      status: 'presented',
      tabType: 'protein',
    });
    expect(state.session).not.toHaveBeenCalled();
    expect(state.sequence).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });
  it('does not let a caller protein hint override a native DNA identity', async () => {
    const dnaPath = join(root, 'Declared.fasta');
    writeFileSync(dnaPath, '>Declared\nACGTACGT\n');
    const dna = registerCatalogEntityInDb(state.db!, {
      id: 'protein-project::declared-dna-hint',
      type: 'sequence',
      name: 'Declared',
      locator: `file://${dnaPath}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(state.db!, {
      entityId: dna.id,
      path: dnaPath,
      fileKind: 'fasta',
      workspaceRoot: root,
    });
    expect(await openSelectedDocument(dnaPath, 'protein')).toMatchObject({
      status: 'blocked',
      message: 'sequence-handler-reached',
    });
    expect(state.session).toHaveBeenCalledWith(dnaPath);
    expect(state.sequence).toHaveBeenCalledWith(expect.objectContaining({ filePath: dnaPath }));
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });
  it('keeps the filename fallback for an uncataloged loose FASTA source', async () => {
    state.db!.prepare('DELETE FROM catalog_entity_files').run();
    state.db!.prepare('DELETE FROM catalog_entities').run();
    expect(
      await openDocument({ target: { kind: 'file', path, tabType: 'protein' } })
    ).toMatchObject({ status: 'blocked', message: 'sequence-handler-reached' });
    expect(state.sequence).toHaveBeenCalledWith(expect.objectContaining({ filePath: path }));
  });
  it('keeps a genuinely unbound legacy protein file on its filename read route', async () => {
    const sourcePath = join(realpathSync(fixture.tmpDir), 'Unbound.faa');
    writeFileSync(sourcePath, '>Unbound\nMKTW\n');
    registerCatalogEntityInDb(state.db!, {
      id: 'unbound-protein',
      type: 'protein',
      name: 'Unbound',
      locator: `file://${sourcePath}`,
      storageType: 'file',
    });
    const binding = bindCatalogEntityFileInDb(state.db!, {
      entityId: 'unbound-protein',
      path: sourcePath,
      fileKind: 'fasta',
    });
    expect(binding.workspace_id).toBeNull();
    expect(await openDocument({ target: { kind: 'file', path: sourcePath } })).toMatchObject({
      status: 'presented',
      tabType: 'protein',
    });
    expect(state.sequence).not.toHaveBeenCalled();
  });

  it.each(['owner', 'inactive', 'missing', 'kind', 'retargeted'] as const)(
    'refuses a protein source with a changed %s binding',
    async (change) => {
      if (change === 'owner') {
        const other = join(realpathSync(fixture.tmpDir), 'other');
        mkdirSync(other);
        const otherId = ensureWorkspaceOwnerInDb(state.db!, other);
        state
          .db!.prepare('UPDATE catalog_entity_files SET workspace_id=? WHERE entity_id=?')
          .run(otherId, id);
      }
      if (change === 'inactive')
        state.db!.prepare('UPDATE workspaces SET trashed_at=1 WHERE id=?').run(workspaceId);
      if (change === 'missing')
        state
          .db!.prepare("UPDATE catalog_entity_files SET status='missing' WHERE entity_id=?")
          .run(id);
      if (change === 'kind')
        state
          .db!.prepare("UPDATE catalog_entity_files SET file_kind='genbank' WHERE entity_id=?")
          .run(id);
      if (change === 'retargeted')
        state.afterRead = (sql) => {
          if (!sql.includes('catalog_entity_files WHERE path = ?')) return;
          state.afterRead = null;
          state
            .db!.prepare('UPDATE catalog_entity_files SET path=?,relative_path=? WHERE entity_id=?')
            .run(join(root, 'Other.fasta'), 'Other.fasta', id);
        };
      const result = await openDocument({
        target: { kind: 'file', path, tabType: 'protein' },
      });
      expect(result).toMatchObject({ status: 'failed' });
      expect(state.sequence).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
    }
  );
});
