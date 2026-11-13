import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { VitestTestRunner } from 'vitest/runners';

import AssemblyCorpusTestRunner from '../../scripts/assembly-corpus-test-runner.mjs';

interface CorpusTask {
  file: { filepath: string };
}
interface Subject {
  onBeforeTryTask(task: CorpusTask): Promise<void>;
  onTaskUpdate(packs: unknown[], events: unknown[]): Promise<void>;
}
const corpusTask: CorpusTask = {
  file: {
    filepath:
      '/owned/apps/desktop/src/features/assembly-graph/__tests__/inference/synthetic-assembly-catalog.test.ts',
  },
};
const subject = (): Subject => Object.create(AssemblyCorpusTestRunner.prototype);

afterEach(() => vi.restoreAllMocks());

it('waits for the real injected status acknowledgment after base initialization', async () => {
  const events: string[] = [];
  vi.spyOn(VitestTestRunner.prototype, 'onBeforeTryTask').mockImplementation(() => {
    events.push('base');
  });
  const runner = subject();
  let acknowledge = () => {
    throw new Error('status acknowledgment was not requested');
  };
  runner.onTaskUpdate = () => {
    events.push('sent');
    return new Promise<void>((resolve) => {
      acknowledge = () => {
        events.push('acknowledged');
        resolve();
      };
    });
  };
  const execution = runner.onBeforeTryTask(corpusTask).then(() => events.push('CPU work'));
  await nextTurn();
  expect(events).toEqual(['base', 'sent']);
  acknowledge();
  await execution;
  expect(events).toEqual(['base', 'sent', 'acknowledged', 'CPU work']);
});

it('propagates a failed acknowledgment instead of starting CPU work', async () => {
  vi.spyOn(VitestTestRunner.prototype, 'onBeforeTryTask').mockImplementation(() => {});
  const runner = subject();
  const failure = new Error('original RPC failure');
  runner.onTaskUpdate = async () => {
    throw failure;
  };
  await expect(runner.onBeforeTryTask(corpusTask)).rejects.toBe(failure);
});

it('keeps unrelated tests on their base behavior without an extra status call', async () => {
  const base = vi.spyOn(VitestTestRunner.prototype, 'onBeforeTryTask').mockImplementation(() => {});
  const runner = subject();
  runner.onTaskUpdate = async () => {
    throw new Error('unrelated test must not add a status call');
  };
  const task = { file: { filepath: '/owned/apps/desktop/src/main/unrelated.test.ts' } };
  await runner.onBeforeTryTask(task);
  expect(base).toHaveBeenCalledExactlyOnceWith(task);
});
