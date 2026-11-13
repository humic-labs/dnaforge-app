import { expect, it, vi } from 'vitest';
import { queueTerminalPaste } from './terminal-paste-queue';

it('captures now but commits two pastes after earlier chunks and confirmation settle', async () => {
  let finishWrite = () => {};
  let finishConfirmation = () => {};
  const order: string[] = [];
  const before = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const first = queueTerminalPaste(before, Promise.resolve('first'), async (token) => {
    order.push(token);
    await new Promise<void>((resolve) => {
      finishConfirmation = resolve;
    });
  });
  const second = queueTerminalPaste(first, Promise.resolve('second'), async (token) => {
    order.push(token);
  });
  await Promise.resolve();
  expect(order).toEqual([]);
  finishWrite();
  await vi.waitFor(() => expect(order).toEqual(['first']));
  finishConfirmation();
  await second;
  expect(order).toEqual(['first', 'second']);
});

it('keeps an early capture failure behind an older write and does not commit', async () => {
  let finish = () => {};
  const before = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const commit = vi.fn();
  const queued = queueTerminalPaste(before, Promise.reject(new Error('capture failed')), commit);
  let settled = false;
  const observed = queued.catch((error) => {
    settled = true;
    expect(error.message).toBe('capture failed');
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await observed;
  expect(commit).not.toHaveBeenCalled();
});
