import { act, renderHook, waitFor } from '@testing-library/react';
import { parseGenomeComparisonPaf } from '@waypoint/genome-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  comparisonSourceProjectionId,
  type ComparisonProjectionViewState,
  type ComparisonSourceWindowRequest,
  type ComparisonSourceWindowResult,
} from '../../../shared/comparison-source';
const native = vi.hoisted(() => ({ read: vi.fn(), readWindow: vi.fn() }));
vi.mock('../../../platform', () => ({ platform: () => ({ comparisonSources: native }) }));
import { useComparisonProjectionSource } from './useComparisonProjectionSource';

const view: ComparisonProjectionViewState = {
  kind: 'aligned-genomes',
  project: '/project',
  source: {
    schema: 'dnaforge.comparison-source.v1',
    path: 'comparison.paf',
    sha256: 'a'.repeat(64),
    targetReference: { id: 'target', chrom: 'target', length: 100 },
    queryReference: { id: 'query', chrom: 'query', length: 102 },
    targetSource: {
      referenceId: 'prepared-target',
      sequenceIdentity: 'b'.repeat(64),
      annotationIdentity: 'c'.repeat(64),
    },
    querySource: {
      referenceId: 'prepared-query',
      sequenceIdentity: 'd'.repeat(64),
      annotationIdentity: 'e'.repeat(64),
    },
  },
};
const projectionId = comparisonSourceProjectionId(view.source);
const reference = [{ chrom: 'target', length: 100 }];
function windowResult(input: ComparisonSourceWindowRequest): ComparisonSourceWindowResult {
  return {
    projectionId: comparisonSourceProjectionId(input.source),
    camera: input.camera,
    basesStatus: 'ready',
    annotationsStatus: { target: 'ready', query: 'ready' },
    targetSequenceWindows: [{ start: input.camera.startColumn, sequence: 'A' }],
    querySequenceWindows: [{ start: input.camera.startColumn + 2, sequence: 'C' }],
    annotations: {
      target: [{ id: 'actual-gene', label: 'actual gene', start: 0, end: 8, strand: '-' }],
      query: [],
    },
  };
}
beforeEach(() => {
  native.read.mockReset().mockImplementation(async (input) => ({
    projectionId: comparisonSourceProjectionId(input.source),
    revision: input.source.sha256,
    path: '/project/comparison.paf',
    label: 'Comparison',
    comparison: parseGenomeComparisonPaf(
      'query\t102\t0\t12\t+\ttarget\t100\t0\t10\t10\t12\t60\tcg:Z:5=2I5=',
      {
        target: { id: 'target', length: 100 },
        query: { id: 'query', length: 102 },
      }
    ),
  }));
  native.readWindow.mockReset().mockImplementation(async (input) => windowResult(input));
});
afterEach(() => vi.useRealTimers());

