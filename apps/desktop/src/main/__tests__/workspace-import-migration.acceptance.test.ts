import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepShareBundleV1,
  workspaceSyncBundleHashInput,
  type WorkspaceSyncBundleV1,
} from '@waypoint/share-bundle';

const fault = vi.hoisted(() => ({ failConversion: false, conversionCalls: 0 }));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false, getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));
vi.mock('../auth/session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/session-store')>()),
  getActiveStoredSession: async () => ({ accountId: 'account-a' }),
}));
vi.mock('../workspace-git/convert-tree-to-packages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-git/convert-tree-to-packages')>();
  return {
    ...actual,
    convertTreeToPlasmidPackages: async (
      ...args: Parameters<typeof actual.convertTreeToPlasmidPackages>
    ) => {
      fault.conversionCalls += 1;
      if (!fault.failConversion) return actual.convertTreeToPlasmidPackages(...args);
      return {
        converted: 0,
        packages: 0,
        skipped: 0,
        skippedDetails: [],
        failures: [
          { path: join(args[0], 'pUC19.gb'), message: 'injected source publication failure' },
        ],
        requiredGitFiles: [],
        mutatedGitFiles: [],
      };
    },
  };
});

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { importShareIntoManagedWorkspace } from '../workspace-sync-import-share';
import { openWorkspaceSyncProject } from '../workspace-sync-projects';

const source =
  'LOCUS       pUC19  12 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgtacgt\n//\n';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cleanup: (() => void)[] = [];
afterEach(() => {
  fault.failConversion = false;
  fault.conversionCalls = 0;
  for (const run of cleanup.splice(0).reverse()) run();
});

function fixture() {
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  const root = mkdtempSync(join(tmpdir(), 'migration-import-acceptance-'));
  cleanup.push(
    () => db.close(),
    () => rmSync(root, { recursive: true, force: true })
  );
  return { db, root };
}

function syncBundle(): WorkspaceSyncBundleV1 {
  const bundle: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-07-08T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Project A' },
    files: [
      {
        id: 'sequence-file',
        relativePath: 'pUC19.gb',
        name: 'pUC19.gb',
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(source),
        sha256: hash(source),
        content: source,
      },
    ],
    excludedSummary: {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 0, bytesApprox: 0 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    },
    limits: { maxFileBytes: 1024 * 1024, maxBundleBytes: 1024 * 1024, maxFiles: 10 },
    provenance: { source: 'dnaforge-desktop', appVersion: '0.3.0', contentSha256: '0'.repeat(64) },
  };
  bundle.provenance.contentSha256 = hash(workspaceSyncBundleHashInput(bundle));
  return bundle;
}

function deepBundle() {
  return createDeepShareBundleV1({
    schema: 'dnaforge.deep-share/v1',
    appVersion: '0.8.0',
    createdAt: '2026-08-27T02:30:00Z',
    source: {
      workspaceId: 'sender-workspace-1',
      workspaceName: 'Sender Project',
      artifact: { id: 'sequence-root', type: 'sequence', name: 'pUC19' },
      pinnedVersionId: 'version-1',
      pinnedVersionNumber: 1,
      pinnedVersionContentSha256: 'a'.repeat(64),
    },
    parent: null,
    manifest: {
      rootArtifactId: 'sequence-root',
      artifacts: [{ id: 'sequence-root', type: 'sequence', name: 'pUC19', required: true }],
      relationships: [],
      files: [{ fileId: 'sequence-file', ownerArtifactId: 'sequence-root', role: 'primary' }],
      chats: [],
      omissions: [],
    },
    files: [
      {
        id: 'sequence-file',
        ownerArtifactId: 'sequence-root',
        relativePath: 'pUC19.gb',
        name: 'pUC19.gb',
        role: 'primary',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(source),
        sha256: hash(source),
        content: { encoding: 'utf8', text: source },
      },
    ],
    chats: [],
    limits: { maxFileBytes: 1024 * 1024, maxBundleBytes: 1024 * 1024, maxFiles: 10 },
  });
}

