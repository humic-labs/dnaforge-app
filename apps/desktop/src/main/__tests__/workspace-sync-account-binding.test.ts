import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DesktopAuthRefreshOutcome } from '../auth/controller';
import type { StoredSession } from '../auth/session-store';

const actionBoundaryMocks = vi.hoisted(() => ({
  listWorkspaceSyncProjects: vi.fn(),
  openWorkspaceSyncProject: vi.fn(),
  resolveWorkspaceSyncConflict: vi.fn(),
  managedRootDir: vi.fn(() => '/managed-root'),
}));

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), isPackaged: false },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));

vi.mock('../workspace-sync-projects', () => ({
  listWorkspaceSyncProjects: actionBoundaryMocks.listWorkspaceSyncProjects,
  openWorkspaceSyncProject: actionBoundaryMocks.openWorkspaceSyncProject,
}));

vi.mock('../workspace-sync-conflicts', () => ({
  resolveWorkspaceSyncConflict: actionBoundaryMocks.resolveWorkspaceSyncConflict,
}));

vi.mock('../ipc/workspace-git', () => ({
  managedRootDir: actionBoundaryMocks.managedRootDir,
}));

import { ensureSchema } from '../schema';
import { createDesktopSyncClient } from '../desktop-sync-client';
import {
  createWorkspaceSyncClaimClient,
  setWorkspaceSyncEnabled,
  type WorkspaceSyncActionRuntime,
} from '../workspace-sync-actions';
import { createTestDb } from './test-db';

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMOTE_OF_A = '11111111-1111-4111-8111-111111111111';
const REMOTE_OF_B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const FRESH = '2026-09-08T12:45:00.000Z';
const STALE = '2026-09-08T12:01:00.000Z';

interface ServerBinding {
  clientWorkspaceId: string;
  ownerAccountId: string;
  workspaceId: string;
}

interface ServerRequest {
  bearerAccountId: string | null;
  body: { clientWorkspaceId: string; owner: { kind: string } };
}

class FakeClaimServer {
  readonly tokens = new Map<string, string>();
  readonly rejectedTokens = new Set<string>();
  readonly bindings: ServerBinding[] = [];
  readonly requests: ServerRequest[] = [];
  confirmIdentity: (accountId: string) => { owner: unknown; claimedBy: unknown } = (accountId) => ({
    owner: { kind: 'personal', accountId },
    claimedBy: { accountId },
  });
  beforeRespond: (() => void) | null = null;

  readonly fetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    const token = headers.Authorization.replace(/^Bearer /, '');
    const bearerAccountId = this.tokens.get(token) ?? null;
    const body = JSON.parse(String(init.body)) as ServerRequest['body'];
    this.requests.push({ bearerAccountId, body });
    if (!bearerAccountId || this.rejectedTokens.has(token)) {
      return jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'expired' });
    }
    let binding = this.bindings.find(
      (candidate) =>
        candidate.clientWorkspaceId === body.clientWorkspaceId &&
        candidate.ownerAccountId === bearerAccountId
    );
    const status = binding ? 'reused' : 'created';
    if (!binding) {
      binding = {
        clientWorkspaceId: body.clientWorkspaceId,
        ownerAccountId: bearerAccountId,
        workspaceId: bearerAccountId === ACCOUNT_A ? REMOTE_OF_A : REMOTE_OF_B,
      };
      this.bindings.push(binding);
    }
    this.beforeRespond?.();
    return jsonResponse(200, {
      status,
      workspaceId: binding.workspaceId,
      clientWorkspaceId: body.clientWorkspaceId,
      ownerKind: 'personal',
      ...this.confirmIdentity(bearerAccountId),
    });
  });
}

