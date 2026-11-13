/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { assertPrimerRegistryProjection } from './primer-projection';
import { buildPrimerArtifact, serializePrimerArtifact } from '../shared/primers/primer-artifact';
import { primerArtifactRegistryProjection } from '../shared/primers/primer-artifact-projection';

it.each(['received', 'ordered', 'archived', null])(
  'restores the authoritative saved Registry state %s into a fresh profile',
  async (domainStatus) => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const root = mkdtempSync(join(tmpdir(), 'primer-state-restore-'));
    try {
      const workspaceId = ensureWorkspaceOwnerInDb(db, root);
      const path = join(root, 'Retained.primer.json');
      const artifact = await buildPrimerArtifact({
        id: 'retained-primer',
        catalogNumber: 'P4108',
        name: 'Retained',
        sequence: 'ATCGATCGATCGATCGATCG',
        workspaceRoot: root,
        artifactPath: path,
      });
      artifact.entity!.state = {
        registrationStatus: 'registered',
        domainStatus,
        status: domainStatus ?? 'received',
        source: 'import',
        archived: domainStatus === 'archived',
        archivedAt: null,
      };
      const content = serializePrimerArtifact(artifact);
      writeFileSync(path, content);
      const projected = primerArtifactRegistryProjection(
        artifact,
        {
          mode: 'inline',
          bases: artifact.sequence.bases,
          topology: 'linear',
          length: artifact.sequence.length,
          contentHash: `sha256:${artifact.sequence.contentHash}`,
        },
        createHash('sha256').update(content).digest('hex')
      );
      const input = {
        id: artifact.id,
        name: artifact.name,
        kind: artifact.registry.kind,
        workspaceId,
        ...projected,
      };
      expect(assertPrimerRegistryProjection(db, input, 'register')).toBe(true);
      expect(() =>
        assertPrimerRegistryProjection(db, { ...input, domainStatus: 'designed' }, 'register')
      ).toThrow(/authoritative artifact/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM primers').get()).toEqual({ n: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
