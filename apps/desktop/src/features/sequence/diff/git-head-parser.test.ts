import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGitHeadInWorker } from './git-head-parser';

type Listener = (event: { data?: unknown; message?: string }) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static postError: Error | null = null;
  posted: unknown[] = [];
  terminations = 0;
  private listeners = new Map<string, Set<Listener>>();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown) {
    if (FakeWorker.postError) throw FakeWorker.postError;
    this.posted.push(message);
  }
  addEventListener(type: string, listener: Listener) {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  terminate() {
    this.terminations++;
  }
  emit(type: string, event: { data?: unknown; message?: string }) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

describe('Git HEAD parser worker lifecycle', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.postError = null;
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the exact HEAD bytes and returns sequence and complete annotations', async () => {
    const content = 'LOCUS exact\nORIGIN\n        1 atcgatcg\n//';
    const parsed = {
      sequence: 'atcgatcg',
      annotations: [{ name: 'Gene', qualifiers: { note: ['retained'] } }],
    };
    const promise = parseGitHeadInWorker(content, new AbortController().signal);
    const worker = FakeWorker.instances.at(-1)!;
    expect(worker.posted).toEqual([{ content }]);
    worker.emit('message', { data: { type: 'result', result: parsed } });
    await expect(promise).resolves.toEqual(parsed);
    expect(worker.terminations).toBe(1);
    worker.emit('message', { data: { type: 'error', message: 'late' } });
    expect(worker.terminations).toBe(1);
  });

  it('does not create a worker for an already aborted read', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Closed tab', 'AbortError');
    controller.abort(reason);
    await expect(parseGitHeadInWorker('retired', controller.signal)).rejects.toBe(reason);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('terminates an in-progress parse on its exact cancellation reason', async () => {
    const controller = new AbortController();
    const promise = parseGitHeadInWorker('retired', controller.signal);
    const worker = FakeWorker.instances.at(-1)!;
    const reason = new DOMException('Closed tab', 'AbortError');
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(worker.terminations).toBe(1);
    worker.emit('message', {
      data: { type: 'result', result: { sequence: 'late', annotations: [] } },
    });
    expect(worker.terminations).toBe(1);
  });

  it('cancels only its own parser when two file reads overlap', async () => {
    const firstController = new AbortController();
    const first = parseGitHeadInWorker('first', firstController.signal);
    const firstWorker = FakeWorker.instances.at(-1)!;
    const second = parseGitHeadInWorker('second', new AbortController().signal);
    const secondWorker = FakeWorker.instances.at(-1)!;
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstWorker.terminations).toBe(1);
    expect(secondWorker.terminations).toBe(0);
    const result = { sequence: 'second', annotations: [] };
    secondWorker.emit('message', { data: { type: 'result', result } });
    await expect(second).resolves.toEqual(result);
    expect(secondWorker.terminations).toBe(1);
  });

  it('preserves parse errors and terminates the failed worker', async () => {
    const promise = parseGitHeadInWorker('invalid', new AbortController().signal);
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit('message', { data: { type: 'error', message: 'Invalid GenBank record' } });
    await expect(promise).rejects.toThrow('Invalid GenBank record');
    expect(worker.terminations).toBe(1);
  });

  it.each(['error', 'messageerror'])('settles and terminates on a worker %s', async (type) => {
    const promise = parseGitHeadInWorker('content', new AbortController().signal);
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit(type, { message: 'Worker failed' });
    await expect(promise).rejects.toBeInstanceOf(Error);
    expect(worker.terminations).toBe(1);
  });

  it('terminates the worker if sending the content fails', async () => {
    const error = new Error('Cannot send content');
    FakeWorker.postError = error;
    await expect(parseGitHeadInWorker('content', new AbortController().signal)).rejects.toBe(error);
    expect(FakeWorker.instances.at(-1)?.terminations).toBe(1);
  });
});
