// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Listener>();
  const mainListeners = new Map<string, Set<Listener>>();
  const rendererListeners = new Map<string, Set<Listener>>();
  const add = (table: Map<string, Set<Listener>>, channel: string, listener: Listener) => {
    const set = table.get(channel) ?? new Set<Listener>();
    set.add(listener);
    table.set(channel, set);
  };
  return {
    handlers,
    mainListeners,
    rendererListeners,
    exposed: new Map<string, unknown>(),
    ipcMain: {
      handle: vi.fn((channel: string, listener: Listener) => {
        if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
        handlers.set(channel, listener);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      on: vi.fn((channel: string, listener: Listener) => add(mainListeners, channel, listener)),
      once: vi.fn((channel: string, listener: Listener) => add(mainListeners, channel, listener)),
      removeListener: vi.fn((channel: string, listener: Listener) =>
        mainListeners.get(channel)?.delete(listener)
      ),
    },
    ipcRenderer: {
      invoke: vi.fn(async (..._args: unknown[]) => 'invoked'),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: Listener) => add(rendererListeners, channel, listener)),
      removeListener: vi.fn((channel: string, listener: Listener) =>
        rendererListeners.get(channel)?.delete(listener)
      ),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
  ipcRenderer: electron.ipcRenderer,
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, api: unknown) => electron.exposed.set(name, api)),
  },
  webUtils: { getPathForFile: vi.fn(() => '') },
}));

import { awaitReply, createClient, handleGroup, sendRendererIpc } from './ipc-contract';
import { entityNavigationContract } from './ipc/entity-navigation.contract';
import { contractEntries, defineGroup, event, invoke, reply, send } from './ipc/contract';
import { remoteHostsContract } from './ipc/remote-hosts.contract';
import {
  toUserMessage,
  userMessage,
  userMessagePayload,
  userMessageValue,
  withUserMessage,
} from '@waypoint/user-messages';

const demo = defineGroup('demo', {
  query: invoke<[input: { readonly kind?: string }], string>().withDefault(0, {}),
  pair: invoke<[left: string, right: string], string>(),
  probe: invoke<[], string>().conditionallyExposed(),
  report: send<[dirty: boolean]>().channel('demo:reported'),
  respond: reply<[ok: boolean]>(),
  onStatus: event<[status: string]>(),
  onCancel: event<[payload: { readonly requestId: string }]>().projected(
    (payload) => payload.requestId
  ),
});

afterEach(() => {
  electron.handlers.clear();
  electron.mainListeners.clear();
  electron.rendererListeners.clear();
  vi.clearAllMocks();
});

describe('createClient', () => {
  it('delivers owned entity targets through the navigation event and removes the subscription', () => {
    const client = createClient(entityNavigationContract);
    const received = vi.fn();
    const dispose = client.onOpen(received);
    const targets = [{ entityId: 'stable-sequence', projectId: 'owner', referenceId: 'selection' }];
    const receiver = {
      send(channel: string, ...args: unknown[]) {
        electron.rendererListeners.get(channel)?.forEach((listener) => listener({}, ...args));
      },
    };
    sendRendererIpc(receiver, 'entity-navigation:open', targets);
    expect(received.mock.calls).toEqual([[targets]]);
    dispose();
    sendRendererIpc(receiver, 'entity-navigation:open', targets);
    expect(received).toHaveBeenCalledTimes(1);
    expect(electron.rendererListeners.get('entity-navigation:open')?.size).toBe(0);
  });

  it('forwards invoke arguments and fills only a missing defaulted argument', async () => {
    const client = createClient(demo, { include: { probe: false } });
    await client.pair('a', 'b');
    await client.query();
    await client.query({ kind: 'plasmid' });
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['demo:pair', 'a', 'b'],
      ['demo:query', {}],
      ['demo:query', { kind: 'plasmid' }],
    ]);
  });

  it('sends, replies on the request channel, and subscribes with projection', () => {
    const client = createClient(demo, { include: { probe: false } });
    client.report(true);
    client.respond('req-1', false);
    expect(electron.ipcRenderer.send.mock.calls).toEqual([
      ['demo:reported', true],
      ['demo:respond:req-1', false],
    ]);

    const statuses: string[] = [];
    const cancelled: string[] = [];
    const stopStatus = client.onStatus((status) => statuses.push(status));
    const stopCancel = client.onCancel((requestId) => cancelled.push(requestId));
    for (const listener of electron.rendererListeners.get('demo:onStatus') ?? [])
      listener({}, 'ready');
    for (const listener of electron.rendererListeners.get('demo:onCancel') ?? [])
      listener({}, { requestId: 'req-2' });
    expect(statuses).toEqual(['ready']);
    expect(cancelled).toEqual(['req-2']);
    stopStatus();
    stopCancel();
    expect(electron.rendererListeners.get('demo:onStatus')?.size).toBe(0);
    expect(electron.rendererListeners.get('demo:onCancel')?.size).toBe(0);
  });

  it('omits a conditional method unless included', async () => {
    expect(createClient(demo, { include: { probe: false } }).probe).toBeUndefined();
    const included = createClient(demo, { include: { probe: true } });
    await included.probe?.();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('demo:probe');
  });
});

