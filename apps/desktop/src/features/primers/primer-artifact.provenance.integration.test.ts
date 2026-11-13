import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { bindCatalogEntityFileInDb } from '../../main/catalog-file-binding';
import { registerCatalogEntityInDb } from '../../main/catalog-entity-registration';
import { ensureWorkspaceOwnerInDb } from '../../main/catalog-projection-commands';
import { getAllLimsPrimersInDb } from '../../main/lims';
import {
  allocatePrimerCatalogNumberInDb,
  replacePrimerLegacyProjectionInDb,
} from '../../main/primer-projection';
import {
  validateWorkspacePathInMain,
  writeWorkspaceTextFileAtomicInMain,
} from '../../main/primer-artifact-files';
import { queryLimsEntities } from '../lims/operations';
import type { PrimerDesignProvenanceV1 } from './primer-artifact';
import { savePrimerArtifact } from './primer-artifact-service';
import { recordPrimers } from './record-primers';

let db: Database.Database;
let workspaceRoot: string;

function dbBridge(database: Database.Database) {
  return {
    ensureWorkspaceOwner: async (
      root: string,
      access?: Parameters<typeof ensureWorkspaceOwnerInDb>[2]
    ) => ensureWorkspaceOwnerInDb(database, root, access),
    registerCatalogEntity: async (input: Parameters<typeof registerCatalogEntityInDb>[1]) =>
      registerCatalogEntityInDb(database, input),
    bindCatalogEntityFile: async (input: Parameters<typeof bindCatalogEntityFileInDb>[1]) =>
      bindCatalogEntityFileInDb(database, input),
    execute: async (sql: string, params: unknown[] = []) => {
      const result = database.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },
    select: async <T>(sql: string, params: unknown[] = []): Promise<T> =>
      database.prepare(sql).all(...params) as T,
    allocatePrimerCatalogNumber: async (workspaceId?: number) =>
      allocatePrimerCatalogNumberInDb(database, workspaceId ?? 0),
    replacePrimerProjection: async (
      input: Parameters<typeof replacePrimerLegacyProjectionInDb>[1]
    ) => replacePrimerLegacyProjectionInDb(database, input),
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'fixture-provenance-'));
  const bridge = createLimsTestBridge();
  db = bridge.db;
  db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES (1, ?, ?, ?)`).run(
    'Provenance test',
    workspaceRoot,
    Date.now()
  );
  mocks.platformBridge = {
    db: dbBridge(db),
    lims: bridge.lims,
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

describe('assembly provenance reaches the registry ', () => {
  it("threads origin: 'assembly' through file, entity, SQLite, and union row", async () => {
    const saved = await savePrimerArtifact({
      name: 'AsmPrimer_F1',
      sequence: 'ACGTACGTACGTACGTACGT',
      artifactPath: join(workspaceRoot, 'primers', 'AsmPrimer_F1.primer.json'),
      workspaceRoot,
      requireRegistry: true,
      origin: 'assembly',
    });

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
      (r) =>
        r.limsEntityId === saved.artifact.registry.entityId ||
        r.legacyPrimerId === saved.artifact.id
    );
    expect(union.length).toBeGreaterThan(0);
    for (const unionRow of union) {
      expect((unionRow as { origin?: string | null }).origin).toBe('assembly');
    }
  });

  it("leaves a manual primer's origin as 'manual' (no false assembly tag)", async () => {
    const saved = await savePrimerArtifact({
      name: 'ManualPrimer_1',
      sequence: 'TTTTGGGGCCCCAAAATTTT',
      artifactPath: join(workspaceRoot, 'primers', 'ManualPrimer_1.primer.json'),
      workspaceRoot,
      requireRegistry: true,
      origin: 'manual',
    });
    expect(saved.artifact.metadata.source).toBe('manual');
    const row = db.prepare(`SELECT origin FROM primers WHERE id = ?`).get(saved.artifact.id) as
      | { origin: string }
      | undefined;
    expect(row?.origin).toBe('manual');
  });
});

describe('agent design retry identity ', () => {
  it('treats provider fields omitted by JSON as the same provenance on retry', async () => {
    const designId = `sha256:${'d'.repeat(64)}`;
    const sequence = 'ACGTACGTACGTACGTACGT';
    const designProvenance: PrimerDesignProvenanceV1 = {
      designId,
      candidateId: `${designId}:pair-0:forward`,
      candidateRank: 0,
      role: 'forward',
      pbsSequence: sequence,
      overhangSequence: '',
      target: {
        documentId: 'sequence-document-template',
        topology: 'linear',
        length: 2686,
        fileContentHash: 'sha256:target-file',
        normalizedSequenceHash: 'sha256:target-sequence',
        start: 100,
        end: 200,
        wrapsOrigin: false,
      },
      primer3: {
        application: 'pcr',
        parameters: { num_return: 1 },
        warnings: [],
      },
      tm: {
        model: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
        source: 'user-setting',
        reason: 'The saved NEB model was selected.',
        valueC: 62.5,
        status: 'verified',
        provider: {
          source: 'neb-api',
          tm: 62.5,
          ta: undefined,
          conc_nM: 500,
          verified: true,
          pendingNebVerification: false,
          polymerase: 'q5',
          prodcode: 'q5-0',
          nebApiVersion: 'v1',
          fetchedAt: '2026-08-11T00:00:00.000Z',
        },
      },
    };
    const artifactPath = join(workspaceRoot, 'primers', 'AgentRetry_F.primer.json');
    const input = {
      name: 'AgentRetry_F',
      sequence,
      artifactPath,
      workspaceRoot,
      requireRegistry: true as const,
      artifactSource: 'agent-design' as const,
      designProvenance,
    };

    const first = await savePrimerArtifact(input);
    const written = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      designProvenance: { tm: { provider: Record<string, unknown> } };
    };
    expect(written.designProvenance.tm.provider).not.toHaveProperty('ta');

    const retry = await savePrimerArtifact(input);
    expect(retry.artifact.id).toBe(first.artifact.id);
    expect(retry.artifact.artifactRevision).toBe(first.artifact.artifactRevision);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM primers WHERE id = ?`).get(first.artifact.id) as {
          count: number;
        }
      ).count
    ).toBe(1);
  });
});

