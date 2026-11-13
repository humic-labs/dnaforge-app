// @vitest-environment node
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteAlignmentMaterializationV1,
  RemoteSignalMaterializationV1,
} from '../../shared/remote-genomics-ipc';
import {
  RemoteGenomicsRuntime,
  type RemoteGenomicsTransportProvider,
} from '../remote-genomics-runtime';
import { registerRemoteGenomicsIpcHandlers } from './remote-genomics';
import { remoteSshPromptBroker } from '../remote-ssh-prompt-broker';

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  send: vi.fn(),
  recordFailure: vi.fn(),
}));
vi.mock('../../shared/ipc-contract', async () => {
  const { contractEntries } = await vi.importActual<typeof import('../../shared/ipc/contract')>(
    '../../shared/ipc/contract'
  );
  return {
    mainIpc: { handle: (name: string, handler: Function) => ipc.handlers.set(name, handler) },
    handleGroup: (
      contract: import('../../shared/ipc/contract').AnyContractGroup,
      handlers: Record<string, Function | null>
    ) => {
      for (const { method, channel } of contractEntries(contract)) {
        const handler = handlers[method];
        if (handler) ipc.handlers.set(channel, handler);
      }
      return () => undefined;
    },
    sendRendererIpc: ipc.send,
  };
});
vi.mock('./database', () => ({
  getDb: () => {
    throw new Error('Unexpected real database');
  },
}));
vi.mock('../remote-endpoint-registry', () => ({
  findRemoteEndpointProfileById: () => null,
  findRemoteEndpointProfileByTarget: () => null,
  listRemoteEndpointProfiles: vi.fn(() => []),
  renameRemoteEndpointProfile: () => null,
  forgetRemoteEndpointProfile: () => false,
  recordRemoteEndpointFailure: ipc.recordFailure,
  recordRemoteEndpointSuccess: (_db: unknown, profile: unknown) => profile,
}));
vi.mock('../remote-ssh-prompt-broker', () => ({
  remoteSshPromptBroker: {
    prepare: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
    respond: vi.fn(),
  },
}));

class Owner extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  get contents(): WebContents {
    return this as unknown as WebContents;
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
  ipc.handlers.clear();
  vi.clearAllMocks();
});

