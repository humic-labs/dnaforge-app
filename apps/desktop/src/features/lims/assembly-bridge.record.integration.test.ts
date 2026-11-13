import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));

const mocks = vi.hoisted(() => ({ platformBridge: null as any }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
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
import type { AcceptedAssemblyVersion } from '../assembly/accepted-types';
import type { DesignPrimerPair } from '../design/types';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { readScientificDocumentInMain } from '../../main/ipc/scientific-documents';
import { getAllLimsPrimersInDb } from '../../main/lims';
import { resolveOriginalDefaultProject } from '../../main/original-default-project';
import { bindCatalogEntityFileInDb } from '../../main/catalog-file-binding';
import { registerCatalogEntityInDb } from '../../main/catalog-entity-registration';
import {
  allocatePrimerCatalogNumberInDb,
  replacePrimerLegacyProjectionInDb,
} from '../../main/primer-projection';
import {
  validateWorkspacePathInMain,
  writeWorkspaceTextFileAtomicInMain,
} from '../../main/primer-artifact-files';
import { queryLimsEntities } from './operations';
import { reconcilePrimerArtifactsInWorkspace } from '../primers/primer-artifact-service';
import { buildRealAssemblyPipelineDesign } from '../../test/scenarios/assembly-real-pipeline';
import { recordAcceptedAssemblyPrimers } from './assembly-bridge';

let db: Database.Database;
let workspaceRoot: string;

function dbBridge(database: Database.Database) {
  return {
    execute: async (sql: string, params: unknown[] = []) => {
      const result = database.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },
    select: async <T>(sql: string, params: unknown[] = []): Promise<T> =>
      database.prepare(sql).all(...params) as T,
    bindCatalogEntityFile: async (input: Parameters<typeof bindCatalogEntityFileInDb>[1]) =>
      bindCatalogEntityFileInDb(database, input),
    registerCatalogEntity: async (input: Parameters<typeof registerCatalogEntityInDb>[1]) =>
      registerCatalogEntityInDb(database, input),
    allocatePrimerCatalogNumber: async (workspaceId?: number) =>
      allocatePrimerCatalogNumberInDb(database, workspaceId ?? 0),
    replacePrimerProjection: async (
      input: Parameters<typeof replacePrimerLegacyProjectionInDb>[1]
    ) => replacePrimerLegacyProjectionInDb(database, input),
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'fixture-assembly-record-'));
  const bridge = createLimsTestBridge();
  db = bridge.db;
  db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES (1, ?, ?, ?)`).run(
    'Assembly record test',
    workspaceRoot,
    Date.now()
  );
  mocks.platformBridge = {
    scientificObjects: { catalog: async () => ({ head: null, entries: [] }) },
    scientificDocuments: {
      read: (request: Parameters<typeof readScientificDocumentInMain>[0]) =>
        readScientificDocumentInMain(request, { database: db }),
      cancelRead: async () => {},
    },
    db: dbBridge(db),
    lims: bridge.lims,
    workspace: { getOriginalDefaultProject: async () => resolveOriginalDefaultProject(db) },
    fs: {
      readTextFile: async (path: string) => readFileSync(path, 'utf8'),
      readFile: async (path: string) => new Uint8Array(readFileSync(path)),
      writeTextFile: async (path: string, content: string) => writeFileSync(path, content),
      mkdir: async (path: string) => mkdirSync(path, { recursive: true }),
      stat: async (path: string) => {
        const stat = statSync(path);
        return {
          canonicalPath: realpathSync(path),
          size: stat.size,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          mtime: stat.mtimeMs,
        };
      },
      exists: async (path: string) => existsSync(path),
      rename: async (from: string, to: string) => renameSync(from, to),
      writeWorkspaceTextFileAtomic: writeWorkspaceTextFileAtomicInMain,
      validateWorkspacePath: validateWorkspacePathInMain,
      readDir: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        })),
    },
  };
});

afterEach(() => {
  db.close();
  mocks.platformBridge = null;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function acceptedVersion(designPrimers: readonly DesignPrimerPair[]): AcceptedAssemblyVersion {
  return { projectionInput: { designPrimers } } as unknown as AcceptedAssemblyVersion;
}

function realGibsonPairs(): DesignPrimerPair[] {
  const design = buildRealAssemblyPipelineDesign('gibson-pcr-pcr');
  return design.designPrimers.map((pairEntry) => ({ ...pairEntry }));
}

function nonEmptyPrimerCount(pairs: readonly DesignPrimerPair[]): number {
  return pairs
    .flatMap((pairEntry) => [pairEntry.forward, pairEntry.reverse])
    .filter((primer) => primer.sequence.trim().length > 0).length;
}

function withMutatedSequences(pairs: DesignPrimerPair[], tail: string): DesignPrimerPair[] {
  return pairs.map((pairEntry) => ({
    ...pairEntry,
    forward: { ...pairEntry.forward, sequence: tail + pairEntry.forward.sequence },
    reverse: { ...pairEntry.reverse, sequence: tail + pairEntry.reverse.sequence },
  }));
}

function primerCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM primers`).get() as { c: number }).c;
}

