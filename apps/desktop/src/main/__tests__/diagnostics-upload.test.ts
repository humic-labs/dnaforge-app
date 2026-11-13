import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateKeyPairSync } from 'node:crypto';
import {
  mintTelemetryActorAssertion,
  sealTelemetryActorAssertionPublicKey,
} from '@waypoint/analytics-policy/telemetry-actor-assertion';

const actorAssertionKeys = generateKeyPairSync('ed25519');
const actorAssertionPrivateKey = actorAssertionKeys.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
const actorAssertionPublicKey = actorAssertionKeys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
const actorBuildTag = 'v0.3.0-test';
const actorBuildTagStamp = `DNAFORGE_BUILD_TAG=${actorBuildTag}::TELEMETRY_PROVENANCE_V1::END`;

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const authAuthority = vi.hoisted(() => ({ origin: 'https://dnaforge.com', unreadable: false }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: () => {
    if (authAuthority.unreadable) throw new Error('packaged_auth_authority_unreadable');
    return authAuthority.origin;
  },
}));

const telemetryConsent = vi.hoisted(() => ({
  value: 'allowed' as 'allowed' | 'denied' | 'unknown',
  listeners: [] as Array<(consent: 'allowed' | 'denied' | 'unknown') => void>,
}));
vi.mock('../telemetry-consent', () => ({
  getTelemetryConsent: () => telemetryConsent.value,
  onTelemetryConsentChange: (listener: (consent: 'allowed' | 'denied' | 'unknown') => void) => {
    telemetryConsent.listeners.push(listener);
    return () => undefined;
  },
}));

const appExitMock = vi.fn();
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.__TEST_USER_DATA || tmpdir(),
    getVersion: () => '0.3.0-test',
    isPackaged: true,
    exit: (...args: unknown[]) => appExitMock(...args),
  },
}));

import {
  sendDiagnosticsUpload,
  sendAppBootBeacon,
  flushPendingDiagnostics,
  maybeForceBootFailureAndExit,
  consumeInstallIdentitySnapshot,
  notifyBootSucceeded,
  readInstallIdentitySnapshot,
  reportRendererErrorSignal,
  persistStartupFailure,
} from '../diagnostics-upload';
import { initBootLog, appendBootLog, __resetBootLogForTest } from '../boot-log';

