// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSyncPublicationPolicy } from '@waypoint/share-bundle';
import {
  createHostedWorkspaceShare,
  createHostedWorkspace,
  HostedWorkspaceApiError,
  HOSTED_MANIFEST_RESPONSE_MAX_BYTES,
  HOSTED_RECOVERY_DETAIL_RESPONSE_MAX_BYTES,
  loadHostedManifest,
  loadHostedWorkspaceHistory,
  loadHostedWorkspaceIndex,
  localSignedObjectUploadUrl,
  publishHostedWorkspaceFiles,
  prepareHostedWorkspaceFiles,
  prepareHostedWorkspaceWrites,
  requestJson,
  restoreHostedWorkspaceVersion,
  hostedUploadFingerprint,
  signOutHostedWorkspace,
} from './api';

const TEST_PUBLICATION_POLICY: WorkspaceSyncPublicationPolicy = {
  schema: 'dnaforge.workspace-sync-publication-policy/v1',
  policy: {
    schemaVersion: 1,
    policyKey: 'test-expanded',
    revision: 1,
    maxFileBytes: 12 * 1024 ** 3,
    maxProjectBytes: 120 * 1024 ** 3,
    maxFiles: 2000,
    storageQuotaBytes: 240 * 1024 ** 3,
  },
  fileSelection: { supportedVersion: 1, requiredVersion: 0 },
};

afterEach(() => vi.unstubAllGlobals());