describe('recordPrimers records through the real primitive with provenance ', () => {
  it("records an assembly primer end-to-end, origin 'assembly' reaching the registry", async () => {
    const result = await recordPrimers({
      primers: [
        {
          name: 'SeamPrimer_A',
          sequence: 'GGGGCCCCAAAATTTTGGGG',
          artifactStem: 'SeamPrimer_A-hash',
        },
      ],
      workspaceRoot,
      origin: 'assembly',
      deferCommit: true,
    });

    expect(result.recorded).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    const primerId = result.recorded[0].artifact.id;
    const entities = await queryLimsEntities({
      id: result.recorded[0].artifact.registry.entityId,
      includeArchived: true,
      limit: 1,
    });
    expect(entities[0]?.fields.source).toBe('assembly');
    expect(
      (db.prepare(`SELECT origin FROM primers WHERE id = ?`).get(primerId) as { origin: string })
        .origin
    ).toBe('assembly');
  });

  it('is idempotent: re-recording the identical primer skips (no duplicate rows)', async () => {
    const primers = [
      { name: 'SeamPrimer_B', sequence: 'AAAACCCCGGGGTTTTAAAA', artifactStem: 'SeamPrimer_B-hash' },
    ];
    const first = await recordPrimers({
      primers,
      workspaceRoot,
      origin: 'assembly',
      deferCommit: true,
    });
    expect(first.recorded).toHaveLength(1);

    const second = await recordPrimers({
      primers,
      workspaceRoot,
      origin: 'assembly',
      deferCommit: true,
    });
    expect(second.recorded).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0].reason).toBe('duplicate');

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM primers WHERE name = 'SeamPrimer_B'`)
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('does NOT let a different-origin file at the same path masquerade as an idempotent retry', async () => {
    const shared = {
      name: 'Collide_1',
      sequence: 'CCCCGGGGAAAATTTTCCCC',
      artifactStem: 'Collide_1',
    };
    const manual = await recordPrimers({
      primers: [shared],
      workspaceRoot,
      origin: 'manual',
      deferCommit: true,
    });
    expect(manual.recorded).toHaveLength(1);

    const assembly = await recordPrimers({
      primers: [shared],
      workspaceRoot,
      origin: 'assembly',
      deferCommit: true,
    });
    expect(assembly.recorded).toHaveLength(0);
    expect(assembly.skipped).toHaveLength(0);
    expect(assembly.failed).toHaveLength(1);
    expect(assembly.failed[0].reason).toBe('path-collision');

    const row = db.prepare(`SELECT origin FROM primers WHERE name = 'Collide_1'`).get() as {
      origin: string;
    };
    expect(row.origin).toBe('manual');
  });
});
