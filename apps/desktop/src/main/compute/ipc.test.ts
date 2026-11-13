import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from('enc::' + s, 'utf8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf8').slice(5)),
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => h.isEncryptionAvailable(),
    encryptString: (s: string) => h.encryptString(s),
    decryptString: (b: Buffer) => h.decryptString(b),
  },
}));

import { COMPUTE_CREDENTIAL_HEADER } from '../../shared/compute-ipc';
import { deleteCredential, hasCredential, writeCredential } from '../ipc/keyring';
import {
  hasComputeCredential,
  readComputeCredential,
  resetComputeCredentialCache,
} from './credentials';
import { createComputeIpcHandlers } from './ipc';

const SECRET = 'tmr-live-ABCDEFGHIJKLMNOP';

interface Seen {
  url: string;
  method: string;
  credential: string | null;
  body: unknown;
}

function fakeSidecar(script: {
  verify?: (seen: Seen) => Response;
  providers?: () => Response;
  validateManifest?: (seen: Seen) => Response;
}) {
  const seen: Seen[] = [];
  let validatedCustomProvider: unknown;
  const sidecarFetch = async (pathOrUrl: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(pathOrUrl);
    const headers = new Headers(init?.headers);
    const record: Seen = {
      url,
      method: init?.method ?? 'GET',
      credential: headers.get(COMPUTE_CREDENTIAL_HEADER),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    seen.push(record);
    if (url.endsWith('/verify')) {
      return (
        script.verify?.(record) ??
        new Response(JSON.stringify({ provider: 'tamarind', ok: true, tool_count: 3 }), {
          status: 200,
        })
      );
    }
    if (url === '/compute/providers/validate-manifest') {
      const response =
        script.validateManifest?.(record) ??
        new Response(
          JSON.stringify({
            id: 'runpod-lab',
            display_name: 'Lab Runpod',
            summary: 'Run one user-owned Runpod Serverless endpoint.',
            transport: 'rest',
            driver: 'http-job',
            custom: true,
            auth_scheme: 'header',
            credential_header: 'authorization',
            endpoint_url: 'https://api.runpod.ai/v2/lab',
            verify_target: '/health',
            catalog: 'static',
            job_model: 'async',
            cost: 'rate-card',
            disclosure: 'Lab Runpod bills your Runpod account.',
            retention_note: 'Import promptly.',
            cancellation_mode: 'provider',
            cancellation_note: 'Runpod accepts cancellation.',
            docs_url: 'https://docs.runpod.io/serverless/endpoints/overview',
            key_page_url: 'https://www.runpod.io/console/user/settings',
            terms_url: 'https://www.runpod.io/legal/terms-of-service',
            privacy_url: 'https://www.runpod.io/legal/privacy-policy',
            has_binding: true,
          }),
          { status: 200 }
        );
      if (response.ok) validatedCustomProvider = await response.clone().json();
      return response;
    }
    if (url === '/compute/providers') {
      return (
        script.providers?.() ??
        new Response(
          JSON.stringify({
            providers: [
              ...(validatedCustomProvider &&
              existsSync(join(h.dir, 'compute-endpoints', 'runpod-lab.json'))
                ? [validatedCustomProvider]
                : []),
              {
                id: 'tamarind',
                display_name: 'Tamarind Bio',
                summary: 'Protein and molecular modeling tools.',
                transport: 'mcp',
                driver: 'mcp-tool-map',
                custom: false,
                auth_scheme: 'header',
                credential_header: 'x-api-key',
                endpoint_url: 'https://mcp.tamarind.bio/mcp',
                verify_target: 'listModalities',
                catalog: 'dynamic',
                job_model: 'queue',
                cost: 'estimate',
                disclosure: 'Tamarind Bio bills your account.',
                retention_note: 'n/a',
                cancellation_mode: 'provider',
                cancellation_note: 'Queued or running jobs can be canceled.',
                docs_url: 'https://app.tamarind.bio/api-docs',
                key_page_url: 'https://app.tamarind.bio/api-docs/api-key',
                terms_url: 'https://app.tamarind.bio/terms-of-service',
                privacy_url: 'https://app.tamarind.bio/privacy-policy',
                has_binding: true,
              },
              {
                id: 'subseq',
                display_name: 'subseq.bio',
                summary: 'Run hosted command-line bioinformatics tools.',
                transport: 'rest',
                driver: 'legacy-rest',
                custom: false,
                auth_scheme: 'header',
                credential_header: 'authorization',
                endpoint_url: 'https://api.subseq.bio/api/v1',
                verify_target: '/account/info',
                catalog: 'dynamic',
                job_model: 'async',
                cost: 'rate-card',
                disclosure: 'subseq.bio bills your account.',
                retention_note: 'n/a',
                cancellation_mode: 'provider',
                cancellation_note: 'Queued or running jobs can be canceled.',
                docs_url: 'https://subseq.bio/docs/api',
                key_page_url: 'https://subseq.bio/',
                terms_url: 'https://subseq.bio/terms',
                privacy_url: 'https://subseq.bio/terms',
                has_binding: false,
              },
            ],
          }),
          { status: 200 }
        )
      );
    }
    return new Response('not found', { status: 404 });
  };
  return { sidecarFetch, seen };
}

function detail(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ detail: { error, provider: 'tamarind', message } }), {
    status,
  });
}

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'fixture-compute-'));
  h.isEncryptionAvailable.mockClear().mockImplementation(() => true);
  h.encryptString.mockClear();
  h.decryptString.mockClear();
  resetComputeCredentialCache();
});

