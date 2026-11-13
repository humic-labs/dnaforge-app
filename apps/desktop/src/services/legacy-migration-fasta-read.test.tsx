/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  truncateSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createFileTestDb } from '../main/__tests__/test-db';
import { ensureSchema } from '../main/schema';
import { ensureWorkspaceOwnerInDb } from '../main/catalog-projection-commands';
import { readFileBoundedFromHandle } from '../main/ipc/bounded-file-read';
import { validateWorkspacePathInMain } from '../main/primer-artifact-files';
import {
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  serializeNativeWorkspaceManifest,
} from '../shared/native-workspace-manifest';
import {
  registerCatalogEntityInDb,
  registerWorkspaceFileInDb,
} from '../main/catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../main/catalog-file-binding';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { fileBackedTabPath } from '../features/canvas/oversize-scan';
import { getFastaKindReadAuthorityInDb } from '../main/fasta-kind-authority';
import { buildMigrationDestinationLinkIndexWriterPayload } from '../shared/benchling-migration-destination-index';
import { openDocument } from '../features/document-opening/open-document';
import {
  ENTITY_REFERENCE_ROUTES,
  type ReferenceRouteContext,
} from '../features/page/entity-ref/entity-reference-routes';
import type { DocumentOpenResult } from '../features/canvas/public/document-presentation';
import { resolveTabWorkspacePath } from '../features/canvas/tab-menu-presentation';
import { useCanvasStore } from '../features/canvas/public/store';
import { LegacyMigrationFastaTab } from '../features/canvas/components/LegacyMigrationFastaTab';

const state = vi.hoisted(() => ({ db: null as Database.Database | null, write: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, parameters: unknown[] = []) =>
        state.db!.prepare(sql).all(...parameters),
      getFastaKindReadAuthority: (input: Parameters<typeof getFastaKindReadAuthorityInDb>[1]) =>
        getFastaKindReadAuthorityInDb(state.db!, input),
    },
    fs: {
      validateWorkspacePath: validateWorkspacePathInMain,
      readFileBounded: readFileBoundedFromHandle,
      readTextFileSlice: async (path: string, maxBytes: number) => {
        const bytes = await readFileBoundedFromHandle(path, maxBytes);
        return { text: new TextDecoder().decode(bytes), bytesRead: bytes.byteLength };
      },
      stat: async (path: string) => {
        const value = await stat(path);
        return {
          size: value.size,
          isFile: value.isFile(),
          isDirectory: value.isDirectory(),
          mtime: value.mtimeMs,
          ctime: value.ctimeMs,
        };
      },
    },
  }),
}));
vi.stubGlobal('navigator', { clipboard: { writeText: state.write } });
let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  fixture = createFileTestDb('legacy-migration-final-reader');
  state.db = fixture.db;
  ensureSchema(state.db, fixture.dbPath);
  root = join(realpathSync(fixture.tmpDir), 'workspace');
  mkdirSync(join(root, '.dnaforge/migration'), { recursive: true });
  ensureWorkspaceOwnerInDb(state.db, root);
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
});
afterEach(() => {
  cleanup();
  fixture.cleanup();
});
function writeSourceIndex(
  path: string,
  view: 'sequence' | 'protein',
  destinationId = 'legacy-record'
) {
  const payload = buildMigrationDestinationLinkIndexWriterPayload([
    {
      destinationObjectId: destinationId,
      sourceStableIds: ['legacy-alias'],
      title: 'Legacy source',
      locator: { kind: 'workspace_path', relativePath: path.slice(root.length + 1), tabType: view },
    },
  ]);
  writeFileSync(join(root, payload.relativePath), payload.text);
}

