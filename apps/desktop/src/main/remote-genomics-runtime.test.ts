import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteAlignmentConnectRequestV1,
  RemoteAlignmentMaterializationV1,
} from '../shared/remote-genomics-ipc';
import { createFakeSshBoundary } from '../../../../e2e/electron/fixtures/fake-ssh-boundary';
import {
  buildRemoteRangeHelperScript,
  RemoteGenomicsError,
  RemoteGenomicsSupervisor,
  terminateRemoteChild,
} from './remote-genomics-supervisor';
import {
  RemoteGenomicsRuntime,
  type RemoteGenomicsTransportProvider,
} from './remote-genomics-runtime';

const request: RemoteAlignmentConnectRequestV1 = {
  endpointId: 'endpoint-a',
  displayName: 'cluster-a',
  target: 'cluster-a',
  alignmentPath: '/run/sample.bam',
  indexPath: '/run/sample.bam.bai',
  signalPath: '/run/sample.bigWig',
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe('RemoteGenomicsRuntime', () => {
  it.each(['read', 'header'])(
    'forwards admitted alignment %s and refuses other cluster routes',
    async (operation) => {
      const fixture = await byteRangeFixture();
      const received: Array<{ url: string | undefined; body: string }> = [];
      const upstream = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        received.push({ url: req.url, body });
        res
          .writeHead(200, {
            'content-type': 'application/json',
            'X-DNAForge-Compute-Platform': 'Linux',
            'X-DNAForge-Compute-Pid': '42',
          })
          .end('{"readId":"original","seq":"ACG"}');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      cleanup.push(
        () =>
          new Promise<void>((resolve, reject) =>
            upstream.close((error) => (error ? reject(error) : resolve()))
          )
      );
      const address = upstream.address();
      if (!address || typeof address === 'string') throw Error('Missing upstream port');
      const runtime = new RemoteGenomicsRuntime(
        transportProvider(
          vi.fn(async () => ({
            ...fixture.materialization,
            tileBaseUrl: `http://127.0.0.1:${address.port}/compute`,
          }))
        ),
        { healthCheckIntervalMs: 0 }
      );
      cleanup.push(() => runtime.stopAll());
      const lease = await runtime.connect({
        ...request,
        tileServerReceiptPath: '/private/session/connection.json',
      });
      const response = await fetch(`${lease.tileBaseUrl}/tiles/alignment/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readId: 'original', chrom: 'chr1', referenceStart: 100, flag: 0 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ readId: 'original', seq: 'ACG' });
      expect(response.headers.get('x-dnaforge-compute-platform')).toBe('Linux');
      expect(received).toEqual([
        {
          url: `/compute/tiles/alignment/${operation}`,
          body: '{"readId":"original","chrom":"chr1","referenceStart":100,"flag":0}',
        },
      ]);
      expect(
        (await fetch(`${lease.tileBaseUrl}/tiles/alignment/arbitrary`, { method: 'POST' })).status
      ).toBe(404);
      expect(
        (await fetch(`${lease.tileBaseUrl}/tiles/alignment/read/extra`, { method: 'POST' })).status
      ).toBe(404);
      expect(received).toHaveLength(1);
    }
  );

  it('shares overlapping remote blocks across readers and revalidates warm reads', async () => {
    const fixture = await byteRangeFixture();
    const runtime = new RemoteGenomicsRuntime(
      transportProvider(vi.fn(async () => fixture.materialization)),
      { healthCheckIntervalMs: 0 }
    );
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);
    const results = await Promise.all(
      ['bytes=100-199', 'bytes=150-249', 'bytes=200-299'].map(async (Range) => {
        const response = await fetch(lease.bamUrl, { headers: { Range } });
        expect(response.status).toBe(206);
        return Buffer.from(await response.arrayBuffer());
      })
    );
    expect(results).toEqual([
      fixture.bytes.subarray(100, 200),
      fixture.bytes.subarray(150, 250),
      fixture.bytes.subarray(200, 300),
    ]);
    expect(fixture.requests.filter((entry) => entry.method === 'GET')).toEqual([
      { method: 'GET', range: 'bytes=0-65535' },
    ]);
    const warm = await fetch(lease.bamUrl, { headers: { Range: 'bytes=100-199' } });
    expect(Buffer.from(await warm.arrayBuffer())).toEqual(results[0]);
    expect(fixture.requests.filter((entry) => entry.method === 'GET')).toHaveLength(1);
    fixture.changed = true;
    const changed = await fetch(lease.bamUrl, { headers: { Range: 'bytes=100-199' } });
    expect(changed.status).toBe(412);
    expect(runtime.listStatuses()[0]?.state).toBe('blocked');
  });

  it('streams an ordinary full-file open through finite blocks with exact bytes', async () => {
    const fixture = await byteRangeFixture();
    const runtime = new RemoteGenomicsRuntime(
      transportProvider(vi.fn(async () => fixture.materialization)),
      { healthCheckIntervalMs: 0 }
    );
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);
    const response = await fetch(lease.bamUrl);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes);
    expect(fixture.requests.filter((entry) => entry.method === 'GET')).toEqual([
      { method: 'GET', range: 'bytes=0-65535' },
      { method: 'GET', range: 'bytes=65536-131071' },
      { method: 'GET', range: 'bytes=131072-196607' },
      { method: 'GET', range: 'bytes=196608-196730' },
    ]);
  });

  it('keeps a shared HTTP block alive when one real reader disconnects', async () => {
    const fixture = await byteRangeFixture();
    fixture.getDelayMs = 250;
    const provider = transportProvider(vi.fn(async () => fixture.materialization));
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);
    const cancelled = new AbortController();
    const abandoned = fetch(lease.bamUrl, {
      headers: { Range: 'bytes=100-199' },
      signal: cancelled.signal,
    }).catch(() => null);
    const remaining = fetch(lease.bamUrl, { headers: { Range: 'bytes=150-249' } });
    await vi.waitFor(() =>
      expect(fixture.requests.filter((entry) => entry.method === 'HEAD')).toHaveLength(2)
    );
    await vi.waitFor(() =>
      expect(fixture.requests.filter((entry) => entry.method === 'GET')).toHaveLength(1)
    );
    cancelled.abort();
    expect(await abandoned).toBeNull();
    expect(Buffer.from(await (await remaining).arrayBuffer())).toEqual(
      fixture.bytes.subarray(150, 250)
    );
    expect(fixture.requests.filter((entry) => entry.method === 'GET')).toHaveLength(1);
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(runtime.listStatuses()[0]?.state).toBe('online');
  });

  it.each([
    'bytes=196600-',
    'bytes=-123',
    'bytes=196600-999999',
    'bytes=196731-',
    'bytes=3-2',
    'bytes=-0',
  ])('preserves exact boundary range semantics for %s', async (range) => {
    const fixture = await byteRangeFixture();
    const runtime = new RemoteGenomicsRuntime(
      transportProvider(vi.fn(async () => fixture.materialization)),
      { healthCheckIntervalMs: 0 }
    );
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);
    const response = await fetch(lease.bamUrl, { headers: { Range: range } });
    if (['bytes=196731-', 'bytes=3-2', 'bytes=-0'].includes(range)) {
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */196731');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(fixture.requests.filter((entry) => entry.method === 'GET')).toHaveLength(0);
    } else {
      const start = range === 'bytes=-123' ? 196608 : 196600;
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-196730/196731`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes.subarray(start));
    }
  });

  it.each(['wrong range', 'short body', 'encoded body'] as const)(
    'never publishes or retains a block with a %s',
    async (failure) => {
      const fixture = await byteRangeFixture();
      fixture.failure = failure;
      const runtime = new RemoteGenomicsRuntime(
        transportProvider(vi.fn(async () => fixture.materialization)),
        { healthCheckIntervalMs: 0 }
      );
      cleanup.push(() => runtime.stopAll());
      const lease = await runtime.connect(request);
      const failed = await fetch(lease.bamUrl, { headers: { Range: 'bytes=100-199' } });
      expect(failed.status).toBe(503);
      expect((await failed.arrayBuffer()).byteLength).toBe(0);
      fixture.failure = null;
      const recovered = await fetch(lease.bamUrl, { headers: { Range: 'bytes=100-199' } });
      expect(recovered.status).toBe(206);
      expect(Buffer.from(await recovered.arrayBuffer())).toEqual(fixture.bytes.subarray(100, 200));
    }
  );

  it.each(['shutdown', 'final release'] as const)(
    'awaits detached helper cleanup when %s starts synchronously from the blocked event',
    async (action) => {
      const fixture = await actualHelperFixture();
      const disconnected = deferred<boolean>();
      const provider = transportProvider(
        vi.fn(async () => fixture.materialization),
        {
          disconnect: vi.fn(() => disconnected.promise),
        }
      );
      const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
      cleanup.push(() => runtime.stopAll());
      const lease = await runtime.connect({ ...request, ...fixture.materialization.locator });
      let teardown: Promise<unknown> | null = null;
      let finished = false;
      runtime.subscribe((event) => {
        if (event.status.state !== 'blocked') return;
        teardown = action === 'shutdown' ? runtime.stopAll() : runtime.disconnect(lease.sessionId);
        void teardown.then(() => {
          finished = true;
        });
      });
      await writeFile(fixture.paths.signal, Buffer.alloc(64, 'B'));
      const demand = fetch(lease.bigWigUrl!).catch(() => null);
      try {
        await vi.waitFor(() => expect(teardown).not.toBeNull());
        await Promise.race([teardown!, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
        expect(
          finished,
          'Terminal publication must retain ownership of the helper being reaped'
        ).toBe(false);
        expect(provider.disconnect).toHaveBeenCalledExactlyOnceWith(
          fixture.materialization.sessionId
        );
      } finally {
        disconnected.resolve(true);
        await teardown;
        await demand;
      }
    }
  );

  it('awaits an already-started final lease disposal when shutdown overlaps it', async () => {
    const fixture = await transportFixture('first-generation');
    const disconnected = deferred<boolean>();
    const runtime = new RemoteGenomicsRuntime(
      transportProvider(
        vi.fn(async () => fixture.materialization),
        {
          disconnect: vi.fn(() => disconnected.promise),
        }
      ),
      { healthCheckIntervalMs: 0 }
    );
    const lease = await runtime.connect(request);
    const releasing = runtime.disconnect(lease.sessionId);
    const shutdown = runtime.stopAll();
    let finished = false;
    void shutdown.then(() => {
      finished = true;
    });
    try {
      await Promise.race([shutdown, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
      expect(finished).toBe(false);
    } finally {
      disconnected.resolve(true);
      await Promise.all([releasing, shutdown]);
    }
  });

  it.each(['provider rejects candidate', 'renderer rejects header'] as const)(
    'restores blocked predecessor aliases after a fresh %s',
    async (failure) => {
      const first = await transportFixture('first-generation');
      const changed = await transportFixture('changed-generation', { fileGeneration: 2 });
      const connect = vi
        .fn<RemoteGenomicsTransportProvider['connect']>()
        .mockResolvedValueOnce(first.materialization)
        .mockResolvedValueOnce(changed.materialization);
      if (failure === 'provider rejects candidate') {
        connect.mockRejectedValueOnce(
          new RemoteGenomicsError('authentication-required', 'The user cancelled login.')
        );
      } else {
        connect.mockResolvedValueOnce(changed.materialization);
      }
      connect.mockResolvedValue(changed.materialization);
      const provider = transportProvider(connect);
      const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
      cleanup.push(() => runtime.stopAll());
      const implicit = { ...request, signalPath: undefined };
      const firstOwner = await runtime.connect(implicit);
      const nextOwner = await runtime.connect(implicit);
      provider.emitClosed(first.materialization.sessionId);
      await vi.waitFor(() => expect(runtime.listStatuses()[0]?.state).toBe('blocked'));
      const foreground = runtime.connect({
        ...firstOwner.locator,
        requestId: 'fresh-repair',
        allowInteractive: true,
      });
      if (failure === 'provider rejects candidate') {
        await expect(foreground).rejects.toThrow('cancelled login');
      } else {
        await runtime.disconnect((await foreground).sessionId);
      }
      await expect(runtime.connect(implicit)).rejects.toThrow(/files changed/i);
      await expect(runtime.connect(firstOwner.locator)).rejects.toThrow(/files changed/i);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(runtime.listStatuses()).toEqual([
        expect.objectContaining({ sourceId: firstOwner.runtimeStatus!.sourceId, state: 'blocked' }),
      ]);
      expect((await fetch(firstOwner.bamUrl)).status).toBe(503);
      expect((await fetch(nextOwner.bamUrl)).status).toBe(503);
      expect(await readFile(firstOwner.indexPath, 'utf8')).toBe('index');
    }
  );

  it.each(['alignment', 'signal'] as const)(
    'turns an actual helper %s 412 into a terminal source change without background SSH retry',
    async (asset) => {
      const fixture = await actualHelperFixture();
      const connect = vi
        .fn<RemoteGenomicsTransportProvider['connect']>()
        .mockResolvedValue(fixture.materialization);
      const provider = transportProvider(connect);
      const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
      cleanup.push(() => runtime.stopAll());
      const first = await runtime.connect({ ...request, ...fixture.materialization.locator });
      const next = await runtime.connect(first.locator);
      const url = asset === 'alignment' ? first.bamUrl : first.bigWigUrl!;
      const before = await fetch(url, { headers: { Range: 'bytes=0-15' } });
      expect(await before.text()).toBe('A'.repeat(16));
      await writeFile(fixture.paths[asset], Buffer.alloc(64, 'B'));
      const changed = await fetch(url, { headers: { Range: 'bytes=0-15' } });
      expect(changed.status).toBe(412);
      await changed.arrayBuffer();
      await vi.waitFor(() =>
        expect(runtime.listStatuses()[0]).toMatchObject({
          state: 'blocked',
          lastFailure: { code: 'source-changed' },
        })
      );
      expect(provider.disconnect).toHaveBeenCalledExactlyOnceWith(
        fixture.materialization.sessionId
      );
      expect(connect).toHaveBeenCalledOnce();
      expect(runtime.retryEndpoint(first.runtimeStatus!.sourceId)).toBe(false);
      expect((await fetch(next.bamUrl)).status).toBe(503);
      expect(await readFile(first.indexPath, 'utf8')).toBe('index');
    }
  );

  it('treats an actual helper health-check 412 as terminal without waiting for a viewport request', async () => {
    const fixture = await actualHelperFixture();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValue(fixture.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 10 });
    cleanup.push(() => runtime.stopAll());
    await runtime.connect({ ...request, ...fixture.materialization.locator });
    await writeFile(fixture.paths.alignment, Buffer.alloc(64, 'B'));
    await vi.waitFor(() =>
      expect(runtime.listStatuses()[0]).toMatchObject({
        state: 'blocked',
        lastFailure: { code: 'source-changed' },
      })
    );
    expect(connect).toHaveBeenCalledOnce();
    expect(provider.disconnect).toHaveBeenCalledExactlyOnceWith(fixture.materialization.sessionId);
  });

  it('rolls back a gateway bind that finishes after shutdown starts', async () => {
    const connect = vi.fn<RemoteGenomicsTransportProvider['connect']>();
    const runtime = new RemoteGenomicsRuntime(transportProvider(connect));
    const connecting = runtime.connect({ ...request, requestId: 'shutdown-first-bind' });
    const cancelled = expect(connecting).rejects.toThrow(/cancelled|stopping|released/u);
    await runtime.stopAll();
    await cancelled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const gateway = (runtime as unknown as { gateway: Server | null }).gateway;
    if (gateway) cleanup.push(() => close(gateway));
    expect(gateway?.listening ?? false).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(runtime.listStatuses()).toEqual([]);
  });

  it('returns the same complete shutdown promise while a transport is being reaped', async () => {
    const fixture = await transportFixture('first-generation');
    const disconnected = deferred<boolean>();
    const disconnect = vi.fn<RemoteGenomicsTransportProvider['disconnect']>(
      () => disconnected.promise
    );
    const runtime = new RemoteGenomicsRuntime(
      transportProvider(
        vi.fn(async () => fixture.materialization),
        { disconnect }
      ),
      { healthCheckIntervalMs: 0 }
    );
    await runtime.connect(request);
    const firstStop = runtime.stopAll();
    const nextStop = runtime.stopAll();
    let nextFinished = false;
    void nextStop.then(() => {
      nextFinished = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(nextFinished).toBe(false);
      expect(nextStop).toBe(firstStop);
    } finally {
      disconnected.resolve(true);
      await Promise.all([firstStop, nextStop]);
    }
    expect(disconnect).toHaveBeenCalledOnce();
    expect(runtime.listStatuses()).toEqual([]);
  });

  it.each([
    { label: 'discovered signal', initial: { ...request, signalPath: undefined } },
    {
      label: 'discovered index and signal',
      initial: { ...request, indexPath: undefined, signalPath: undefined },
    },
    { label: 'canonical alignment', initial: { ...request, alignmentPath: '/linked/sample.bam' } },
  ])('reuses one source when $label returns as a fully resolved locator', async ({ initial }) => {
    const fixture = await transportFixture('first-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValue(fixture.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());
    const first = await runtime.connect({ ...initial, requestId: 'implicit-owner' });
    const resolved = await runtime.connect({
      ...first.locator,
      requestId: 'resolved-owner',
      allowInteractive: true,
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(resolved.sessionId).not.toBe(first.sessionId);
    expect(resolved.bamUrl).toBe(first.bamUrl);
    expect(resolved.indexPath).toBe(first.indexPath);
    expect(runtime.listStatuses()).toHaveLength(1);
    await runtime.disconnect(first.sessionId);
    expect(provider.disconnect).not.toHaveBeenCalled();
    await expect(fetchText(resolved.bamUrl)).resolves.toBe('first-generation');
  });

  it('does not overwrite an already-live resolved source when another admission discovers its locator', async () => {
    const explicit = await transportFixture('first-generation');
    const implicit = await transportFixture('second-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(explicit.materialization)
      .mockResolvedValueOnce(implicit.materialization);
    const runtime = new RemoteGenomicsRuntime(transportProvider(connect), {
      healthCheckIntervalMs: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const existing = await runtime.connect(request);
    const discovered = await runtime.connect({ ...request, signalPath: undefined });
    const next = await runtime.connect(discovered.locator);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(next.bamUrl).toBe(existing.bamUrl);
    await runtime.disconnect(discovered.sessionId);
    const afterOldCleanup = await runtime.connect(discovered.locator);
    expect(afterOldCleanup.bamUrl).toBe(existing.bamUrl);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it.each(['alignment', 'index', 'signal', 'reference', 'referenceIndex'] as const)(
    'blocks a changed %s generation before replacing the cached index or serving new bytes',
    async (asset) => {
      const first = await transportFixture('first-generation');
      const replacement = await transportFixture('replacement-generation');
      const firstGeneration = {
        ...first.materialization.generation,
        reference: {
          ...first.materialization.generation.alignment,
          canonicalPath: '/full/reference.fa',
        },
        referenceIndex: {
          ...first.materialization.generation.index,
          canonicalPath: '/full/reference.fa.fai',
        },
      };
      const admitted = { ...first.materialization, generation: firstGeneration };
      const materialization = {
        ...replacement.materialization,
        generation: {
          ...firstGeneration,
          [asset]: { ...firstGeneration[asset]!, mtimeNs: 'changed' },
        },
      };
      await writeFile(replacement.materialization.indexPath, 'replacement-index');
      const connect = vi
        .fn<RemoteGenomicsTransportProvider['connect']>()
        .mockResolvedValueOnce(admitted)
        .mockResolvedValue(materialization);
      const provider = transportProvider(connect);
      const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
      cleanup.push(() => runtime.stopAll());
      const lease = await runtime.connect(request);
      const admittedIndex = await readFile(lease.indexPath, 'utf8');
      provider.emitClosed(first.materialization.sessionId);
      await vi.waitFor(() => expect(runtime.listStatuses()[0]?.state).toBe('blocked'));
      expect(runtime.listStatuses()[0]).toMatchObject({
        transportGeneration: 1,
        lastFailure: {
          code: 'source-changed',
          message: expect.stringMatching(/reconnect|edit source/i),
        },
      });
      expect(await readFile(lease.indexPath, 'utf8')).toBe(admittedIndex);
      expect(lease.generation).toEqual(firstGeneration);
      expect(provider.disconnect).toHaveBeenCalledWith(materialization.sessionId);
      expect(runtime.retryEndpoint(lease.runtimeStatus!.sourceId)).toBe(false);
      await expect(runtime.connect(request)).rejects.toThrow(/files changed/i);
      const response = await fetch(lease.bamUrl);
      expect(response.status).toBe(503);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(connect).toHaveBeenCalledTimes(2);
    }
  );

  it('admits a changed source through an explicit interactive connection while old leases stay blocked', async () => {
    const first = await transportFixture('first-generation');
    const replacement = await transportFixture('replacement-generation', { fileGeneration: 2 });
    await writeFile(replacement.materialization.indexPath, 'replacement-index');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockResolvedValue(replacement.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());
    const oldLease = await runtime.connect({ ...request, signalPath: undefined });
    provider.emitClosed(first.materialization.sessionId);
    await vi.waitFor(() => expect(runtime.listStatuses()[0]?.state).toBe('blocked'));
    const fresh = await runtime.connect({
      ...oldLease.locator,
      requestId: 'explicit-readmission',
      allowInteractive: true,
    });
    expect(fresh.runtimeStatus?.sourceId).not.toBe(oldLease.runtimeStatus?.sourceId);
    expect(fresh.bamUrl).not.toBe(oldLease.bamUrl);
    expect(fresh.indexPath).not.toBe(oldLease.indexPath);
    expect(fresh.generation).toEqual(replacement.materialization.generation);
    expect(await readFile(fresh.indexPath, 'utf8')).toBe('replacement-index');
    expect(await fetchText(fresh.bamUrl)).toBe('replacement-generation');
    expect((await fetch(oldLease.bamUrl)).status).toBe(503);
    const originalAlias = await runtime.connect({ ...request, signalPath: undefined });
    expect(originalAlias.bamUrl).toBe(fresh.bamUrl);
    await runtime.disconnect(oldLease.sessionId);
    const resolvedAlias = await runtime.connect(fresh.locator);
    expect(resolvedAlias.bamUrl).toBe(fresh.bamUrl);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it.runIf(process.platform !== 'win32')(
    'ends the actual silent SSH child when its last connection wait is cancelled',
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-cancel-child-test-')));
      const boundary = createFakeSshBoundary(root);
      vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
      const supervisor = new RemoteGenomicsSupervisor({
        sshPath: boundary.executablePath,
        connectTimeoutMs: 2_000,
      });
      const runtime = new RemoteGenomicsRuntime(supervisor, { healthCheckIntervalMs: 0 });
      let pid: number | null = null;
      try {
        const connecting = runtime.connect({
          ...request,
          target: 'silent-hpc',
          requestId: 'silent-connect-1234',
        });
        const cancelled = expect(connecting).rejects.toThrow('cancelled');
        await vi.waitFor(async () => {
          const log = await readFile(boundary.logPath, 'utf8');
          pid = Number(/^DNAFORGE_FAKE_SSH_PID (\d+)$/mu.exec(log)?.[1]);
          expect(pid).toBeGreaterThan(1);
        });
        expect(runtime.cancelConnect('silent-connect-1234')).toBe(true);
        await cancelled;
        await vi.waitFor(
          () => {
            expect(() => process.kill(pid!, 0)).toThrow();
          },
          { timeout: 500 }
        );
        expect(runtime.listStatuses()).toEqual([]);
      } finally {
        if (pid) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }
        await runtime.stopAll();
        await supervisor.stopAll();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'awaits the actual pending admission child before shutdown completes',
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-pending-shutdown-test-')));
      const sshPath = join(root, 'slow-term-ssh.cjs');
      const markerPath = join(root, 'owned-child.log');
      await writeFile(
        sshPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '-G') {
  process.stdout.write('controlmaster false\\ncontrolpersist no\\n');
  process.exit(0);
}
const markerPath = ${JSON.stringify(markerPath)};
process.stdin.resume();
let terminating = false;
process.on('SIGTERM', () => {
  if (terminating) return;
  terminating = true;
  fs.appendFileSync(markerPath, 'TERM\\n');
  setTimeout(() => process.exit(0), 350);
});
fs.writeFileSync(markerPath, 'START ' + process.pid + '\\n');
setInterval(() => {}, 1000);
`,
        { mode: 0o700 }
      );
      const supervisor = new RemoteGenomicsSupervisor({ sshPath, connectTimeoutMs: 2_000 });
      const runtime = new RemoteGenomicsRuntime(supervisor, { healthCheckIntervalMs: 0 });
      let pid: number | null = null;
      const connecting = runtime.connect({ ...request, requestId: 'pending-shutdown-1234' }).then(
        () => 'admitted',
        (error: Error) => error.message
      );
      try {
        await vi.waitFor(async () => {
          const marker = await readFile(markerPath, 'utf8');
          pid = Number(/^START (\d+)$/mu.exec(marker)?.[1]);
          expect(pid).toBeGreaterThan(1);
        });
        expect(() => process.kill(pid!, 0)).not.toThrow();

        await runtime.stopAll();

        expect(
          () => process.kill(pid!, 0),
          'Shutdown must await the helper being reaped inside provider.connect'
        ).toThrow();
        expect(await readFile(markerPath, 'utf8')).toContain('TERM\n');
        expect(runtime.listStatuses()).toEqual([]);
        expect(await connecting).toContain('cancelled');
      } finally {
        await runtime.stopAll();
        if (pid) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
          await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), {
            timeout: 1_500,
          });
        }
        await connecting;
        await supervisor.stopAll();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('ends a first authentication failure so a saved row can offer Repair', async () => {
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockRejectedValue(
        new RemoteGenomicsError(
          'authentication-required',
          'OpenSSH needs interactive authentication.'
        )
      );
    const runtime = new RemoteGenomicsRuntime(transportProvider(connect), {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const states: string[] = [];
    runtime.subscribe((event) => states.push(event.status.state));

    await expect(runtime.connect(request)).rejects.toThrow('interactive authentication');
    expect(connect).toHaveBeenCalledOnce();
    expect(states).toContain('needs-authentication');
    expect(runtime.listStatuses()).toEqual([]);
  });

  it('keeps a shared pending transport alive when only one of its callers cancels', async () => {
    const fixture = await transportFixture('shared-generation');
    const transport = deferred<RemoteAlignmentMaterializationV1>();
    let signal: AbortSignal | undefined;
    const connect = vi.fn<RemoteGenomicsTransportProvider['connect']>((_request, pendingSignal) => {
      signal = pendingSignal;
      return transport.promise;
    });
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());
    const first = runtime.connect({ ...request, requestId: 'shared-first-1234' });
    const cancelled = expect(first).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const second = runtime.connect({ ...request, requestId: 'shared-second-1234' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.cancelConnect('shared-first-1234')).toBe(true);
    await cancelled;
    expect(signal?.aborted).toBe(false);
    transport.resolve(fixture.materialization);
    const remaining = await second;
    await expect(fetchText(remaining.bamUrl)).resolves.toBe('shared-generation');
    expect(connect).toHaveBeenCalledOnce();
    expect(provider.disconnect).not.toHaveBeenCalled();
  });

  it('bounds first-connection transient retries instead of leaving restore pending forever', async () => {
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockRejectedValue(new RemoteGenomicsError('host-unreachable', 'OpenSSH could not connect.'));
    const runtime = new RemoteGenomicsRuntime(transportProvider(connect), {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());

    await expect(runtime.connect(request)).rejects.toThrow('OpenSSH could not connect.');
    expect(connect).toHaveBeenCalledTimes(3);
    expect(runtime.listStatuses()).toEqual([]);
  });

  it('times out a silent first connect and disconnects a transport that arrives afterward', async () => {
    const late = await transportFixture('late-generation');
    const transport = deferred<RemoteAlignmentMaterializationV1>();
    const cancelled = deferred<void>();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockImplementation((_request, signal) => {
        signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
        return transport.promise;
      });
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      connectWaitTimeoutMs: 20,
      healthCheckIntervalMs: 0,
    });
    cleanup.push(() => runtime.stopAll());

    const rejection = expect(runtime.connect(request)).rejects.toThrow(
      'Connection to cluster-a is taking too long'
    );
    await cancelled.promise;
    transport.resolve(late.materialization);
    await rejection;
    await vi.waitFor(() =>
      expect(provider.disconnect).toHaveBeenCalledWith(late.materialization.sessionId)
    );
    expect(runtime.listStatuses()).toEqual([]);
  });

  it('bounds a new caller joining a reconnect without destroying the existing stable source', async () => {
    const first = await transportFixture('first-generation');
    const recovered = await transportFixture('recovered-generation');
    const replacement = deferred<RemoteAlignmentMaterializationV1>();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockReturnValueOnce(replacement.promise);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      connectWaitTimeoutMs: 30,
      healthCheckIntervalMs: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const originalLease = await runtime.connect(request);

    provider.emitClosed(first.materialization.sessionId);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

    await expect(runtime.connect(request)).rejects.toThrow(
      'Connection to cluster-a is taking too long'
    );
    expect(runtime.listStatuses()).toEqual([
      expect.objectContaining({ state: 'retrying', transportGeneration: 1 }),
    ]);

    replacement.resolve(recovered.materialization);
    await vi.waitFor(() =>
      expect(runtime.listStatuses()[0]).toMatchObject({
        state: 'online',
        transportGeneration: 2,
      })
    );
    await expect(fetchText(originalLease.bamUrl)).resolves.toBe('recovered-generation');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('holds an established source at authentication failure until Retry is clicked', async () => {
    const first = await transportFixture('first-generation');
    const recovered = await transportFixture('recovered-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockRejectedValueOnce(
        new RemoteGenomicsError('authentication-required', 'Sign in on the endpoint.')
      )
      .mockResolvedValueOnce(recovered.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);

    provider.emitClosed(first.materialization.sessionId);
    await vi.waitFor(() =>
      expect(runtime.listStatuses()[0]).toMatchObject({ state: 'needs-authentication' })
    );
    expect(connect).toHaveBeenCalledTimes(2);
    expect(runtime.retryEndpoint('endpoint-a')).toBe(true);
    await vi.waitFor(() =>
      expect(runtime.listStatuses()[0]).toMatchObject({
        state: 'online',
        transportGeneration: 2,
      })
    );
    expect(connect).toHaveBeenCalledTimes(3);
    await expect(fetchText(lease.bamUrl)).resolves.toBe('recovered-generation');
  });

  it.each([
    'authentication-required',
    'host-trust-failed',
    'alignment-not-found',
    'cluster-unavailable',
  ] as const)(
    'does not restart a %s source for viewport reads or a background restore',
    async (code) => {
      const first = await transportFixture('first-generation');
      const recovered = await transportFixture('recovered-generation');
      const connect = vi
        .fn<RemoteGenomicsTransportProvider['connect']>()
        .mockResolvedValueOnce(first.materialization)
        .mockRejectedValueOnce(new RemoteGenomicsError(code, 'Explicit reconnect required.'))
        .mockResolvedValue(recovered.materialization);
      const provider = transportProvider(connect);
      const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
      cleanup.push(() => runtime.stopAll());
      const original = await runtime.connect(request);
      provider.emitClosed(first.materialization.sessionId);
      const state =
        code === 'authentication-required' || code === 'host-trust-failed'
          ? 'needs-authentication'
          : 'blocked';
      await vi.waitFor(() => expect(runtime.listStatuses()[0]).toMatchObject({ state }));

      const responses = await Promise.all([
        fetch(original.bamUrl, { headers: { Range: 'bytes=0-15' } }),
        fetch(original.bamUrl, { method: 'HEAD', headers: { Range: 'bytes=0-15' } }),
        fetch(original.bigWigUrl!, { headers: { Range: 'bytes=0-15' } }),
      ]);
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      expect(responses.map((response) => response.status)).toEqual([503, 503, 503]);
      await expect(runtime.connect(request)).rejects.toThrow('Explicit reconnect required.');
      expect(connect).toHaveBeenCalledTimes(2);
      expect(runtime.listStatuses()[0]).toMatchObject({
        state,
        sourceId: original.runtimeStatus!.sourceId,
        transportGeneration: 1,
        lastFailure: { code, message: 'Explicit reconnect required.' },
      });

      const resumed = await runtime.connect({
        ...request,
        requestId: 'explicit-reconnect-1234',
        allowInteractive: true,
      });
      expect(resumed.bamUrl).toBe(original.bamUrl);
      expect(resumed.runtimeStatus).toMatchObject({ state: 'online', transportGeneration: 2 });
      expect(connect).toHaveBeenCalledTimes(3);
      await expect(fetchText(original.bamUrl)).resolves.toBe('recovered-generation');
      await runtime.disconnect(resumed.sessionId);
      await expect(fetchText(original.bamUrl)).resolves.toBe('recovered-generation');
    }
  );

  it('lets interactive Reconnect outlive an in-flight background authentication failure', async () => {
    const first = await transportFixture('first-generation');
    const recovered = await transportFixture('recovered-generation');
    const background = deferred<void>();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockImplementationOnce(async () => {
        await background.promise;
        throw new RemoteGenomicsError('authentication-required', 'The background login failed.');
      })
      .mockResolvedValueOnce(recovered.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());
    const originalLease = await runtime.connect(request);

    provider.emitClosed(first.materialization.sessionId);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    const repair = runtime.connect({
      ...request,
      requestId: 'interactive-repair-1234',
      allowInteractive: true,
    });
    const repaired = expect(repair).resolves.toMatchObject({ bamUrl: originalLease.bamUrl });
    await new Promise<void>((resolve) => setImmediate(resolve));
    background.resolve();
    await repaired;

    expect(connect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ requestId: 'interactive-repair-1234', allowInteractive: true }),
      expect.any(AbortSignal)
    );
    await expect(fetchText(originalLease.bamUrl)).resolves.toBe('recovered-generation');
    expect(runtime.listStatuses()).toHaveLength(1);
    expect(runtime.listStatuses()[0]).toMatchObject({ state: 'online', transportGeneration: 2 });
  });

  it('absorbs a helper-port collision before publishing one stable source', async () => {
    const fixture = await transportFixture('first-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockRejectedValueOnce(
        new RemoteGenomicsError(
          'tunnel-failed',
          'The endpoint could not reserve the private helper port.'
        )
      )
      .mockResolvedValueOnce(fixture.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());

    const statuses: string[] = [];
    runtime.subscribe((event) => statuses.push(event.status.state));

    const materialization = await runtime.connect(request);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(materialization.bamUrl).not.toBe(fixture.materialization.bamUrl);
    expect(materialization.bigWigUrl).not.toBe(fixture.materialization.bigWigUrl);
    expect(await fetchText(materialization.bamUrl)).toBe('first-generation');
    expect(materialization.runtimeStatus).toMatchObject({
      state: 'online',
      transportGeneration: 1,
      alignmentPath: request.alignmentPath,
    });
    expect(statuses).toContain('retrying');
    expect(statuses.at(-1)).toBe('online');
  });

  it('disconnects an uninstalled transport when local index handoff fails, then retries', async () => {
    const broken = await transportFixture('first-generation');
    const recovered = await transportFixture('second-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce({
        ...broken.materialization,
        indexPath: `${broken.materialization.indexPath}.missing`,
      })
      .mockResolvedValueOnce(recovered.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());

    const materialization = await runtime.connect(request);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(provider.disconnect).toHaveBeenCalledWith('transport-1');
    expect(await fetchText(materialization.bamUrl)).toBe('second-generation');
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
  });

  it('rotates a nominally-online transport when the user explicitly retries it', async () => {
    const first = await transportFixture('first-generation');
    const recovered = await transportFixture('recovered-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockResolvedValueOnce(recovered.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);

    expect(runtime.retryEndpoint('endpoint-a')).toBe(true);

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await expect(fetchText(lease.bamUrl)).resolves.toBe('recovered-generation');
    expect(provider.disconnect).toHaveBeenCalledWith('transport-1');
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 2,
    });
  });

  it('does not let a failing status observer corrupt a successful transport handoff', async () => {
    const fixture = await transportFixture('first-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValue(fixture.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runtime.subscribe(() => {
      throw new Error('observer failed');
    });

    const materialization = await runtime.connect(request);

    expect(connect).toHaveBeenCalledOnce();
    expect(await fetchText(materialization.bamUrl)).toBe('first-generation');
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
    expect(warning).toHaveBeenCalledWith(
      '[remote-genomics] status listener failed:',
      'observer failed'
    );
    warning.mockRestore();
  });

  it('replaces a dead transport behind the same URL without a caller retry', async () => {
    const first = await transportFixture('first-generation');
    const second = await transportFixture('second-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockResolvedValueOnce(second.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());

    const firstLease = await runtime.connect(request);
    const stableBamUrl = firstLease.bamUrl;
    expect(await fetchText(stableBamUrl)).toBe('first-generation');

    provider.emitClosed('transport-1');

    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledTimes(2);
      expect(runtime.listStatuses()).toEqual([
        expect.objectContaining({
          endpointId: 'endpoint-a',
          state: 'online',
          transportGeneration: 2,
        }),
      ]);
    });

    expect(firstLease.bamUrl).toBe(stableBamUrl);
    expect(await fetchText(stableBamUrl)).toBe('second-generation');
    expect(provider.disconnect).not.toHaveBeenCalledWith(firstLease.sessionId);

    await runtime.disconnect(firstLease.sessionId);
    expect(provider.disconnect).toHaveBeenCalledWith('transport-2');
  });

  it('keeps one stable source alive while a replacement lease is validated and handed over', async () => {
    const fixture = await transportFixture('stable-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValue(fixture.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());

    const currentLease = await runtime.connect(request);
    const replacementLease = await runtime.connect(request);

    expect(replacementLease.bamUrl).toBe(currentLease.bamUrl);
    expect(replacementLease.indexPath).toBe(currentLease.indexPath);
    expect(connect).toHaveBeenCalledOnce();
    expect(await runtime.disconnect(currentLease.sessionId)).toBe(true);
    expect(provider.disconnect).not.toHaveBeenCalled();
    await expect(fetchText(replacementLease.bamUrl)).resolves.toBe('stable-generation');

    expect(await runtime.disconnect(replacementLease.sessionId)).toBe(true);
    expect(provider.disconnect).toHaveBeenCalledWith(fixture.materialization.sessionId);
  });

  it('keeps a newly admitted source pooled when its previous owner finishes slow teardown', async () => {
    const first = await transportFixture('first-generation');
    const replacement = await transportFixture('replacement-generation');
    const disconnectingFirst = deferred<boolean>();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockResolvedValueOnce(replacement.materialization)
      .mockResolvedValue({
        ...replacement.materialization,
        sessionId: 'unexpected-third-transport',
      });
    const disconnect = vi.fn<RemoteGenomicsTransportProvider['disconnect']>((sessionId) =>
      sessionId === first.materialization.sessionId
        ? disconnectingFirst.promise
        : Promise.resolve(true)
    );
    const provider = transportProvider(connect, { disconnect });
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());

    const firstOwner = await runtime.connect({ ...request, requestId: 'first-owner' });
    const closingFirstOwner = runtime.disconnect(firstOwner.sessionId);
    try {
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(first.materialization.sessionId);
      const nextOwner = await runtime.connect({ ...request, requestId: 'next-owner' });
      await expect(fetchText(nextOwner.bamUrl)).resolves.toBe('replacement-generation');

      disconnectingFirst.resolve(true);
      await closingFirstOwner;
      const thirdOwner = await runtime.connect({ ...request, requestId: 'third-owner' });

      expect(connect).toHaveBeenCalledTimes(2);
      expect(thirdOwner.sessionId).not.toBe(nextOwner.sessionId);
      expect(thirdOwner.bamUrl).toBe(nextOwner.bamUrl);
      expect(thirdOwner.indexPath).toBe(nextOwner.indexPath);
      expect(runtime.listStatuses()).toHaveLength(1);
      await runtime.disconnect(nextOwner.sessionId);
      expect(disconnect).not.toHaveBeenCalledWith(replacement.materialization.sessionId);
      await expect(fetchText(thirdOwner.bamUrl)).resolves.toBe('replacement-generation');
      await runtime.disconnect(thirdOwner.sessionId);
      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(runtime.listStatuses()).toEqual([]);
    } finally {
      disconnectingFirst.resolve(true);
      await closingFirstOwner;
    }
  });

  it('coalesces stationary in-flight demand while a replacement transport starts', async () => {
    const first = await transportFixture('first-generation');
    const second = await transportFixture('second-generation');
    const replacement = deferred<RemoteAlignmentMaterializationV1>();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockReturnValueOnce(replacement.promise);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());

    const lease = await runtime.connect(request);
    provider.emitClosed('transport-1');
    const alignmentDemand = fetchText(lease.bamUrl);
    const signalDemand = fetchText(lease.bigWigUrl!);

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    replacement.resolve(second.materialization);

    await expect(alignmentDemand).resolves.toBe('second-generation');
    await expect(signalDemand).resolves.toBe('second-generation');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 2,
    });
  });

  it('replaces a live-but-unresponsive transport within the same gateway request', async () => {
    const stalled = await transportFixture('never-returned', { hang: true });
    const replacement = await transportFixture('recovered-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(stalled.materialization)
      .mockResolvedValueOnce(replacement.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
      upstreamRequestTimeoutMs: 20,
    });
    cleanup.push(() => runtime.stopAll());

    const lease = await runtime.connect(request);

    await expect(fetchText(lease.bamUrl)).resolves.toBe('recovered-generation');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(provider.disconnect).toHaveBeenCalledWith('transport-1');
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 2,
    });
  });

  it('does not let a late failure from the dead transport poison its healthy replacement', async () => {
    const stalled = await transportFixture('never-returned', { hang: true });
    const replacement = await transportFixture('recovered-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(stalled.materialization)
      .mockResolvedValue(replacement.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
      upstreamRequestTimeoutMs: 30,
    });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);

    const firstDemand = fetchText(lease.bamUrl);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const lateOldTransportDemand = fetchText(lease.bigWigUrl!);

    await expect(firstDemand).resolves.toBe('recovered-generation');
    await expect(lateOldTransportDemand).resolves.toBe('recovered-generation');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 2,
    });
  });

  it('honors Retry clicked synchronously from the blocked status event', async () => {
    const first = await transportFixture('first-generation');
    const recovered = await transportFixture('recovered-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockRejectedValueOnce(
        new RemoteGenomicsError('alignment-not-found', 'The remote alignment was not found.')
      )
      .mockResolvedValueOnce(recovered.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);
    const blocked = deferred<void>();
    runtime.subscribe((event) => {
      if (event.status.state !== 'blocked') return;
      expect(runtime.retryEndpoint('endpoint-a')).toBe(true);
      blocked.resolve();
    });

    provider.emitClosed('transport-1');
    await blocked.promise;
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    await expect(fetchText(lease.bamUrl)).resolves.toBe('recovered-generation');
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 2,
    });
  });

  it('replaces a silent hung helper while the viewport has no outstanding range request', async () => {
    const stalled = await transportFixture('never-returned', { hang: true });
    const replacement = await transportFixture('heartbeat-recovered');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(stalled.materialization)
      .mockResolvedValue(replacement.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
      healthCheckIntervalMs: 10,
      healthCheckTimeoutMs: 20,
    });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);

    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledTimes(2);
      expect(runtime.listStatuses()[0]).toMatchObject({
        state: 'online',
        transportGeneration: 2,
      });
    });
    expect(provider.disconnect).toHaveBeenCalledWith('transport-1');
    await expect(fetchText(lease.bamUrl)).resolves.toBe('heartbeat-recovered');
  });

  it('does not replace healthy SSH when a range reader abandons a superseded request', async () => {
    const fixture = await transportFixture('still-online', {
      hangAfterHeadersForRange: 'bytes=0-999',
    });
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValue(fixture.materialization);
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
      upstreamRequestTimeoutMs: 20,
    });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);

    const controller = new AbortController();
    const superseded = await fetch(lease.bamUrl, {
      headers: { Range: 'bytes=0-999' },
      signal: controller.signal,
    });
    expect(superseded.status).toBe(206);
    controller.abort();
    await expect(superseded.text()).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(connect).toHaveBeenCalledOnce();
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
    await expect(fetchText(lease.bamUrl)).resolves.toBe('still-online');
  });

  it('does not let slow teardown overwrite an already-online replacement', async () => {
    const stalled = await transportFixture('never-returned', { hang: true });
    const replacement = await transportFixture('recovered-generation');
    const disconnectingFirst = deferred<boolean>();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(stalled.materialization)
      .mockResolvedValueOnce(replacement.materialization);
    const disconnect = vi.fn<RemoteGenomicsTransportProvider['disconnect']>((sessionId) =>
      sessionId === 'transport-1' ? disconnectingFirst.promise : Promise.resolve(true)
    );
    const provider = transportProvider(connect, { disconnect });
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
      upstreamRequestTimeoutMs: 20,
    });
    cleanup.push(() => runtime.stopAll());
    const lease = await runtime.connect(request);

    const firstDemand = fetchText(lease.bamUrl);
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('transport-1'));
    const concurrentDemand = fetchText(lease.bigWigUrl!);
    await vi.waitFor(() => {
      expect(runtime.listStatuses()[0]).toMatchObject({
        state: 'online',
        transportGeneration: 2,
      });
    });

    disconnectingFirst.resolve(true);
    await expect(firstDemand).resolves.toBe('recovered-generation');
    await expect(concurrentDemand).resolves.toBe('recovered-generation');
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 2,
    });
  });

  it('releases an abandoned renderer connection wait without leaving a retrying source behind', async () => {
    const eventual = await transportFixture('first-generation');
    const transport = deferred<RemoteAlignmentMaterializationV1>();
    const cancelled = deferred<void>();
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockImplementation((_request, signal) => {
        signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
        return transport.promise;
      });
    const provider = transportProvider(connect);
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());
    const connecting = runtime.connect({ ...request, requestId: 'renderer-wait-1' });
    const rejection = expect(connecting).rejects.toThrow('cancelled');

    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(runtime.cancelConnect('renderer-wait-1')).toBe(true);
    await cancelled.promise;
    transport.resolve(eventual.materialization);
    await rejection;
    await vi.waitFor(() =>
      expect(provider.disconnect).toHaveBeenCalledWith(eventual.materialization.sessionId)
    );
    expect(runtime.listStatuses()).toEqual([]);
  });

  it('does not publish a materialization whose SSH child died during handoff', async () => {
    const first = await transportFixture('first-generation');
    const second = await transportFixture('second-generation');
    const connect = vi
      .fn<RemoteGenomicsTransportProvider['connect']>()
      .mockResolvedValueOnce(first.materialization)
      .mockResolvedValueOnce(second.materialization);
    const provider = transportProvider(connect, { closeOnSubscribeSessionId: 'transport-1' });
    const runtime = new RemoteGenomicsRuntime(provider, {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
    });
    cleanup.push(() => runtime.stopAll());

    const lease = await runtime.connect(request);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(await fetchText(lease.bamUrl)).toBe('second-generation');
    expect(runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 2,
    });
  });
});

function transportProvider(
  connect: RemoteGenomicsTransportProvider['connect'],
  options: {
    readonly closeOnSubscribeSessionId?: string;
    readonly disconnect?: RemoteGenomicsTransportProvider['disconnect'];
  } = {}
): RemoteGenomicsTransportProvider & { emitClosed(sessionId: string): void } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    connect,
    disconnect: options.disconnect ?? vi.fn(async () => true),
    subscribeSession: (sessionId, listener) => {
      const current = listeners.get(sessionId) ?? new Set();
      current.add(listener);
      listeners.set(sessionId, current);
      if (sessionId === options.closeOnSubscribeSessionId) queueMicrotask(listener);
      return () => current.delete(listener);
    },
    emitClosed: (sessionId) => {
      for (const listener of listeners.get(sessionId) ?? []) listener();
    },
  };
}

async function actualHelperFixture() {
  const root = await mkdtemp(join(tmpdir(), 'remote-runtime-helper-test-'));
  const paths = {
    alignment: join(root, 'sample.bam'),
    index: join(root, 'sample.bam.bai'),
    signal: join(root, 'sample.bigWig'),
  };
  await Promise.all([
    writeFile(paths.alignment, Buffer.alloc(64, 'A')),
    writeFile(paths.index, 'index'),
    writeFile(paths.signal, Buffer.alloc(64, 'A')),
  ]);
  const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  cleanup.push(async () => {
    await terminateRemoteChild(child);
    await rm(root, { recursive: true, force: true });
  });
  const ready = await new Promise<{
    port: number;
    paths: { alignment: string; signal: string };
    files: RemoteAlignmentMaterializationV1['generation'];
  }>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (data) => {
      output += String(data);
      const line = output.split('\n').find((line) => line.startsWith('DNAFORGE_REMOTE_READY '));
      if (line) resolve(JSON.parse(line.slice('DNAFORGE_REMOTE_READY '.length)));
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('The fixture helper exited before readiness.')));
    child.stdin.end(
      buildRemoteRangeHelperScript({
        port: 0,
        alignmentPath: paths.alignment,
        indexPath: paths.index,
        signalPath: paths.signal,
        sourceHandle: 'runtime-file-change',
      })
    );
  });
  const materialization: RemoteAlignmentMaterializationV1 = {
    protocol: 'dnaforge-remote-range.v1',
    sessionId: 'actual-helper-transport',
    endpoint: {
      endpointId: 'endpoint-a',
      target: request.target,
      displayName: request.target,
      lastConnectedAt: 1,
      observedPlatform: 'local-python',
      lastFailure: null,
    },
    locator: {
      contract: 'remote-alignment-locator.v1',
      endpointId: 'endpoint-a',
      target: request.target,
      alignmentPath: paths.alignment,
      indexPath: paths.index,
      signalPath: paths.signal,
    },
    bamUrl: `http://127.0.0.1:${ready.port}${ready.paths.alignment}`,
    bigWigUrl: `http://127.0.0.1:${ready.port}${ready.paths.signal}`,
    indexPath: paths.index,
    generation: ready.files,
  };
  return { paths, materialization };
}

async function transportFixture(
  body: string,
  options: {
    readonly hang?: boolean;
    readonly hangAfterHeadersForRange?: string;
    readonly fileGeneration?: number;
  } = {}
): Promise<{
  readonly materialization: RemoteAlignmentMaterializationV1;
}> {
  const server = createServer((req, res) => {
    if (options.hang) return;
    res.statusCode = req.headers.range ? 206 : 200;
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-type', 'application/octet-stream');
    if (
      options.hangAfterHeadersForRange !== undefined &&
      req.headers.range === options.hangAfterHeadersForRange
    ) {
      res.setHeader('content-length', '1000');
      res.write('x');
      return;
    }
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  const port = await listen(server);
  const root = await mkdtemp(join(tmpdir(), 'remote-runtime-test-'));
  const indexPath = join(root, 'sample.bam.bai');
  await writeFile(indexPath, 'index');
  cleanup.push(async () => {
    await close(server);
    await rm(root, { recursive: true, force: true });
  });
  const generationNumber = body === 'first-generation' || body === 'never-returned' ? 1 : 2;
  const fileGeneration = options.fileGeneration ?? 1;
  return {
    materialization: {
      protocol: 'dnaforge-remote-range.v1',
      sessionId: `transport-${generationNumber}`,
      endpoint: {
        endpointId: 'endpoint-a',
        displayName: 'cluster-a',
        target: 'cluster-a',
        lastConnectedAt: generationNumber,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: {
        contract: 'remote-alignment-locator.v1',
        endpointId: 'endpoint-a',
        target: 'cluster-a',
        alignmentPath: '/run/sample.bam',
        indexPath: '/run/sample.bam.bai',
        signalPath: '/run/sample.bigWig',
      },
      bamUrl: `http://127.0.0.1:${port}/alignment.bam`,
      bigWigUrl: `http://127.0.0.1:${port}/signal.bigWig`,
      indexPath,
      generation: {
        alignment: receipt('/run/sample.bam', fileGeneration),
        index: receipt('/run/sample.bam.bai', fileGeneration),
        signal: receipt('/run/sample.bigWig', fileGeneration),
      },
    },
  };
}

async function byteRangeFixture() {
  const base = await transportFixture('byte-cache');
  const bytes = Buffer.alloc(196731);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const fixture = {
    bytes,
    changed: false,
    getDelayMs: 15,
    failure: null as 'wrong range' | 'short body' | 'encoded body' | null,
    requests: [] as Array<{ method: string; range: string | undefined }>,
    materialization: base.materialization,
  };
  const server = createServer((req, res) => {
    fixture.requests.push({ method: req.method!, range: req.headers.range });
    if (fixture.changed) {
      res.writeHead(412).end();
      return;
    }
    const selection = /^bytes=(\d+)-(\d*)$/u.exec(req.headers.range ?? '');
    const start = selection ? Number(selection[1]) : 0;
    const end = selection?.[2]
      ? Math.min(bytes.length - 1, Number(selection[2]))
      : bytes.length - 1;
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('etag', '"1-1-3007b"');
    res.setHeader('content-length', end - start + 1);
    if (selection) res.setHeader('content-range', `bytes ${start}-${end}/${bytes.length}`);
    const failing = req.method === 'GET' && end - start > 0 ? fixture.failure : null;
    if (failing === 'wrong range') res.setHeader('content-range', `bytes 1-${end}/${bytes.length}`);
    if (failing === 'encoded body') res.setHeader('content-encoding', 'gzip');
    res.statusCode = selection ? 206 : 200;
    if (req.method === 'HEAD') res.end();
    else
      setTimeout(() => {
        if (failing === 'short body') {
          res.write(bytes.subarray(start, start + 5));
          res.destroy();
        } else res.end(bytes.subarray(start, end + 1));
      }, fixture.getDelayMs);
  });
  const port = await listen(server);
  cleanup.push(() => close(server));
  fixture.materialization = {
    ...base.materialization,
    bamUrl: `http://127.0.0.1:${port}/alignment.bam`,
    generation: {
      ...base.materialization.generation,
      alignment: { ...base.materialization.generation.alignment, size: bytes.length },
    },
  };
  return fixture;
}

function receipt(path: string, generation: number) {
  return {
    canonicalPath: path,
    size: 1024,
    mtimeNs: String(generation),
    ctimeNs: String(generation),
    device: '1',
    inode: String(generation),
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-31' } });
  expect(response.status).toBe(206);
  return response.text();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP.');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
