import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
} from 'electron';
import type {
  ProteinExperimentPrepareRequest,
  ProteinExperimentWorkerRequest,
} from '../shared/protein-experiment-workers';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class extends EventEmitter {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
  };
});

import {
  onProteinExperimentTurnReleased,
  ProteinExperimentWorkerPool,
} from './protein-experiment-workers';

function fakeWindow(id: number, url: string) {
  let destroyed = false;
  const webContents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { url },
    getURL: () => url,
    isDestroyed: () => destroyed,
    send: vi.fn(),
  });
  const window = Object.assign(new BrowserWindow(), {
    webContents,
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async (next: string) => {
      webContents.mainFrame.url = next;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      webContents.emit('destroyed');
      window.emit('closed');
    }),
  });
  return window;
}

function fixture(jobId: string): ProteinExperimentPrepareRequest {
  return {
    jobId,
    admission: {
      runId: 'test-round',
      mode: 'full-round',
      frozen: 'test',
      slots: [jobId],
      slot: jobId,
    },
    label: `KcsA ${jobId}`,
    fixtures: [{ structureViewId: `trial-view:${jobId}`, attrs: { id: `trial-view:${jobId}` } }],
    workspace: { folders: [{ path: '/lab', name: 'Lab', addedAt: 1 }], activeWorkspaceFile: null },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
});

function setup(jobsPerWorker = 4, maxWorkers = 4) {
  const root = fakeWindow(1, 'http://localhost:1522/');
  const workers: ReturnType<typeof fakeWindow>[] = [];
  const enrollment: number[] = [];
  const revocation: number[] = [];
  const options: BrowserWindowConstructorOptions[] = [];
  const pool = new ProteinExperimentWorkerPool({
    rootWindow: root,
    rendererUrl: 'http://localhost:1522/',
    preloadPath: '/app/preload/index.js',
    preloadArguments: ['--dnaforge-runtime=development'],
    admission: { check: () => undefined, claim: () => undefined },
    jobsPerWorker,
    maxWorkers,
    onWorkerCreated: (contents) => enrollment.push(contents.id),
    onWorkerDestroyed: (contents) => revocation.push(contents.id),
    createWindow: (input) => {
      options.push(input);
      const worker = fakeWindow(workers.length + 10, 'http://localhost:1522/');
      workers.push(worker);
      return worker;
    },
  });
  cleanups.push(() => pool.close());
  const senderEvent = (window: ReturnType<typeof fakeWindow>) =>
    ({
      type: 'frame',
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
      frameId: 0,
      processId: 0,
      preventDefault: vi.fn(),
      defaultPrevented: false,
    }) satisfies IpcMainInvokeEvent;
  const finish = (
    worker: ReturnType<typeof fakeWindow>,
    kind: 'prepare' | 'release' | 'assert-fresh-start'
  ) => {
    const request = worker.webContents.send.mock.calls.findLast(
      ([channel, payload]) =>
        channel === 'protein-experiment-workers:request' && payload.kind === kind
    )?.[1] as ProteinExperimentWorkerRequest;
    expect(request).toBeDefined();
    pool.respond(senderEvent(worker), { requestId: request.requestId, ok: true });
  };
  const prepare = async (jobId: string, purpose?: ProteinExperimentPrepareRequest['purpose']) => {
    const pending = pool.prepare(senderEvent(root), { ...fixture(jobId), purpose });
    const worker = workers.at(-1)!;
    pool.ready(senderEvent(worker));
    await vi.waitFor(() => expect(worker.webContents.send).toHaveBeenCalled());
    finish(worker, 'prepare');
    return pending;
  };
  const bind = async (jobId: string, turnId: string) => {
    const worker = workers.find((w) =>
      w.webContents.send.mock.calls.some(
        ([, r]) => r.kind === 'prepare' && r.request.jobId === jobId
      )
    )!;
    const pending = pool.bind(senderEvent(root), { jobId, turnId });
    await vi.waitFor(() =>
      expect(worker.webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: 'assert-fresh-start',
        jobId,
      })
    );
    finish(worker, 'assert-fresh-start');
    await pending;
  };
  return {
    root,
    workers,
    pool,
    senderEvent,
    finish,
    prepare,
    bind,
    enrollment,
    revocation,
    options,
  };
}