describe('shared credential changes made by another app', () => {
  it('observes replacement and disconnection after an earlier compute read', async () => {
    await writeCredential('dnaforge', 'tamarind_compute_key', 'technical-original-key');
    expect(await readComputeCredential('tamarind')).toBe('technical-original-key');
    await writeCredential('dnaforge', 'tamarind_compute_key', 'technical-replacement-key');
    expect(await readComputeCredential('tamarind')).toBe('technical-replacement-key');
    await deleteCredential('dnaforge', 'tamarind_compute_key');
    expect(await hasComputeCredential('tamarind')).toBe(false);
    expect(await readComputeCredential('tamarind')).toBeNull();
  });
});

describe('connect', () => {
  it('verifies against the sidecar, then writes the keychain, then reports verified', async () => {
    const sidecar = fakeSidecar({});
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => ['external-compute:discover'],
      now: () => new Date('2026-09-09T20:00:00Z'),
    });
    const result = await handlers.connect('tamarind', `  ${SECRET}\n`);
    expect(result).toEqual({
      ok: true,
      providerId: 'tamarind',
      toolCount: 3,
      verifiedAt: '2026-09-09T20:00:00.000Z',
    });
    expect(sidecar.seen).toHaveLength(1);
    expect(sidecar.seen[0]).toMatchObject({
      url: '/compute/tamarind/verify',
      method: 'POST',
      credential: SECRET,
      body: { granted_capabilities: ['external-compute:discover'] },
    });
    expect(await hasCredential('dnaforge', 'tamarind_compute_key')).toBe(true);
    expect(await readComputeCredential('tamarind')).toBe(SECRET);
  });

  it('does NOT save when the provider rejects the key, and reports the stable failure kind', async () => {
    const sidecar = fakeSidecar({
      verify: () => detail(401, 'bad_credential', 'tamarind: rejected credential (401)'),
    });
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
    });
    const result = await handlers.connect('tamarind', SECRET);
    expect(result).toEqual({
      ok: false,
      kind: 'bad_credential',
      message: 'tamarind: rejected credential (401)',
    });
    expect(await hasComputeCredential('tamarind')).toBe(false);
    expect(h.encryptString).not.toHaveBeenCalled();
  });

  it('maps budget, provider-down, and unknown-provider failures', async () => {
    for (const [status, kind] of [
      [402, 'budget_exhausted'],
      [503, 'provider_unavailable'],
      [404, 'unknown_provider'],
    ] as const) {
      const sidecar = fakeSidecar({ verify: () => detail(status, kind, 'm') });
      const handlers = createComputeIpcHandlers({
        sidecarFetch: sidecar.sidecarFetch,
        grantedCapabilities: () => [],
      });
      expect(await handlers.connect('tamarind', SECRET)).toMatchObject({ ok: false, kind });
    }
  });

  it('treats an unreachable sidecar as sidecar_unavailable without saving', async () => {
    const handlers = createComputeIpcHandlers({
      sidecarFetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      grantedCapabilities: () => [],
    });
    expect(await handlers.connect('tamarind', SECRET)).toMatchObject({
      ok: false,
      kind: 'sidecar_unavailable',
    });
    expect(await hasComputeCredential('tamarind')).toBe(false);
  });

  it('rejects obviously malformed keys before contacting anyone', async () => {
    const sidecar = fakeSidecar({});
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
    });
    expect(await handlers.connect('tamarind', 'short')).toMatchObject({
      ok: false,
      kind: 'bad_key_format',
    });
    expect(await handlers.connect('tamarind', 'has a space inside it')).toMatchObject({
      ok: false,
      kind: 'bad_key_format',
    });
    expect(sidecar.seen).toEqual([]);
  });

  it('reports keychain_unavailable when encryption is off, after a successful verify', async () => {
    h.isEncryptionAvailable.mockImplementation(() => false);
    const sidecar = fakeSidecar({});
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
    });
    expect(await handlers.connect('tamarind', SECRET)).toMatchObject({
      ok: false,
      kind: 'keychain_unavailable',
    });
  });
});

