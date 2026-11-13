import { describe, expect, it, vi } from 'vitest';

import { SharedCancellableTaskRegistry } from './shared-cancellable-task-registry';

describe('SharedCancellableTaskRegistry', () => {
  it('bounds callers sharing one physical task and releases them on settlement', async () => {
    const registry = new SharedCancellableTaskRegistry<string>(2);
    let resolveTask!: (value: string) => void;
    const start = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          resolveTask = resolve;
        })
    );
    const first = registry.run('same-build', undefined, start);
    const second = registry.run('same-build', undefined, start);

    await expect(registry.run('same-build', undefined, start)).rejects.toThrow(
      'Shared task waiter capacity is full'
    );
    expect(start).toHaveBeenCalledOnce();

    resolveTask('ready');
    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    await expect(registry.run('same-build', undefined, async () => 'replacement')).resolves.toBe(
      'replacement'
    );
  });

  it('bounds distinct physical tasks that ignore cancellation until they settle', async () => {
    const registry = new SharedCancellableTaskRegistry<string>(2, 2);
    const firstController = new AbortController();
    const secondController = new AbortController();
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const first = registry.run(
      'first-build',
      firstController.signal,
      async () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const second = registry.run(
      'second-build',
      secondController.signal,
      async () =>
        new Promise<string>((resolve) => {
          resolveSecond = resolve;
        })
    );

    firstController.abort();
    secondController.abort();
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await expect(registry.run('third-build', undefined, async () => 'third')).rejects.toThrow(
      'Shared task capacity is full'
    );

    resolveFirst('late-first');
    await firstRejected;
    await expect(registry.run('third-build', undefined, async () => 'third')).resolves.toBe(
      'third'
    );
    resolveSecond('late-second');
    await secondRejected;
  });

  it('detaches an aborted successor while the incumbent is still settling', async () => {
    const registry = new SharedCancellableTaskRegistry<string>(2);
    const incumbentController = new AbortController();
    let resolveIncumbent!: (value: string) => void;
    const startIncumbent = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          resolveIncumbent = resolve;
        })
    );
    const incumbent = registry.run('same-build', incumbentController.signal, startIncumbent);
    await vi.waitFor(() => expect(startIncumbent).toHaveBeenCalledOnce());
    incumbentController.abort();

    const abandonedSuccessorController = new AbortController();
    const abandonedSuccessor = registry.run(
      'same-build',
      abandonedSuccessorController.signal,
      async () => 'unused'
    );
    abandonedSuccessorController.abort();
    await expect(abandonedSuccessor).rejects.toMatchObject({ name: 'AbortError' });

    const liveSuccessor = registry.run('same-build', undefined, async () => 'replacement');
    resolveIncumbent('late-incumbent');
    await expect(incumbent).rejects.toMatchObject({ name: 'AbortError' });
    await expect(liveSuccessor).resolves.toBe('replacement');
  });
});