describe('workspace sync account binding across credential renewal ', () => {
  let db: Database.Database;
  let server: FakeClaimServer;
  let runtime: WorkspaceSyncActionRuntime;
  let activeSession: StoredSession | null;
  let sessionAtDispatch: (() => StoredSession | null) | null;
  const performRefresh = vi.fn<() => Promise<DesktopAuthRefreshOutcome>>();

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Project A', '/managed/workspace-a/repo', 'workspace-a', 100, 100)`
    ).run();
    server = new FakeClaimServer();
    server.tokens.set('token-a-1', ACCOUNT_A);
    server.tokens.set('token-a-2', ACCOUNT_A);
    server.tokens.set('token-b-1', ACCOUNT_B);
    runtime = {
      ensureWatchingWorkspace: vi.fn(async () => undefined),
      stopWatchingWorkspace: vi.fn(),
      pauseWorkspace: vi.fn(),
      resumeWorkspace: vi.fn(),
      flushWorkspace: vi.fn(async () => ({ status: 'uploaded' })),
      waitForIdle: vi.fn(async () => undefined),
    };
    activeSession = session(ACCOUNT_A, 'token-a-1', FRESH);
    sessionAtDispatch = null;
    performRefresh.mockReset();
    performRefresh.mockImplementation(async () => {
      activeSession = session(ACCOUNT_A, 'token-a-2', FRESH);
      return { status: 'refreshed' };
    });
  });

  it('renews the same account and binds the server-confirmed owner', async () => {
    activeSession = session(ACCOUNT_A, 'token-a-1', STALE);

    await expect(enable()).resolves.toEqual({ ok: true });

    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual([
      {
        bearerAccountId: ACCOUNT_A,
        body: expect.objectContaining({
          clientWorkspaceId: 'workspace-a',
          owner: { kind: 'personal' },
        }),
      },
    ]);
    expect(server.bindings).toEqual([
      { clientWorkspaceId: 'workspace-a', ownerAccountId: ACCOUNT_A, workspaceId: REMOTE_OF_A },
    ]);
    expect(localBinding()).toMatchObject({
      owner_account_id: ACCOUNT_A,
      remote_workspace_id: REMOTE_OF_A,
      enabled: 1,
    });
  });

  it('stops when the active account changes during credential renewal', async () => {
    activeSession = session(ACCOUNT_A, 'token-a-1', STALE);
    performRefresh.mockImplementationOnce(async () => {
      activeSession = session(ACCOUNT_B, 'token-b-1', FRESH);
      return { status: 'refreshed' };
    });

    await expect(enable()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/signed-in account changed/i),
    });

    expect(server.requests).toEqual([]);
    expect(server.bindings).toEqual([]);
    expect(localBinding()).toBeUndefined();
    expect(runtime.flushWorkspace).not.toHaveBeenCalled();
  });

  it('stops a 401 retry when the active account changed after the first attempt', async () => {
    server.rejectedTokens.add('token-a-1');
    performRefresh.mockImplementationOnce(async () => {
      activeSession = session(ACCOUNT_B, 'token-b-1', FRESH);
      return { status: 'refreshed' };
    });

    await expect(enable()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/signed-in account changed/i),
    });

    expect(server.requests).toEqual([
      {
        bearerAccountId: ACCOUNT_A,
        body: expect.objectContaining({ clientWorkspaceId: 'workspace-a' }),
      },
    ]);
    expect(server.bindings).toEqual([]);
    expect(localBinding()).toBeUndefined();
  });

  it('stops before dispatch when the active account differs from the enabling account', async () => {
    sessionAtDispatch = () => session(ACCOUNT_B, 'token-b-1', FRESH);

    await expect(enable()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/signed-in account changed/i),
    });

    expect(performRefresh).not.toHaveBeenCalled();
    expect(server.requests).toEqual([]);
    expect(localBinding()).toBeUndefined();
  });

  it('stops when renewal signs the account out with no replacement', async () => {
    activeSession = session(ACCOUNT_A, 'token-a-1', STALE);
    performRefresh.mockImplementationOnce(async () => {
      activeSession = null;
      return { status: 'signed_out' };
    });

    await expect(enable()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/sign in again/i),
    });

    expect(server.requests).toEqual([]);
    expect(localBinding()).toBeUndefined();
  });

  it('refuses a server-confirmed different owner before persistence', async () => {
    server.confirmIdentity = () => ({
      owner: { kind: 'personal', accountId: ACCOUNT_B },
      claimedBy: { accountId: ACCOUNT_B },
    });

    await expect(enable()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/different owner/i),
    });

    expect(server.requests).toHaveLength(1);
    expect(localBinding()).toBeUndefined();
  });

  it('keeps a late successful claim consistent and lets the same account recover it', async () => {
    server.beforeRespond = () => {
      activeSession = session(ACCOUNT_B, 'token-b-1', FRESH);
    };
    vi.mocked(runtime.flushWorkspace).mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'ACCOUNT_PAUSED',
    });

    await expect(enable()).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('ACCOUNT_PAUSED'),
    });
    expect(localBinding()).toMatchObject({
      owner_account_id: ACCOUNT_A,
      remote_workspace_id: REMOTE_OF_A,
      enabled: 1,
    });
    expect(server.bindings).toEqual([
      { clientWorkspaceId: 'workspace-a', ownerAccountId: ACCOUNT_A, workspaceId: REMOTE_OF_A },
    ]);

    server.beforeRespond = null;
    activeSession = session(ACCOUNT_A, 'token-a-1', FRESH);
    await expect(enable()).resolves.toEqual({ ok: true });
    expect(server.requests).toHaveLength(1);
    expect(localBinding()).toMatchObject({
      owner_account_id: ACCOUNT_A,
      remote_workspace_id: REMOTE_OF_A,
    });
  });

  it('keeps the local owner guards for a pre-existing mismatched binding', async () => {
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
        workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
        enabled, created_at, updated_at
      ) VALUES (1, 'workspace-a', ?, ?, 0, 100, 100)`
    ).run(ACCOUNT_A, REMOTE_OF_B);

    await expect(enable()).resolves.toEqual({ ok: true });
    expect(server.requests).toEqual([]);
    expect(localBinding()).toMatchObject({
      owner_account_id: ACCOUNT_A,
      remote_workspace_id: REMOTE_OF_B,
      enabled: 1,
    });

    activeSession = session(ACCOUNT_B, 'token-b-1', FRESH);
    await expect(enable()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/different sync owner/i),
    });
    expect(server.requests).toEqual([]);
  });

  function enable() {
    const client = createDesktopSyncClient({
      baseUrl: 'https://web.test',
      fetch: server.fetch as unknown as typeof fetch,
      getActiveStoredSession: async () => (sessionAtDispatch ? sessionAtDispatch() : activeSession),
      performRefresh,
      nowMs: () => NOW,
    });
    return setWorkspaceSyncEnabled(db, 'workspace-a', true, {
      runtime,
      getActiveSession: async () => activeSession,
      createClaimClient: (deviceId) => createWorkspaceSyncClaimClient(deviceId, client),
      nowMs: () => NOW,
    });
  }

  function localBinding(): Record<string, unknown> | undefined {
    return db
      .prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_uuid = 'workspace-a'`)
      .get() as Record<string, unknown> | undefined;
  }
});

function session(accountId: string, accessToken: string, expiresAt: string): StoredSession {
  return {
    accountId,
    desktopSessionId: `desktop-session-${accountId}`,
    accessToken,
    accessTokenExpiresAt: expiresAt,
    refreshToken: `refresh-${accountId}`,
    email: `${accountId}@example.com`,
    displayName: accountId,
    channel: 'dev',
    updatedAt: 100,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