describe('migration FASTA final read role', () => {
  it.each([
    { view: 'protein' as const, file: 'protein.fna', bases: 'MKTW' },
    { view: 'sequence' as const, file: 'sequence.faa', bases: 'ACGTACGT' },
  ])(
    'retains the exact $view index role for $file through the opener and final native file reader',
    async ({ view, file, bases }) => {
      const path = join(root, file);
      writeFileSync(path, `>Legacy ${view}\n${bases}\n`);
      const index = buildMigrationDestinationLinkIndexWriterPayload([
        {
          destinationObjectId: `legacy-${view}`,
          sourceStableIds: [`benchling-${view}`],
          title: `Legacy ${view}`,
          locator: { kind: 'workspace_path', relativePath: file, tabType: view },
        },
      ]);
      const indexPath = join(root, index.relativePath);
      writeFileSync(indexPath, index.text);
      const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
      const before = hash();
      let result: DocumentOpenResult | undefined;
      const filenameFallback = vi.fn(async () => {
        throw new Error('The saved view was passed back through filename classification.');
      });
      const context: ReferenceRouteContext = {
        folders: [{ path: root }],
        signal: new AbortController().signal,
        handleViewChange: vi.fn(),
        current: () => true,
        refuse: (_intent, _reason, message) => {
          throw new Error(message);
        },
        documentResult: (_intent, value) => {
          result = value;
        },
        registry: vi.fn(),
        openSelected: filenameFallback,
        openContained: vi.fn(),
        claimPrimerRequest: () => () => true,
      };
      await ENTITY_REFERENCE_ROUTES['native-catalog'].beforeLocation(
        {
          detail: { entityType: 'native-catalog', entityId: `benchling-${view}`, owningRoot: root },
          intent: { finished: false, finish: vi.fn() },
          entityId: `benchling-${view}`,
          owningRoot: root,
          action: 'open',
        },
        context
      );
      expect(result).toMatchObject({ status: 'presented', tabType: 'file' });
      expect(filenameFallback).not.toHaveBeenCalled();
      const tab = useCanvasStore.getState().panels.main.tabs[0];
      expect(tab).toMatchObject({
        entityId: `legacy-${view}`,
        readOnly: true,
        legacyMigrationRead: {
          source: 'migration-index',
          destinationId: `legacy-${view}`,
          path,
          workspaceRoot: root,
          readView: view,
          readOnly: true,
        },
      });
      expect(fileBackedTabPath(tab)).toBe(path);
      expect(await resolveTabWorkspacePath('main', tab.id)).toBe(path);
      render(
        <LegacyMigrationFastaTab
          request={{ ...tab.legacyMigrationRead!, readOnly: false } as never}
        />
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('legacy-migration-fasta-read').getAttribute('data-read-view')
        ).toBe(view)
      );
      if (view === 'protein')
        expect(screen.getByTestId('protein-residue-track').textContent).toContain(bases);
      else expect(screen.getByTestId('legacy-migration-fasta-bases').textContent).toBe(bases);
      fireEvent.click(screen.getByRole('button', { name: 'Copy sequence' }));
      expect(state.write).toHaveBeenCalledWith(bases);
      expect(screen.queryByTestId('protein-edit-sequence')).toBeNull();
      expect(screen.queryByTestId('protein-menu-ask-ai')).toBeNull();
      expect(state.db!.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual({
        count: 0,
      });
      expect(state.db!.prepare('SELECT COUNT(*) AS count FROM sequences').get()).toEqual({
        count: 0,
      });
      expect(state.db!.prepare('SELECT COUNT(*) AS count FROM indexed_files').get()).toEqual({
        count: 0,
      });
      expect(hash()).toBe(before);
      expect(readFileSync(indexPath, 'utf8')).toBe(index.text);
    }
  );
  it('reads a legitimate native generic file owner through the independent legacy view without declaring a scientific kind', async () => {
    const path = join(root, 'protein.fna');
    writeFileSync(path, '>Generic file\nMKTW\n');
    writeSourceIndex(path, 'protein');
    mkdirSync(join(root, '.forge'), { recursive: true });
    const manifest = serializeNativeWorkspaceManifest({
      schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
      entities: [
        {
          id: 'generic-source',
          type: 'file',
          name: 'Generic source',
          placement: { kind: 'file', relativePath: 'protein.fna', fileKind: 'fasta' },
        },
      ],
      links: [],
    });
    writeFileSync(join(root, '.forge/catalog.json'), manifest);

    const entity = registerCatalogEntityInDb(state.db!, {
      id: 'ws1::generic-source',
      type: 'file',
      name: 'Generic source',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    const binding = bindCatalogEntityFileInDb(state.db!, {
      entityId: entity.id,
      path,
      fileKind: 'fasta',
      workspaceRoot: root,
    });
    for (let refresh = 0; refresh < 2; refresh++) {
      const discovered = registerWorkspaceFileInDb(state.db!, {
        path,
        workspaceRoot: root,
        entityType: 'sequence',
        fileKind: 'fasta',
        metadata: { discoveredFrom: 'filesystem' },
      });
      expect
        .soft(discovered)
        .toMatchObject({ id: entity.id, type: 'file', workspace_id: entity.workspace_id });
    }
    expect(
      await openDocument({
        target: { kind: 'legacy-migration-file', workspaceRoot: root, targetId: 'legacy-alias' },
      })
    ).toMatchObject({ status: 'presented', tabType: 'file' });
    const tab = useCanvasStore.getState().panels.main.tabs[0];
    expect(tab.entityId).toBe('legacy-record');
    expect(tab.entityId).not.toBe(entity.id);
    render(<LegacyMigrationFastaTab request={tab.legacyMigrationRead!} />);
    await waitFor(() =>
      expect(screen.getByTestId('protein-residue-track').textContent).toContain('MKTW')
    );
    expect(await resolveTabWorkspacePath('main', tab.id)).toBe(path);
    expect(
      state.db!.prepare('SELECT type FROM catalog_entities WHERE id=?').get(entity.id)
    ).toEqual({ type: 'file' });
    expect(
      state
        .db!.prepare('SELECT object_uuid FROM catalog_entity_files WHERE entity_id=?')
        .get(entity.id)
    ).toEqual({ object_uuid: binding.object_uuid });
    expect(
      state
        .db!.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events WHERE entity_id=?')
        .get(entity.id)
    ).toEqual({ count: 0 });
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM sequences').get()).toEqual({
      count: 0,
    });
    expect(screen.queryByTestId('protein-edit-sequence')).toBeNull();
    expect(screen.queryByTestId('protein-menu-ask-ai')).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('>Generic file\nMKTW\n');
    expect(readFileSync(join(root, '.forge/catalog.json'), 'utf8')).toBe(manifest);
  });

  it('refuses an index retarget between opening and the final reader', async () => {
    const path = join(root, 'protein.fna');
    writeFileSync(path, '>Original\nMKTW\n');
    writeSourceIndex(path, 'protein');
    expect(
      await openDocument({
        target: { kind: 'legacy-migration-file', workspaceRoot: root, targetId: 'legacy-alias' },
      })
    ).toMatchObject({ status: 'presented' });
    const tab = useCanvasStore.getState().panels.main.tabs[0];
    const otherPath = join(root, 'Other.fna');
    writeFileSync(otherPath, '>Other\nPEPT\n');
    writeSourceIndex(otherPath, 'protein');
    render(<LegacyMigrationFastaTab request={tab.legacyMigrationRead!} />);
    await waitFor(() =>
      expect(screen.getByTestId('legacy-migration-fasta-unresolved').textContent).toContain(
        'destination changed'
      )
    );
    expect(screen.queryByTestId('protein-residue-track')).toBeNull();
  });

  it.each(['source', 'index'] as const)(
    'refuses a symbolic-link %s at the native contained-file boundary',
    async (which) => {
      const path = join(root, 'protein.fna');
      const outside = join(realpathSync(fixture.tmpDir), 'outside.fna');
      writeFileSync(outside, '>Outside\nMKTW\n');
      if (which === 'source') symlinkSync(outside, path);
      else writeFileSync(path, '>Local\nMKTW\n');
      if (which === 'index') {
        const outsideIndex = join(realpathSync(fixture.tmpDir), 'outside-index.json');
        const payload = buildMigrationDestinationLinkIndexWriterPayload([
          {
            destinationObjectId: 'legacy-record',
            sourceStableIds: ['legacy-alias'],
            title: 'Legacy source',
            locator: { kind: 'workspace_path', relativePath: 'protein.fna', tabType: 'protein' },
          },
        ]);
        writeFileSync(outsideIndex, payload.text);
        symlinkSync(outsideIndex, join(root, payload.relativePath));
      } else writeSourceIndex(path, 'protein');
      expect(
        await openDocument({
          target: { kind: 'legacy-migration-file', workspaceRoot: root, targetId: 'legacy-alias' },
        })
      ).toMatchObject({ status: 'failed' });
      expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
    }
  );

  it('refuses an explicit legacy view that contradicts the real native declared kind', async () => {
    const path = join(root, 'protein.fna');
    writeFileSync(path, '>DNA\nACGTACGT\n');
    writeSourceIndex(path, 'protein');
    const entity = registerCatalogEntityInDb(state.db!, {
      id: 'ws1::canonical-source',
      type: 'sequence',
      name: 'DNA',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(state.db!, {
      entityId: entity.id,
      path,
      fileKind: 'fasta',
      workspaceRoot: root,
    });
    expect(
      await openDocument({
        target: { kind: 'legacy-migration-file', workspaceRoot: root, targetId: 'legacy-alias' },
      })
    ).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('native source is declared as sequence'),
    });
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
    expect(
      state.db!.prepare('SELECT type FROM catalog_entities WHERE id=?').get(entity.id)
    ).toEqual({ type: 'sequence' });
  });

  it('reports a multi-record source instead of silently showing its first record', async () => {
    const path = join(root, 'sequence.faa');
    writeFileSync(path, '>One\nACGT\n>Two\nTGCA\n');
    writeSourceIndex(path, 'sequence');
    expect(
      await openDocument({
        target: { kind: 'legacy-migration-file', workspaceRoot: root, targetId: 'legacy-alias' },
      })
    ).toMatchObject({ status: 'presented' });
    const tab = useCanvasStore.getState().panels.main.tabs[0];
    render(<LegacyMigrationFastaTab request={tab.legacyMigrationRead!} />);
    await waitFor(() =>
      expect(screen.getByTestId('legacy-migration-fasta-unresolved').textContent).toContain(
        'multiple records'
      )
    );
    expect(screen.queryByTestId('legacy-migration-fasta-bases')).toBeNull();
  });

  it('refuses an oversized complete source before bounded reading instead of displaying a prefix', async () => {
    const path = join(root, 'sequence.faa');
    writeFileSync(path, '>Large\nACGT\n');
    truncateSync(path, HARD_CAP_BYTES + 1);
    writeSourceIndex(path, 'sequence');
    expect(
      await openDocument({
        target: { kind: 'legacy-migration-file', workspaceRoot: root, targetId: 'legacy-alias' },
      })
    ).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('complete legacy FASTA is unavailable'),
    });
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });
});
