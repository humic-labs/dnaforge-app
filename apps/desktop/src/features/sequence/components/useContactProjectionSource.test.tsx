import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContactProjectionViewState,
  ContactSourceReadResult,
} from '../../../shared/contact-source';
const native = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../platform', () => ({
  platform: () => ({ contactSources: { read: native.read } }),
}));
import { useContactProjectionSource } from './useContactProjectionSource';

const view: ContactProjectionViewState = {
  kind: 'contact-matrix',
  project: '/project',
  source: {
    schema: 'dnaforge.contact-source.v1',
    path: 'data.contacts.json',
    sha256: 'a'.repeat(64),
    xReference: { id: 'U00096.2', chrom: 'U00096.2', length: 4_639_675 },
    yReference: { id: 'U00096.2', chrom: 'U00096.2', length: 4_639_675 },
  },
};
const reference = [{ chrom: 'U00096.2', length: 4_639_675 }];
const loaded = (id: string): ContactSourceReadResult => ({
  projection: {
    kind: 'contact-matrix',
    id,
    xReference: view.source.xReference,
    yReference: view.source.yReference,
    cells: [],
    colorScale: {
      kind: 'continuous',
      domain: [1, 10],
      colors: ['#ffffff', '#ff0000'],
      missingColor: '#cccccc',
      transform: 'linear',
    },
  },
  label: 'Measured contacts',
  unit: 'counts',
  path: '/project/data.contacts.json',
  revision: view.source.sha256,
});

beforeEach(() => {
  native.read.mockReset();
});

describe('native contact source lifetime', () => {
  it('loads through the native owner and does not reload scientific data for camera updates', async () => {
    native.read.mockResolvedValue(loaded('source-a'));
    const { result, rerender } = renderHook(
      ({ current }) => useContactProjectionSource(current, reference),
      { initialProps: { current: view } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(native.read).toHaveBeenCalledExactlyOnceWith({
      project: view.project,
      source: view.source,
    });
    rerender({
      current: {
        ...view,
        camera: { projectionId: 'source-a', xStart: 0, xEnd: 100_000, yStart: 0, yEnd: 200_000 },
      },
    });
    expect(result.current.status).toBe('ready');
    expect(native.read).toHaveBeenCalledTimes(1);
  });

  it('rejects another reference before reading or painting the source', async () => {
    const { result } = renderHook(() =>
      useContactProjectionSource(view, [{ chrom: 'NC_000913.3', length: 4_641_652 }])
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toMatchObject({
      message: expect.stringContaining('accession and length'),
    });
    expect(native.read).not.toHaveBeenCalled();
  });

  it('ignores a late old source after a replacement or detachment', async () => {
    const first = Promise.withResolvers<ContactSourceReadResult>();
    const second = Promise.withResolvers<ContactSourceReadResult>();
    native.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ current }: { current: ContactProjectionViewState | undefined }) =>
        useContactProjectionSource(current, reference),
      { initialProps: { current: view as ContactProjectionViewState | undefined } }
    );
    rerender({ current: { ...view, source: { ...view.source, sha256: 'b'.repeat(64) } } });
    await act(async () => {
      first.resolve(loaded('old'));
      await first.promise;
    });
    expect(result.current.status).toBe('loading');
    await act(async () => {
      second.resolve(loaded('new'));
      await second.promise;
    });
    expect(result.current).toMatchObject({ status: 'ready', value: { projection: { id: 'new' } } });
    rerender({ current: undefined });
    expect(result.current.status).toBe('inactive');
  });

  it('keeps a native hash/read error unavailable rather than drawing old data', async () => {
    native.read
      .mockResolvedValueOnce(loaded('source-a'))
      .mockRejectedValueOnce(new Error('The contact source bytes changed.'));
    const { result, rerender } = renderHook(
      ({ current }) => useContactProjectionSource(current, reference),
      { initialProps: { current: view } }
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ current: { ...view, source: { ...view.source, path: 'changed.contacts.json' } } });
    expect(result.current.status).toBe('loading');
    await waitFor(() =>
      expect(result.current).toMatchObject({
        status: 'error',
        message: 'The contact source bytes changed.',
      })
    );
  });
});
