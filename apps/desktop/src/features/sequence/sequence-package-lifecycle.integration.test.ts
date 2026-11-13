import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformBridge: null as any,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: null as (EventEmitter & { id: number }) | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = mocks.handlers.get(channel);
      if (!handler) throw new Error(`Missing native handler: ${channel}`);
      return handler({ sender: mocks.sender }, ...args);
    },
  },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

vi.mock('../../platform', () => ({
  platform: () => {
    if (!mocks.platformBridge) throw new Error('Test platform bridge not initialized');
    return mocks.platformBridge;
  },
}));

import type Database from 'better-sqlite3';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { registerDatabaseHandlers } from '../../main/ipc/database';
import { createClient } from '../../shared/ipc-contract';
import { dbContract } from '../../shared/ipc/db.contract';
import { materializeImportedSequencePackages } from '../../main/workspace-git/sequence-package-import';
import { reconcileWorkspaceRoot } from '../../services/workspace-reconcile';
import { relinkMovedEntityFile } from '../../main/ipc/workspace-relocate';
import { getCatalogFileForPath } from '../../db/workspace-catalog';
import { parseSequencePackageDocument, sequencePackagePaths } from '../../db/sequence-package';
import { resolveSequencePackageProductPath } from './sequence-package-product';

let db: Database.Database;
let root: string;

const GENBANK = (name: string, bases: string) =>
  `LOCUS       ${name}  ${bases.length} bp    DNA     circular SYN\nORIGIN\n        1 ${bases.toLowerCase()}\n//\n`;

function dbBridge(database: Database.Database) {
  mocks.handlers.clear();
  registerDatabaseHandlers(() => database);
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = mocks.handlers.get(channel);
    if (!handler) throw new Error(`Missing native handler: ${channel}`);
    return handler({ sender: mocks.sender }, ...args);
  };
  return {
    ...createClient(dbContract),
    execute: (sql: string, params: unknown[] = []) => invoke('db:execute', sql, params),
    select: async <T>(sql: string, params: unknown[] = []): Promise<T> =>
      (await invoke('db:select', sql, params)) as T,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fixture-lifecycle-'));
  mocks.sender = Object.assign(new EventEmitter(), { id: 1704 });
  const bridge = createLimsTestBridge();
  db = bridge.db;
  db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES (1, ?, ?, ?)`).run(
    'Lifecycle test',
    root,
    Date.now()
  );
  mocks.platformBridge = {
    db: dbBridge(db),
    lims: bridge.lims,
    fs: {
      readTextFile: async (path: string) => readFileSync(path, 'utf8'),
      readFile: async (path: string) => new Uint8Array(readFileSync(path)),
      sha256File: async (path: string) =>
        `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
      writeTextFile: async (path: string, content: string) => writeFileSync(path, content),
      mkdir: async (path: string) => mkdirSync(path, { recursive: true }),
      stat: async (path: string) => {
        const s = statSync(path);
        return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtime: s.mtimeMs };
      },
      exists: async (path: string) => existsSync(path),
      rename: async (from: string, to: string) => renameSync(from, to),
      readDir: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        })),
    },
    workspace: {
      relinkMovedEntityFile: async (input: {
        workspaceRoot: string | null;
        oldPath: string;
        newPath: string;
      }) => relinkMovedEntityFile(input),
    },
  };
});