describe('recordAcceptedAssemblyPrimers — real-boundary parity ', () => {
  it('records assembly primers as assembly-sourced oligos that reconcile round-trip', async () => {
    const pairs = realGibsonPairs();
    const expected = nonEmptyPrimerCount(pairs);
    expect(expected).toBe(4);

    const result = await recordAcceptedAssemblyPrimers({
      acceptedVersion: acceptedVersion(pairs),
      workspaceRoot,
    });

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.recorded).toHaveLength(expected);

    for (const saved of result.recorded) {
      expect(existsSync(saved.artifactPath)).toBe(true);
      expect(saved.artifact.file.workspaceRelativePath.startsWith('primers/')).toBe(true);
      expect(saved.artifact.metadata.source).toBe('assembly');

      const entities = await queryLimsEntities({
        id: saved.artifact.registry.entityId,
        includeArchived: true,
        limit: 1,
      });
      expect(entities[0]?.fields.source).toBe('assembly');

      const row = db.prepare(`SELECT origin FROM primers WHERE id = ?`).get(saved.artifact.id) as
        | { origin: string }
        | undefined;
      expect(row?.origin).toBe('assembly');

      const union = getAllLimsPrimersInDb(db).filter(
        (unionRow) =>
          unionRow.limsEntityId === saved.artifact.registry.entityId ||
          unionRow.legacyPrimerId === saved.artifact.id
      );
      expect(union.length).toBeGreaterThan(0);
      for (const unionRow of union) {
        expect((unionRow as { origin?: string | null }).origin).toBe('assembly');
      }
    }

    const reconcile = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(reconcile.errors).toEqual([]);
    expect(reconcile.discovered).toBe(expected);
    expect(reconcile.reconciled).toBe(expected);
    expect(primerCount()).toBe(expected);
    for (const saved of result.recorded) {
      const row = db.prepare(`SELECT origin FROM primers WHERE id = ?`).get(saved.artifact.id) as {
        origin: string;
      };
      expect(row.origin).toBe('assembly');
    }
  });

  it('RT1: two assemblies with name-colliding, different-sequence primers both fully record', async () => {
    const first = realGibsonPairs();
    const expected = nonEmptyPrimerCount(first);

    const a = await recordAcceptedAssemblyPrimers({
      acceptedVersion: acceptedVersion(first),
      workspaceRoot,
    });
    expect(a.recorded).toHaveLength(expected);
    expect(a.failed).toEqual([]);

    const second = withMutatedSequences(first, 'AAAA');
    const b = await recordAcceptedAssemblyPrimers({
      acceptedVersion: acceptedVersion(second),
      workspaceRoot,
    });
    expect(b.failed).toEqual([]);
    expect(b.skipped).toEqual([]);
    expect(b.recorded).toHaveLength(expected);

    expect(primerCount()).toBe(expected * 2);

    const sharedName = first[0].forward.name;
    const seqs = (
      db.prepare(`SELECT sequence FROM primers WHERE name = ?`).all(sharedName) as {
        sequence: string;
      }[]
    ).map((r) => r.sequence);
    expect(seqs.length).toBe(2);
    expect(new Set(seqs).size).toBe(2);
  });

  it('RT4: re-finalizing the SAME assembly is idempotent (all skipped, no duplicates)', async () => {
    const pairs = realGibsonPairs();
    const expected = nonEmptyPrimerCount(pairs);

    const first = await recordAcceptedAssemblyPrimers({
      acceptedVersion: acceptedVersion(pairs),
      workspaceRoot,
    });
    expect(first.recorded).toHaveLength(expected);
    const firstEntityIds = first.recorded.map((r) => r.artifact.registry.entityId).sort();

    const again = await recordAcceptedAssemblyPrimers({
      acceptedVersion: acceptedVersion(pairs),
      workspaceRoot,
    });
    expect(again.recorded).toEqual([]);
    expect(again.failed).toEqual([]);
    expect(again.skipped).toHaveLength(expected);
    for (const skip of again.skipped) expect(skip.reason).toBe('duplicate');

    expect(primerCount()).toBe(expected);
    const oligoCount = (
      await queryLimsEntities({ kind: 'oligo', includeArchived: true, limit: 100 })
    ).length;
    expect(oligoCount).toBe(expected);
    const reconcile = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(reconcile.discovered).toBe(expected);

    const stillPresent = (
      await queryLimsEntities({ kind: 'oligo', includeArchived: true, limit: 100 })
    )
      .map((entity) => entity.id)
      .sort();
    expect(stillPresent).toEqual(firstEntityIds);
  });

  it('RT4: changing one primer records only that one anew; the rest dedup', async () => {
    const pairs = realGibsonPairs();
    const expected = nonEmptyPrimerCount(pairs);

    await recordAcceptedAssemblyPrimers({
      acceptedVersion: acceptedVersion(pairs),
      workspaceRoot,
    });
    expect(primerCount()).toBe(expected);

    const changed: DesignPrimerPair[] = pairs.map((pairEntry, index) =>
      index === 0
        ? {
            ...pairEntry,
            forward: { ...pairEntry.forward, sequence: 'GG' + pairEntry.forward.sequence },
          }
        : { ...pairEntry }
    );
    const result = await recordAcceptedAssemblyPrimers({
      acceptedVersion: acceptedVersion(changed),
      workspaceRoot,
    });
    expect(result.failed).toEqual([]);
    expect(result.recorded).toHaveLength(1);
    expect(result.skipped).toHaveLength(expected - 1);
    expect(primerCount()).toBe(expected + 1);
  });
});
