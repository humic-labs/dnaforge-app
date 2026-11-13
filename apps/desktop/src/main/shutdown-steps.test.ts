import { describe, expect, it, vi } from 'vitest';

import { runShutdownSteps } from './shutdown-steps';

describe('runShutdownSteps', () => {
  it('runs steps in order and waits for each one', async () => {
    const order: string[] = [];
    await runShutdownSteps([
      {
        name: 'slow',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push('slow');
        },
      },
      { name: 'sync', run: () => void order.push('sync') },
    ]);
    expect(order).toEqual(['slow', 'sync']);
  });

  it('still closes the database when earlier services throw or reject', async () => {
    const closeDatabase = vi.fn();
    const onFailure = vi.fn();
    const syncError = new Error('canvas pane close threw');
    const asyncError = new Error('remote runtime would not stop');

    const failures = await runShutdownSteps(
      [
        {
          name: 'canvas pane',
          run: () => {
            throw syncError;
          },
        },
        { name: 'remote runtime', run: () => Promise.reject(asyncError) },
        { name: 'database', run: closeDatabase },
      ],
      onFailure
    );

    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(failures).toEqual([
      { name: 'canvas pane', error: syncError },
      { name: 'remote runtime', error: asyncError },
    ]);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });
});
