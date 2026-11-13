// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') }, safeStorage: {}, shell: {} }));
vi.mock('@sentry/electron/main', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));

import type { DesktopSyncClient } from './desktop-sync-client';
import { scientificCloudVersionHashInput } from '@waypoint/scientific-objects';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle';
import {
  retainWorkspaceSyncRecoveryCandidate,
  validateWorkspaceSyncRecoveryCandidateReceipt,
  workspaceSyncRecoveryCandidateRequest,
  WORKSPACE_SYNC_RECOVERY_RETENTION_MS,
  parseScientificWorkspaceSyncRecoveryDetail,
} from './workspace-sync-recovery-candidate';

const input = {
  remoteWorkspaceId: '11111111-1111-4111-8111-111111111111',
  ownerAccountId: 'account-a',
  baseVersionId: null,
  manifest: {
    schemaVersion: 1 as const,
    files: [
      {
        path: 'sequences/construct/construct.gb',
        contentSha256: 'a'.repeat(64),
        sizeBytes: 8,
        contentType: 'application/genbank',
      },
    ],
  },
  reason: 'dirty' as const,
};

function receipt() {
  const expected = workspaceSyncRecoveryCandidateRequest(input);
  return {
    id: '33333333-3333-4333-8333-333333333333',
    accountId: input.ownerAccountId,
    baseVersionId: null,
    contentSha256: expected.contentSha256,
    requestSha256: expected.requestSha256,
    reason: 'dirty' as const,
    coverage: 'captured-bytes' as const,
    createdAt: '2026-10-05T00:00:00.000Z',
    expiresAt: '2026-10-12T00:00:00.000Z',
  };
}

