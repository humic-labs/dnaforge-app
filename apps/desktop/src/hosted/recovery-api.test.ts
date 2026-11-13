// @vitest-environment node
import { createHash, webcrypto } from 'node:crypto';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareHostedWorkspaceFiles, type HostedManifestFile } from './api';
import { loadHostedRecoveryCandidate, retainHostedRecoveryCandidate } from './recovery-api';

vi.mock('./api', async () => ({
  ...(await vi.importActual<typeof import('./api')>('./api')),
  prepareHostedWorkspaceFiles: vi.fn(),
}));

const prepared = vi.mocked(prepareHostedWorkspaceFiles);
const accountId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const baseVersionId = '33333333-3333-4333-8333-333333333333';
const candidateId = '44444444-4444-4444-8444-444444444444';
const files: HostedManifestFile[] = [
  {
    path: 'sequences/𐀀.gb',
    contentSha256: 'a'.repeat(64),
    sizeBytes: 8,
    contentType: 'application/genbank',
    resourceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  },
  {
    path: 'sequences/é.gb',
    contentSha256: 'b'.repeat(64),
    sizeBytes: 9,
    contentType: 'application/genbank',
    resourceId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
  },
];
const input = {
  workspaceId,
  baseVersionId,
  baseFiles: [],
  files: [],
  expectedAccountId: accountId,
  operationId: 'frozen-operation',
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const summary = {
  unsupportedCount: 0,
  privateRawDataCount: 0,
  referencePointerCount: 0,
  fileTooLargeCount: 0,
  bundleTooLargeCount: 0,
};

function expectedRequest() {
  const sorted = [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  );
  const manifest = {
    schemaVersion: 1 as const,
    files: sorted.map(({ path, contentSha256, sizeBytes, contentType }) => ({
      path,
      contentSha256,
      sizeBytes,
      contentType,
    })),
  };
  const resourceIdentities = sorted.map((file) => ({
    path: file.path,
    resourceId: file.resourceId!.toLowerCase(),
  }));
  const body = {
    baseVersionId,
    manifest,
    resourceIdentities,
    reason: 'dirty',
    excludedSummary: summary,
    missingPaths: [],
  };
  const contentSha256 = digest(workspaceSyncManifestHashInput(manifest));
  const requestSha256 = digest(
    JSON.stringify({
      schema: 'dnaforge.workspace-sync-recovery-candidate/v1',
      workspaceId,
      accountId,
      baseVersionId,
      contentSha256,
      reason: 'dirty',
      resourceIdentities,
      excludedSummary: summary,
      missingPaths: [],
    })
  );
  return { body, contentSha256, requestSha256 };
}

function receipt() {
  const hashes = expectedRequest();
  const createdAt = new Date().toISOString();
  return {
    id: candidateId,
    accountId,
    baseVersionId,
    contentSha256: hashes.contentSha256,
    requestSha256: hashes.requestSha256,
    reason: 'dirty',
    coverage: 'captured-bytes',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}
const success = () => ({ status: 'retained', workspaceId, candidate: receipt() });

beforeEach(() => {
  prepared.mockReset();
  prepared.mockResolvedValue(files);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

describe('browser exact frozen recovery receipts', () => {
  it('binds the real HTTP receipt to exact actor, base, normalized identities, Unicode content and seven-day retention', async () => {
    const saved = success();
    const fetch = vi.fn(async () => Response.json(saved));
    vi.stubGlobal('fetch', fetch);
    expect(await retainHostedRecoveryCandidate(input)).toEqual(saved.candidate);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('X-DNAForge-Account-ID')).toBe(accountId);
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(
      'hosted-recovery:frozen-operation'
    );
    expect(JSON.parse(init.body as string)).toEqual(expectedRequest().body);
    expect(JSON.stringify(init.body)).not.toContain('bytes');
  });

  it.each([
    'status',
    'workspaceId',
    'id',
    'accountId',
    'baseVersionId',
    'contentSha256',
    'requestSha256',
    'reason',
    'coverage',
    'createdAt',
    'expiresAt',
    'retention',
  ] as const)('refuses a mismatched %s without claiming remote protection', async (field) => {
    const saved = success();
    if (field === 'status') saved.status = 'ready';
    else if (field === 'workspaceId') saved.workspaceId = '55555555-5555-4555-8555-555555555555';
    else if (field === 'retention')
      saved.candidate.expiresAt = new Date(
        Date.parse(saved.candidate.createdAt) + 1000
      ).toISOString();
    else
      (saved.candidate as unknown as Record<string, unknown>)[field] =
        field === 'coverage' ? 'incomplete' : 'mismatched';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(saved))
    );
    await expect(retainHostedRecoveryCandidate(input)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      status: 502,
    });
  });

  it('replays exactly the same immutable request after a lost acknowledgement', async () => {
    const saved = success();
    const network = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Lost recovery acknowledgement'))
      .mockResolvedValue(Response.json(saved));
    vi.stubGlobal('fetch', network);
    await expect(retainHostedRecoveryCandidate(input)).rejects.toThrow(
      'Lost recovery acknowledgement'
    );
    expect(await retainHostedRecoveryCandidate(input)).toEqual(saved.candidate);
    const first = network.mock.calls[0]![1] as RequestInit;
    const second = network.mock.calls[1]![1] as RequestInit;
    expect(first.body).toBe(second.body);
    expect(new Headers(first.headers).get('Idempotency-Key')).toBe(
      new Headers(second.headers).get('Idempotency-Key')
    );
  });

  it('requires the initiating account before uploading bytes or retaining a candidate', async () => {
    await expect(
      retainHostedRecoveryCandidate({ ...input, expectedAccountId: undefined })
    ).rejects.toMatchObject({ code: 'account_changed' });
    expect(prepared).not.toHaveBeenCalled();
  });

  it('loads a policy-supported recovery manifest larger than the ordinary control-response budget', async () => {
    const detail = {
      workspaceId,
      candidate: receipt(),
      missingPaths: [],
      resourceIdentities: [],
      manifest: {
        schemaVersion: 1,
        files: Array.from({ length: 2000 }, (_, n) => ({
          path: `library/${n}/${'a'.repeat(100)}.gb`,
          contentSha256: 'a'.repeat(64),
          sizeBytes: 1,
          contentType: 'application/genbank',
        })),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeGreaterThan(256 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(detail))
    );
    const loaded = await loadHostedRecoveryCandidate(workspaceId, candidateId, accountId);
    expect(loaded.manifest.files).toHaveLength(2000);
  });
});
