import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  return {
    listeners,
    releasedTurnListeners: new Set<(turnId: string) => void>(),
    ipcMain: {
      on: vi.fn((name: string, callback: (event: unknown, payload: unknown) => void) => {
        const callbacks = listeners.get(name) ?? new Set();
        callbacks.add(callback);
        listeners.set(name, callbacks);
      }),
      removeListener: vi.fn(
        (name: string, callback: (event: unknown, payload: unknown) => void) => {
          listeners.get(name)?.delete(callback);
        }
      ),
    },
  };
});
vi.mock('../ipc/database', () => ({ getDb: vi.fn() }));

vi.mock('../registered-project-authority', () => ({
  createRegisteredProjectAuthority: () => ({ folders: () => [] }),
}));

vi.mock('electron', () => ({ ipcMain: state.ipcMain, BrowserWindow: vi.fn() }));
vi.mock('../agent-grants', () => ({
  mintInAppChatGrant: () => ({
    sessionToken: 'test-session',
    agentIdentityId: 'test-agent',
    capabilities: ['*'],
  }),
}));
vi.mock('../agent-caller', () => ({
  resolveCurrentAgentCaller: async () => ({
    agentIdentityId: 'test-agent',
    effectiveCapabilities: ['*'],
  }),
}));
vi.mock('../protein-experiment-workers', () => ({
  proteinExperimentRendererForTurn: () => undefined,
  onProteinExperimentTurnReleased: (listener: (turnId: string) => void) => {
    state.releasedTurnListeners.add(listener);
    return () => state.releasedTurnListeners.delete(listener);
  },
}));

import { startAgentToolsBridge, cancelRendererToolCallsForTurn } from '../agent-tools-bridge';

function contents(id: number) {
  return Object.assign(new EventEmitter(), { id, send: vi.fn(), isDestroyed: () => false });
}

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
  state.listeners.clear();
  state.releasedTurnListeners.clear();
  vi.clearAllMocks();
});

async function setup() {
  const root = contents(1);
  const worker = contents(2);
  let assigned: typeof worker | null = worker;
  const server = await startAgentToolsBridge(
    { webContents: root, isDestroyed: () => false } as never,
    {
      timeoutMs: 5000,
      resolveRendererTarget: (turnId) =>
        turnId === 'private-turn' ? (assigned as never) : undefined,
    }
  );
  close.push(() => server.close());
  const call = (actionId: string, turnId = 'private-turn', toolName = 'mol_get_scene') =>
    server.callTool({
      turnId,
      actionId,
      toolName,
      args: { structureViewId: 'trial-view' },
    });
  const reply = (sender: typeof root, target: typeof worker, ok = true) => {
    const request = target.send.mock.calls.find(([name]) => name === 'agent-tools:call')?.[1] as {
      requestId: string;
    };
    for (const listener of [
      ...(state.listeners.get(`agent-tools:response:${request.requestId}`) ?? []),
    ])
      listener(
        { sender },
        ok ? { ok: true, result: { rendered: true }, audit_id: 'audit-1' } : { ok: false }
      );
  };
  const released = () => {
    for (const listener of state.releasedTurnListeners) listener('private-turn');
  };
  return {
    root,
    worker,
    call,
    reply,
    released,
    release: () => {
      assigned = null;
      released();
    },
  };
}

describe('protein tools use the captured isolated renderer', () => {
  it('routes an isolated molecular call to its worker and ignores root replies', async () => {
    const { root, worker, call, reply } = await setup();
    const pending = call('action-1');
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalledOnce());
    expect(root.send).not.toHaveBeenCalled();
    reply(root, worker);
    expect(state.listeners.values().next().value?.size).toBe(1);
    reply(worker, worker);
    await expect(pending).resolves.toMatchObject({ ok: true, result: { rendered: true } });
  });

  it('keeps cancellation and final response on the original worker after route release', async () => {
    const { root, worker, call, reply, release } = await setup();
    const pending = call('action-1');
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalledOnce());
    release();
    expect(cancelRendererToolCallsForTurn('private-turn')).toBe(1);
    expect(worker.send.mock.calls.at(-1)?.[0]).toBe('agent-tools:cancel');
    expect(root.send).not.toHaveBeenCalled();
    reply(worker, worker);
    await expect(pending).resolves.toMatchObject({ ok: true });
    await expect(call('action-2')).resolves.toMatchObject({
      ok: false,
      error: { code: 'OUTCOME_UNRESOLVED' },
    });
    expect(root.send).not.toHaveBeenCalled();
  });

  it('settles only the worker operation on process loss; ordinary tools still use root', async () => {
    const { root, worker, call, reply } = await setup();
    const pending = call('action-1');
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalledOnce());
    worker.emit('render-process-gone');
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'OUTCOME_UNRESOLVED' },
    });
    expect(worker.listenerCount('destroyed')).toBe(0);
    const ordinary = call('action-ordinary', 'ordinary-turn', 'get_workspace');
    await vi.waitFor(() => expect(root.send).toHaveBeenCalledOnce());
    reply(root, root);
    await expect(ordinary).resolves.toMatchObject({ ok: true });
  });

  it('rejects non-molecular tools from isolated turns before dispatching to the root', async () => {
    const { root, worker, call } = await setup();
    await expect(call('action-outside', 'private-turn', 'edit_sequence')).resolves.toMatchObject({
      ok: false,
      error: { code: 'OUTSIDE_EXPERIMENT_CONTEXT' },
    });
    expect(root.send).not.toHaveBeenCalled();
    expect(worker.send).not.toHaveBeenCalled();
  });

  it('releases more than 256 completed experiment actions without blocking a fresh action', async () => {
    const { worker, call, reply, released } = await setup();
    for (let index = 0; index < 270; index += 1) {
      worker.send.mockClear();
      const pending = call(`action-${index}`);
      await vi.waitFor(() => expect(worker.send).toHaveBeenCalledOnce(), { interval: 1 });
      reply(worker, worker);
      await expect(pending).resolves.toMatchObject({ ok: true });
      released();
    }
    worker.send.mockClear();
    const fresh = call('fresh-action');
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalledOnce(), { interval: 1 });
    reply(worker, worker);
    await expect(fresh).resolves.toMatchObject({ ok: true });
  });

  it('retains an unresolved experiment operation through job-release pruning', async () => {
    const { worker, call, released } = await setup();
    const pending = call('pending-write');
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalledOnce());
    worker.emit('render-process-gone');
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'OUTCOME_UNRESOLVED' },
    });
    released();
    await expect(call('pending-write')).resolves.toMatchObject({
      ok: false,
      error: { code: 'OUTCOME_UNRESOLVED' },
    });
    expect(worker.send).toHaveBeenCalledOnce();
  });

  it('retains more than 256 completed experimental actions while their turn is still active', async () => {
    const { worker, call, reply } = await setup();
    for (let index = 0; index < 300; index += 1) {
      worker.send.mockClear();
      const pending = call(`active-action-${index}`);
      await vi.waitFor(() => expect(worker.send).toHaveBeenCalledOnce(), { interval: 1 });
      reply(worker, worker);
      await expect(pending).resolves.toMatchObject({ ok: true });
    }
    worker.send.mockClear();
    await expect(call('active-action-1')).resolves.toMatchObject({ ok: true });
    expect(worker.send).not.toHaveBeenCalled();
  });
});
