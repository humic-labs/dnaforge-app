// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import {
  hasIndexedLiveViewportReader,
  readIndexedLiveViewport,
  registerIndexedLiveViewportReader,
  resetIndexedLiveViewportForTests,
  waitForIndexedLiveViewport,
} from './indexed-live-viewport';

beforeEach(() => {
  resetIndexedLiveViewportForTests();
});

describe('indexed live viewport', () => {
  it('reads lazily and acknowledges only the exact consumed command', async () => {
    let commandId: number | null = null;
    const unregister = registerIndexedLiveViewportReader('tab-1', () => ({
      chrom: 'chrI',
      start0: 0,
      end0: 100,
      commandId,
    }));
    expect(hasIndexedLiveViewportReader('tab-1')).toBe(true);
    expect(readIndexedLiveViewport('tab-1')).toMatchObject({ start0: 0, commandId: null });

    const pending = waitForIndexedLiveViewport({
      tabId: 'tab-1',
      chrom: 'chrI',
      start0: 0,
      end0: 100,
      commandId: 7,
      timeoutMs: 100,
    });
    commandId = 7;
    await expect(pending).resolves.toMatchObject({
      tabId: 'tab-1',
      chrom: 'chrI',
      start0: 0,
      end0: 100,
      commandId: 7,
    });

    unregister();
    expect(hasIndexedLiveViewportReader('tab-1')).toBe(false);
    expect(readIndexedLiveViewport('tab-1')).toBeNull();
  });

  it('resolves null when the caller cancels', async () => {
    const controller = new AbortController();
    const pending = waitForIndexedLiveViewport({
      tabId: 'tab-1',
      chrom: 'chrI',
      start0: 0,
      end0: 100,
      commandId: 1,
      abortSignal: controller.signal,
      timeoutMs: 100,
    });
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });

  it.each(['current', 'wrong-request', 'wrong-command', 'moved-camera', 'moved-global'] as const)(
    'checks the command-bound fractional camera receipt: %s',
    async (scenario) => {
      const requested = { chrom: 'chr11', start0: 63_508_550, end0: 63_508_705 };
      const committed = {
        chrom: 'chr11',
        start0: requested.start0 + 0.0000002384185791015625,
        end0: requested.end0 + 0.0000002384185791015625,
      };
      const globalRange = {
        start: committed.start0 + 1_808_681_051,
        end: committed.end0 + 1_808_681_051,
      };
      registerIndexedLiveViewportReader('fractional-tab', () => ({
        ...committed,
        start0: scenario === 'moved-camera' ? committed.start0 + 1 : committed.start0,
        commandId: 8,
        globalRange:
          scenario === 'moved-global'
            ? { ...globalRange, end: globalRange.end + 0.000001 }
            : globalRange,
        commandReceipt: {
          commandId: scenario === 'wrong-command' ? 7 : 8,
          requested:
            scenario === 'wrong-request'
              ? { ...requested, start0: requested.start0 + 1 }
              : requested,
          committed,
          globalRange,
        },
      }));
      const result = await waitForIndexedLiveViewport({
        tabId: 'fractional-tab',
        ...requested,
        commandId: 8,
        timeoutMs: 50,
      });
      if (scenario === 'current') expect(result).toMatchObject(committed);
      else expect(result).toBeNull();
    }
  );
});