describe('exact captured-byte recovery receipts', () => {
  it('binds scientific recovery to full accepted history and independently captured drafts', () => {
    const scientificHistory = {
      formatVersion: 1 as const,
      logicalWorkspaceId: 'ws1' as never,
      acceptedHead: null,
      archive: { hash: `sha256:${'b'.repeat(64)}` as never, byteLength: 99 },
    };
    const scientificBlobRefs = [{ hash: `sha256:${'c'.repeat(64)}` as never, byteLength: 8 }];
    const fileManifestSha256 = createHash('sha256')
      .update(workspaceSyncManifestHashInput(input.manifest))
      .digest('hex');
    const scientificInput = {
      ...input,
      ownerAccountId: '22222222-2222-4222-8222-222222222222',
      scientificHistory,
      scientificBlobRefs,
      fileManifestSha256,
    };
    const expected = workspaceSyncRecoveryCandidateRequest(scientificInput);
    const contentSha256 = createHash('sha256')
      .update(scientificCloudVersionHashInput(fileManifestSha256, scientificHistory))
      .digest('hex');
    expect(expected.contentSha256).toBe(contentSha256);
    expect(expected.body).toMatchObject({
      representation: 'scientific_manifest_v1',
      scientificHistory,
      scientificBlobRefs,
    });
    const requestSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          schema: 'dnaforge.workspace-sync-recovery-candidate/scientific-v1',
          workspaceId: input.remoteWorkspaceId,
          accountId: scientificInput.ownerAccountId,
          baseVersionId: null,
          representation: 'scientific_manifest_v1',
          fileManifestSha256,
          contentSha256,
          scientificHistory,
          scientificBlobRefs,
          reason: 'dirty',
          resourceIdentities: [],
          excludedSummary: expected.body.excludedSummary,
          missingPaths: [],
        })
      )
      .digest('hex');
    expect(expected.requestSha256).toBe(requestSha256);
    const held = {
      ...receipt(),
      accountId: scientificInput.ownerAccountId,
      contentSha256,
      requestSha256,
      representation: 'scientific_manifest_v1',
      fileManifestSha256,
      scientificHistory,
      scientificBlobRefs,
    };
    expect(validateWorkspaceSyncRecoveryCandidateReceipt(held, scientificInput)).toMatchObject(
      held
    );
    const context = {
      workspaceId: input.remoteWorkspaceId,
      candidateId: held.id,
      accountId: scientificInput.ownerAccountId,
      nowMs: Date.parse('2026-10-06T00:00:00.000Z'),
    };
    const detail = {
      workspaceId: context.workspaceId,
      candidate: held,
      manifest: scientificInput.manifest,
      resourceIdentities: expected.body.resourceIdentities,
      excludedSummary: expected.body.excludedSummary,
      missingPaths: expected.body.missingPaths,
    };
    expect(parseScientificWorkspaceSyncRecoveryDetail(detail, context)).toMatchObject({
      candidate: held,
      manifest: scientificInput.manifest,
    });
    expect(() =>
      parseScientificWorkspaceSyncRecoveryDetail(detail, {
        ...context,
        accountId: '33333333-3333-4333-8333-333333333333',
      })
    ).toThrow('foreign authority');
    expect(() =>
      parseScientificWorkspaceSyncRecoveryDetail(detail, {
        ...context,
        nowMs: Date.parse(held.expiresAt),
      })
    ).toThrow('expired');
    expect(() =>
      parseScientificWorkspaceSyncRecoveryDetail(
        {
          ...detail,
          manifest: {
            ...detail.manifest,
            files: detail.manifest.files.map((file) => ({
              ...file,
              contentSha256: 'd'.repeat(64),
            })),
          },
        },
        context
      )
    ).toThrow('file or blob metadata');
    expect(() =>
      validateWorkspaceSyncRecoveryCandidateReceipt(
        { ...held, scientificBlobRefs: [] },
        scientificInput
      )
    ).toThrow('exact account');
    const { scientificHistory: omitted, ...incomplete } = held;
    expect(omitted).toBe(scientificHistory);
    expect(() =>
      validateWorkspaceSyncRecoveryCandidateReceipt(incomplete, scientificInput)
    ).toThrow('exact account');
    expect(() =>
      workspaceSyncRecoveryCandidateRequest({ ...scientificInput, scientificBlobRefs: undefined })
    ).toThrow('blob metadata');
    const draft = {
      ...scientificInput,
      manifest: {
        ...input.manifest,
        files: input.manifest.files.map((file) => ({ ...file, contentSha256: 'd'.repeat(64) })),
      },
      fileManifestSha256: createHash('sha256')
        .update(
          workspaceSyncManifestHashInput({
            ...input.manifest,
            files: input.manifest.files.map((file) => ({ ...file, contentSha256: 'd'.repeat(64) })),
          })
        )
        .digest('hex'),
    };
    expect(workspaceSyncRecoveryCandidateRequest(draft).body.scientificHistory).toEqual(
      scientificHistory
    );
    expect(workspaceSyncRecoveryCandidateRequest(draft).requestSha256).not.toBe(requestSha256);
  });
  it('returns only validated receipt fields instead of passing through an untrusted object', () => {
    expect(
      validateWorkspaceSyncRecoveryCandidateReceipt(
        { ...receipt(), untrustedExtension: { fakeProtection: true } },
        input
      )
    ).toEqual(receipt());
  });

  it('binds a metadata-only request to its account, workspace, base, exclusions and missing paths', async () => {
    const requestJson = vi.fn(async () => ({
      status: 'retained',
      workspaceId: input.remoteWorkspaceId,
      candidate: receipt(),
    }));
    const result = await retainWorkspaceSyncRecoveryCandidate(
      { requestJson } as unknown as DesktopSyncClient,
      { ...input, idempotencyKey: 'candidate:stable-request' }
    );
    expect(result).toEqual(receipt());
    expect(requestJson).toHaveBeenCalledWith(
      `/api/desktop-sync/workspaces/${input.remoteWorkspaceId}/recovery-candidates`,
      expect.objectContaining({
        method: 'POST',
        expectedAccountId: input.ownerAccountId,
        idempotencyKey: 'candidate:stable-request',
        body: {
          baseVersionId: null,
          manifest: input.manifest,
          reason: 'dirty',
          resourceIdentities: [],
          missingPaths: [],
          excludedSummary: {
            unsupportedCount: 0,
            privateRawDataCount: 0,
            referencePointerCount: 0,
            fileTooLargeCount: 0,
            bundleTooLargeCount: 0,
          },
        },
      })
    );
    expect(JSON.stringify(requestJson.mock.calls[0])).not.toContain('fileSources');
    expect(result.requestSha256).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            schema: 'dnaforge.workspace-sync-recovery-candidate/v1',
            workspaceId: input.remoteWorkspaceId,
            accountId: input.ownerAccountId,
            baseVersionId: null,
            contentSha256: result.contentSha256,
            reason: 'dirty',
            resourceIdentities: [],
            excludedSummary: {
              unsupportedCount: 0,
              privateRawDataCount: 0,
              referencePointerCount: 0,
              fileTooLargeCount: 0,
              bundleTooLargeCount: 0,
            },
            missingPaths: [],
          })
        )
        .digest('hex')
    );
  });

  it.each([
    'accountId',
    'baseVersionId',
    'contentSha256',
    'requestSha256',
    'reason',
    'coverage',
    'expiresAt',
  ] as const)(
    'rejects a receipt with mismatching %s instead of claiming remote recovery',
    (field) => {
      expect(() =>
        validateWorkspaceSyncRecoveryCandidateReceipt({ ...receipt(), [field]: 'wrong' }, input)
      ).toThrow(/exact account|retention/);
    }
  );

  it('keeps captured-byte completeness distinct from scientific validity and omitted required members', () => {
    const incomplete = {
      ...input,
      reason: 'invalid-package' as const,
      missingPaths: ['sequences/construct/contents/missing.bin'],
      excludedSummary: { privateRawDataCount: 1 },
    };
    const expected = workspaceSyncRecoveryCandidateRequest(incomplete);
    const valid = {
      ...receipt(),
      requestSha256: expected.requestSha256,
      reason: 'invalid-package',
      coverage: 'incomplete',
    };
    expect(validateWorkspaceSyncRecoveryCandidateReceipt(valid, incomplete).coverage).toBe(
      'incomplete'
    );
    expect(Date.parse(receipt().expiresAt) - Date.parse(receipt().createdAt)).toBe(
      WORKSPACE_SYNC_RECOVERY_RETENTION_MS
    );
  });
});
