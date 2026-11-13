import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveFilesystemWorkGuard, withActiveFilesystemWork } from './active-filesystem-work';

afterEach(() => setActiveFilesystemWorkGuard(undefined));

describe('active filesystem work', () => {
  it('keeps concurrent operations active until each operation has actually settled', async () => {
    const live = new Set<number>();
    let nextId = 0;
    setActiveFilesystemWorkGuard(() => {
      const id = ++nextId;
      live.add(id);
      return () => {
        live.delete(id);
      };
    });
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = withActiveFilesystemWork(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        })
    );
    const second = withActiveFilesystemWork(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        })
    );
    expect([...live]).toEqual([1, 2]);
    finishFirst();
    await first;
    expect([...live]).toEqual([2]);
    finishSecond();
    await second;
    expect(live.size).toBe(0);
  });

  it.each(['throw', 'reject'])(
    'releases activity after an operation fails by %s',
    async (failure) => {
      const release = vi.fn();
      setActiveFilesystemWorkGuard(() => release);
      const error = new Error('actual filesystem failure');
      await expect(
        withActiveFilesystemWork(() => {
          if (failure === 'throw') throw error;
          return Promise.reject(error);
        })
      ).rejects.toBe(error);
      expect(release).toHaveBeenCalledExactlyOnceWith();
    }
  );

  it('runs the same operation without a shell guard in other runtimes', async () => {
    const work = vi.fn(async () => 'complete');
    await expect(withActiveFilesystemWork(work)).resolves.toBe('complete');
    expect(work).toHaveBeenCalledExactlyOnceWith();
  });
});