describe('test / disconnect / listProviders', () => {
  it('test re-verifies the stored key without the renderer ever seeing it', async () => {
    const sidecar = fakeSidecar({});
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
    });
    expect(await handlers.test('tamarind')).toMatchObject({
      ok: false,
      kind: 'missing_credential',
    });
    await handlers.connect('tamarind', SECRET);
    const result = await handlers.test('tamarind');
    expect(result).toMatchObject({ ok: true, toolCount: 3 });
    expect(sidecar.seen.at(-1)?.credential).toBe(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('disconnect deletes the keychain entry and the cache', async () => {
    const sidecar = fakeSidecar({});
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
    });
    await handlers.connect('tamarind', SECRET);
    expect(await handlers.disconnect('tamarind')).toEqual({
      ok: true,
      providerId: 'tamarind',
      removed: true,
    });
    expect(await hasComputeCredential('tamarind')).toBe(false);
    expect(await readComputeCredential('tamarind')).toBeNull();
    expect(await handlers.disconnect('tamarind')).toEqual({
      ok: true,
      providerId: 'tamarind',
      removed: false,
    });
  });

  it('listProviders merges sidecar manifests with local connection state', async () => {
    const sidecar = fakeSidecar({});
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
      now: () => new Date('2026-09-09T20:00:00Z'),
    });
    await handlers.connect('tamarind', SECRET);
    const providers = await handlers.listProviders();
    expect(providers.map((p) => [p.id, p.connected, p.hasBinding, p.lastVerifiedAt])).toEqual([
      ['tamarind', true, true, '2026-09-09T20:00:00.000Z'],
      ['subseq', false, false, null],
    ]);
    expect(providers[0]).toMatchObject({
      displayName: 'Tamarind Bio',
      summary: 'Protein and molecular modeling tools.',
      authScheme: 'header',
      cancellationMode: 'provider',
      cancellationNote: 'Queued or running jobs can be canceled.',
      keyPageUrl: 'https://app.tamarind.bio/api-docs/api-key',
    });
    expect(JSON.stringify(providers)).not.toContain(SECRET);
  });

  it('listProviders surfaces a sidecar outage as a thrown error, not an empty list', async () => {
    const sidecar = fakeSidecar({ providers: () => new Response('{}', { status: 503 }) });
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
    });
    await expect(handlers.listProviders()).rejects.toThrow(/sidecar_unavailable/);
  });
});