afterEach(() => {
  mocks.platformBridge = null;
  mocks.sender?.removeAllListeners();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function importSequence(fileName: string, content: string): Promise<string> {
  const staged = join(root, fileName);
  writeFileSync(staged, content, 'utf8');
  const result = await materializeImportedSequencePackages(staged);
  expect(result.converted).toBe(true);
  return result.packages[0].packageRoot;
}

const entityFor = async (path: string) => (await getCatalogFileForPath(path))?.entity_id ?? null;

describe('plasmid package lifecycle ', () => {
  describe('import → registry', () => {
    it('keeps the filename as the package name and records the GenBank locus', async () => {
      const pkg = await importSequence('pBR322.gb', GENBANK('SYNPBR322', 'ACGTACGTAC'));
      const meta = JSON.parse(readFileSync(join(pkg, '.forge', 'plasmid.json'), 'utf8')) as {
        name?: string;
        entity?: { fields?: { locus?: string } };
      };
      expect(meta.name).toBe('pBR322');
      expect(meta.entity?.fields?.locus).toBe('SYNPBR322');
      expect(readFileSync(join(pkg, 'pBR322.gb'), 'utf8')).toContain('SYNPBR322');
    });

    it('does not invent a locus field for a FASTA import', async () => {
      const pkg = await importSequence('pBR322.fasta', '>pBR322 plasmid vector DNA\nGGGGCCCCAA\n');
      const meta = JSON.parse(readFileSync(join(pkg, '.forge', 'plasmid.json'), 'utf8')) as {
        entity?: { fields?: { locus?: string } };
      };
      expect(meta.entity?.fields?.locus).toBeUndefined();
    });

    it('registers an imported GenBank package as one catalog entity', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });

      const product = join(pkg, 'pUC19.gb');
      expect(existsSync(product)).toBe(true);
      expect(await entityFor(pkg)).toBeTruthy();
      expect(await entityFor(product)).toBeNull();
    });

    it('registers a FASTA that was converted on the way in', async () => {
      const pkg = await importSequence('pBR322.fasta', '>pBR322 plasmid vector DNA\nGGGGCCCCAA\n');
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });

      const product = join(pkg, 'pBR322.gb');
      expect(existsSync(product)).toBe(true);
      expect(await entityFor(pkg)).toBeTruthy();
      expect(await entityFor(product)).toBeNull();
    });

    it('reconciling repeatedly keeps ONE entity', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      const product = join(pkg, 'pUC19.gb');
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });
      const first = await entityFor(pkg);
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });

      expect(await entityFor(pkg)).toBe(first);
      expect(await entityFor(product)).toBeNull();
    });
  });

  describe('editing the plasmid', () => {
    it('keeps the SAME entity when the plasmid is edited in the app', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      const product = join(pkg, 'pUC19.gb');
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });
      const before = await getCatalogFileForPath(pkg);
      const beforeProductHash = createHash('sha256').update(readFileSync(product)).digest('hex');

      writeFileSync(product, GENBANK('pUC19', 'ACGTACGTACTTTTTTTTTT'), 'utf8');
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });
      const after = await getCatalogFileForPath(pkg);
      const afterProductHash = createHash('sha256').update(readFileSync(product)).digest('hex');

      expect(after?.entity_id).toBe(before?.entity_id);
      expect(afterProductHash).not.toBe(beforeProductHash);
      expect(await getCatalogFileForPath(product)).toBeNull();
    });

    it('an edited plasmid does NOT break its build record', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      const product = join(pkg, 'pUC19.gb');
      writeFileSync(product, GENBANK('pUC19', 'TTTTTTTTTT'), 'utf8');

      const meta = parseSequencePackageDocument(
        readFileSync(sequencePackagePaths(pkg).metaPath, 'utf8')
      );
      expect(meta.product.file).toBe('pUC19.gb');
      await expect(resolveSequencePackageProductPath(pkg)).resolves.toBe(product);
    });
  });

  describe('renaming and moving the package', () => {
    it('a renamed package still resolves its plasmid', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      const renamed = join(root, 'pRenamed');
      renameSync(pkg, renamed);

      await expect(resolveSequencePackageProductPath(renamed)).resolves.toBe(
        join(renamed, 'pUC19.gb')
      );
    });

    it('a moved package still resolves its plasmid', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      const nested = join(root, 'plasmids', 'vectors');
      mkdirSync(nested, { recursive: true });
      const moved = join(nested, 'pUC19');
      renameSync(pkg, moved);

      await expect(resolveSequencePackageProductPath(moved)).resolves.toBe(join(moved, 'pUC19.gb'));
    });

    it('a moved package is still self-describing, and reconcile still sees a plasmid', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });

      const nested = join(root, 'plasmids');
      mkdirSync(nested, { recursive: true });
      const moved = join(nested, 'pUC19');
      renameSync(pkg, moved);
      await expect(reconcileWorkspaceRoot(root)).resolves.toMatchObject({ errors: [] });

      await expect(resolveSequencePackageProductPath(moved)).resolves.toBe(join(moved, 'pUC19.gb'));
      expect(await entityFor(moved)).toBeTruthy();
      expect(await entityFor(join(moved, 'pUC19.gb'))).toBeNull();
    });
  });

  describe('metadata changes', () => {
    it('a record edited to point at a renamed plasmid resolves to the new name', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      const paths = sequencePackagePaths(pkg);

      renameSync(join(pkg, 'pUC19.gb'), join(pkg, 'pUC19-v2.gb'));
      const meta = parseSequencePackageDocument(readFileSync(paths.metaPath, 'utf8'));
      writeFileSync(
        paths.metaPath,
        JSON.stringify({ ...meta, product: { ...meta.product, file: 'pUC19-v2.gb' } }),
        'utf8'
      );

      await expect(resolveSequencePackageProductPath(pkg)).resolves.toBe(join(pkg, 'pUC19-v2.gb'));
    });

    it('a plasmid renamed OUTSIDE the app still opens, without touching the record', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      renameSync(join(pkg, 'pUC19.gb'), join(pkg, 'renamed-in-finder.gb'));

      await expect(resolveSequencePackageProductPath(pkg)).resolves.toBe(
        join(pkg, 'renamed-in-finder.gb')
      );
    });

    it('a corrupt record does not make the plasmid unopenable', async () => {
      const pkg = await importSequence('pUC19.gb', GENBANK('pUC19', 'ACGTACGTAC'));
      writeFileSync(sequencePackagePaths(pkg).metaPath, '{ not json', 'utf8');

      await expect(resolveSequencePackageProductPath(pkg)).resolves.toBe(join(pkg, 'pUC19.gb'));
    });
  });
});