describe('handleGroup', () => {
  it('retains a static public refusal after the preload Error loses its custom properties', async () => {
    const privateMessage = 'Cannot undo import batch; entity modified since import: private-id';
    handleGroup(demo, {
      query: () => {
        throw withUserMessage(new Error(privateMessage), 'registry.undoChanged');
      },
      pair: (_event, left, right) => `${left}${right}`,
      probe: null,
      report: vi.fn(),
    });
    electron.ipcRenderer.invoke.mockImplementation(async (channel, ...args) => {
      const value = await electron.handlers.get(String(channel))!({}, ...args);
      const wire = JSON.stringify(value);
      expect(wire).not.toContain(privateMessage);
      return JSON.parse(wire);
    });
    const client = createClient(demo, { include: { probe: false } });
    const copied = await client.query().catch((error: Error) => new Error(error.message));
    expect(copied).toBeInstanceOf(Error);
    expect(copied).not.toHaveProperty('userMessagePayload');
    expect(copied).not.toHaveProperty('userMessageKey');
    expect(toUserMessage(copied, 'registry.importFailed')).toBe(
      userMessage('registry.undoChanged')
    );
    expect(toUserMessage(new Error(privateMessage), 'registry.importFailed')).toBe(
      userMessage('registry.importFailed')
    );
    expect(
      toUserMessage(new Error(`${userMessage('registry.undoChanged')} ${privateMessage}`))
    ).toBe(userMessage('operation.failed'));
    const getter = vi.fn(() => {
      throw new Error('The public boundary must not invoke a message getter.');
    });
    expect(toUserMessage(Object.defineProperty(new Error(), 'message', { get: getter }))).toBe(
      userMessage('operation.failed')
    );
    expect(getter).not.toHaveBeenCalled();
    electron.ipcRenderer.invoke.mockResolvedValue('invoked');
  });

  it('retains catalog failure guidance across Electron error serialization', async () => {
    const privateMessage =
      'platform.trackViews.list is not available in the hosted browser runtime.';
    handleGroup(demo, {
      query: () => {
        throw withUserMessage(new Error(privateMessage), 'tracks.unavailable');
      },
      pair: async () => {
        throw withUserMessage(
          new Error('private recovery diagnostic'),
          userMessagePayload('approval.commandScope', { programs: userMessageValue('blastn') })
        );
      },
      probe: null,
      report: vi.fn(),
    });
    electron.ipcRenderer.invoke.mockImplementation(async (channel, ...args) => {
      try {
        const value = await electron.handlers.get(String(channel))!({}, ...args);
        const wire = JSON.stringify(value);
        expect(wire).not.toContain(privateMessage);
        expect(wire).not.toContain('private recovery diagnostic');
        return JSON.parse(wire);
      } catch (failure) {
        throw new Error(failure instanceof Error ? failure.message : 'native failure');
      }
    });
    const client = createClient(demo, { include: { probe: false } });
    await expect(client.query().catch(toUserMessage)).resolves.toBe(
      userMessage('tracks.unavailable')
    );
    await expect(client.pair('a', 'b').catch(toUserMessage)).resolves.toBe('blastn commands');
    electron.ipcRenderer.invoke.mockResolvedValue('invoked');
  });

  it('registers invoke and send handlers, skips null, and disposes exactly once', () => {
    const report = vi.fn();
    const dispose = handleGroup(demo, {
      query: (_event, input) => input.kind ?? 'all',
      pair: (_event, left, right) => `${left}${right}`,
      probe: null,
      report,
    });
    expect([...electron.handlers.keys()].sort()).toEqual(['demo:pair', 'demo:query']);
    expect(electron.mainListeners.get('demo:reported')?.has(report)).toBe(true);

    dispose();
    dispose();
    expect(electron.handlers.size).toBe(0);
    expect(electron.mainListeners.get('demo:reported')?.size).toBe(0);
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(2);
    expect(electron.ipcMain.removeListener).toHaveBeenCalledTimes(1);
  });
});