const request = { target: 'synthetic-owner-test', alignmentPath: '/run/source.bam' };
function invoke(name: string, owner: Owner, ...args: unknown[]): Promise<any> {
  return Promise.resolve(
    ipc.handlers.get(`remoteGenomics:${name}`)!({ sender: owner.contents }, ...args)
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'remote-ipc-owner-'));
  const indexPath = join(root, 'source.bai');
  await writeFile(indexPath, Buffer.from([1, 2, 3, 4]));
  const server = createServer((_req, response) => response.end('independent-owner-data'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing helper address');
  const materialization: RemoteAlignmentMaterializationV1 = {
    protocol: 'dnaforge-remote-range.v1',
    sessionId: 'transport-owned-by-runtime',
    endpoint: {
      endpointId: 'endpoint-owner-test',
      target: request.target,
      displayName: request.target,
      lastConnectedAt: 1,
      observedPlatform: 'synthetic',
      lastFailure: null,
    },
    locator: {
      contract: 'remote-alignment-locator.v1',
      endpointId: 'endpoint-owner-test',
      target: request.target,
      alignmentPath: request.alignmentPath,
      indexPath: '/run/source.bam.bai',
    },
    bamUrl: `http://127.0.0.1:${address.port}/source.bam`,
    indexPath,
    generation: {
      alignment: {
        canonicalPath: request.alignmentPath,
        size: 4,
        mtimeNs: '1',
        ctimeNs: '1',
        device: null,
        inode: null,
      },
      index: {
        canonicalPath: '/run/source.bam.bai',
        size: 4,
        mtimeNs: '1',
        ctimeNs: '1',
        device: null,
        inode: null,
      },
    },
  };
  const provider = {
    connect: vi.fn<RemoteGenomicsTransportProvider['connect']>(async () => materialization),
    connectSignal: vi.fn<NonNullable<RemoteGenomicsTransportProvider['connectSignal']>>(
      async (): Promise<RemoteSignalMaterializationV1> => ({
        protocol: materialization.protocol,
        sessionId: materialization.sessionId,
        endpoint: materialization.endpoint,
        locator: {
          contract: 'remote-signal-locator.v1',
          endpointId: materialization.endpoint.endpointId,
          target: request.target,
          signalPath: '/run/only.bigWig',
        },
        bigWigUrl: materialization.bamUrl,
        generation: {
          signal: { ...materialization.generation.alignment, canonicalPath: '/run/only.bigWig' },
        },
      })
    ),
    disconnect: vi.fn(async () => true),
    subscribeSession: () => () => undefined,
  };
  const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
  const explorer = {
    open: vi.fn(),
    list: vi.fn(),
    close: vi.fn(),
    closeOwner: vi.fn(async () => undefined),
    cancelOpen: vi.fn(),
    retainConnection: vi.fn(),
    subscribeClosed: vi.fn(() => () => undefined),
  };
  registerRemoteGenomicsIpcHandlers({
    database: () => ({}) as Database.Database,
    supervisor: runtime,
    explorer,
  });
  cleanup.push(async () => {
    await runtime.stopAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, provider, explorer, materialization };
}

describe('remote hosts contract registration', () => {
  it('no longer registers remoteHosts channels; the remote hosts feature owns them', async () => {
    await fixture();
    expect([...ipc.handlers.keys()].filter((name) => name.startsWith('remoteHosts:'))).toEqual([]);
  });
});

describe('remote genomics renderer ownership', () => {
  it('leaves explicit browser and attachment authentication to the institutional login procedure', async () => {
    const { explorer } = await fixture();
    const owner = new Owner(601);
    explorer.open.mockResolvedValue({
      sessionId: 'institutional-browser',
      target: request.target,
      platform: 'linux',
      homePath: '/home/researcher',
      connectedAt: 1,
    });
    await invoke('openExplorer', owner, {
      requestId: 'institutional-browser-601',
      target: request.target,
    });
    await invoke('connectAlignment', owner, {
      ...request,
      requestId: 'institutional-reads-601',
      allowInteractive: true,
    });
    expect(remoteSshPromptBroker.prepare).not.toHaveBeenCalled();
    expect(ipc.send.mock.calls.some(([, channel]) => channel === 'remoteGenomics:authPrompt')).toBe(
      false
    );
  });

  it('keeps a standalone signal live for its second renderer after its first renderer reloads', async () => {
    const { runtime, provider } = await fixture();
    const first = new Owner(501);
    const second = new Owner(502);
    const signalRequest = { target: request.target, signalPath: '/run/only.bigWig' };
    const firstLease = await invoke('connectSignal', first, signalRequest);
    const secondLease = await invoke('connectSignal', second, signalRequest);
    expect(firstLease).not.toHaveProperty('bamUrl');
    expect(provider.connect).not.toHaveBeenCalled();
    expect(provider.connectSignal).toHaveBeenCalledOnce();
    first.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(await (await fetch(secondLease.bigWigUrl)).text()).toBe('independent-owner-data');
    await invoke('disconnectSession', second, secondLease.sessionId);
    expect(runtime.listStatuses()).toEqual([]);
    expect(provider.disconnect).toHaveBeenCalledOnce();
  });

  it('cancels signal restoration on renderer loss even without a caller-supplied request ID', async () => {
    const { runtime, provider } = await fixture();
    provider.connectSignal.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const owner = new Owner(503);
    const pending = invoke('connectSignal', owner, {
      target: request.target,
      signalPath: '/run/only.bigWig',
    });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(provider.connectSignal).toHaveBeenCalledOnce());
    owner.emit('render-process-gone');
    await rejected;
    expect(runtime.listStatuses()).toEqual([]);
    expect(ipc.recordFailure).not.toHaveBeenCalled();
  });

  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'] as const)(
    'releases the lost owner on %s while a second renderer keeps fresh data access',
    async (event) => {
      const { runtime, provider } = await fixture();
      const first = new Owner(101);
      const second = new Owner(102);
      const firstLease = await invoke('connectAlignment', first, {
        ...request,
        requestId: 'first-owner',
      });
      const secondLease = await invoke('connectAlignment', second, {
        ...request,
        requestId: 'second-owner',
      });
      expect(firstLease.sessionId).not.toBe(secondLease.sessionId);
      if (event === 'destroyed') first.destroyed = true;
      first.emit(event, { isMainFrame: true, isSameDocument: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(provider.disconnect).not.toHaveBeenCalled();
      expect(await (await fetch(secondLease.bamUrl)).text()).toBe('independent-owner-data');
      await invoke('disconnectSession', second, secondLease.sessionId);
      expect(runtime.listStatuses()).toEqual([]);
      expect(provider.disconnect).toHaveBeenCalledOnce();
    }
  );

  it('keeps leases across same-document and subframe navigation, and rejects another owner releasing them', async () => {
    const { runtime, provider } = await fixture();
    const owner = new Owner(201);
    const lease = await invoke('connectAlignment', owner, request);
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    await invoke('disconnectSession', new Owner(202), lease.sessionId);
    expect(runtime.listStatuses()).toHaveLength(1);
    expect(provider.disconnect).not.toHaveBeenCalled();
    await invoke('disconnectSession', owner, lease.sessionId);
    expect(runtime.listStatuses()).toEqual([]);
  });

  it('cancels a restore without an explicit request ID when its renderer dies', async () => {
    const { runtime, provider } = await fixture();
    provider.connect.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const owner = new Owner(301);
    const pending = invoke('connectAlignment', owner, request);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledOnce());
    owner.emit('render-process-gone');
    await rejected;
    expect(runtime.listStatuses()).toEqual([]);
    expect(ipc.recordFailure).not.toHaveBeenCalled();
  });

  it('rolls back a materialization arriving after reload, then admits the new renderer generation', async () => {
    const { runtime } = await fixture();
    const owner = new Owner(401);
    const connect = runtime.connect.bind(runtime);
    let deliver: (() => void) | undefined;
    vi.spyOn(runtime, 'connect').mockImplementationOnce(async (input) => {
      const lease = await connect(input);
      await new Promise<void>((resolve) => {
        deliver = resolve;
      });
      return lease;
    });
    const pending = invoke('connectAlignment', owner, { ...request, requestId: 'old-generation' });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    deliver!();
    await rejected;
    expect(runtime.listStatuses()).toEqual([]);
    const lease = await invoke('connectAlignment', owner, {
      ...request,
      requestId: 'new-generation',
    });
    await invoke('disconnectSession', owner, lease.sessionId);
    expect(runtime.listStatuses()).toEqual([]);
  });
});
