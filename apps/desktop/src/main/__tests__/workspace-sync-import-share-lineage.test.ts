import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeepShareBundleV1 } from '@waypoint/share-bundle';

const restoreMocks = vi.hoisted(() => ({
  validateWorkspaceSyncStateForStrictRestore: vi.fn(),
  rehydrateWorkspaceSyncState: vi.fn(() => ({
    notebooksRestored: 0,
    lims: null,
    legacyLimsIgnored: false,
  })),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0'), isPackaged: false, getPath: vi.fn(() => '/tmp') },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));
vi.mock('../workspace-git', () => ({
  initManagedRepo: vi.fn(async () => undefined),
  commitAllIfDirty: vi.fn(async () => undefined),
  resolveHeadCommit: vi.fn(async () => 'head'),
  hasWorkingChanges: vi.fn(async () => false),
}));
vi.mock('../workspace-sync-restore', () => ({
  LEGACY_LIMS_NOT_IMPORTED_WARNING: 'Legacy LIMS data was preserved but not imported.',
  validateWorkspaceSyncStateForStrictRestore:
    restoreMocks.validateWorkspaceSyncStateForStrictRestore,
  rehydrateWorkspaceSyncState: restoreMocks.rehydrateWorkspaceSyncState,
}));

import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import {
  createAuthenticatedDeepShareImportClient,
  importShareIntoManagedWorkspace,
  prepareDeepShareImport,
} from '../workspace-sync-import-share';
import {
  DEEP_SHARE_LINEAGE_NOTICE,
  SHARE_LINEAGE_RELATIVE_PATH,
  parseShareLineage,
} from '../../shared/share-lineage';
import {
  __resetWorkspaceSyncObservationForTests,
  bindWorkspaceSyncObservationSink,
  type WorkspaceSyncObservation,
} from '../workspace-sync-observation';

function deepBundle() {
  const content = 'LOCUS       pUC19';
  return createDeepShareBundleV1({
    schema: 'dnaforge.deep-share/v1',
    appVersion: '0.8.0',
    createdAt: '2026-08-27T02:30:00Z',
    source: {
      workspaceId: 'sender-workspace-1',
      workspaceName: 'Sender Project',
      artifact: { id: 'artifact-root', type: 'sequence', name: 'pUC19' },
      pinnedVersionId: 'version-1',
      pinnedVersionNumber: 4,
      pinnedVersionContentSha256: 'a'.repeat(64),
    },
    parent: null,
    manifest: {
      rootArtifactId: 'artifact-root',
      artifacts: [{ id: 'artifact-root', type: 'sequence', name: 'pUC19', required: true }],
      relationships: [],
      files: [{ fileId: 'file-1', ownerArtifactId: 'artifact-root', role: 'primary' }],
      chats: [{ conversationId: 'chat-source', title: 'Design notes' }],
      omissions: [],
    },
    files: [
      {
        id: 'file-1',
        ownerArtifactId: 'artifact-root',
        relativePath: 'pUC19.gb',
        name: 'pUC19.gb',
        role: 'primary',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
        content: { encoding: 'utf8', text: content },
      },
    ],
    chats: [
      {
        id: 'chat-source',
        title: 'Design notes',
        createdAt: '2026-08-27T01:00:00Z',
        updatedAt: '2026-08-27T01:10:00Z',
        messages: [
          {
            id: 'source-user',
            role: 'user',
            content: 'Review pUC19.',
            createdAt: '2026-08-27T01:00:00Z',
            references: [],
          },
          {
            id: 'source-answer',
            role: 'assistant',
            content: 'Use the confirmed sequence.',
            createdAt: '2026-08-27T01:10:00Z',
            references: [{ artifactId: 'artifact-root', artifactType: 'sequence', label: 'pUC19' }],
          },
        ],
      },
    ],
    limits: { maxFileBytes: 1024, maxBundleBytes: 100_000, maxFiles: 10 },
  });
}

describe('importShareIntoManagedWorkspace Deep Share lineage', () => {
  it('reviews without writing, then imports the same frozen source without another capability request', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const root = mkdtempSync(join(tmpdir(), 'deep-share-reviewed-'));
    const response = {
      status: 'ok' as const,
      shareId: 'share-reviewed',
      shortId: 'deep12345',
      createdAt: null,
      bundle: deepBundle(),
    };
    const load = vi.fn(async () => response);
    const input = {
      shortId: response.shortId,
      token: 'private-capability-input',
      managedRootDir: root,
      db,
      client: { load },
    };
    try {
      const prepared = await prepareDeepShareImport(input);
      expect(existsSync(prepared.review.destination.repoPath)).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 0 });
      expect(JSON.stringify(prepared.review)).not.toContain(input.token);
      response.bundle.files[0].content = { encoding: 'utf8', text: 'outside replacement' };
      const result = await importShareIntoManagedWorkspace({ ...input, prepared, token: '' });
      expect(result.repoPath).toBe(prepared.review.destination.repoPath);
      expect(readFileSync(join(result.repoPath, 'pUC19', 'pUC19.gb'), 'utf8')).toBe(
        'LOCUS       pUC19'
      );
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a destination created after review and preserves its bytes', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const root = mkdtempSync(join(tmpdir(), 'deep-share-destination-'));
    const input = {
      shortId: 'deep12345',
      token: 'private-capability-input',
      managedRootDir: root,
      db,
      client: {
        load: async () => ({
          status: 'ok' as const,
          shareId: 'share-reviewed',
          shortId: 'deep12345',
          createdAt: null,
          bundle: deepBundle(),
        }),
      },
    };
    try {
      const prepared = await prepareDeepShareImport(input);
      mkdirSync(prepared.review.destination.repoPath, { recursive: true });
      const sentinel = join(prepared.review.destination.repoPath, 'preserve.txt');
      writeFileSync(sentinel, 'Outside destination bytes');
      await expect(
        importShareIntoManagedWorkspace({ ...input, prepared, token: '' })
      ).rejects.toThrow('already exists');
      expect(readFileSync(sentinel, 'utf8')).toBe('Outside destination bytes');
      expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('creates a new private fork, v2 lineage, and portable local conversations', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const root = mkdtempSync(join(tmpdir(), 'deep-share-import-'));
    const bundle = deepBundle();
    try {
      const result = await importShareIntoManagedWorkspace({
        shortId: 'deep12345',
        token: 'capability-token',
        managedRootDir: root,
        db,
        nowMs: 1_720_000_000_000,
        createWorkspaceUuid: () => '11111111-1111-4111-8111-111111111111',
        client: {
          load: vi.fn(async () => ({
            status: 'ok' as const,
            shareId: 'share-1',
            shortId: 'deep12345',
            createdAt: '2026-08-27T02:30:00Z',
            bundle,
          })),
        },
      });

      expect(result.workspaceUuid).toBe('11111111-1111-4111-8111-111111111111');
      expect(result.displayName).toBe('Private fork of pUC19');
      expect(result.lineage).toMatchObject({
        schemaVersion: 2,
        source: {
          shareId: 'share-1',
          workspaceId: 'sender-workspace-1',
          artifact: { id: 'artifact-root', type: 'sequence' },
          pinnedVersion: { id: 'version-1', number: 4 },
          bundle: { schema: 'dnaforge.deep-share/v1', contentSha256: bundle.contentSha256 },
        },
        localWorkspaceUuid: '11111111-1111-4111-8111-111111111111',
        notice: DEEP_SHARE_LINEAGE_NOTICE,
      });
      expect(JSON.stringify(result.lineage)).not.toContain('capability-token');
      expect(result.warnings).toEqual([]);
      expect(restoreMocks.validateWorkspaceSyncStateForStrictRestore).toHaveBeenCalledWith(
        expect.stringContaining('.deep-share-import-')
      );
      expect(restoreMocks.rehydrateWorkspaceSyncState).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          workspaceRoot: result.repoPath,
          strict: true,
        })
      );

      const lineagePath = join(result.repoPath, ...SHARE_LINEAGE_RELATIVE_PATH.split('/'));
      expect(parseShareLineage(JSON.parse(readFileSync(lineagePath, 'utf8')))).toEqual(
        result.lineage
      );
      expect(readFileSync(join(result.repoPath, 'pUC19', 'pUC19.gb'), 'utf8')).toBe(
        'LOCUS       pUC19'
      );
      expect(existsSync(join(result.repoPath, 'pUC19', '.forge', 'plasmid.json'))).toBe(true);

      const conversation = db
        .prepare('SELECT id, title, workspace_path, provider, model FROM conversations')
        .get() as Record<string, unknown>;
      expect(conversation).toMatchObject({
        title: 'Shared context: Design notes',
        workspace_path: result.repoPath,
        provider: null,
        model: null,
      });
      expect(result.lineage.conversationIdMap['chat-source']).toBe(conversation.id);
      const messages = db
        .prepare('SELECT role, content, tool_name, tool_call_id FROM messages ORDER BY created_at')
        .all();
      expect(messages).toEqual([
        { role: 'user', content: 'Review pUC19.', tool_name: null, tool_call_id: null },
        {
          role: 'assistant',
          content: 'Use the confirmed sequence.',
          tool_name: null,
          tool_call_id: null,
        },
      ]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM message_references').get()).toMatchObject({
        count: 1,
      });
      expect(
        db.prepare('SELECT remote_workspace_id, enabled FROM workspace_sync_bindings').get()
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      db.close();
    }
  });

  it('uses the authenticated desktop client endpoint and never sends a destination workspace', async () => {
    const requestJson = vi.fn(async () => ({ status: 'ok' }));
    const client = createAuthenticatedDeepShareImportClient({ requestJson } as never);
    await client.load({ shortId: 'deep12345', token: 'secret' });
    expect(requestJson).toHaveBeenCalledWith('/api/desktop-sync/share-links/deep12345/import', {
      method: 'POST',
      body: { token: 'secret' },
    });
    expect(JSON.stringify(requestJson.mock.calls)).not.toContain('destination');
  });

  it('continues to parse lineage v1 records for backward compatibility', () => {
    expect(
      parseShareLineage({
        schemaVersion: 1,
        shareId: null,
        shortId: 'legacy123',
        pinnedVersionId: null,
        pinnedVersionNumber: null,
        originalName: 'Legacy',
        sharedAt: null,
        contentSha256: null,
        senderDisplayName: null,
        importedAt: '2026-01-01T00:00:00Z',
        notice: 'Opened from a public snapshot link. This is your editable local copy.',
      })
    ).toMatchObject({ schemaVersion: 1, shortId: 'legacy123' });
  });

  it('removes staging and final paths when database materialization fails', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const root = mkdtempSync(join(tmpdir(), 'deep-share-import-fail-'));
    const observations: WorkspaceSyncObservation[] = [];
    bindWorkspaceSyncObservationSink((observation) => observations.push(observation));
    db.exec(`CREATE TRIGGER fail_deep_share_workspace BEFORE INSERT ON workspaces
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
    try {
      await expect(
        importShareIntoManagedWorkspace({
          shortId: 'deep12345',
          token: 'secret',
          managedRootDir: root,
          db,
          createWorkspaceUuid: () => '22222222-2222-4222-8222-222222222222',
          client: {
            load: async () => ({
              status: 'ok',
              shareId: 'share-1',
              shortId: 'deep12345',
              createdAt: null,
              bundle: deepBundle(),
            }),
          },
        })
      ).rejects.toThrow('forced failure');
      expect(observations).toEqual([
        {
          feature_area: 'workspace',
          sync_operation: 'share_import',
          sync_outcome: 'failed',
          error_code: expect.stringMatching(/^[a-z][a-z0-9_]*$/),
          duration_ms: expect.any(Number),
        },
      ]);
      expect(JSON.stringify(observations)).not.toMatch(/deep12345|secret|forced/);
      expect(existsSync(join(root, '22222222-2222-4222-8222-222222222222'))).toBe(false);
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM workspaces WHERE repo_uuid = ?')
          .get('22222222-2222-4222-8222-222222222222')
      ).toMatchObject({ count: 0 });
    } finally {
      __resetWorkspaceSyncObservationForTests();
      rmSync(root, { recursive: true, force: true });
      db.close();
    }
  });

  it('returns a user-visible warning when a historical share contains inert LIMS data', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const root = mkdtempSync(join(tmpdir(), 'share-import-legacy-lims-'));
    restoreMocks.rehydrateWorkspaceSyncState.mockReturnValueOnce({
      notebooksRestored: 0,
      lims: null,
      legacyLimsIgnored: true,
    });

    try {
      const result = await importShareIntoManagedWorkspace({
        shortId: 'legacy-lims',
        token: 'tok',
        managedRootDir: root,
        db,
        nowMs: 1_720_000_000_000,
        createWorkspaceUuid: () => '22222222-2222-4222-8222-222222222222',
        client: {
          load: async () => ({
            status: 'ok',
            shareId: 'share-legacy-lims',
            shortId: 'legacy-lims',
            createdAt: null,
            bundle: deepBundle(),
          }),
        },
      });

      expect(result.warnings).toEqual(['Legacy LIMS data was preserved but not imported.']);
    } finally {
      rmSync(root, { recursive: true, force: true });
      db.close();
    }
  });
});