describe('custom provider manifests', () => {
  const runpodManifest = {
    schemaVersion: 2,
    id: 'runpod-lab',
    displayName: 'Lab Runpod',
    summary: 'Run one user-owned Runpod Serverless endpoint.',
    docsUrl: 'https://docs.runpod.io/serverless/endpoints/overview',
    keyPageUrl: 'https://www.runpod.io/console/user/settings',
    termsUrl: 'https://www.runpod.io/legal/terms-of-service',
    privacyUrl: 'https://www.runpod.io/legal/privacy-policy',
    transport: 'rest',
    baseUrl: 'https://api.runpod.ai/v2/abc123',
    driver: {
      kind: 'http-job',
      submit: { method: 'POST', idPath: 'id', bodyTemplate: { input: '$settings' } },
      status: {
        method: 'GET',
        pathTemplate: '/status/{remote_id}',
        statePath: 'status',
        statusMap: {
          IN_QUEUE: 'queued',
          IN_PROGRESS: 'running',
          COMPLETED: 'completed',
          FAILED: 'failed',
          CANCELLED: 'canceled',
          TIMED_OUT: 'failed',
        },
      },
      result: { payloadPath: 'output', codec: 'raw-json' },
      cancel: {
        method: 'POST',
        pathTemplate: '/cancel/{remote_id}',
        statePath: 'status',
      },
    },
    auth: { scheme: 'header', headerName: 'authorization' },
    verify: { method: 'GET', target: '/health', expectKey: 'jobs' },
    catalog: 'static',
    jobModel: 'async',
    staging: 'inline',
    cost: 'rate-card',
    staticTools: [
      {
        id: 'endpoint',
        displayName: 'Runpod endpoint',
        path: '/run',
        outputKind: 'binary',
        description: 'Run the configured endpoint with its native JSON input.',
        inputSchema: { type: 'object' },
      },
    ],
    disclosure:
      'This sends inputs to Lab Runpod under your own Runpod account. Lab Runpod bills that account; DNAForge does not charge for it.',
    retentionNote: 'Runpod keeps completed job results for a limited period. Import promptly.',
    cancellation: { mode: 'provider', note: 'Runpod accepts cancellation for active jobs.' },
    rateLimitRps: 2,
  };

  it('validates, atomically persists, and restarts before reporting an installed endpoint', async () => {
    const sidecar = fakeSidecar({});
    const restartSidecar = vi.fn(async () => undefined);
    const manifestDir = join(h.dir, 'compute-endpoints');
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => ['external-compute:discover'],
      userManifestsDir: manifestDir,
      restartSidecar,
    });

    const result = await handlers.installManifest(JSON.stringify(runpodManifest));

    expect(result).toMatchObject({ ok: true, providerId: 'runpod-lab', displayName: 'Lab Runpod' });
    expect(restartSidecar).toHaveBeenCalledTimes(1);
    expect(readdirSync(manifestDir)).toEqual(['runpod-lab.json']);
    expect(JSON.parse(readFileSync(join(manifestDir, 'runpod-lab.json'), 'utf8'))).toMatchObject({
      id: 'runpod-lab',
      schemaVersion: 2,
      driver: { kind: 'http-job' },
    });
    expect(
      sidecar.seen.find((entry) => entry.url.endsWith('validate-manifest'))?.body
    ).toMatchObject({
      granted_capabilities: ['external-compute:discover'],
      manifest: { id: 'runpod-lab' },
    });
  });

  it('does not write or restart when a custom manifest is malformed or rejected', async () => {
    const sidecar = fakeSidecar({
      validateManifest: () =>
        new Response(
          JSON.stringify({ detail: { error: 'provider_id_conflict', message: 'duplicate' } }),
          { status: 409 }
        ),
    });
    const restartSidecar = vi.fn(async () => undefined);
    const manifestDir = join(h.dir, 'compute-endpoints');
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
      userManifestsDir: manifestDir,
      restartSidecar,
    });

    await expect(handlers.installManifest('{bad json')).resolves.toMatchObject({
      ok: false,
      kind: 'invalid_manifest',
    });
    await expect(handlers.installManifest(JSON.stringify(runpodManifest))).resolves.toMatchObject({
      ok: false,
      kind: 'provider_id_conflict',
    });
    expect(existsSync(manifestDir)).toBe(false);
    expect(restartSidecar).not.toHaveBeenCalled();
  });

  it('removes only a custom provider, its key, and its persisted manifest', async () => {
    const customProvider = {
      id: 'runpod-lab',
      display_name: 'Lab Runpod',
      summary: 'Run one user-owned Runpod Serverless endpoint.',
      transport: 'rest',
      driver: 'http-job',
      custom: true,
      auth_scheme: 'header',
      credential_header: 'authorization',
      endpoint_url: 'https://api.runpod.ai/v2/lab',
      verify_target: '/health',
      catalog: 'static',
      job_model: 'async',
      cost: 'rate-card',
      disclosure: 'Lab Runpod bills your Runpod account.',
      retention_note: 'Import promptly.',
      cancellation_mode: 'provider',
      cancellation_note: 'Runpod accepts cancellation.',
      docs_url: 'https://docs.runpod.io/serverless/endpoints/overview',
      key_page_url: 'https://www.runpod.io/console/user/settings',
      terms_url: 'https://www.runpod.io/legal/terms-of-service',
      privacy_url: 'https://www.runpod.io/legal/privacy-policy',
      has_binding: true,
    };
    const sidecar = fakeSidecar({
      providers: () =>
        new Response(
          JSON.stringify({
            providers: existsSync(join(h.dir, 'compute-endpoints', 'runpod-lab.json'))
              ? [customProvider]
              : [],
          }),
          { status: 200 }
        ),
    });
    const restartSidecar = vi.fn(async () => undefined);
    const manifestDir = join(h.dir, 'compute-endpoints');
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => ['external-compute:discover'],
      userManifestsDir: manifestDir,
      restartSidecar,
    });

    expect(await handlers.installManifest(JSON.stringify(runpodManifest))).toMatchObject({
      ok: true,
    });
    expect(await handlers.connect('runpod-lab', 'runpod-secret-key')).toMatchObject({ ok: true });
    expect(await hasComputeCredential('runpod-lab')).toBe(true);

    await expect(handlers.removeCustomProvider('runpod-lab')).resolves.toEqual({
      ok: true,
      providerId: 'runpod-lab',
      removedCredential: true,
    });
    expect(restartSidecar).toHaveBeenCalledTimes(2);
    expect(existsSync(join(manifestDir, 'runpod-lab.json'))).toBe(false);
    expect(await hasComputeCredential('runpod-lab')).toBe(false);
  });

  it('refuses to remove a bundled provider without touching disk or restarting', async () => {
    const sidecar = fakeSidecar({});
    const restartSidecar = vi.fn(async () => undefined);
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
      userManifestsDir: join(h.dir, 'compute-endpoints'),
      restartSidecar,
    });

    await expect(handlers.removeCustomProvider('tamarind')).resolves.toMatchObject({
      ok: false,
      kind: 'not_custom',
    });
    expect(restartSidecar).not.toHaveBeenCalled();
  });

  it('rolls back the manifest when a post-install sidecar restart fails', async () => {
    const sidecar = fakeSidecar({});
    const restartSidecar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined);
    const manifestDir = join(h.dir, 'compute-endpoints');
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
      userManifestsDir: manifestDir,
      restartSidecar,
    });

    await expect(handlers.installManifest(JSON.stringify(runpodManifest))).resolves.toMatchObject({
      ok: false,
      kind: 'restart_failed',
    });
    expect(restartSidecar).toHaveBeenCalledTimes(2);
    expect(existsSync(join(manifestDir, 'runpod-lab.json'))).toBe(false);
  });

  it('does not report installation success when a resolved restart has no registered endpoint', async () => {
    const sidecar = fakeSidecar({
      providers: () => new Response(JSON.stringify({ providers: [] }), { status: 200 }),
    });
    const restartSidecar = vi.fn(async () => undefined);
    const manifestDir = join(h.dir, 'compute-endpoints');
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
      userManifestsDir: manifestDir,
      restartSidecar,
    });

    await expect(handlers.installManifest(JSON.stringify(runpodManifest))).resolves.toMatchObject({
      ok: false,
      kind: 'restart_failed',
    });
    expect(existsSync(join(manifestDir, 'runpod-lab.json'))).toBe(false);
    expect(restartSidecar).toHaveBeenCalledTimes(2);
  });

  it('restores the endpoint and key when removal restart resolves but the service is offline', async () => {
    const sidecar = fakeSidecar({});
    const manifestDir = join(h.dir, 'compute-endpoints');
    let offline = false;
    let customProvider: unknown;
    const sidecarFetch = async (path: string | URL, init?: RequestInit) => {
      if (String(path) === '/compute/providers') {
        if (offline) throw new Error('The compute service is offline.');
        return new Response(JSON.stringify({ providers: [customProvider] }), { status: 200 });
      }
      const response = await sidecar.sidecarFetch(path, init);
      if (String(path) === '/compute/providers/validate-manifest') {
        customProvider = await response.clone().json();
      }
      return response;
    };
    const restartSidecar = vi.fn(async () => {
      offline = !existsSync(join(manifestDir, 'runpod-lab.json'));
    });
    const handlers = createComputeIpcHandlers({
      sidecarFetch,
      grantedCapabilities: () => [],
      userManifestsDir: manifestDir,
      restartSidecar,
    });
    expect(await handlers.installManifest(JSON.stringify(runpodManifest))).toMatchObject({
      ok: true,
    });
    expect(await handlers.connect('runpod-lab', 'runpod-secret-key')).toMatchObject({ ok: true });

    await expect(handlers.removeCustomProvider('runpod-lab')).resolves.toMatchObject({
      ok: false,
      kind: 'restart_failed',
    });
    expect(existsSync(join(manifestDir, 'runpod-lab.json'))).toBe(true);
    expect(await hasComputeCredential('runpod-lab')).toBe(true);
    expect(restartSidecar).toHaveBeenCalledTimes(3);
  });

  it('restores a removed manifest when the sidecar cannot restart without it', async () => {
    const customProvider = {
      id: 'runpod-lab',
      display_name: 'Lab Runpod',
      summary: 'Run one user-owned Runpod Serverless endpoint.',
      transport: 'rest',
      driver: 'http-job',
      custom: true,
      auth_scheme: 'header',
      credential_header: 'authorization',
      endpoint_url: 'https://api.runpod.ai/v2/lab',
      verify_target: '/health',
      catalog: 'static',
      job_model: 'async',
      cost: 'rate-card',
      disclosure: 'Lab Runpod bills your Runpod account.',
      retention_note: 'Import promptly.',
      cancellation_mode: 'provider',
      cancellation_note: 'Runpod accepts cancellation.',
      docs_url: 'https://docs.runpod.io/serverless/endpoints/overview',
      key_page_url: 'https://www.runpod.io/console/user/settings',
      terms_url: 'https://www.runpod.io/legal/terms-of-service',
      privacy_url: 'https://www.runpod.io/legal/privacy-policy',
      has_binding: true,
    };
    const sidecar = fakeSidecar({
      providers: () =>
        new Response(JSON.stringify({ providers: [customProvider] }), { status: 200 }),
    });
    const restartSidecar = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined);
    const manifestDir = join(h.dir, 'compute-endpoints');
    const handlers = createComputeIpcHandlers({
      sidecarFetch: sidecar.sidecarFetch,
      grantedCapabilities: () => [],
      userManifestsDir: manifestDir,
      restartSidecar,
    });
    expect(await handlers.installManifest(JSON.stringify(runpodManifest))).toMatchObject({
      ok: true,
    });
    expect(await handlers.connect('runpod-lab', 'runpod-secret-key')).toMatchObject({ ok: true });

    await expect(handlers.removeCustomProvider('runpod-lab')).resolves.toMatchObject({
      ok: false,
      kind: 'restart_failed',
    });
    expect(restartSidecar).toHaveBeenCalledTimes(3);
    expect(existsSync(join(manifestDir, 'runpod-lab.json'))).toBe(true);
    expect(await hasComputeCredential('runpod-lab')).toBe(true);
  });
});
