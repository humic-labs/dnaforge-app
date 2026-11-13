import { createHash } from 'node:crypto';

import { workspaceSyncBundleHashInput, type WorkspaceSyncBundleV1 } from '@waypoint/share-bundle';
import { describe, expect, it } from 'vitest';

import { parseAndValidateDesktopSyncLatestResponse } from '../workspace-sync-latest-worker-job';

const REMOTE_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_VERSION_ID = '22222222-2222-4222-8222-222222222222';

describe('workspace sync latest worker job', () => {
  it('parses and validates a complete latest-version response', () => {
    const latest = validLatest();
    expect(parseAndValidateDesktopSyncLatestResponse(encode(latest))).toEqual(latest);
  });

  it.each([
    { label: 'invalid UTF-8', bytes: new Uint8Array([0xc3, 0x28]), message: 'valid UTF-8' },
    { label: 'malformed JSON', bytes: encodeText('{'), message: 'malformed JSON' },
    {
      label: 'valid JSON with a forged bundle hash',
      bytes: encode({
        ...validLatest(),
        version: { ...validLatest().version, contentSha256: '0'.repeat(64) },
      }),
      message: 'hash does not match',
    },
    {
      label: 'valid JSON with a non-UUID workspace id',
      bytes: encode({ ...validLatest(), workspaceId: 'not-a-uuid' }),
      message: 'invalid envelope',
    },
    {
      label: 'valid JSON with a non-UUID version id',
      bytes: encode({
        ...validLatest(),
        version: { ...validLatest().version, id: 'not-a-uuid' },
      }),
      message: 'invalid envelope',
    },
  ])('rejects $label', ({ bytes, message }) => {
    expect(() => parseAndValidateDesktopSyncLatestResponse(bytes)).toThrow(message);
  });
});

function validLatest() {
  const bundle = validBundle();
  return {
    workspaceId: REMOTE_WORKSPACE_ID,
    version: {
      id: REMOTE_VERSION_ID,
      versionNumber: 1,
      contentSha256: bundle.provenance.contentSha256,
      sizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
      fileCount: bundle.files.length,
      createdAt: '2026-08-24T00:00:00.000Z',
    },
    bundle,
  };
}

function validBundle(): WorkspaceSyncBundleV1 {
  const bundle: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-08-24T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Project A' },
    files: [],
    excludedSummary: {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 0, bytesApprox: 0 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    },
    limits: { maxFileBytes: 1, maxBundleBytes: 1, maxFiles: 1 },
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: '0.8.1',
      contentSha256: '',
    },
  };
  bundle.provenance.contentSha256 = createHash('sha256')
    .update(workspaceSyncBundleHashInput(bundle))
    .digest('hex');
  return bundle;
}

function encode(value: unknown): Uint8Array {
  return encodeText(JSON.stringify(value));
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
