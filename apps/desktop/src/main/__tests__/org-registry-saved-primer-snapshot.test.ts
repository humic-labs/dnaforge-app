import { parseScientificCloudHistory } from '@waypoint/scientific-objects';
import { defineBlob } from '@waypoint/workspace-revisions';
import { workspaceSyncScientificContentSha256 } from '../workspace-sync-scientific-history';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle';

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

import {
  buildPrimerArtifact,
  revisePrimerArtifactContent,
  serializePrimerArtifact,
} from '../../shared/primers/primer-artifact';
import { primerArtifactRegistryProjection } from '../../shared/primers/primer-artifact-projection';
import type { OrgRegistryRecordReview } from '../org-registry-record-sync';
import type { DesktopSyncClient, DesktopSyncRequestOptions } from '../desktop-sync-client';
import { readOrganizationSavedPrimerSnapshot } from '../org-registry-saved-primer-snapshot';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const HOME = '20000000-0000-4000-8000-000000000001';
const ENTITY = '30000000-0000-4000-8000-000000000001';
const ORG = '40000000-0000-4000-8000-000000000001';
const SCHEMA_REV = '50000000-0000-4000-8000-000000000001';
const SCHEMA = '50000000-0000-4000-8000-000000000002';
const PATH = 'primers/saved.primer.json';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function historyFixture(scientific = false) {
  const wanted = await buildPrimerArtifact({
    id: ENTITY,
    catalogNumber: 'P001',
    name: 'Saved primer',
    sequence: 'GTAAAACGACGGCCAGT',
    workspaceRoot: '/fixture',
    artifactPath: `/fixture/${PATH}`,
    source: 'manual',
    notes: 'Retained approved notes',
    now: 1_700_000_000_000,
    inventory: {
      origin: 'manual',
      originDetails: { retained: 'organization inventory' },
      vendor: 'Test vendor',
      orderDate: null,
      scale: null,
      purification: null,
      modifications: null,
      stockLocation: 'Box 1',
      concentration: 8,
    },
  });
  const newer = await revisePrimerArtifactContent(
    wanted,
    {
      name: wanted.name,
      sequence: wanted.sequence.bases,
      notes: 'A newer project version not approved in Registry',
    },
    1_700_000_000_001
  );
  const content = ` \n${serializePrimerArtifact(wanted)}\n`;
  const projection = primerArtifactRegistryProjection(
    wanted,
    {
      mode: 'inline',
      bases: wanted.sequence.bases,
      topology: 'linear',
      length: wanted.sequence.length,
      contentHash: `sha256:${wanted.sequence.contentHash}`,
    },
    hash(serializePrimerArtifact(wanted))
  );

  const review: OrgRegistryRecordReview = {
    sourceRevision: hash('saved-primer-transport-review'),
    scope: { accountId: ACCOUNT, orgId: ORG, accessGeneration: 'primer-history-generation' },
    conflictId: null,
    mutationId: null,
    binding: {
      entityId: ENTITY,
      clientId: 'desktop:primer-history-test',
      workspaceId: 1,
      workspaceUuid: '20000000-0000-4000-8000-000000000002',
      homeWorkspaceId: HOME,
      authority: 'primer_artifact',
      schemaId: SCHEMA,
      schemaRevisionId: SCHEMA_REV,
    },
    localEventSeq: 1,
    local: { id: ENTITY, name: wanted.name, ...projection, archived: false },
    canonical: {
      id: ENTITY,
      kind: wanted.registry.kind,
      name: wanted.name,
      orgId: ORG,
      homeWorkspaceId: HOME,
      schemaId: SCHEMA,
      schemaRevisionId: SCHEMA_REV,
      revision: 4,
      archivedAt: null,
      ...projection,
    },
    base: { provenance: 'receipt', identity: 'primer-history-registration', revision: 4 },
    publications: [],
  };
  const makeVersion = (number: number, text: string) => {
    const id = `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    const manifest = {
      schemaVersion: 1 as const,
      files: [
        {
          path: PATH,
          contentSha256: hash(text),
          sizeBytes: Buffer.byteLength(text),
          contentType: 'application/json',
        },
      ],
    };
    const fileManifestSha256 = hash(workspaceSyncManifestHashInput(manifest));
    const scientificHistory = parseScientificCloudHistory({
      formatVersion: 1,
      logicalWorkspaceId: HOME,
      acceptedHead: null,
      archive: defineBlob(new TextEncoder().encode('fixture archive')),
    });
    const version = {
      id,
      versionNumber: number,
      representation: scientific ? ('scientific_manifest_v1' as const) : ('manifest_v1' as const),
      ...(scientific ? { fileManifestSha256 } : {}),
      manifestSchemaVersion: 1,
      contentSha256: scientific
        ? workspaceSyncScientificContentSha256(fileManifestSha256, scientificHistory)
        : fileManifestSha256,
      sizeBytes: Buffer.byteLength(text),
      fileCount: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      finalizedAt: '2026-10-01T00:00:01.000Z',
      createdBy: null,
    };
    return {
      text,
      version,
      manifest,
      workspaceId: HOME,
      ...(scientific
        ? { scientificHistory, fileManifestSha256, scientificBlobRefs: [scientificHistory.archive] }
        : {}),
      resourceIdentities: [{ path: PATH, resourceId: ENTITY }],
    };
  };
  const older = makeVersion(1, content),
    latest = makeVersion(2, serializePrimerArtifact(newer));
  const requests: Array<{ path: string; options: DesktopSyncRequestOptions }> = [];
  let accountId = ACCOUNT;
  const assertAccount = vi.fn(async (expected: string) => {
    if (expected !== accountId) throw new Error('The active account changed');
  });
  const requestStream = vi.fn(async (path: string, options: DesktopSyncRequestOptions) => {
    requests.push({ path, options });
    return new Response(path.includes(older.version.id) ? older.text : latest.text);
  });
  const client: DesktopSyncClient = {
    getAccountId: async () => accountId,
    assertAccount,
    requestStream,
    requestJson: async <T>(path: string, options: DesktopSyncRequestOptions) => {
      requests.push({ path, options });
      if (path.endsWith('/manifest'))
        return (path.includes(older.version.id) ? older : latest) as T;
      return {
        workspaceId: HOME,
        versions: path.includes('beforeVersionNumber=2') ? [older.version] : [latest.version],
        nextBeforeVersionNumber: path.includes('beforeVersionNumber=2') ? null : 2,
      } as T;
    },
  };
  return {
    wanted,
    content,
    review,
    client,
    requests,
    requestStream,
    older,
    latest,
    switchAccount: () => {
      accountId = ORG;
    },
  };
}

describe('exact organization primer from authenticated home history', () => {
  it('recovers the matching saved version from scientific manifest history', async () => {
    const f = await historyFixture(true);
    const snapshot = await readOrganizationSavedPrimerSnapshot(f.review, f.client);
    expect(snapshot.projectVersionId).toBe(f.older.version.id);
    expect(snapshot.projectVersionSha256).toBe(f.older.version.contentSha256);
  });

  it('finds the complete approved artifact in an older immutable version and pins every request to its account', async () => {
    const f = await historyFixture();
    const result = await readOrganizationSavedPrimerSnapshot(f.review, f.client);
    expect(result).toMatchObject({
      accountId: ACCOUNT,
      orgId: ORG,
      entityId: ENTITY,
      homeWorkspaceId: HOME,
      schemaRevisionId: SCHEMA_REV,
      organizationRevision: 4,
      projectVersionId: f.older.version.id,
      projectVersionSha256: f.older.version.contentSha256,
      relativePath: PATH,
      contentSha256: hash(f.content),
      content: f.content,
    });
    expect(f.requestStream).toHaveBeenCalledTimes(2);
    expect(f.requests.some(({ path }) => path.includes('beforeVersionNumber=2'))).toBe(true);
    for (const { options } of f.requests) expect(options.expectedAccountId).toBe(ACCOUNT);
  });

  it.each(['short', 'long', 'digest'] as const)(
    'rejects %s file bytes instead of accepting a matching Registry row',
    async (failure) => {
      const f = await historyFixture();
      f.requestStream.mockImplementationOnce(
        async () =>
          new Response(
            failure === 'short'
              ? f.latest.text.slice(1)
              : failure === 'long'
                ? f.latest.text + 'x'
                : 'x' + f.latest.text.slice(1)
          )
      );
      await expect(readOrganizationSavedPrimerSnapshot(f.review, f.client)).rejects.toThrow(
        /file length|digest or length/
      );
    }
  );

  it('rechecks the account after streaming before releasing saved bytes to publication', async () => {
    const f = await historyFixture();
    f.requestStream.mockImplementationOnce(async () => {
      f.switchAccount();
      return new Response(f.latest.text);
    });
    await expect(readOrganizationSavedPrimerSnapshot(f.review, f.client)).rejects.toThrow(
      'active account changed'
    );
  });

  it('reports missing complete bytes instead of reconstructing an artifact from projected fields', async () => {
    const f = await historyFixture();
    f.review.canonical.name = 'Registry-only edit without matching saved bytes';
    await expect(readOrganizationSavedPrimerSnapshot(f.review, f.client)).rejects.toMatchObject({
      code: 'SAVED_VERSION_UNAVAILABLE',
    });
  });
});
