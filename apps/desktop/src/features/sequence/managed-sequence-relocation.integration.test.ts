import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { relocateWorkspaceFileRefsInDb } from '../../main/workspace-relocate';
import {
  buildSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { useCanvasStore } from '../canvas/public/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSequenceStore } from './store';
import { managedSequenceRepository } from './managed-sequence-repository';
import { openSequenceDocumentResult, __resetInflightForTests } from './openSequenceFile';
import { presentResolvedReference } from '../ai/public/navigate-to-reference';
import type { ManagedSequenceDocumentRef } from '../../shared/managed-sequence-document';

const bridge = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../platform', () => ({ platform: () => bridge.value }));

const DOCUMENT_ID = '05466526-edf8-46d0-b975-3e78ff66e371';
let db: Database.Database;
let root = '';
let packageRoot = '';
let movedRoot = '';
let beforeReadDir: ((path: string) => Promise<void>) | undefined;

function reference(): ManagedSequenceDocumentRef {
  return { kind: 'managed-sequence', packageId: DOCUMENT_ID, packageRoot };
}

async function moveSource(): Promise<void> {
  await mkdir(dirname(movedRoot), { recursive: true });
  await rename(packageRoot, movedRoot);
  db.transaction(() =>
    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: root,
      oldPath: packageRoot,
      newPath: movedRoot,
    })
  )();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fixture-sequence-relocation-'));
  packageRoot = join(root, 'pUC19');
  movedRoot = join(root, 'primers', 'pUC19 moved');
  beforeReadDir = undefined;
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces (id,name,path,access_mode,created_at) VALUES (1,?,?,?,0)').run(
    'Primer development',
    root,
    'writable'
  );
  db.prepare(
    `INSERT INTO catalog_entities (id,type,name,locator,storage_type,workspace_id,status,created_at,updated_at)
    VALUES (?,'sequence','pUC19',?,'file',1,'active',0,0)`
  ).run(DOCUMENT_ID, `file://${packageRoot}`);
  db.prepare(
    `INSERT INTO catalog_entity_files (id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at)
    VALUES ('source-binding',?,1,?,'pUC19','waypoint-sequence','current',0,0)`
  ).run(DOCUMENT_ID, packageRoot);
  const paths = sequencePackagePaths(packageRoot, { productFile: 'pUC19.gb' });
  await mkdir(paths.metaDir, { recursive: true });
  await writeFile(
    paths.metaPath,
    serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: DOCUMENT_ID,
        name: 'pUC19',
        product: { file: 'pUC19.gb', topology: 'circular' },
      })
    )
  );
  await writeFile(
    paths.productPath,
    'LOCUS       pUC19  4 bp    DNA     circular SYN\nORIGIN\n        1 acgt\n//\n'
  );
  bridge.value = {
    db: { select: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) },
    fileAssociations: { prepareQuickLookPackage: async () => false },
    fs: {
      exists: async (path: string) =>
        access(path).then(
          () => true,
          () => false
        ),
      readTextFile: (path: string) => readFile(path, 'utf8'),
      readDir: async (path: string) => {
        await beforeReadDir?.(path);
        return (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
        }));
      },
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
    },
  };
  __resetInflightForTests();
  useCanvasStore.setState({
    panels: { main: { id: 'main', activeTabId: null, tabs: [] } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
  useWorkspaceStore.setState({ folders: [{ path: root, name: 'Primer development', addedAt: 0 }] });
});

afterEach(async () => {
  __resetInflightForTests();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('native managed source relocation and existing selection opening', () => {
  it('resolves a pending old-directory read through the newly committed native binding', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeReadDir = async (path) => {
      if (path !== packageRoot) return;
      entered();
      await paused;
    };
    const pending = managedSequenceRepository.resolve(reference());
    await started;
    await moveSource();
    release();
    await expect(pending).resolves.toMatchObject({
      ref: { kind: 'managed-sequence', packageId: DOCUMENT_ID, packageRoot: movedRoot },
      document: { id: DOCUMENT_ID },
      productPath: join(movedRoot, 'pUC19.gb'),
    });
    expect(db.prepare('SELECT entity_id,path FROM catalog_entity_files').all()).toEqual([
      { entity_id: DOCUMENT_ID, path: movedRoot },
    ]);
  });

  it.each(['saved selection', 'document opener'] as const)(
    'revalidates %s after a native move without a renderer notification and retains the dirty editor',
    async (route) => {
      const opened = await openSequenceDocumentResult(reference(), { label: 'pUC19' });
      expect(opened.status).toBe('presented');
      const tab = useCanvasStore.getState().panels.main.tabs[0];
      useCanvasStore.getState().updateTab('main', tab.id, { isDirty: true });
      useSequenceStore.getState().setSequence(DOCUMENT_ID, {
        id: DOCUMENT_ID,
        name: 'pUC19',
        sequence: 'ACGT',
        length: 4,
        circular: true,
        annotations: [],
      });
      useSequenceStore.getState().replaceBases(DOCUMENT_ID, 1, 2, 'TT');
      const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
      await moveSource();
      if (route === 'saved selection') {
        await presentResolvedReference({
          id: 'saved-region',
          entity_type: 'sequence_region',
          display_label: 'Saved region',
          locator: `entity://sequence/${DOCUMENT_ID}`,
          data: JSON.stringify({ documentId: DOCUMENT_ID }),
          deep_link_params: JSON.stringify({ start: 1, end: 3 }),
          workspace_root_path: root,
          source: 'user',
          status: 'created',
          created_at: 0,
          updated_at: 0,
        });
      } else {
        await openSequenceDocumentResult(reference(), { label: 'pUC19' });
      }
      const tabs = useCanvasStore.getState().panels.main.tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        id: tab.id,
        entityId: DOCUMENT_ID,
        isDirty: true,
        sequenceDocument: {
          kind: 'managed-sequence',
          packageId: DOCUMENT_ID,
          packageRoot: movedRoot,
        },
      });
      expect(useSequenceStore.getState().captureForSave(DOCUMENT_ID)).toEqual(capture);
      expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
      if (route === 'saved selection')
        expect(tabs[0].viewState?.highlightRange).toEqual({ start: 0, end: 2 });
    }
  );
});