describe('initiating principal, not a background workspace-index result', () => {
  const account = (id: string) => ({
    account: { id, email: `${id}@example.test`, displayName: id },
    workspaces: [],
  });

  it('cannot turn a rejected Bob preflight into mutation authority for an Alice screen', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(account('alice')))
      .mockResolvedValueOnce(Response.json(account('bob')))
      .mockResolvedValue(Response.json({ workspaceId: 'created-under-bob' }));
    vi.stubGlobal('fetch', fetchMock);
    await loadHostedWorkspaceIndex();
    await loadHostedWorkspaceIndex();

    await expect(createHostedWorkspace('Alice project')).rejects.toMatchObject({
      code: 'account_changed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['create', () => createHostedWorkspace('Project')],
    [
      'share',
      () =>
        createHostedWorkspaceShare({ workspaceId: 'shared', expectedLatestVersionId: 'version' }),
    ],
    [
      'prepare',
      () =>
        prepareHostedWorkspaceFiles({
          workspaceId: 'shared',
          baseVersionId: null,
          baseFiles: [],
          files: [{ path: 'notes.txt', bytes: new Uint8Array([1]), contentType: 'text/plain' }],
        }),
    ],
    [
      'publish',
      () =>
        publishHostedWorkspaceFiles({
          workspaceId: 'shared',
          baseVersionId: null,
          baseFiles: [],
          files: [{ path: 'notes.txt', bytes: new Uint8Array([1]), contentType: 'text/plain' }],
        }),
    ],
    [
      'restore',
      () =>
        restoreHostedWorkspaceVersion({
          workspaceId: 'shared',
          baseVersionId: 'latest',
          revisionId: 'historical',
        }),
    ],
    [
      'generic mutation',
      () => requestJson('/api/hosted-workspaces/shared/shares', { method: 'POST' }),
    ],
  ] as const)('refuses %s without an initiating account before any request', async (_name, act) => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    await expect(act()).rejects.toMatchObject({ code: 'account_changed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins create and share to Alice even after a Bob index response', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json(account('bob'));
      expect(new Headers(init.headers).get('X-DNAForge-Account-ID')).toBe('alice');
      return Response.json({ workspaceId: 'shared', url: 'https://dnaforge.test/share' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await loadHostedWorkspaceIndex();
    await createHostedWorkspace('Alice project', 'alice');
    await createHostedWorkspaceShare({
      workspaceId: 'shared',
      expectedLatestVersionId: 'version',
      expectedAccountId: 'alice',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps ordinary GET and explicit session sign-out valid without a mutation account', async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    await requestJson('/api/hosted-workspaces');
    await signOutHostedWorkspace();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('hosted resumable upload identity', () => {
  const input = {
    accountId: 'alice',
    workspaceId: 'shared',
    endpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable/sign',
    bucket: 'workspace-snapshots',
    path: 'reservation/nonce-one',
    contentSha256: 'a'.repeat(64),
    sizeBytes: 4,
  };
  it('resumes the same actor and exact reservation deterministically', () => {
    expect(hostedUploadFingerprint(input)).toMatch(/\S/);
    expect(hostedUploadFingerprint({ ...input })).toBe(hostedUploadFingerprint(input));
  });
  it.each([
    { accountId: 'bob' },
    { path: 'reservation/nonce-two' },
    { workspaceId: 'other' },
    { endpoint: 'https://other.storage.supabase.co/storage/v1/upload/resumable/sign' },
  ])('does not reuse an old resume URL for changed authority %j', (change) => {
    expect(hostedUploadFingerprint({ ...input, ...change })).not.toBe(
      hostedUploadFingerprint(input)
    );
  });
});

describe('bounded hosted control responses', () => {
  it('reads all 2,000 accepted manifest placements and their stable identities', async () => {
    const files = Array.from({ length: 2000 }, (_, n) => ({
      path: `library/${n}.gb`,
      contentSha256: n.toString(16).padStart(64, '0'),
      sizeBytes: 1,
      contentType: 'text/plain',
    }));
    const detail = {
      workspaceId: 'workspace',
      version: {
        id: 'version',
        versionNumber: 1,
        contentSha256: 'c'.repeat(64),
        createdAt: '2026-10-05T00:00:00Z',
      },
      manifest: { schemaVersion: 1, files },
      resourceIdentities: files.map((file, n) => ({
        path: file.path,
        resourceId: `dddddddd-dddd-4ddd-8ddd-${n.toString(16).padStart(12, '0')}`,
      })),
    };
    expect(new TextEncoder().encode(JSON.stringify(detail)).byteLength).toBeGreaterThan(256 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(detail))
    );
    const result = await loadHostedManifest('workspace', 'version');
    expect(result.manifest.files).toHaveLength(2000);
    expect(result.manifest.files[1999]).toMatchObject({
      path: 'library/1999.gb',
      resourceId: detail.resourceIdentities[1999].resourceId,
    });
  });

  it.each([undefined, '1'])(
    'cancels an oversized streaming response, even with content-length %s',
    async (length) => {
      const cancel = vi.fn();
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls <= 5) controller.enqueue(new Uint8Array(100_000));
            else controller.close();
          },
          cancel,
        },
        { highWaterMark: 0 }
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(stream, {
              headers: length === undefined ? {} : { 'content-length': length },
            })
        )
      );
      await expect(requestJson('/api/hosted-workspaces')).rejects.toMatchObject({
        status: 502,
        code: 'OVERSIZED_RESPONSE',
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(pulls).toBe(3);
    }
  );

  it('bounds recovery detail using all supported paths, identities and missing-path metadata', async () => {
    const suffix = Array.from({ length: 4 }, () => '汉'.repeat(240)).join('/');
    const files = Array.from({ length: 2000 }, (_, n) => ({
      path: `library/${n}/${suffix}.gb`,
      contentSha256: 'a'.repeat(64),
      sizeBytes: 1,
      contentType: 'text/plain',
    }));
    const detail = {
      workspaceId: 'workspace',
      candidate: {
        id: 'candidate',
        baseVersionId: null,
        reason: 'invalid-package',
        coverage: 'incomplete',
        createdAt: '2026-10-05T00:00:00Z',
        expiresAt: '2026-10-12T00:00:00Z',
      },
      manifest: { schemaVersion: 1, files },
      resourceIdentities: files.map((file, n) => ({
        path: file.path,
        resourceId: `dddddddd-dddd-4ddd-8ddd-${n.toString(16).padStart(12, '0')}`,
      })),
      missingPaths: files.map((file) => file.path.replace('library/', 'missing/')),
    };
    expect(files.every((file) => file.path.length <= 1024)).toBe(true);
    const body = JSON.stringify(detail);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(
      HOSTED_RECOVERY_DETAIL_RESPONSE_MAX_BYTES
    );
    expect(HOSTED_RECOVERY_DETAIL_RESPONSE_MAX_BYTES).toBeGreaterThan(
      HOSTED_MANIFEST_RESPONSE_MAX_BYTES
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    const result = await requestJson<typeof detail>(
      '/api/hosted-workspaces/workspace/recovery-candidates/candidate',
      { headers: new Headers({ 'X-DNAForge-Account-ID': 'original-account' }) },
      { maxResponseBytes: HOSTED_RECOVERY_DETAIL_RESPONSE_MAX_BYTES }
    );
    expect(result.resourceIdentities).toHaveLength(2000);
    expect(result.missingPaths).toHaveLength(2000);
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Headers;
    expect(headers.get('X-DNAForge-Account-ID')).toBe('original-account');
  });

  it('cancels an oversized declared response without reading its body', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, {
            headers: { 'content-length': String(256 * 1024 + 1) },
          })
      )
    );
    await expect(requestJson('/api/hosted-workspaces')).rejects.toMatchObject({
      code: 'OVERSIZED_RESPONSE',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });

  it('accepts a control response exactly at the limit and rejects an invalid limit before fetching', async () => {
    const body = JSON.stringify({ value: 'x'.repeat(256 * 1024 - 12) });
    expect(new TextEncoder().encode(body).byteLength).toBe(256 * 1024);
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    expect((await requestJson<{ value: string }>('/api/hosted-workspaces')).value).toHaveLength(
      256 * 1024 - 12
    );
    await expect(
      requestJson('/api/hosted-workspaces', {}, { maxResponseBytes: 0 })
    ).rejects.toThrow('positive safe integer');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('localSignedObjectUploadUrl', () => {
  it('converts the loopback TUS endpoint into an object-scoped signed upload URL', () => {
    const result = localSignedObjectUploadUrl({
      tusEndpoint: 'http://127.0.0.1:54521/storage/v1/upload/resumable/sign',
      token: 'signed.token.value',
      bucket: 'workspace-snapshots',
      path: 'desktop-sync/cas/personal/account/digest.bin',
    });
    const url = new URL(result);
    expect(url.origin).toBe('http://127.0.0.1:54521');
    expect(url.pathname).toBe(
      '/storage/v1/object/upload/sign/workspace-snapshots/desktop-sync/cas/personal/account/digest.bin'
    );
    expect(url.searchParams.get('token')).toBe('signed.token.value');
  });

  it('rejects hosted origins so the non-resumable adapter cannot replace production TUS', () => {
    expect(() =>
      localSignedObjectUploadUrl({
        tusEndpoint: 'https://project-ref.storage.supabase.co/storage/v1/upload/resumable/sign',
        token: 'signed.token.value',
        bucket: 'workspace-snapshots',
        path: 'desktop-sync/cas/personal/account/digest.bin',
      })
    ).toThrowError(HostedWorkspaceApiError);
  });

  it.each(['../escape.bin', '/absolute.bin', 'nested//empty.bin', 'nested\\escape.bin'])(
    'rejects unsafe object path %s',
    (path) => {
      expect(() =>
        localSignedObjectUploadUrl({
          tusEndpoint: 'http://localhost:54521/storage/v1/upload/resumable/sign',
          token: 'signed.token.value',
          bucket: 'workspace-snapshots',
          path,
        })
      ).toThrowError(HostedWorkspaceApiError);
    }
  );
});

describe('hosted immutable history', () => {
  it('waits for package inspection using the identical guarded result request and owner', async () => {
    vi.useFakeTimers();
    try {
      const requests: RequestInit[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
            return Response.json(TEST_PUBLICATION_POLICY);
          if (url.endsWith('/blobs/reserve')) return Response.json({ status: 'ready' });
          requests.push(init!);
          return requests.length === 1
            ? Response.json(
                { error: 'SEQUENCE_PACKAGE_ADMISSION_PENDING', message: 'Verifying' },
                { status: 503 }
              )
            : Response.json({
                status: 'ready',
                version: { id: 'accepted', versionNumber: 2, contentSha256: 'c'.repeat(64) },
              });
        })
      );
      const condition = {
        kind: 'managed-operation-result' as const,
        operationId: '11111111-1111-4111-8111-111111111111',
        inputRevision: `pairwise-session-alignment-v1:sha256:${'a'.repeat(64)}`,
        baseRevisionId: '22222222-2222-4222-8222-222222222222',
        outputPath: 'contents/reference.gb.waypoint.json',
      };
      const result = publishHostedWorkspaceFiles({
        expectedAccountId: 'alice',
        workspaceId: '33333333-3333-4333-8333-333333333333',
        baseVersionId: condition.baseRevisionId,
        baseFiles: [],
        publicationCondition: condition,
        files: [
          {
            path: condition.outputPath,
            bytes: new TextEncoder().encode('{}'),
            contentType: 'application/json',
          },
        ],
      }).then(
        (value) => value,
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1500);
      expect(await result).toMatchObject({ id: 'accepted' });
      expect(requests).toHaveLength(2);
      expect(requests[1].body).toBe(requests[0].body);
      expect(requests[1].method).toBe(requests[0].method);
      expect([...new Headers(requests[1].headers)]).toEqual([...new Headers(requests[0].headers)]);
      expect(JSON.parse(String(requests[0].body))).toMatchObject({
        publicationCondition: condition,
        baseVersionId: condition.baseRevisionId,
      });
      expect(new Headers(requests[0].headers).get('X-DNAForge-Account-ID')).toBe('alice');
      expect(new Headers(requests[0].headers).get('Idempotency-Key')!.length).toBeLessThanOrEqual(
        200
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('publishes rename identity outside the immutable manifest and retains unchanged identities', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
        return Response.json(TEST_PUBLICATION_POLICY);
      if (url.endsWith('/blobs/reserve')) {
        return Response.json({ status: 'ready' });
      }
      expect(url).toBe('/api/hosted-workspaces/workspace-1/versions');
      const body = JSON.parse(String(init?.body));
      expect(body.manifest.files.map((file: { path: string }) => file.path).sort()).toEqual([
        'notes/unchanged.md',
        'sequences/renamed.gbk',
      ]);
      expect(body.resourceIdentities).toEqual([
        { path: 'notes/unchanged.md', resourceId: 'resource-2' },
        { path: 'sequences/renamed.gbk', resourceId: 'resource-1' },
      ]);
      expect(body.manifest.files.every((file: object) => !('resourceId' in file))).toBe(true);
      return Response.json({
        status: 'ready',
        version: { id: 'version-3', versionNumber: 3, contentSha256: 'c'.repeat(64) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await publishHostedWorkspaceFiles({
      expectedAccountId: 'account-1',
      workspaceId: 'workspace-1',
      baseVersionId: 'version-2',
      baseFiles: [
        {
          resourceId: 'resource-1',
          path: 'sequences/one.gbk',
          contentSha256: '1'.repeat(64),
          sizeBytes: 2,
          contentType: 'application/genbank',
        },
        {
          resourceId: 'resource-2',
          path: 'notes/unchanged.md',
          contentSha256: '2'.repeat(64),
          sizeBytes: 3,
          contentType: 'text/markdown',
        },
      ],
      files: [
        {
          resourceId: 'resource-1',
          path: 'sequences/renamed.gbk',
          bytes: new Uint8Array([1, 2]),
          contentType: 'application/genbank',
        },
      ],
      removePaths: ['sequences/one.gbk'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not borrow an existing identity for a new copy with identical contents', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
        return Response.json(TEST_PUBLICATION_POLICY);
      if (url.endsWith('/blobs/reserve')) return Response.json({ status: 'ready' });
      const body = JSON.parse(String(init?.body));
      expect(body.resourceIdentities).toEqual([
        { path: 'sequences/one.gbk', resourceId: 'resource-1' },
      ]);
      expect(body.manifest.files).toHaveLength(2);
      return Response.json({
        status: 'ready',
        version: { id: 'version-3', versionNumber: 3, contentSha256: 'c'.repeat(64) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await publishHostedWorkspaceFiles({
      expectedAccountId: 'account-1',
      workspaceId: 'workspace-1',
      baseVersionId: 'version-2',
      baseFiles: [
        {
          resourceId: 'resource-1',
          path: 'sequences/one.gbk',
          contentSha256: '1'.repeat(64),
          sizeBytes: 2,
          contentType: 'application/genbank',
        },
      ],
      files: [
        {
          resourceId: null,
          path: 'sequences/copy.gbk',
          bytes: new Uint8Array([1, 2]),
          contentType: 'application/genbank',
        },
      ],
    });
  });

  it('loads the authorized workspace revision list', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workspaceId: 'workspace-1',
            versions: [],
            nextBeforeVersionNumber: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadHostedWorkspaceHistory('workspace-1')).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      versions: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/hosted-workspaces/workspace-1/versions?limit=100',
      expect.objectContaining({ credentials: 'same-origin' })
    );
  });

  it('restores a historical manifest as a new compare-and-swap revision', async () => {
    const file = {
      path: 'sequences/one.gbk',
      contentSha256: '1'.repeat(64),
      sizeBytes: 10,
      contentType: 'application/genbank',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: 'workspace-1',
            version: {
              id: 'version-1',
              versionNumber: 1,
              contentSha256: 'a'.repeat(64),
              createdAt: '2026-09-18T09:00:00.000Z',
            },
            manifest: { schemaVersion: 1, files: [file] },
            resourceIdentities: [{ path: file.path, resourceId: 'resource-1' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(Response.json(TEST_PUBLICATION_POLICY))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'ready',
            version: {
              id: 'version-3',
              versionNumber: 3,
              contentSha256: 'c'.repeat(64),
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      restoreHostedWorkspaceVersion({
        expectedAccountId: 'account-1',
        workspaceId: 'workspace-1',
        baseVersionId: 'version-2',
        revisionId: 'version-1',
      })
    ).resolves.toMatchObject({ id: 'version-3', versionNumber: 3, files: [file] });

    const publishCall = fetchMock.mock.calls[2];
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/hosted-workspaces/workspace-1/storage-policy?fileSelectionVersion=1'
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-DNAForge-Account-ID')).toBe(
      'account-1'
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-DNAForge-Account-ID')).toBe(
      'account-1'
    );
    expect(new Headers(publishCall?.[1]?.headers).get('X-DNAForge-Account-ID')).toBe('account-1');
    expect(publishCall?.[0]).toBe('/api/hosted-workspaces/workspace-1/versions');
    expect(JSON.parse(String((publishCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      baseVersionId: 'version-2',
      fileSelectionVersion: 1,
      manifest: { schemaVersion: 1, files: [file] },
      resourceIdentities: [{ path: file.path, resourceId: 'resource-1' }],
    });
  });
});

describe('hosted public share publishing', () => {
  it('pins the accepted revision through the cookie-authenticated hosted route', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workspaceId: 'workspace-1',
            revisionPolicy: 'pinned_version',
            pinnedVersion: {
              id: 'version-2',
              versionNumber: 2,
              contentSha256: 'a'.repeat(64),
              sizeBytes: 123,
              fileCount: 1,
              createdAt: '2026-09-30T00:00:00.000Z',
            },
            share: {
              id: 'share-1',
              shortId: 'share12345',
              linkToken: 'opaque-token',
              url: 'https://dnaforge.com/d/share12345#token=opaque-token',
              scopeMode: 'anyone-with-link',
              displayLabel: 'Public sequence',
              expiresAt: null,
              createdAt: '2026-09-30T00:01:00.000Z',
            },
            short_id: 'share12345',
            link_token: 'opaque-token',
            url: 'https://dnaforge.com/d/share12345#token=opaque-token',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createHostedWorkspaceShare({
        expectedAccountId: 'account-1',
        workspaceId: 'workspace-1',
        expectedLatestVersionId: 'version-2',
        displayLabel: 'Public sequence',
      })
    ).resolves.toMatchObject({
      revisionPolicy: 'pinned_version',
      url: 'https://dnaforge.com/d/share12345#token=opaque-token',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/hosted-workspaces/workspace-1/shares',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({
          mode: 'pinned',
          expectedLatestVersionId: 'version-2',
          scopeMode: 'anyone-with-link',
          displayLabel: 'Public sequence',
        }),
      })
    );
  });
});

describe('bounded browser blob preparation', () => {
  it('reuses exact retained upload metadata while still requesting fresh server publication', async () => {
    const files = [
      {
        path: 'query.fasta',
        bytes: new TextEncoder().encode('>query\nACGT\n'),
        contentType: 'text/plain',
      },
    ];
    const input = {
      workspaceId: 'workspace',
      expectedAccountId: 'alice',
      baseVersionId: null,
      baseFiles: [],
      files,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
        return Response.json(TEST_PUBLICATION_POLICY);
      if (url.endsWith('/blobs/reserve')) return Response.json({ status: 'ready' });
      expect(url).toBe('/api/hosted-workspaces/workspace/versions');
      expect(new Headers(init?.headers).get('X-DNAForge-Account-ID')).toBe('alice');
      return Response.json(
        { error: 'FORBIDDEN', message: 'Membership was revoked.' },
        { status: 403 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const retained = await prepareHostedWorkspaceFiles(input);
    await expect(publishHostedWorkspaceFiles(input, retained)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/hosted-workspaces/workspace/blobs/reserve',
      '/api/hosted-workspaces/workspace/storage-policy?fileSelectionVersion=1',
      '/api/hosted-workspaces/workspace/versions',
    ]);
  });

  it('prepares changed bytes instead of publishing stale retained transfer metadata', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
        return Response.json(TEST_PUBLICATION_POLICY);
      if (url.endsWith('/blobs/reserve')) return Response.json({ status: 'ready' });
      const body = JSON.parse(String(init?.body));
      expect(body.manifest.files[0].contentSha256).not.toBe('a'.repeat(64));
      return Response.json({
        status: 'ready',
        version: { id: 'accepted', versionNumber: 1, contentSha256: 'b'.repeat(64) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await publishHostedWorkspaceFiles(
      {
        workspaceId: 'workspace',
        expectedAccountId: 'alice',
        baseVersionId: null,
        baseFiles: [],
        files: [
          {
            path: 'query.fasta',
            bytes: new TextEncoder().encode('changed'),
            contentType: 'text/plain',
          },
        ],
      },
      [
        {
          path: 'query.fasta',
          contentSha256: 'a'.repeat(64),
          sizeBytes: 7,
          contentType: 'text/plain',
        },
      ]
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/hosted-workspaces/workspace/blobs/reserve',
      '/api/hosted-workspaces/workspace/storage-policy?fileSelectionVersion=1',
      '/api/hosted-workspaces/workspace/versions',
    ]);
  });

  it('prepares the complete future manifest only after its new immutable bytes are verified', async () => {
    let release!: () => void;
    let entered!: () => void;
    const reserved = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const verified = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push(url);
        expect(new Headers(init?.headers).get('X-DNAForge-Account-ID')).toBe('alice');
        if (url.endsWith('/blobs/reserve')) {
          entered();
          await verified;
          return Response.json({ status: 'ready' });
        }
        expect(url).toBe('/api/hosted-workspaces/workspace/package-admission');
        const body = JSON.parse(String(init?.body));
        expect(body.baseVersionId).toBeNull();
        expect(body.manifest.files.map((file: { path: string }) => file.path)).toEqual([
          'query.fasta',
          'reference.gb',
        ]);
        expect(
          body.manifest.files.find((file: { path: string }) => file.path === 'query.fasta')
            .contentSha256
        ).toMatch(/^[a-f0-9]{64}$/);
        return Response.json({ status: 'pending' }, { status: 202 });
      })
    );
    const pending = prepareHostedWorkspaceWrites({
      workspaceId: 'workspace',
      expectedAccountId: 'alice',
      baseFiles: ['obsolete.fasta', 'reference.gb'].map((path) => ({
        path,
        contentSha256: 'a'.repeat(64),
        sizeBytes: 10,
        contentType: 'text/plain',
      })),
      files: [
        {
          path: 'query.fasta',
          bytes: new TextEncoder().encode('>query\nACGT\n'),
          contentType: 'text/plain',
        },
      ],
      removePaths: ['obsolete.fasta'],
    });
    await reserved;
    expect(requests).toHaveLength(1);
    release();
    await pending;
    expect(requests).toHaveLength(2);
    expect(requests.some((url) => url.endsWith('/versions'))).toBe(false);
  });

  it('shares one immutable upload for identical bytes at different project paths', async () => {
    let reserves = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
          return Response.json(TEST_PUBLICATION_POLICY);
        if (url.endsWith('/blobs/reserve')) {
          reserves += 1;
          return Response.json({ status: 'ready' });
        }
        const body = JSON.parse(String(init?.body));
        expect(body.manifest.files.map((file: { path: string }) => file.path)).toEqual([
          'copy.fasta',
          'original.fasta',
        ]);
        return Response.json({
          status: 'ready',
          version: { id: 'accepted', versionNumber: 1, contentSha256: 'a'.repeat(64) },
        });
      })
    );
    const bytes = new TextEncoder().encode('>same\nACGT\n');
    await publishHostedWorkspaceFiles({
      workspaceId: 'workspace',
      expectedAccountId: 'alice',
      baseVersionId: null,
      baseFiles: [],
      files: [
        { path: 'original.fasta', bytes, contentType: 'text/plain' },
        { path: 'copy.fasta', bytes, contentType: 'text/plain' },
      ],
    });
    expect(reserves).toBe(1);
  });

  const files = Array.from({ length: 9 }, (_, index) => ({
    path: `input-${index}.fasta`,
    bytes: new TextEncoder().encode(`>input-${index}\nACGT\n`),
    contentType: 'text/plain',
  }));

  it('shares the four-transfer bound across independent durable operations', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toMatch(/\/blobs\/reserve$/);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return Response.json({ status: 'ready' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const preparations = [files.slice(0, 5), files.slice(5)].map((batch) =>
      prepareHostedWorkspaceWrites({
        workspaceId: 'workspace',
        expectedAccountId: 'alice',
        files: batch,
      })
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(active).toBe(4);
    for (let index = 0; index < files.length; index += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));
      releases[index]();
    }
    await Promise.all(preparations);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(files.length);
  });

  it('joins an in-flight staged blob before publishing the original immutable revision', async () => {
    let release!: () => void;
    let reservations = 0;
    let publications = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
          return Response.json(TEST_PUBLICATION_POLICY);
        if (url.endsWith('/blobs/reserve')) {
          reservations += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return Response.json({ status: 'ready' });
        }
        publications += 1;
        return Response.json({
          status: 'ready',
          version: { id: 'accepted', versionNumber: 1, contentSha256: 'a'.repeat(64) },
        });
      })
    );
    const staged = prepareHostedWorkspaceWrites({
      workspaceId: 'workspace',
      expectedAccountId: 'alice',
      files: [files[0]],
    });
    await vi.waitFor(() => expect(reservations).toBe(1));
    let preparing!: () => void;
    const prepared = new Promise<void>((resolve) => {
      preparing = resolve;
    });
    const publication = publishHostedWorkspaceFiles({
      workspaceId: 'workspace',
      expectedAccountId: 'alice',
      baseVersionId: null,
      baseFiles: [],
      files: [files[0]],
      onProgress: () => preparing(),
    });
    await prepared;
    expect(reservations).toBe(1);
    expect(publications).toBe(0);
    release();
    await Promise.all([staged, publication]);
    expect(reservations).toBe(1);
    expect(publications).toBe(1);
  });

  it('starts independent verification requests together, caps active transfers, and publishes only after all are ready', async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    let published = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('X-DNAForge-Account-ID')).toBe('alice');
        if (url.endsWith('/storage-policy?fileSelectionVersion=1'))
          return Response.json(TEST_PUBLICATION_POLICY);
        if (url.endsWith('/blobs/reserve')) {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => pending.push(resolve));
          active -= 1;
          return Response.json({ status: 'ready' });
        }
        expect(active).toBe(0);
        expect(pending).toHaveLength(files.length);
        published = true;
        return Response.json({
          status: 'ready',
          version: { id: 'accepted', versionNumber: 1, contentSha256: 'a'.repeat(64) },
        });
      })
    );
    const progress: number[] = [];
    const result = publishHostedWorkspaceFiles({
      workspaceId: 'workspace',
      expectedAccountId: 'alice',
      baseVersionId: null,
      baseFiles: [],
      files,
      onProgress: (sent) => progress.push(sent),
    });
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(4));
      expect(published).toBe(false);
      pending.slice(0, 4).forEach((resolve) => resolve());
      await vi.waitFor(() => expect(pending).toHaveLength(8));
      expect(published).toBe(false);
      pending.slice(4, 8).forEach((resolve) => resolve());
      await vi.waitFor(() => expect(pending).toHaveLength(9));
      expect(published).toBe(false);
      pending[8]();
      await expect(result).resolves.toMatchObject({ id: 'accepted' });
      expect(peak).toBe(4);
      expect(progress.at(-1)).toBe(files.reduce((sum, file) => sum + file.bytes.byteLength, 0));
      expect(progress.every((sent, index) => index === 0 || sent >= progress[index - 1])).toBe(
        true
      );
    } finally {
      for (let round = 0; round < files.length; round += 1) {
        pending.forEach((resolve) => resolve());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await result.catch(() => undefined);
    }
  });

  it('settles active transfers after a failure without starting another batch or publishing a partial version', async () => {
    const pending: Array<(response: Response) => void> = [];
    let versionRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/blobs/reserve'))
          return new Promise<Response>((resolve) => pending.push(resolve));
        versionRequests += 1;
        return Response.json({});
      })
    );
    let settled = false;
    const result = publishHostedWorkspaceFiles({
      workspaceId: 'workspace',
      expectedAccountId: 'alice',
      baseVersionId: null,
      baseFiles: [],
      files,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(4));
      pending[0](Response.json({ error: 'FORBIDDEN', message: 'Access revoked' }, { status: 403 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      pending.slice(1, 4).forEach((resolve) => resolve(Response.json({ status: 'ready' })));
      expect(await result).toMatchObject({ code: 'FORBIDDEN' });
      expect(pending).toHaveLength(4);
      expect(versionRequests).toBe(0);
    } finally {
      pending.forEach((resolve) =>
        resolve(Response.json({ error: 'FORBIDDEN', message: 'Access revoked' }, { status: 403 }))
      );
      await result;
    }
  });
});