describe('awaitReply', () => {
  const owner = { id: 7 };
  const intruder = { id: 99 };
  const deliver = (sender: { id: number }, ok: boolean) => {
    for (const registered of [...(electron.mainListeners.get('demo:respond:req-9') ?? [])])
      registered({ sender }, ok);
  };

  it('settles once on the expected sender and stops listening', () => {
    const onReply = vi.fn();
    const onTimeout = vi.fn();
    awaitReply(demo, 'respond', {
      requestId: 'req-9',
      sender: owner,
      timeoutMs: 1_000,
      onReply,
      onTimeout,
    });
    expect(electron.ipcMain.on).toHaveBeenCalledWith('demo:respond:req-9', expect.any(Function));
    deliver(owner, true);
    deliver(owner, false);
    expect(onReply.mock.calls).toEqual([[true]]);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(electron.mainListeners.get('demo:respond:req-9')?.size).toBe(0);
  });

  it('ignores a spoofed reply from another renderer and keeps listening', () => {
    const onReply = vi.fn();
    awaitReply(demo, 'respond', {
      requestId: 'req-9',
      sender: owner,
      timeoutMs: 1_000,
      onReply,
      onTimeout: vi.fn(),
    });
    deliver(intruder, false);
    expect(onReply).not.toHaveBeenCalled();
    expect(electron.mainListeners.get('demo:respond:req-9')?.size).toBe(1);
    deliver(owner, true);
    expect(onReply.mock.calls).toEqual([[true]]);
  });

  it('times out when the expected sender never answers, then ignores late replies', () => {
    vi.useFakeTimers();
    try {
      const onReply = vi.fn();
      const onTimeout = vi.fn();
      awaitReply(demo, 'respond', {
        requestId: 'req-9',
        sender: owner,
        timeoutMs: 500,
        onReply,
        onTimeout,
      });
      deliver(intruder, true);
      vi.advanceTimersByTime(500);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(electron.mainListeners.get('demo:respond:req-9')?.size).toBe(0);
      deliver(owner, true);
      expect(onReply).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a disposer removes the listener and cancels the timeout, and is safe to call twice', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const dispose = awaitReply(demo, 'respond', {
        requestId: 'req-9',
        sender: owner,
        timeoutMs: 500,
        onReply: vi.fn(),
        onTimeout,
      });
      dispose();
      dispose();
      vi.advanceTimersByTime(1_000);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(electron.mainListeners.get('demo:respond:req-9')?.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('preload exposure of contract groups', () => {
  it('exposes exactly the remoteHosts contract methods on their channels', async () => {
    vi.doMock('../preload/indexed-genome-ipc', () => ({
      createIndexedGenomeIpc: vi.fn(() => ({})),
    }));
    await import('../preload/index');
    const exposed = electron.exposed.get('electronAPI') as {
      remoteHosts: Record<string, (...args: unknown[]) => Promise<unknown>>;
    };
    expect(Object.keys(exposed.remoteHosts).sort()).toEqual(
      contractEntries(remoteHostsContract)
        .map(({ method }) => method)
        .sort()
    );
    await exposed.remoteHosts.list?.();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('remoteHosts:list');
  }, 30_000);
});
