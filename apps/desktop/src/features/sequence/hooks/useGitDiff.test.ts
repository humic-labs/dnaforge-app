/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGitDiff } from './useGitDiff';
import type { GitHeadParseResponse } from '../diff/git-head-parser.protocol';
import type { GitHeadBaseline, GitHeadParserResponse } from './git-head-parser.worker';

interface ControlledHeadWorker {
  onmessage: ((event: MessageEvent<GitHeadParseResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  reply(response: GitHeadParserResponse): void;
}

const workerControl = vi.hoisted(() => ({
  autoReply: true,
  result: { sequence: '', annotations: [] } as GitHeadBaseline,
  workers: [] as ControlledHeadWorker[],
}));

vi.mock('../diff/git-head-parser.worker.ts?worker&inline', () => ({
  default: class implements ControlledHeadWorker {
    onmessage: ControlledHeadWorker['onmessage'] = null;
    onerror: ControlledHeadWorker['onerror'] = null;
    onmessageerror: ControlledHeadWorker['onmessageerror'] = null;
    terminate = vi.fn();
    postMessage = vi.fn((_content: string) => {
      if (workerControl.autoReply) {
        const result = workerControl.result;
        queueMicrotask(() => this.reply({ result }));
      }
    });
    addEventListener(type: string, listener: unknown) {
      if (type === 'message') this.onmessage = listener as ControlledHeadWorker['onmessage'];
      if (type === 'error') this.onerror = listener as ControlledHeadWorker['onerror'];
      if (type === 'messageerror')
        this.onmessageerror = listener as ControlledHeadWorker['onmessageerror'];
    }
    removeEventListener(type: string) {
      if (type === 'message') this.onmessage = null;
      if (type === 'error') this.onerror = null;
      if (type === 'messageerror') this.onmessageerror = null;
    }
    constructor() {
      workerControl.workers.push(this);
    }
    reply(response: GitHeadParserResponse) {
      const data: GitHeadParseResponse =
        'error' in response
          ? { type: 'error', message: response.error.message }
          : { type: 'result', result: response.result };
      this.onmessage?.(new MessageEvent<GitHeadParseResponse>('message', { data }));
    }
  },
}));

vi.mock('../../workspace/git', () => ({
  gitReadHeadForDiff: vi.fn(),
}));

vi.mock('../diff/sequence-diff', () => ({
  computeSequenceDiff: vi.fn(),
  computeAnnotationDiff: vi.fn(),
}));

vi.mock('@waypoint/sequence-utils', () => ({
  parseGenBankFull: vi.fn(),
}));

vi.mock('../diff/git-head-parser', () => ({
  parseGitHeadInWorker: vi.fn(),
}));

import { gitReadHeadForDiff } from '../../workspace/git';
import { computeSequenceDiff, computeAnnotationDiff } from '../diff/sequence-diff';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { parseGitHeadInWorker } from '../diff/git-head-parser';
import { recordSequenceTabCloseGesture } from '../../../shared/tab-close-gesture';

const mockGitReadHeadForDiff = vi.mocked(gitReadHeadForDiff);
const mockComputeSequenceDiff = vi.mocked(computeSequenceDiff);
const mockComputeAnnotationDiff = vi.mocked(computeAnnotationDiff);
const mockParseGenBankFull = vi.mocked(parseGenBankFull);
const mockParseGitHeadInWorker = vi.mocked(parseGitHeadInWorker);
const { parseGitHeadInWorker: parseActualHeadInWorker } =
  await vi.importActual<typeof import('../diff/git-head-parser')>('../diff/git-head-parser');

describe('useGitDiff', () => {
  beforeEach(() => {
    workerControl.autoReply = true;
    workerControl.workers = [];
    workerControl.result = {
      sequence: 'atcgatcg',
      annotations: [{ name: 'Gene', type: 'CDS', start: 1, end: 4, direction: 1, color: '#000' }],
    };
    mockGitReadHeadForDiff.mockResolvedValue('LOCUS test\nORIGIN\n        1 atcgatcg\n//');
    mockParseGenBankFull.mockReturnValue({
      name: 'test',
      sequence: 'atcgatcg',
      length: 8,
      circular: false,
      annotations: [
        { name: 'Gene', type: 'CDS', start: 1, end: 4, direction: 1 as const, color: '#000' },
      ],
    });
    mockParseGitHeadInWorker.mockImplementation(parseActualHeadInWorker);
    mockComputeSequenceDiff.mockResolvedValue({
      changes: [],
      insertions: 0,
      deletions: 0,
      mutations: 0,
      insertedBp: 0,
      deletedBp: 0,
    });
    mockComputeAnnotationDiff.mockReturnValue({
      changes: [],
      added: 0,
      removed: 0,
      modified: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not publish a retired asynchronous parser result over the current file baseline', async () => {
    let resolveRetired!: (value: { sequence: string; annotations: [] }) => void;
    mockParseGitHeadInWorker
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetired = resolve;
          })
      )
      .mockResolvedValueOnce({ sequence: 'current', annotations: [] });
    const view = renderHook(({ filePath }) => useGitDiff('parse-tab', filePath, 'current', []), {
      initialProps: { filePath: '/test/retired.gb' },
    });
    await waitFor(() => expect(mockParseGitHeadInWorker).toHaveBeenCalledOnce());
    view.rerender({ filePath: '/test/current.gb' });
    await waitFor(() => expect(view.result.current.headSequence).toBe('current'));
    await act(async () => resolveRetired({ sequence: 'retired', annotations: [] }));
    expect(view.result.current.headSequence).toBe('current');
    expect(view.result.current.status).toBe('done');
  });

  it('does not let a rejected asynchronous parser erase a newer file baseline', async () => {
    let rejectRetired!: (reason: Error) => void;
    mockParseGitHeadInWorker
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRetired = reject;
          })
      )
      .mockResolvedValueOnce({ sequence: 'current', annotations: [] });
    const view = renderHook(({ filePath }) => useGitDiff('parse-tab', filePath, 'current', []), {
      initialProps: { filePath: '/test/retired.gb' },
    });
    await waitFor(() => expect(mockParseGitHeadInWorker).toHaveBeenCalledOnce());
    view.rerender({ filePath: '/test/current.gb' });
    await waitFor(() => expect(view.result.current.headSequence).toBe('current'));
    await act(async () => rejectRetired(new Error('retired parser failed')));
    expect(view.result.current.headSequence).toBe('current');
    expect(view.result.current.status).toBe('done');
  });

  it('binds the real tab-close cancellation to an asynchronous parser still in progress', async () => {
    let resolveParse!: (value: { sequence: string; annotations: [] }) => void;
    mockParseGitHeadInWorker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveParse = resolve;
        })
    );
    const view = renderHook(() => useGitDiff('parse-close-tab', '/test/file.gb', 'current', []));
    await waitFor(() => expect(mockParseGitHeadInWorker).toHaveBeenCalledOnce());
    const signal = mockParseGitHeadInWorker.mock.calls[0][1];
    const reason = recordSequenceTabCloseGesture('parse-close-tab');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toEqual(reason);
    view.unmount();
    await act(async () => resolveParse({ sequence: 'retired', annotations: [] }));
    expect(mockComputeSequenceDiff).not.toHaveBeenCalled();
  });

  it('recomputes after a refreshed HEAD with the same current editor inputs', async () => {
    const annotations: [] = [];
    const { result } = renderHook(() =>
      useGitDiff('refresh-tab', '/test/file.gb', 'edited', annotations)
    );
    await waitFor(() => expect(result.current.diffResult).not.toBeNull());
    mockComputeSequenceDiff.mockClear();
    workerControl.result = { sequence: 'new-baseline', annotations: [] };
    act(() => result.current.refreshHeadContent());
    await waitFor(() =>
      expect(mockComputeSequenceDiff).toHaveBeenCalledWith('new-baseline', 'edited')
    );
  });

  it('returns unavailable when the bounded Git HEAD read returns null', async () => {
    mockGitReadHeadForDiff.mockResolvedValue(null);

    const { result } = renderHook(() => useGitDiff('tab-test', '/test/file.gb', 'atcgatcg', []));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.diffResult).toBeNull();
  });

  it('does not parse fetched Git HEAD content on the renderer thread', async () => {
    workerControl.autoReply = false;
    const view = renderHook(() => useGitDiff('tab-head-worker', '/test/file.gb', null, null));

    await waitFor(() => expect(workerControl.workers).toHaveLength(1));
    expect(mockParseGenBankFull).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('loading');
    expect(view.result.current.headSequence).toBeNull();
    expect(workerControl.workers[0].postMessage).toHaveBeenCalledWith({
      content: 'LOCUS test\nORIGIN\n        1 atcgatcg\n//',
    });

    await act(async () => workerControl.workers[0].reply({ result: workerControl.result }));

    expect(view.result.current.status).toBe('done');
    expect(view.result.current.headSequence).toBe('atcgatcg');
    expect(workerControl.workers[0].terminate).toHaveBeenCalledOnce();
  });

  it.each(['late', 'already queued'] as const)(
    'does not publish a %s parse from a retired file',
    async (completion) => {
      workerControl.autoReply = false;
      const view = renderHook(
        ({ filePath }) => useGitDiff('tab-parser-race', filePath, null, null),
        {
          initialProps: { filePath: '/test/retired.gb' },
        }
      );
      await waitFor(() => expect(workerControl.workers).toHaveLength(1));
      const retired = workerControl.workers[0];
      const deliverRetired = retired.onmessage!;
      const retiredResponse: GitHeadParserResponse = {
        result: { sequence: 'retired', annotations: [] },
      };

      act(() => {
        if (completion === 'already queued') retired.reply(retiredResponse);
        view.rerender({ filePath: '/test/current.gb' });
      });
      await waitFor(() => expect(workerControl.workers).toHaveLength(2));
      expect(retired.terminate).toHaveBeenCalledOnce();
      expect(view.result.current.status).toBe('loading');
      expect(view.result.current.headSequence).toBeNull();

      await act(async () => {
        workerControl.workers[1].reply({ result: { sequence: 'current', annotations: [] } });
      });
      await act(async () => {
        deliverRetired(
          new MessageEvent<GitHeadParseResponse>('message', {
            data: { type: 'result', result: retiredResponse.result },
          })
        );
      });

      expect(view.result.current.status).toBe('done');
      expect(view.result.current.headSequence).toBe('current');
    }
  );

  it('refresh cancels a pending parse and computes against the refreshed baseline', async () => {
    workerControl.autoReply = false;
    const annotations: [] = [];
    const view = renderHook(() =>
      useGitDiff('tab-parser-refresh', '/test/file.gb', 'edited', annotations)
    );
    await waitFor(() => expect(workerControl.workers).toHaveLength(1));
    const retired = workerControl.workers[0];

    act(() => view.result.current.refreshHeadContent());
    await waitFor(() => expect(workerControl.workers).toHaveLength(2));
    expect(retired.terminate).toHaveBeenCalledOnce();
    expect(view.result.current.status).toBe('loading');
    expect(mockComputeSequenceDiff).not.toHaveBeenCalled();

    await act(async () => {
      workerControl.workers[1].reply({ result: { sequence: 'refreshed', annotations: [] } });
    });
    await waitFor(() =>
      expect(mockComputeSequenceDiff).toHaveBeenCalledWith('refreshed', 'edited')
    );
    expect(view.result.current.headSequence).toBe('refreshed');
  });

  it.each(['unmount', 'committed close'] as const)(
    '%s terminates an in-flight parse without publishing its queued response',
    async (cancel) => {
      workerControl.autoReply = false;
      const tabId = `tab-parser-${cancel}`;
      const view = renderHook(() => useGitDiff(tabId, '/test/file.gb', 'edited', []));
      await waitFor(() => expect(workerControl.workers).toHaveLength(1));
      const worker = workerControl.workers[0];
      const deliver = worker.onmessage!;
      const signal = mockGitReadHeadForDiff.mock.calls[0][1]!;

      if (cancel === 'committed close') {
        const closeReason = recordSequenceTabCloseGesture(tabId);
        expect(signal.reason).toEqual(closeReason);
      } else view.unmount();
      expect(signal.aborted).toBe(true);
      expect(worker.terminate).toHaveBeenCalledOnce();
      await act(async () => {
        deliver(
          new MessageEvent<GitHeadParseResponse>('message', {
            data: { type: 'result', result: workerControl.result },
          })
        );
      });
      expect(mockComputeSequenceDiff).not.toHaveBeenCalled();
      expect(view.result.current.headSequence).toBeNull();
      if (cancel === 'committed close') view.unmount();
    }
  );

  it.each(['parse error', 'worker crash', 'unreadable response'] as const)(
    'reports %s as unavailable without falling back to renderer parsing',
    async (failure) => {
      workerControl.autoReply = false;
      const view = renderHook(() =>
        useGitDiff('tab-parser-failure', '/test/file.gb', 'edited', [])
      );
      await waitFor(() => expect(workerControl.workers).toHaveLength(1));
      const worker = workerControl.workers[0];
      await act(async () => {
        if (failure === 'parse error')
          worker.reply({ error: { name: 'Error', message: 'Invalid GenBank' } });
        else if (failure === 'worker crash')
          worker.onerror!(new ErrorEvent('error', { message: 'Worker failed' }));
        else worker.onmessageerror!();
      });
      expect(view.result.current.status).toBe('unavailable');
      expect(view.result.current.headSequence).toBeNull();
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(mockParseGenBankFull).not.toHaveBeenCalled();
      expect(mockComputeSequenceDiff).not.toHaveBeenCalled();
    }
  );

  it('does not start a worker for an already aborted read', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Read retired'));
    await expect(parseActualHeadInWorker('unused', controller.signal)).rejects.toBe(
      controller.signal.reason
    );
    expect(workerControl.workers).toHaveLength(0);
  });

  it('the worker preserves the existing parser sequence, joined features and qualifiers', async () => {
    const { parseGenBankFull: parseOriginal } = await vi.importActual<
      typeof import('@waypoint/sequence-utils')
    >('@waypoint/sequence-utils');
    const content = `LOCUS       head-record              12 bp    DNA     circular
FEATURES             Location/Qualifiers
     CDS             complement(join(1..3,7..9))
                     /label="joined gene"
                     /gene="example"
                     /transl_table=11
                     /note="first note"
                     /note="second note"
ORIGIN
        1 atgcgatgcgat
//`;
    const expected = parseOriginal(content);
    expect(expected.annotations).toHaveLength(1);
    expect(expected.annotations[0].direction).toBe(-1);
    expect(expected.annotations[0].segments).toHaveLength(2);
    mockParseGenBankFull.mockImplementation(parseOriginal);
    const originalHandler = globalThis.onmessage;
    const postMessage = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => undefined);
    try {
      await import('../diff/git-head-parser.worker');
      globalThis.onmessage!.call(window, new MessageEvent('message', { data: { content } }));
      expect(mockParseGenBankFull).toHaveBeenCalledExactlyOnceWith(content);
      expect(postMessage).toHaveBeenCalledExactlyOnceWith({
        type: 'result',
        result: { sequence: expected.sequence, annotations: expected.annotations },
      });
    } finally {
      globalThis.onmessage = originalHandler;
      postMessage.mockRestore();
    }
  });

  it('refresh retires an in-flight diff before publishing the new HEAD baseline', async () => {
    let resolveRetiredDiff!: (diff: Awaited<ReturnType<typeof computeSequenceDiff>>) => void;
    mockComputeSequenceDiff.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetiredDiff = resolve;
      })
    );
    const annotations: [] = [];
    const view = renderHook(() =>
      useGitDiff('tab-diff-refresh', '/test/file.gb', 'edited', annotations)
    );
    await waitFor(() => expect(mockComputeSequenceDiff).toHaveBeenCalledOnce());
    workerControl.autoReply = false;
    act(() => view.result.current.refreshHeadContent());
    await waitFor(() => expect(workerControl.workers).toHaveLength(2));
    await act(async () => {
      resolveRetiredDiff({
        changes: [{ type: 'insertion', position: 1, length: 1, newBases: 'A' }],
        insertions: 1,
        deletions: 0,
        mutations: 0,
        insertedBp: 1,
        deletedBp: 0,
      });
    });
    expect(view.result.current.status).toBe('loading');
    expect(view.result.current.headSequence).toBeNull();
    expect(view.result.current.diffResult).toBeNull();

    await act(async () => {
      workerControl.workers[1].reply({ result: { sequence: 'new-head', annotations: [] } });
    });
    await waitFor(() =>
      expect(mockComputeSequenceDiff).toHaveBeenLastCalledWith('new-head', 'edited')
    );
    await waitFor(() => expect(view.result.current.diffResult?.changes).toEqual([]));
    expect(view.result.current.headSequence).toBe('new-head');
  });

  it('computes diff after initial HEAD fetch', async () => {
    const mockDiff = {
      changes: [{ type: 'insertion' as const, position: 4, length: 2, newBases: 'CC' }],
      insertions: 1,
      deletions: 0,
      mutations: 0,
      insertedBp: 2,
      deletedBp: 0,
    };
    mockComputeSequenceDiff.mockResolvedValue(mockDiff);

    const { result } = renderHook(() => useGitDiff('tab-test', '/test/file.gb', 'atcgCCatcg', []));

    await waitFor(() => expect(result.current.diffResult).not.toBeNull(), { timeout: 2000 });
    expect(result.current.diffResult?.changes).toHaveLength(1);
    expect(result.current.diffResult?.changes[0].type).toBe('insertion');
  });

  it('caches HEAD content — only fetches once', async () => {
    const { result, rerender } = renderHook(
      ({ seq }) => useGitDiff('tab-test', '/test/file.gb', seq, []),
      { initialProps: { seq: 'atcgCCatcg' } }
    );

    await waitFor(() => expect(result.current.status).toBe('done'), { timeout: 2000 });
    expect(mockGitReadHeadForDiff).toHaveBeenCalledTimes(1);

    rerender({ seq: 'atcgCCCatcg' });

    await waitFor(() => expect(mockComputeSequenceDiff).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });

    expect(mockGitReadHeadForDiff).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fetch HEAD when sequence value stays the same', async () => {
    const { result, rerender } = renderHook(
      ({ seq }) => useGitDiff('tab-test', '/test/file.gb', seq, []),
      { initialProps: { seq: 'atcgCCatcg' } }
    );

    await waitFor(() => expect(result.current.status).toBe('done'), { timeout: 2000 });
    expect(mockGitReadHeadForDiff).toHaveBeenCalledTimes(1);

    rerender({ seq: 'atcgCCatcg' });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(mockGitReadHeadForDiff).toHaveBeenCalledTimes(1);
  });

  it('refreshHeadContent re-fetches HEAD', async () => {
    const { result } = renderHook(() => useGitDiff('tab-test', '/test/file.gb', 'atcgCCatcg', []));

    await waitFor(() => expect(result.current.status).toBe('done'), { timeout: 2000 });
    expect(mockGitReadHeadForDiff).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refreshHeadContent();
    });

    await waitFor(() => expect(mockGitReadHeadForDiff).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
  });

  it('returns null diffResult when currentSequence is null', async () => {
    const { result } = renderHook(() => useGitDiff('tab-test', '/test/file.gb', null, null));

    await waitFor(() => expect(result.current.status).toBe('done'), { timeout: 2000 });
    expect(result.current.diffResult).toBeNull();
  });

  it('recomputeNow bypasses debounce timer', async () => {
    const mockDiff = {
      changes: [{ type: 'insertion' as const, position: 4, length: 2, newBases: 'CC' }],
      insertions: 1,
      deletions: 0,
      mutations: 0,
      insertedBp: 2,
      deletedBp: 0,
    };
    mockComputeSequenceDiff.mockResolvedValue(mockDiff);

    const { result } = renderHook(() => useGitDiff('tab-test', '/test/file.gb', 'atcgCCatcg', []));

    await waitFor(() => expect(result.current.status).toBe('done'), { timeout: 2000 });

    await waitFor(() => expect(result.current.diffResult).not.toBeNull(), { timeout: 2000 });

    const callCountBefore = mockComputeSequenceDiff.mock.calls.length;

    act(() => {
      result.current.recomputeNow();
    });

    await waitFor(
      () => expect(mockComputeSequenceDiff.mock.calls.length).toBeGreaterThan(callCountBefore),
      { timeout: 100 }
    );
  });

  it('recomputeNow clears pending debounce timer', async () => {
    mockComputeSequenceDiff.mockResolvedValue({
      changes: [],
      insertions: 0,
      deletions: 0,
      mutations: 0,
      insertedBp: 0,
      deletedBp: 0,
    });

    const annotations: [] = [];
    const { result, rerender } = renderHook(
      ({ seq }) => useGitDiff('tab-test', '/test/file.gb', seq, annotations),
      { initialProps: { seq: 'atcgatcg' } }
    );

    await waitFor(() => expect(mockComputeSequenceDiff).toHaveBeenCalledOnce());

    rerender({ seq: 'atcgCCatcg' });

    act(() => {
      result.current.recomputeNow();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(mockComputeSequenceDiff).toHaveBeenCalledTimes(2);
  });

  it('does not publish a HEAD response that settles after unmount', async () => {
    let resolveHead!: (content: string) => void;
    mockGitReadHeadForDiff.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveHead = resolve;
      })
    );
    const view = renderHook(() => useGitDiff('tab-test', '/test/file.gb', 'atcgatcg', []));

    await waitFor(() => expect(mockGitReadHeadForDiff).toHaveBeenCalledOnce());
    const signal = mockGitReadHeadForDiff.mock.calls[0]?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    resolveHead('LOCUS retired\nORIGIN\n        1 atcgatcg\n//');
    await Promise.resolve();

    expect(mockParseGenBankFull).not.toHaveBeenCalled();
    expect(mockComputeSequenceDiff).not.toHaveBeenCalled();
  });

  it('binds a sequence-tab close gesture to the Git read aborted by unmount', async () => {
    let resolveHead: (content: string) => void = () => undefined;
    mockGitReadHeadForDiff.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveHead = resolve;
      })
    );
    const view = renderHook(() =>
      useGitDiff('sequence-tab-close', '/test/file.gb', 'atcgatcg', [])
    );

    await waitFor(() => expect(mockGitReadHeadForDiff).toHaveBeenCalledOnce());
    const signal = mockGitReadHeadForDiff.mock.calls[0]?.[1];
    const closeReason = recordSequenceTabCloseGesture('sequence-tab-close');

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toEqual(closeReason);
    view.unmount();

    resolveHead('LOCUS retired\nORIGIN\n        1 atcgatcg\n//');
    await Promise.resolve();
  });

  it('does not let a rejected stale HEAD request erase the current file baseline', async () => {
    let rejectRetiredHead!: (reason: Error) => void;
    mockGitReadHeadForDiff
      .mockReturnValueOnce(
        new Promise<string>((_resolve, reject) => {
          rejectRetiredHead = reject;
        })
      )
      .mockResolvedValueOnce('LOCUS current\nORIGIN\n        1 atcgatcg\n//');

    const view = renderHook(({ filePath }) => useGitDiff('tab-test', filePath, 'atcgatcg', []), {
      initialProps: { filePath: '/test/retired.gb' },
    });

    await waitFor(() => expect(mockGitReadHeadForDiff).toHaveBeenCalledOnce());
    const retiredSignal = mockGitReadHeadForDiff.mock.calls[0]?.[1];
    view.rerender({ filePath: '/test/current.gb' });
    await waitFor(() => expect(view.result.current.status).toBe('done'));
    expect(retiredSignal?.aborted).toBe(true);

    rejectRetiredHead(new Error('retired request failed'));
    await Promise.resolve();

    expect(view.result.current.status).toBe('done');
  });
});