describe('migration completion before native import promotion', () => {
  it.each([false, true])(
    'fresh sync restore failConversion=%s only promotes completed migration',
    async (failConversion) => {
      const f = fixture();
      fault.failConversion = failConversion;
      const bundle = syncBundle();
      const remoteWorkspaceId = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
      const versionId = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
      const remote = {
        workspaceId: remoteWorkspaceId,
        clientWorkspaceId: 'workspace-a',
        displayName: 'Project A',
        owner: { kind: 'personal' as const, accountId: 'account-a' },
        latest: { versionId, versionNumber: 1, contentSha256: bundle.provenance.contentSha256 },
        storageBytesUsed: 512,
        versionCount: 1,
        updatedAt: '2026-07-08T00:00:00.000Z',
        lastSeenAt: '2026-07-08T00:00:00.000Z',
        deviceId: 'device-a',
      };
      const result = await openWorkspaceSyncProject(f.db, {
        remoteWorkspaceId,
        managedRootDir: f.root,
        getActiveAccountId: () => 'account-a',
        nowMs: () => 1000,
        client: {
          listWorkspaces: async () => [remote],
          downloadLatest: async () => ({
            workspaceId: remoteWorkspaceId,
            version: {
              id: versionId,
              versionNumber: 1,
              contentSha256: bundle.provenance.contentSha256,
              sizeBytes: Buffer.byteLength(JSON.stringify(bundle)),
              fileCount: 1,
              createdAt: '2026-07-08T00:00:00.000Z',
            },
            bundle,
          }),
        },
      });
      expect(fault.conversionCalls).toBeGreaterThan(0);
      if (!failConversion && !result.ok) throw new Error(JSON.stringify(result));
      expect
        .soft(result.ok, 'incomplete conversion cannot become a successful restore')
        .toBe(!failConversion);
      const binding = f.db.prepare('SELECT enabled FROM workspace_sync_bindings').all();
      const active = f.db
        .prepare('SELECT id FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL')
        .all();
      if (failConversion) {
        expect.soft(binding).toEqual([]);
        expect.soft(active).toEqual([]);
        expect
          .soft(
            f.db
              .prepare("SELECT status FROM workspace_sync_restore_locks WHERE status='completed'")
              .all()
          )
          .toEqual([]);
      } else {
        expect(binding).toEqual([{ enabled: 1 }]);
        expect(existsSync(join(f.root, 'workspace-a/repo/pUC19/pUC19.gb'))).toBe(true);
      }
    }
  );

  it.each([false, true])(
    'Deep Share failConversion=%s only promotes completed migration',
    async (failConversion) => {
      const f = fixture();
      fault.failConversion = failConversion;
      const operation = importShareIntoManagedWorkspace({
        shortId: 'deep12345',
        token: 'test-capability',
        db: f.db,
        managedRootDir: f.root,
        createWorkspaceUuid: () => 'private-fork',
        nowMs: 1000,
        client: {
          load: async () => ({
            status: 'ok',
            shareId: 'share-1',
            shortId: 'deep12345',
            createdAt: null,
            bundle: deepBundle(),
          }),
        },
      });
      const result = await operation.then(
        (value) => ({ kind: 'success', value }),
        (error: unknown) => ({ kind: 'failure', error })
      );
      expect(fault.conversionCalls).toBeGreaterThan(0);
      if (!failConversion && result.kind === 'failure' && 'error' in result) throw result.error;
      expect
        .soft(result.kind, 'incomplete conversion cannot become a private fork')
        .toBe(failConversion ? 'failure' : 'success');
      if (failConversion) {
        expect.soft(f.db.prepare('SELECT id FROM workspaces').all()).toEqual([]);
        expect.soft(existsSync(join(f.root, 'private-fork'))).toBe(false);
        expect.soft(readdirSync(f.root)).toEqual([]);
      } else {
        expect(existsSync(join(f.root, 'private-fork/repo/pUC19/pUC19.gb'))).toBe(true);
      }
    }
  );
});