describe('isolated protein experiment worker ownership', () => {
  it('refuses replay authors and altered fresh scenes before routing, and never reuses an author job', async () => {
    const { root, pool, workers, senderEvent, prepare, bind } = setup();
    await prepare('replay', 'saved-view-replay');
    await expect(
      pool.bind(senderEvent(root), { jobId: 'replay', turnId: 'replay-model' })
    ).rejects.toThrow(/replay cannot dispatch/);
    expect(pool.rendererForTurn('replay-model')).toBeUndefined();
    await prepare('dirty');
    const pending = pool.bind(senderEvent(root), { jobId: 'dirty', turnId: 'dirty-model' });
    const failure = expect(pending).rejects.toThrow('Prior styled scene');
    const request = workers[0].webContents.send.mock.calls.at(
      -1
    )![1] as ProteinExperimentWorkerRequest;
    expect(request.kind).toBe('assert-fresh-start');
    pool.respond(senderEvent(workers[0]), {
      requestId: request.requestId,
      ok: false,
      error: 'Prior styled scene',
    });
    await failure;
    expect(pool.rendererForTurn('dirty-model')).toBeUndefined();
    await bind('dirty', 'first-fresh-model');
    await expect(
      pool.bind(senderEvent(root), { jobId: 'dirty', turnId: 'second-model' })
    ).rejects.toThrow(/new clean experiment/);
  });
  it('revokes old turns on a full root reload and accepts fresh jobs after the trusted load', async () => {
    const { root, pool, workers, senderEvent, bind, prepare } = setup();
    await prepare('before-reload');
    await bind('before-reload', 'old-private-turn');
    root.webContents.emit('did-start-navigation', {}, 'http://localhost:1522/', false, true);
    expect(workers[0].isDestroyed()).toBe(true);
    expect(pool.rendererForTurn('old-private-turn')).toBeNull();
    await expect(pool.prepare(senderEvent(root), fixture('while-loading'))).rejects.toThrow(
      /root/i
    );
    root.webContents.emit('did-finish-load');
    await expect(prepare('after-reload')).resolves.toMatchObject({ jobId: 'after-reload' });
    expect(pool.rendererForTurn('old-private-turn')).toBeNull();
    root.webContents.emit('did-start-navigation', {}, 'https://example.org/', false, true);
    root.webContents.mainFrame.url = 'https://example.org/';
    root.webContents.emit('did-finish-load');
    await expect(pool.prepare(senderEvent(root), fixture('foreign-root'))).rejects.toThrow(/root/i);
  });
  it('transports three or four distinct pinned views and rejects a fifth', async () => {
    const { root, pool, workers, senderEvent, finish } = setup();
    const request = {
      ...fixture('multi-source'),
      fixtures: Array.from({ length: 4 }, (_, i) => ({
        structureViewId: `trial-view:source-${i}`,
        attrs: { id: i },
      })),
    };
    const pending = pool.prepare(senderEvent(root), request);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    pool.ready(senderEvent(worker));
    await vi.waitFor(() => expect(worker.webContents.send).toHaveBeenCalled());
    finish(worker, 'prepare');
    await expect(pending).resolves.toMatchObject({ jobId: 'multi-source' });
    await expect(
      pool.prepare(senderEvent(root), {
        ...request,
        jobId: 'too-many',
        fixtures: [...request.fixtures, { structureViewId: 'trial-view:fifth', attrs: {} }],
      })
    ).rejects.toThrow();
  });
  it('waits for the exact worker ready handshake before sending preparation', async () => {
    const { root, pool, workers, senderEvent, finish, options } = setup();
    const pending = pool.prepare(senderEvent(root), fixture('job-1'));
    const worker = workers[0];
    expect(worker.webContents.send).not.toHaveBeenCalled();
    expect(() => pool.ready(senderEvent(root))).toThrow(/worker/i);
    pool.ready(senderEvent(worker));
    await vi.waitFor(() => expect(worker.webContents.send).toHaveBeenCalledOnce());
    finish(worker, 'prepare');
    await expect(pending).resolves.toMatchObject({ jobId: 'job-1' });
    expect(options[0]).toMatchObject({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    expect(worker.loadURL.mock.calls[0][0]).toContain('proteinExperimentWorker=');
  });

  it('rejects root operations from workers and replies from the wrong sender', async () => {
    const { root, pool, workers, senderEvent, finish } = setup();
    const pending = pool.prepare(senderEvent(root), fixture('job-1'));
    const worker = workers[0];
    pool.ready(senderEvent(worker));
    await vi.waitFor(() => expect(worker.webContents.send).toHaveBeenCalled());
    const request = worker.webContents.send.mock.calls[0][1] as ProteinExperimentWorkerRequest;
    expect(() =>
      pool.respond(senderEvent(root), { requestId: request.requestId, ok: true })
    ).toThrow(/sender/i);
    await expect(pool.prepare(senderEvent(worker), fixture('job-2'))).rejects.toThrow(/root/i);
    await expect(
      pool.bind(senderEvent(worker), { jobId: 'job-1', turnId: 'private-1' })
    ).rejects.toThrow(/root/i);
    finish(worker, 'prepare');
    await pending;
  });

  it('binds the private turn to its worker and leaves ordinary turns unbound', async () => {
    const { root, pool, workers, senderEvent, bind, prepare } = setup();
    await prepare('job-1');
    await bind('job-1', 'private-1');
    expect(pool.rendererForTurn('private-1')).toBe(workers[0].webContents);
    expect(pool.rendererForTurn('ordinary-1')).toBeUndefined();
    await expect(
      pool.bind(senderEvent(root), { jobId: 'missing', turnId: 'private-2' })
    ).rejects.toThrow(/ready/i);
  });

  it('preserves a closed route so it cannot fall back to the visible root viewer', async () => {
    const { root, pool, workers, senderEvent, bind, prepare, revocation } = setup();
    await prepare('job-1');
    await bind('job-1', 'private-1');
    workers[0].destroy();
    expect(pool.rendererForTurn('private-1')).toBeNull();
    expect(revocation).toEqual([workers[0].webContents.id]);
    expect(root.webContents.send).not.toHaveBeenCalled();
  });

  it('uses a bounded pool and immediately reuses a released job slot', async () => {
    const { root, pool, workers, senderEvent, bind, prepare, finish } = setup(1, 2);
    await prepare('job-1');
    await bind('job-1', 'private-1');
    await prepare('job-2');
    await expect(pool.prepare(senderEvent(root), fixture('job-3'))).rejects.toThrow(/capacity/i);
    const releasing = pool.release(senderEvent(root), { jobId: 'job-1' });
    finish(workers[0], 'release');
    await releasing;
    expect(pool.rendererForTurn('private-1')).toBeNull();
    const pending = pool.prepare(senderEvent(root), fixture('job-3'));
    await vi.waitFor(() =>
      expect(workers[0].webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: 'prepare',
        request: { jobId: 'job-3' },
      })
    );
    finish(workers[0], 'prepare');
    await pending;
    expect(workers).toHaveLength(2);
  });

  it('fails in-flight preparation on worker loss and tears workers down with root ownership', async () => {
    const { root, pool, workers, senderEvent, revocation } = setup();
    const pending = pool.prepare(senderEvent(root), fixture('job-1'));
    const failure = expect(pending).rejects.toThrow(/unavailable/i);
    workers[0].destroy();
    await failure;
    const second = pool.prepare(senderEvent(root), fixture('job-2'));
    const secondFailure = expect(second).rejects.toThrow(/unavailable/i);
    root.destroy();
    await secondFailure;
    expect(workers.every((worker) => worker.isDestroyed())).toBe(true);
    expect(revocation).toHaveLength(2);
  });

  it('places a different workspace in another worker while a job is active', async () => {
    const { root, pool, workers, senderEvent, bind, prepare, finish } = setup();
    await prepare('job-1');
    const request = fixture('job-2');
    const pending = pool.prepare(senderEvent(root), {
      ...request,
      workspace: {
        folders: [{ path: '/other', name: 'Other', addedAt: 2 }],
        activeWorkspaceFile: null,
      },
    });
    expect(workers).toHaveLength(2);
    pool.ready(senderEvent(workers[1]));
    await vi.waitFor(() => expect(workers[1].webContents.send).toHaveBeenCalled());
    finish(workers[1], 'prepare');
    await pending;
  });

  it('a confirmed failed preparation frees only that job, preserving other private routes', async () => {
    const { root, pool, workers, senderEvent, bind, prepare } = setup();
    await prepare('job-1');
    await bind('job-1', 'private-1');
    const pending = pool.prepare(senderEvent(root), fixture('job-2'));
    const failure = expect(pending).rejects.toThrow('Invalid fixture');
    await vi.waitFor(() =>
      expect(workers[0].webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
        kind: 'prepare',
        request: { jobId: 'job-2' },
      })
    );
    const request = workers[0].webContents.send.mock.calls.at(
      -1
    )![1] as ProteinExperimentWorkerRequest;
    pool.respond(senderEvent(workers[0]), {
      requestId: request.requestId,
      ok: false,
      error: 'Invalid fixture',
    });
    await failure;
    expect(pool.rendererForTurn('private-1')).toBe(workers[0].webContents);
    expect(workers[0].isDestroyed()).toBe(false);
  });

  it('announces terminal release only after the captured worker confirms cleanup', async () => {
    const { root, pool, workers, senderEvent, bind, prepare, finish } = setup();
    const released = vi.fn();
    cleanups.push(onProteinExperimentTurnReleased(released));
    await prepare('job-1');
    await bind('job-1', 'private-1');
    const pending = pool.release(senderEvent(root), { jobId: 'job-1' });
    expect(released).not.toHaveBeenCalled();
    finish(workers[0], 'release');
    await pending;
    expect(released).toHaveBeenCalledExactlyOnceWith('private-1');
    await prepare('job-2');
    await bind('job-2', 'private-2');
    workers[0].destroy();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('rejects a root child frame even when its URL shares the trusted origin', async () => {
    const { root, pool, senderEvent } = setup();
    const event = senderEvent(root);
    await expect(
      pool.prepare(
        { ...event, senderFrame: { url: root.webContents.mainFrame.url } } as never,
        fixture('job-1')
      )
    ).rejects.toThrow(/root/i);
  });
});