describe('native comparison viewport lifetime', () => {
  it('debounces rapid camera changes before invoking a native source read', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ current }) => useComparisonProjectionSource(current, reference),
      { initialProps: { current: view } }
    );
    await act(async () => {});
    expect(native.read).toHaveBeenCalledOnce();
    expect(native.readWindow).not.toHaveBeenCalled();
    for (let startColumn = 1; startColumn <= 6; startColumn++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30);
      });
      rerender({
        current: { ...view, camera: { projectionId, startColumn, endColumn: startColumn + 6 } },
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(79);
    });
    expect(native.readWindow).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(native.readWindow).toHaveBeenCalledExactlyOnceWith({
      project: view.project,
      source: view.source,
      camera: { projectionId, startColumn: 6, endColumn: 12 },
    });
    expect(
      result.current.status === 'ready' && result.current.sourceWindow?.camera.startColumn
    ).toBe(6);
    expect(native.read).toHaveBeenCalledOnce();
  });

  it('cancels queued source reads before source replacement or detachment', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ current }: { current: ComparisonProjectionViewState | undefined }) =>
        useComparisonProjectionSource(current, reference),
      { initialProps: { current: view as ComparisonProjectionViewState | undefined } }
    );
    await act(async () => {});
    const changed = {
      ...view,
      source: {
        ...view.source,
        querySource: { ...view.source.querySource!, annotationIdentity: 'f'.repeat(64) },
      },
    };
    rerender({ current: changed });
    expect(result.current.status).toBe('loading');
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(native.readWindow).toHaveBeenCalledOnce();
    expect(native.readWindow.mock.calls[0][0].source).toEqual(changed.source);
    rerender({
      current: {
        ...changed,
        camera: {
          projectionId: comparisonSourceProjectionId(changed.source),
          startColumn: 2,
          endColumn: 8,
        },
      },
    });
    rerender({ current: undefined });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(native.readWindow).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('inactive');
  });

  it('requests exact pinned sources and alignment camera while retaining the same parsed layout on pan', async () => {
    const { result, rerender } = renderHook(
      ({ current }) => useComparisonProjectionSource(current, reference),
      { initialProps: { current: view } }
    );
    await waitFor(() =>
      expect(result.current.status === 'ready' && result.current.sourceWindow).toBeTruthy()
    );
    const projection = result.current.status === 'ready' ? result.current.projection : null;
    expect(native.readWindow).toHaveBeenCalledWith({
      project: '/project',
      source: view.source,
      camera: { projectionId, startColumn: 0, endColumn: 12 },
    });
    rerender({ current: { ...view, camera: { projectionId, startColumn: 2, endColumn: 8 } } });
    expect(
      result.current.status === 'ready' ? result.current.projection.targetSequenceWindows : null
    ).toBeUndefined();
    await waitFor(() =>
      expect(
        result.current.status === 'ready' && result.current.sourceWindow?.camera.startColumn
      ).toBe(2)
    );
    expect(result.current.status === 'ready' ? result.current.projection.layout : null).toBe(
      projection?.layout
    );
    expect(native.read).toHaveBeenCalledOnce();
    expect(native.readWindow).toHaveBeenCalledTimes(2);
  });

  it('fences late window data after a camera move, source replacement and detachment', async () => {
    const late = Promise.withResolvers<ComparisonSourceWindowResult>();
    native.readWindow.mockImplementationOnce(() => late.promise);
    const { result, rerender } = renderHook(
      ({ current }: { current: ComparisonProjectionViewState | undefined }) =>
        useComparisonProjectionSource(current, reference),
      { initialProps: { current: view as ComparisonProjectionViewState | undefined } }
    );
    await waitFor(() => expect(native.readWindow).toHaveBeenCalledOnce());
    const oldRequest = native.readWindow.mock.calls[0][0];
    rerender({ current: { ...view, camera: { projectionId, startColumn: 3, endColumn: 9 } } });
    await waitFor(() =>
      expect(
        result.current.status === 'ready' && result.current.sourceWindow?.camera.startColumn
      ).toBe(3)
    );
    await act(async () => {
      late.resolve(windowResult(oldRequest));
      await late.promise;
    });
    expect(
      result.current.status === 'ready' ? result.current.sourceWindow?.camera.startColumn : null
    ).toBe(3);
    const changed = {
      ...view,
      source: {
        ...view.source,
        querySource: { ...view.source.querySource!, annotationIdentity: 'f'.repeat(64) },
      },
    };
    rerender({ current: changed });
    expect(result.current.status).toBe('loading');
    await waitFor(() =>
      expect(result.current.status === 'ready' && result.current.sourceWindow?.projectionId).toBe(
        comparisonSourceProjectionId(changed.source)
      )
    );
    rerender({ current: undefined });
    expect(result.current.status).toBe('inactive');
  });

  it('uses the existing error result for native source failures or a mismatched response camera', async () => {
    native.readWindow.mockRejectedValue(
      new Error('The pinned comparison reference content has changed.')
    );
    const { result, unmount } = renderHook(() => useComparisonProjectionSource(view, reference));
    await waitFor(() =>
      expect(result.current).toMatchObject({
        status: 'error',
        message: 'The pinned comparison reference content has changed.',
      })
    );
    unmount();
    native.readWindow.mockImplementation(async (input) => ({
      ...windowResult(input),
      camera: { ...input.camera, startColumn: 5 },
    }));
    const mismatch = renderHook(() => useComparisonProjectionSource(view, reference));
    await waitFor(() =>
      expect(mismatch.result.current).toMatchObject({
        status: 'error',
        message: 'The comparison source window belongs to another camera or source.',
      })
    );
  });
});
