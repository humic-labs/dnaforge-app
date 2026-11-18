import { act, renderHook, waitFor } from '@testing-library/react';
import { parseGenomeComparisonPaf } from '@waypoint/genome-data';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ComparisonProjectionViewState,
  ComparisonSourceReadResult,
} from '../../../shared/comparison-source';
const native = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../platform', () => ({
  platform: () => ({ comparisonSources: { read: native.read } }),
}));
import { useComparisonProjectionSource } from './useComparisonProjectionSource';

const view: ComparisonProjectionViewState = {
  kind: 'aligned-genomes',
  project: '/project',
  source: {
    schema: 'dnaforge.comparison-source.v1',
    path: 'alignment.paf',
    sha256: 'a'.repeat(64),
    targetReference: { id: 'target', chrom: 'target', length: 100 },
    queryReference: { id: 'query', chrom: 'query', length: 102 },
  },
};
const reference = [{ chrom: 'target', length: 100 }];
const loaded = (sha = view.source.sha256): ComparisonSourceReadResult => ({
  comparison: parseGenomeComparisonPaf(
    'query\t102\t0\t12\t+\ttarget\t100\t0\t10\t10\t12\t60\tcg:Z:5=2I5=\tnn:i:0',
    {
      target: { id: 'target', length: 100 },
      query: { id: 'query', length: 102 },
    }
  ),
  projectionId: `comparison:${sha}`,
  label: 'Exact comparison',
  revision: sha,
  path: '/project/alignment.paf',
});

beforeEach(() => native.read.mockReset());

describe('native comparison source lifetime', () => {
  it('builds the native projection once and keeps source data stable while the projected camera changes', async () => {
    native.read.mockResolvedValue(loaded());
    const { result, rerender } = renderHook(
      ({ current }) => useComparisonProjectionSource(current, reference),
      { initialProps: { current: view } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const projection = result.current.status === 'ready' ? result.current.projection : null;
    expect(projection?.layout.entries[0]).toMatchObject({
      kind: 'block',
      columnStart: 0,
      columnEnd: 12,
    });
    rerender({
      current: {
        ...view,
        camera: { projectionId: `comparison:${view.source.sha256}`, startColumn: 2, endColumn: 10 },
      },
    });
    expect(result.current.status === 'ready' ? result.current.projection : null).toBe(projection);
    expect(native.read).toHaveBeenCalledExactlyOnceWith({
      project: view.project,
      source: view.source,
    });
  });

  it('rejects a different biological target before the native read', async () => {
    const { result } = renderHook(() =>
      useComparisonProjectionSource(view, [{ chrom: 'target', length: 101 }])
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(native.read).not.toHaveBeenCalled();
  });

  it('fences a late source after replacement and detachment', async () => {
    const first = Promise.withResolvers<ComparisonSourceReadResult>();
    const second = Promise.withResolvers<ComparisonSourceReadResult>();
    native.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ current }: { current: ComparisonProjectionViewState | undefined }) =>
        useComparisonProjectionSource(current, reference),
      { initialProps: { current: view as ComparisonProjectionViewState | undefined } }
    );
    rerender({ current: { ...view, source: { ...view.source, sha256: 'b'.repeat(64) } } });
    await act(async () => {
      first.resolve(loaded());
      await first.promise;
    });
    expect(result.current.status).toBe('loading');
    await act(async () => {
      second.resolve(loaded('b'.repeat(64)));
      await second.promise;
    });
    expect(result.current).toMatchObject({
      status: 'ready',
      projection: { id: `comparison:${'b'.repeat(64)}` },
    });
    rerender({ current: undefined });
    expect(result.current.status).toBe('inactive');
  });

  it('keeps a changed source unavailable instead of painting its predecessor', async () => {
    native.read
      .mockResolvedValueOnce(loaded())
      .mockRejectedValueOnce(new Error('Comparison bytes changed.'));
    const { result, rerender } = renderHook(
      ({ current }) => useComparisonProjectionSource(current, reference),
      { initialProps: { current: view } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ current: { ...view, source: { ...view.source, sha256: 'b'.repeat(64) } } });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toMatchObject({ message: 'Comparison bytes changed.' });
  });
});
