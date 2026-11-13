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

import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { prepareSequencePackageRevision } from '../../db/sequence-package-versioning';
import { readSequenceProductSummary } from '../../db/entity-substrate/sequence-product-summary-runtime';
import { projectManagedSequenceRegistry } from '../../shared/managed-sequence-registry-projection';
import type { DesktopSyncClient, DesktopSyncRequestOptions } from '../desktop-sync-client';
import type { SavedSequenceReview } from '../org-registry-saved-sequence-snapshot-contract';
import { readOrganizationSavedSequenceSnapshot } from '../org-registry-saved-sequence-snapshot';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const HOME = '20000000-0000-4000-8000-000000000001';
const ENTITY = '30000000-0000-4000-8000-000000000001';
const ORG = '40000000-0000-4000-8000-000000000001';
const MARKER = 'saved-package/.forge/plasmid.json';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function fixture(options: { acceptedExports?: 'current' | 'history_only' } = {}) {
  const product = serializeSequenceForInPlaceSave(
    {
      id: ENTITY,
      name: 'Saved sequence',
      sequence: 'ACGT',
      length: 4,
      circular: false,
      annotations: [],
    },
    '/fixture/product.gb'
  );
  const attachment = Buffer.from([0, 255, 1, 7]);
  const member = {
    id: 'binary-member',
    role: 'user',
    path: 'contents/user-attachment-binary.bin',
    replaceable: false,
    createdAt: '2026-10-17T00:00:00.000Z',
  };
  const primerExports = options.acceptedExports
    ? ['current', 'prior'].flatMap((version) =>
        ['csv', 'fasta'].map((format) => ({
          id: `primer-export:${version}:${format}`,
          role: 'primer-export',
          path: `contents/${version}.primers.${format}`,
          replaceable: false,
          createdAt: member.createdAt,
          content: `${version} saved primer export (${format})\n`,
        }))
      )
    : [];
  const accepted = (version: string) => {
    const [csv, fasta] = primerExports.filter((asset) => asset.id.includes(`:${version}:`));
    return {
      acceptedAssemblyVersionId: version,
      artifacts: {
        primerCsvPath: csv.path,
        primerCsvChecksum: `sha256:${hash(csv.content)}`,
        primerFastaPath: fasta.path,
        primerFastaChecksum: `sha256:${hash(fasta.content)}`,
      },
    };
  };
  const document = buildSequencePackageDocument({
    id: ENTITY,
    name: 'Saved sequence',
    product: {
      file: 'product.gb',
      genBankChecksum: `sha256:${hash(product)}`,
      sequenceChecksum: `sha256:${hash('ACGT')}`,
    },
    members: [member, ...primerExports.map(({ content: _content, ...asset }) => asset)],
    ...(options.acceptedExports
      ? { assembly: { accepted: accepted('current'), history: [accepted('prior')] } }
      : {}),
    userAttachments: { attachment: { memberId: member.id, sha256: `sha256:${hash(attachment)}` } },
  });
  const priorAccepted = options.acceptedExports
    ? await prepareSequencePackageRevision({
        current: null,
        currentProductContent: null,
        next: { ...document, assembly: { accepted: accepted('prior') } },
        nextProductContent: product,
        kind: 'assembly-finalization',
        operationId: 'prior',
        revisionId: 'prior',
      })
    : null;
  const prepared = await prepareSequencePackageRevision({
    current: priorAccepted?.document ?? null,
    currentProductContent: priorAccepted ? product : null,
    next: document,
    nextProductContent: product,
    kind: 'sequence-save',
    operationId: 'saved',
    revisionId: 'saved',
  });
  if (options.acceptedExports === 'history_only') delete prepared.document.assembly;
  const marker = ` \n${serializeSequencePackageDocument(prepared.document)}\n`;
  const projection = await projectManagedSequenceRegistry(
    prepared.document,
    await readSequenceProductSummary(product),
    3,
    marker
  );
  const review: SavedSequenceReview = {
    scope: { accountId: ACCOUNT, orgId: ORG, accessGeneration: 'generation' },
    binding: { authority: 'sequence_package' },
    canonical: {
      id: ENTITY,
      orgId: ORG,
      kind: projection.kind,
      name: projection.name,
      fields: projection.fields,
      registrationStatus: projection.registrationStatus,
      domainStatus: projection.domainStatus,
      homeWorkspaceId: HOME,
      schemaRevisionId: '50000000-0000-4000-8000-000000000001',
      revision: 4,
      archivedAt: null,
    },
  };
  const files = new Map<string, Buffer>([
    [MARKER, Buffer.from(marker)],
    ['saved-package/product.gb', Buffer.from(product)],
    [`saved-package/${member.path}`, attachment],
    ...primerExports.map(
      (asset) => [`saved-package/${asset.path}`, Buffer.from(asset.content)] as [string, Buffer]
    ),
    ...[...(priorAccepted?.snapshots ?? []), ...prepared.snapshots].map(
      (snapshot) =>
        [`saved-package/${snapshot.path}`, Buffer.from(snapshot.content)] as [string, Buffer]
    ),
  ]);
  const makeVersion = (number: number, source: Map<string, Buffer>) => {
    const id = `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    const manifest = {
      schemaVersion: 1 as const,
      files: [...source]
        .map(([path, bytes]) => ({
          path,
          contentSha256: hash(bytes),
          sizeBytes: bytes.byteLength,
          contentType: 'application/octet-stream',
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
    const version = {
      id,
      versionNumber: number,
      representation: 'manifest_v1' as const,
      manifestSchemaVersion: 1,
      contentSha256: hash(workspaceSyncManifestHashInput(manifest)),
      sizeBytes: manifest.files.reduce((n, file) => n + file.sizeBytes, 0),
      fileCount: manifest.files.length,
      createdAt: '2026-10-01T00:00:00.000Z',
      finalizedAt: '2026-10-01T00:00:01.000Z',
      createdBy: null,
    };
    return {
      source,
      workspaceId: HOME,
      version,
      manifest,
      resourceIdentities: manifest.files.map((file, index) => ({
        path: file.path,
        resourceId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      })),
    };
  };
  const newer = await prepareSequencePackageRevision({
    current: prepared.document,
    currentProductContent: product,
    next: { ...prepared.document, name: 'Newer unreviewed name' },
    nextProductContent: product,
    kind: 'metadata-update',
    operationId: 'newer',
    revisionId: 'newer',
  });
  const latestFiles = new Map(files);
  latestFiles.set(MARKER, Buffer.from(serializeSequencePackageDocument(newer.document)));
  const older = makeVersion(1, files),
    latest = makeVersion(2, latestFiles);
  const requests: Array<{ path: string; options: DesktopSyncRequestOptions }> = [];
  let account = ACCOUNT;
  const assertAccount = vi.fn(async (expected: string) => {
    if (expected !== account) throw new Error('The active account changed');
  });
  const requestStream = vi.fn(async (path: string, options: DesktopSyncRequestOptions) => {
    requests.push({ path, options });
    const source = path.includes(older.version.id) ? older.source : latest.source;
    const content = source.get(new URL(path, 'https://web.test').searchParams.get('path')!);
    if (!content) throw new Error('Requested a missing fixture file');
    return new Response(new Uint8Array(content));
  });
  const client: DesktopSyncClient = {
    getAccountId: async () => account,
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
    review,
    client,
    requests,
    requestStream,
    older,
    latest,
    marker,
    product,
    attachment,
    member,
    primerExports,
    switchAccount: () => {
      account = ORG;
    },
  };
}

describe('complete organization sequence from authenticated home history', () => {
  it.each(['current', 'history_only'] as const)(
    'reads immutable primer exports retained by %s accepted assembly records',
    async (acceptedExports) => {
      const f = await fixture({ acceptedExports });
      const result = await readOrganizationSavedSequenceSnapshot(f.review, f.client);
      for (const asset of f.primerExports)
        expect(result.members).toContainEqual({
          path: asset.path,
          contentSha256: hash(asset.content),
          contentBase64: Buffer.from(asset.content).toString('base64'),
        });
      expect(result.members).toHaveLength(6);
      expect(result.markerContent).toBe(f.marker);
    }
  );
  it('finds the exact older marker and verifies its product, history and binary attachment', async () => {
    const f = await fixture();
    const result = await readOrganizationSavedSequenceSnapshot(f.review, f.client);
    expect(result).toMatchObject({
      entityId: ENTITY,
      homeWorkspaceId: HOME,
      projectVersionId: f.older.version.id,
      markerContent: f.marker,
      productContent: f.product,
    });
    expect(result.members).toContainEqual({
      path: f.member.path,
      contentSha256: hash(f.attachment),
      contentBase64: f.attachment.toString('base64'),
    });
    expect(result.members).toHaveLength(2);
    expect(f.requests.some((request) => request.path.includes('beforeVersionNumber=2'))).toBe(true);
    for (const request of f.requests) expect(request.options.expectedAccountId).toBe(ACCOUNT);
  });
  it('refuses corrupt downloaded bytes and never substitutes fields for the missing package', async () => {
    const f = await fixture();
    f.requestStream.mockResolvedValue(new Response('corrupt'));
    await expect(readOrganizationSavedSequenceSnapshot(f.review, f.client)).rejects.toThrow(
      /digest|length/
    );
  });
  it('does not return a saved package after an account switch during download', async () => {
    const f = await fixture();
    const original = f.requestStream.getMockImplementation()!;
    f.requestStream.mockImplementation(async (path, options) => {
      const response = await original(path, options);
      f.switchAccount();
      return response;
    });
    await expect(readOrganizationSavedSequenceSnapshot(f.review, f.client)).rejects.toThrow(
      /account/
    );
  });
  it('requires an exact saved-version association before any history request', async () => {
    const f = await fixture();
    f.review.canonical.fields = { _managedSequenceProjectionVersion: 2 };
    await expect(readOrganizationSavedSequenceSnapshot(f.review, f.client)).rejects.toMatchObject({
      code: 'SAVED_VERSION_UNAVAILABLE',
    });
    expect(f.requests).toEqual([]);
  });
});