describe('diagnostics-upload', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diag-upload-'));
    process.env.__TEST_USER_DATA = dir;
    telemetryConsent.value = 'allowed';
    telemetryConsent.listeners.length = 0;
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('__DNAFORGE_BUILD_TAG__', '');
    vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', '');
    vi.stubGlobal('__DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__', '');
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'official');
    __resetBootLogForTest();
    fetchMock.mockReset();
    authAuthority.origin = 'https://dnaforge.com';
    authAuthority.unreadable = false;
    appExitMock.mockReset();
    delete process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE;
    delete process.env.DNAFORGE_TELEMETRY_ACTOR;
    delete process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.DNAFORGE_RELEASE_CHANNEL;
    initBootLog(dir);
    appendBootLog('test_boot');
  });

  afterEach(() => {
    __resetBootLogForTest();
    delete process.env.__TEST_USER_DATA;
    delete process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE;
    delete process.env.DIAGNOSTICS_URL;
    delete process.env.DNAFORGE_TELEMETRY_ACTOR;
    delete process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.DNAFORGE_RELEASE_CHANNEL;
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a startup failure before consent and delivers its original identity on the next allowed launch', async () => {
    telemetryConsent.value = 'unknown';
    expect(await persistStartupFailure('bootstrap_error')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const queued = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf8'));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: 'boot_failure',
      error_class: 'bootstrap_error',
      summary: 'bootstrap_startup_failed',
      files: [],
      app_version: '0.3.0-test',
    });
    expect(queued[0].event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(queued[0].timestamp))).toBe(true);
    telemetryConsent.value = 'allowed';
    fetchMock.mockResolvedValue({ ok: true });
    await flushPendingDiagnostics(dir);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(queued[0]);
    await flushPendingDiagnostics(dir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes a startup failure before attempting immediate delivery', async () => {
    fetchMock.mockImplementation(async (_url, options) => {
      const persisted = [
        join(dir, 'pending-diagnostics.json'),
        join(dir, 'pending-diagnostics.inflight.json'),
      ]
        .filter(existsSync)
        .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')));
      expect(persisted).toContainEqual(JSON.parse(options.body));
      return { ok: true };
    });
    expect(await persistStartupFailure('startup_error')).toBe(true);
    await flushPendingDiagnostics(dir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains an offline startup failure for retry with the same event identity', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await persistStartupFailure('bootstrap_error')).toBe(true);
    await flushPendingDiagnostics(dir);
    const queued = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf8'));
    expect(queued).toHaveLength(1);
    fetchMock.mockResolvedValue({ ok: true });
    await flushPendingDiagnostics(dir);
    for (const [, options] of fetchMock.mock.calls) {
      expect(JSON.parse(options.body as string)).toEqual(queued[0]);
    }
  });

  it('refuses a startup failure when analytics consent was denied', async () => {
    telemetryConsent.value = 'denied';
    expect(await persistStartupFailure('bootstrap_error')).toBe(false);
    expect(existsSync(join(dir, 'pending-diagnostics.json'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs crash payload and includes boot log tail', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const result = await sendDiagnosticsUpload(
      { kind: 'crash', error_class: 'uncaught_exception', summary: 'boom' },
      dir
    );
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dnaforge.com/api/diagnostics/upload',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(body.kind).toBe('crash');
    expect(body.error_class).toBe('uncaught_exception');
    expect(body.files.some((f: { name: string }) => f.name === 'main-boot.log')).toBe(true);
  });

  it('routes Release B boot and diagnostic uploads to the website rather than its auth gateway', async () => {
    authAuthority.origin = 'https://hosted-ai.dnaforge.com';
    fetchMock.mockResolvedValue({ ok: true });

    await sendAppBootBeacon(dir);
    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);
    await sendDiagnosticsUpload({ kind: 'crash', error_class: 'uncaught_exception' }, dir);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://dnaforge.com/api/diagnostics/install-beacon',
      'https://dnaforge.com/api/diagnostics/upload',
      'https://dnaforge.com/api/diagnostics/upload',
    ]);
  });

  it('can report an unreadable packaged auth authority through the known website', async () => {
    authAuthority.unreadable = true;
    fetchMock.mockResolvedValue({ ok: true });

    await sendAppBootBeacon(dir);
    const result = await sendDiagnosticsUpload(
      { kind: 'boot_failure', error_class: 'auth_config' },
      dir
    );

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://dnaforge.com/api/diagnostics/install-beacon',
      'https://dnaforge.com/api/diagnostics/upload',
    ]);
  });

  it.each(['http://127.0.0.1:8123', 'http://localhost:8123', 'http://[::1]:8123'])(
    'preserves the approved canary loopback authority %s',
    async (origin) => {
      authAuthority.origin = origin;
      fetchMock.mockResolvedValue({ ok: true });
      await sendAppBootBeacon(dir);
      await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${origin}/api/diagnostics/install-beacon`,
        `${origin}/api/diagnostics/upload`,
      ]);
    }
  );

  it('rejects a packaged remote diagnostic override even when the auth authority is Release B', async () => {
    authAuthority.origin = 'https://hosted-ai.dnaforge.com';
    process.env.DIAGNOSTICS_URL = 'https://unapproved.example.test';
    fetchMock.mockResolvedValue({ ok: true });

    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);

    expect(fetchMock.mock.calls[0][0]).toBe('https://dnaforge.com/api/diagnostics/upload');
  });

  it('does not claim trusted deployment or canary dimensions on a public upload', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('build_tag');
    expect(body).not.toHaveProperty('environment');
    expect(body).not.toHaveProperty('release_channel');
    expect(body.is_synthetic).toBe(false);
    expect(body).not.toHaveProperty('telemetry_canary_id');
    expect(body.telemetry_actor).toBe('dev');
    expect(body.desktop_release_channel).toBe('unknown');
    expect(body.files).toEqual([]);
  });

  it('sends bounded desktop-owned artifact dimensions without using server-owned keys', async () => {
    process.env.DNAFORGE_RELEASE_CHANNEL = 'closed_beta';
    fetchMock.mockResolvedValue({ ok: true });

    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.desktop_release_channel).toBe('closed_beta');
    expect(body).not.toHaveProperty('release_channel');
    expect(body).not.toHaveProperty('build_tag');
  });

  it('reads the current installer run and optional download identity once for both boot paths', async () => {
    const attemptId = '550e8400-e29b-41d4-a716-446655440001';
    const downloadId = '550e8400-e29b-41d4-a716-446655440002';
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'install-attempt.id'), `${attemptId}\r\n${downloadId}\r\n`);
    writeFileSync(join(dir, 'logs', 'install.log'), `schema=1 event=init attempt=${attemptId}\r\n`);
    const identity = readInstallIdentitySnapshot(dir);
    fetchMock.mockResolvedValue({ ok: true });

    await sendAppBootBeacon(dir, identity);
    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir, identity);

    const beacon = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const upload = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(beacon).toEqual(
      expect.objectContaining({
        event_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        attempt_id: attemptId,
        download_id: downloadId,
      })
    );
    expect(upload).toEqual(
      expect.objectContaining({
        attempt_id: attemptId,
        download_id: downloadId,
        install_id: beacon.install_id,
      })
    );
  });

  it('retries a transient app-boot beacon with one stable event identity and body', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, status: 201 });

      const delivery = sendAppBootBeacon(dir, {});
      await vi.runAllTimersAsync();
      await delivery;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const bodies = fetchMock.mock.calls.map(([, init]) => init.body as string);
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0]).event_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a terminal app-boot beacon response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    await sendAppBootBeacon(dir, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy one-line run files compatible and ignores malformed download lines', () => {
    const attemptId = 'legacy-installer-run';
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const identityPath = join(dir, 'logs', 'install-attempt.id');
    writeFileSync(identityPath, `${attemptId}\r\n`);
    writeFileSync(join(dir, 'logs', 'install.log'), `schema=1 event=init attempt=${attemptId}\r\n`);
    expect(readInstallIdentitySnapshot(dir)).toEqual({ attemptId });

    writeFileSync(identityPath, `${attemptId}\r\nnot-a-download-id\r\n`);
    expect(readInstallIdentitySnapshot(dir)).toEqual({ attemptId });
  });

  it('rejects stale identity when the current installer run did not persist its new value', () => {
    const staleAttemptId = '550e8400-e29b-41d4-a716-446655440001';
    const staleDownloadId = '550e8400-e29b-41d4-a716-446655440002';
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(
      join(dir, 'logs', 'install-attempt.id'),
      `${staleAttemptId}\r\n${staleDownloadId}\r\n`
    );
    writeFileSync(
      join(dir, 'logs', 'install.log'),
      'schema=1 event=init attempt=550e8400-e29b-41d4-a716-446655440003\r\n'
    );

    expect(readInstallIdentitySnapshot(dir)).toEqual({});
  });

  it('consumes only the identity snapshot used by the successful boot path', () => {
    const attemptId = '550e8400-e29b-41d4-a716-446655440001';
    const downloadId = '550e8400-e29b-41d4-a716-446655440002';
    const identityPath = join(dir, 'logs', 'install-attempt.id');
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(identityPath, `${attemptId}\r\n${downloadId}\r\n`);
    writeFileSync(join(dir, 'logs', 'install.log'), `schema=1 event=init attempt=${attemptId}\r\n`);
    const identity = readInstallIdentitySnapshot(dir);

    consumeInstallIdentitySnapshot(dir, identity);

    expect(existsSync(identityPath)).toBe(false);
  });

  it('retains installer identity when boot_ok is neither accepted nor durably queued', async () => {
    const attemptId = '550e8400-e29b-41d4-a716-446655440001';
    const downloadId = '550e8400-e29b-41d4-a716-446655440002';
    const identityPath = join(dir, 'logs', 'install-attempt.id');
    writeFileSync(identityPath, `${attemptId}\r\n${downloadId}\r\n`);
    writeFileSync(join(dir, 'logs', 'install.log'), `schema=1 event=init attempt=${attemptId}\r\n`);
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    notifyBootSucceeded();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(readFileSync(join(dir, 'logs', 'main-boot.log'), 'utf-8')).toContain(
        'boot_ok_delivery_failed'
      )
    );
    expect(existsSync(identityPath)).toBe(true);
  });

  it('consumes installer identity after boot_ok is accepted', async () => {
    const attemptId = '550e8400-e29b-41d4-a716-446655440001';
    const downloadId = '550e8400-e29b-41d4-a716-446655440002';
    const identityPath = join(dir, 'logs', 'install-attempt.id');
    writeFileSync(identityPath, `${attemptId}\r\n${downloadId}\r\n`);
    writeFileSync(join(dir, 'logs', 'install.log'), `schema=1 event=init attempt=${attemptId}\r\n`);
    fetchMock.mockResolvedValue({ ok: true, status: 201 });

    notifyBootSucceeded();

    await vi.waitFor(() => expect(existsSync(identityPath)).toBe(false));
    expect(readFileSync(join(dir, 'logs', 'main-boot.log'), 'utf-8')).toContain('boot_ok_sent');
  });

  it.each([
    ['shell_usable', 'packaged_shell_usable'],
    ['recovery_window', 'packaged_recovery_window_ready'],
  ] as const)('keeps the boot_ok contract and identifies %s', async (outcome, summary) => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    notifyBootSucceeded(outcome);
    await vi.waitFor(() => {
      const bodies = fetchMock.mock.calls.map(([, init]) => {
        try {
          return JSON.parse(String(init?.body));
        } catch {
          return null;
        }
      });
      expect(bodies).toContainEqual(expect.objectContaining({ kind: 'boot_ok', summary }));
    });
  });

  it('consumes installer identity after boot_ok is durably queued', async () => {
    const attemptId = '550e8400-e29b-41d4-a716-446655440001';
    const downloadId = '550e8400-e29b-41d4-a716-446655440002';
    const identityPath = join(dir, 'logs', 'install-attempt.id');
    writeFileSync(identityPath, `${attemptId}\r\n${downloadId}\r\n`);
    writeFileSync(join(dir, 'logs', 'install.log'), `schema=1 event=init attempt=${attemptId}\r\n`);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockRejectedValueOnce(new Error('offline'));

    notifyBootSucceeded();

    await vi.waitFor(() => expect(existsSync(identityPath)).toBe(false));
    const queue = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'));
    expect(queue).toEqual([
      expect.objectContaining({ kind: 'boot_ok', attempt_id: attemptId, download_id: downloadId }),
    ]);
    expect(readFileSync(join(dir, 'logs', 'main-boot.log'), 'utf-8')).toContain('boot_ok_queued');
  });

  it('marks packaged maintainer diagnostics without exporting CI identity', async () => {
    vi.stubGlobal('__DNAFORGE_BUILD_TAG__', actorBuildTagStamp);
    vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', 'closed_beta');
    vi.stubGlobal(
      '__DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__',
      sealTelemetryActorAssertionPublicKey(actorAssertionPublicKey)
    );
    process.env.DNAFORGE_TELEMETRY_ACTOR = 'maintainer';
    process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION = mintTelemetryActorAssertion({
      privateKey: actorAssertionPrivateKey,
      actor: 'maintainer',
      appVersion: '0.3.0-test',
      buildTag: actorBuildTag,
      releaseChannel: 'closed_beta',
    });
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = '32902696778';
    fetchMock.mockResolvedValue({ ok: true });

    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.telemetry_actor).toBe('maintainer');
    expect(body.telemetry_actor_assertion).toBe(process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION);
    expect(body).not.toHaveProperty('ci_run_id');
  });

  it('attaches renderer breadcrumbs to a crash bundle but NOT to boot_ok', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'renderer-breadcrumbs.log'), 'warn: something happened');

    await sendDiagnosticsUpload({ kind: 'crash', summary: 'boom' }, dir);
    const crashBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(
      crashBody.files.some((f: { name: string }) => f.name === 'renderer-breadcrumbs.log')
    ).toBe(true);

    fetchMock.mockClear();
    await sendDiagnosticsUpload({ kind: 'boot_ok', summary: 'packaged_boot_ok' }, dir);
    const bootBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(bootBody.files).toEqual([]);
  });

  it('reports non-fatal renderer errors as renderer_error without a crash bundle', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });

    reportRendererErrorSignal('renderer_TypeError', 'renderer_error');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual(
      expect.objectContaining({
        kind: 'renderer_error',
        error_class: 'renderer_typeerror',
        summary: 'renderer_error',
        files: [],
      })
    );
  });

  it('queues on network failure and flushes later', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const result = await sendDiagnosticsUpload(
      { kind: 'boot_failure', error_class: 'schema_init_failed' },
      dir
    );
    expect(result.queued).toBe(true);
    expect(existsSync(join(dir, 'pending-diagnostics.json'))).toBe(true);
    const firstAttempt = JSON.parse(fetchMock.mock.calls[0][1].body as string);

    fetchMock.mockResolvedValue({ ok: true });
    await flushPendingDiagnostics(dir);
    const replay = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(replay.event_id).toBe(firstAttempt.event_id);
    const queue = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'));
    expect(queue).toEqual([]);
  });

  it('sends, beacons and flushes nothing in a community build', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const queued = await sendDiagnosticsUpload(
      { kind: 'boot_failure', error_class: 'schema_init_failed' },
      dir
    );
    expect(queued.queued).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'community');
    fetchMock.mockResolvedValue({ ok: true });
    expect(
      await sendDiagnosticsUpload({ kind: 'crash', error_class: 'uncaught_exception' }, dir)
    ).toEqual({ success: false });
    await sendAppBootBeacon(dir, {});
    await flushPendingDiagnostics(dir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not erase an item queued while a claimed batch is awaiting delivery', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await sendDiagnosticsUpload({ kind: 'boot_failure', summary: 'first item' }, dir);
    const firstQueued = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'))[0];

    let finishClaimedDelivery: (response: { ok: boolean; status: number }) => void = () => {};
    const claimedDelivery = new Promise<{ ok: boolean; status: number }>((resolve) => {
      finishClaimedDelivery = resolve;
    });
    fetchMock.mockReset();
    fetchMock
      .mockImplementationOnce(() => claimedDelivery)
      .mockRejectedValueOnce(new Error('offline again'));

    const flushing = flushPendingDiagnostics(dir);
    await vi.waitFor(() =>
      expect(existsSync(join(dir, 'pending-diagnostics.inflight.json'))).toBe(true)
    );
    const concurrentResult = await sendDiagnosticsUpload(
      { kind: 'boot_ok', summary: 'arrived during flush' },
      dir
    );
    const concurrentQueued = JSON.parse(
      readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8')
    )[0];

    finishClaimedDelivery({ ok: true, status: 201 });
    await flushing;

    expect(concurrentResult).toEqual({ success: false, queued: true });
    expect(concurrentQueued.event_id).not.toBe(firstQueued.event_id);
    expect(JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'))).toEqual([
      expect.objectContaining({ event_id: concurrentQueued.event_id }),
    ]);
    expect(existsSync(join(dir, 'pending-diagnostics.inflight.json'))).toBe(false);
  });

  it('serializes simultaneous enqueue mutations for one queue path', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    const [first, second] = await Promise.all([
      sendDiagnosticsUpload({ kind: 'boot_failure', summary: 'first concurrent item' }, dir),
      sendDiagnosticsUpload({ kind: 'boot_ok', summary: 'second concurrent item' }, dir),
    ]);

    expect(first).toEqual({ success: false, queued: true });
    expect(second).toEqual({ success: false, queued: true });
    const queue = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'));
    expect(queue).toHaveLength(2);
    expect(queue.map((item: { summary: string }) => item.summary)).toEqual([
      'first concurrent item',
      'second concurrent item',
    ]);
  });

  it('recovers and replays a stale claimed batch after process loss', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await sendDiagnosticsUpload({ kind: 'boot_failure', summary: 'stale claim' }, dir);
    const queuePath = join(dir, 'pending-diagnostics.json');
    const inflightPath = join(dir, 'pending-diagnostics.inflight.json');
    const queued = JSON.parse(readFileSync(queuePath, 'utf-8'))[0];
    renameSync(queuePath, inflightPath);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 201 });

    await flushPendingDiagnostics(dir);

    const replayed = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(replayed.event_id).toBe(queued.event_id);
    expect(existsSync(inflightPath)).toBe(false);
    expect(JSON.parse(readFileSync(queuePath, 'utf-8'))).toEqual([]);
  });

  it('removes a stale claim copy already published before a crash while preserving later arrivals', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await sendDiagnosticsUpload({ kind: 'boot_failure', summary: 'claimed item' }, dir);
    const queuePath = join(dir, 'pending-diagnostics.json');
    const inflightPath = join(dir, 'pending-diagnostics.inflight.json');
    const claimed = JSON.parse(readFileSync(queuePath, 'utf-8'))[0];
    renameSync(queuePath, inflightPath);

    fetchMock.mockRejectedValueOnce(new Error('offline again'));
    await sendDiagnosticsUpload({ kind: 'boot_ok', summary: 'later arrival' }, dir);
    const laterArrival = JSON.parse(readFileSync(queuePath, 'utf-8'))[0];
    writeFileSync(queuePath, JSON.stringify([claimed, laterArrival]));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 201 });

    await flushPendingDiagnostics(dir);

    expect(JSON.parse(readFileSync(queuePath, 'utf-8'))).toEqual([
      expect.objectContaining({ event_id: laterArrival.event_id }),
    ]);
    expect(existsSync(inflightPath)).toBe(false);
  });

  it('preserves an unreadable stale claim and a new active arrival byte-for-byte', async () => {
    const inflightPath = join(dir, 'pending-diagnostics.inflight.json');
    const unreadableContents = '{existing inflight crash evidence';
    writeFileSync(inflightPath, unreadableContents);
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const result = await sendDiagnosticsUpload({ kind: 'boot_ok', summary: 'new arrival' }, dir);
    const activeContents = readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 201 });

    await flushPendingDiagnostics(dir);

    expect(result).toEqual({ success: false, queued: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(inflightPath, 'utf-8')).toBe(unreadableContents);
    expect(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8')).toBe(activeContents);
  });

  it('does not erase an unreadable queue or claim that a new item was persisted', async () => {
    const queuePath = join(dir, 'pending-diagnostics.json');
    const unreadableContents = '{existing crash evidence';
    writeFileSync(queuePath, unreadableContents);
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const result = await sendDiagnosticsUpload({ kind: 'boot_failure' }, dir);

    expect(result).toEqual({ success: false });
    expect(readFileSync(queuePath, 'utf-8')).toBe(unreadableContents);
  });

  it('sends nothing and keeps nothing when telemetry consent is denied', async () => {
    telemetryConsent.value = 'denied';

    await expect(sendDiagnosticsUpload({ kind: 'crash', summary: 'boom' }, dir)).resolves.toEqual({
      success: false,
    });
    await sendAppBootBeacon(dir);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'pending-diagnostics.json'))).toBe(false);
  });

  it('holds reports locally until consent is known, then sends or discards them', async () => {
    telemetryConsent.value = 'unknown';
    await expect(sendDiagnosticsUpload({ kind: 'crash', summary: 'boom' }, dir)).resolves.toEqual({
      success: false,
      queued: true,
    });
    await flushPendingDiagnostics(dir);
    expect(fetchMock).not.toHaveBeenCalled();

    telemetryConsent.value = 'allowed';
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await flushPendingDiagnostics(dir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      kind: 'crash',
      summary: 'boom',
    });

    fetchMock.mockClear();
    telemetryConsent.value = 'unknown';
    await sendDiagnosticsUpload({ kind: 'boot_failure', summary: 'held' }, dir);
    telemetryConsent.value = 'denied';
    await flushPendingDiagnostics(dir);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'pending-diagnostics.json'))).toBe(false);
  });

  it('sends a user-requested log bundle regardless of the analytics choice', async () => {
    telemetryConsent.value = 'denied';
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await expect(sendDiagnosticsUpload({ kind: 'log_bundle', files: [] }, dir)).resolves.toEqual({
      success: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts caller-provided summaries and file content before live egress or queueing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await sendDiagnosticsUpload(
      {
        kind: 'crash',
        summary: 'startup failed for alice@example.com in /Users/alice/project',
        files: [
          {
            name: '/Users/alice/startup.log',
            content: 'token=xxxxxxxxxxxx for alice@example.com in /Users/alice/project',
          },
        ],
      },
      dir
    );

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const queued = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'))[0];
    for (const payload of [sent, queued]) {
      expect(payload.summary).toBe(
        'startup failed for [redacted-email] in /Users/[redacted-user]/[redacted-path]'
      );
      expect(payload.files[0]).toEqual({
        name: '/Users/[redacted-user]/[redacted-path]',
        content: 'token=[redacted] for [redacted-email] in /Users/[redacted-user]/[redacted-path]',
      });
    }
  });

  it('redacts legacy queued payloads again immediately before replay', async () => {
    writeFileSync(
      join(dir, 'pending-diagnostics.json'),
      JSON.stringify([
        {
          schema: 1,
          kind: 'boot_failure',
          app_version: '0.3.0-test',
          platform_info: 'win32 x64',
          install_id: 'legacy-install',
          summary: 'failed for alice@example.com at C:\\Users\\alice\\project',
          files: [
            {
              name: 'legacy.log',
              content: 'api_key=xxxxxxxxxxxx at C:\\Users\\alice\\project',
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ])
    );
    fetchMock.mockResolvedValue({ ok: true });

    await flushPendingDiagnostics(dir);

    const replayed = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(replayed.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(replayed.telemetry_actor).toBe('dev');
    expect(replayed.desktop_release_channel).toBe('unknown');
    expect(replayed.summary).toBe(
      'failed for [redacted-email] at C:\\Users\\[redacted-user]\\[redacted-path]'
    );
    expect(replayed.files[0].content).toBe(
      'api_key=[redacted] at C:\\Users\\[redacted-user]\\[redacted-path]'
    );
    expect(JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'))).toEqual([]);
  });

  it('derives the same event id when a legacy replay crashes before queue persistence', async () => {
    const legacyPayload = {
      schema: 1,
      kind: 'boot_ok',
      app_version: '0.3.0-test',
      platform_info: 'win32 x64',
      install_id: 'legacy-install',
      timestamp: '2026-08-25T12:00:00.000Z',
    };
    const queuePath = join(dir, 'pending-diagnostics.json');
    writeFileSync(queuePath, JSON.stringify([legacyPayload]));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    await flushPendingDiagnostics(dir);
    const firstReplay = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstReplay).not.toHaveProperty('is_synthetic');

    writeFileSync(queuePath, JSON.stringify([legacyPayload]));
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await flushPendingDiagnostics(dir);
    const secondReplay = JSON.parse(fetchMock.mock.calls[1][1].body as string);

    expect(secondReplay.event_id).toBe(firstReplay.event_id);
    expect(secondReplay.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('reuses a persisted legacy v5 event id on the ordinary retry path', async () => {
    const queuePath = join(dir, 'pending-diagnostics.json');
    writeFileSync(
      queuePath,
      JSON.stringify([
        {
          schema: 1,
          kind: 'boot_ok',
          app_version: '0.3.0-test',
          platform_info: 'win32 x64',
          install_id: 'legacy-install',
          timestamp: '2026-08-25T12:00:00.000Z',
        },
      ])
    );
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await flushPendingDiagnostics(dir);
    const firstReplay = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstReplay).not.toHaveProperty('is_synthetic');

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await flushPendingDiagnostics(dir);
    const secondReplay = JSON.parse(fetchMock.mock.calls[1][1].body as string);

    expect(secondReplay.event_id).toBe(firstReplay.event_id);
    expect(JSON.parse(readFileSync(queuePath, 'utf-8'))).toEqual([]);
  });

  it('drops unknown top-level fields and malformed legacy queue entries before replay', async () => {
    const validPayload = {
      schema: 1,
      kind: 'crash',
      app_version: '0.3.0-test',
      platform_info: 'darwin arm64',
      install_id: 'diag_0123456789abcdef0123456789abcdef',
      telemetry_actor: 'user',
      desktop_release_channel: 'closed_beta',
      timestamp: new Date().toISOString(),
      summary: 'failure for alice@example.com',
      secret: 'DNAFORGE_PRIVATE_TOKEN',
      files: [{ name: 'main.log', content: 'safe content' }, null],
    };
    writeFileSync(
      join(dir, 'pending-diagnostics.json'),
      JSON.stringify([validPayload, { schema: 1, files: [null] }, 'not-an-object'])
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await flushPendingDiagnostics(dir);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).not.toHaveProperty('secret');
    expect(sent.summary).toBe('failure for [redacted-email]');
    expect(sent.files).toEqual([{ name: 'main.log', content: 'safe content' }]);
    expect(JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'))).toEqual([]);
  });

  it('re-queues when the server returns 503', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await sendDiagnosticsUpload({ kind: 'log_bundle' }, dir);
    const queue = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'));
    expect(queue).toHaveLength(1);
  });

  it.each([429, 503])('keeps retryable HTTP %s responses in the active queue', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status });

    const result = await sendDiagnosticsUpload({ kind: 'log_bundle' }, dir);

    expect(result).toEqual({ success: false, queued: true });
    expect(JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'))).toHaveLength(
      1
    );
  });

  it('removes a terminal 4xx poison item and still sends the next valid queued item', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await sendDiagnosticsUpload({ kind: 'boot_failure', summary: 'obsolete payload' }, dir);
    await sendDiagnosticsUpload({ kind: 'boot_ok', summary: 'current payload' }, dir);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: true, status: 201 });

    await flushPendingDiagnostics(dir);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf-8'))).toEqual([]);
  });

  it('does not add a terminal 4xx response to the active queue', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    const result = await sendDiagnosticsUpload({ kind: 'log_bundle' }, dir);

    expect(result).toEqual({ success: false });
    expect(existsSync(join(dir, 'pending-diagnostics.json'))).toBe(false);
  });

  it('attempts a forced failure once when an immediate 503 retains it', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE = '1';

    expect(await maybeForceBootFailureAndExit()).toBe(true);

    const failures = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(init.body as string))
      .filter((body) => body.kind === 'boot_failure');
    expect(failures).toHaveLength(1);
    const pending = ['pending-diagnostics.json', 'pending-diagnostics.inflight.json']
      .map((name) => join(dir, name))
      .filter(existsSync)
      .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')));
    expect(pending).toEqual([
      expect.objectContaining({
        event_id: failures[0].event_id,
        timestamp: failures[0].timestamp,
      }),
    ]);
    expect(appExitMock).toHaveBeenCalledWith(42);
  });

  it('attempts old and new startup reports once while retaining both after a 503', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await sendDiagnosticsUpload({ kind: 'boot_ok', summary: 'older claim' }, dir);
    renameSync(
      join(dir, 'pending-diagnostics.json'),
      join(dir, 'pending-diagnostics.inflight.json')
    );
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE = '1';

    expect(await maybeForceBootFailureAndExit()).toBe(true);

    const attempted = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(attempted.map((body) => body.kind).sort()).toEqual(['boot_failure', 'boot_ok']);
    expect(new Set(attempted.map((body) => body.event_id)).size).toBe(2);
    const pending = JSON.parse(readFileSync(join(dir, 'pending-diagnostics.json'), 'utf8'));
    expect(new Set(pending.map((body: { event_id: string }) => body.event_id))).toEqual(
      new Set(attempted.map((body) => body.event_id))
    );
  });

  it('attempts the new forced failure after recovering an older in-flight batch', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await sendDiagnosticsUpload({ kind: 'boot_ok', summary: 'previous process' }, dir);
    renameSync(
      join(dir, 'pending-diagnostics.json'),
      join(dir, 'pending-diagnostics.inflight.json')
    );
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE = '1';

    expect(await maybeForceBootFailureAndExit()).toBe(true);

    const failures = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(init.body as string))
      .filter((body) => body.kind === 'boot_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error_class: 'forced_boot_failure', files: [] });
    const pending = ['pending-diagnostics.json', 'pending-diagnostics.inflight.json']
      .map((name) => join(dir, name))
      .filter(existsSync)
      .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')))
      .filter((body) => body.kind === 'boot_failure');
    expect(pending).toEqual([
      expect.objectContaining({
        event_id: failures[0].event_id,
        timestamp: failures[0].timestamp,
      }),
    ]);
    expect(appExitMock).toHaveBeenCalledWith(42);
  });

  it('a forced failure is durable and exits while network delivery remains stalled', async () => {
    let deliver!: (value: { ok: boolean }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        deliver = resolve;
      })
    );
    process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE = '1';
    const exiting = maybeForceBootFailureAndExit();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const pending = [
        join(dir, 'pending-diagnostics.json'),
        join(dir, 'pending-diagnostics.inflight.json'),
      ]
        .filter(existsSync)
        .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')));
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: 'boot_failure',
        error_class: 'forced_boot_failure',
        files: [],
      });
      const handled = await Promise.race([
        exiting,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Forced failure waited for network delivery')),
            2_000
          );
        }),
      ]);
      expect(handled).toBe(true);
      expect(appExitMock).toHaveBeenCalledWith(42);
    } finally {
      if (deadline) clearTimeout(deadline);
      deliver({ ok: true });
      await exiting;
      await flushPendingDiagnostics(dir);
    }
  });

  it(' force-boot-failure uploads then exits when env is set', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE = '1';
    const handled = await maybeForceBootFailureAndExit();
    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dnaforge.com/api/diagnostics/upload',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.kind).toBe('boot_failure');
    expect(body.error_class).toBe('forced_boot_failure');
    expect(appExitMock).toHaveBeenCalledWith(42);
  });

  it(' force-boot-failure is a no-op without the env flag', async () => {
    const handled = await maybeForceBootFailureAndExit();
    expect(handled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(appExitMock).not.toHaveBeenCalled();
  });

  it('packaged DIAGNOSTICS_URL only honors loopback overrides', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    process.env.DIAGNOSTICS_URL = 'https://evil.example/steal';
    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);
    expect(fetchMock.mock.calls[0][0]).toBe('https://dnaforge.com/api/diagnostics/upload');

    fetchMock.mockClear();
    process.env.DIAGNOSTICS_URL = 'http://127.0.0.1:8791';
    await sendDiagnosticsUpload({ kind: 'boot_ok' }, dir);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8791/api/diagnostics/upload');
    delete process.env.DIAGNOSTICS_URL;
  });
});
