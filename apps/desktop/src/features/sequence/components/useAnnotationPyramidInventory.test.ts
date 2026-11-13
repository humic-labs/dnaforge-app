import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssemblyAnnotationSceneReadRequest } from '../../../shared/indexed-genome';
import { useAnnotationPyramidInventory } from './useAnnotationPyramidInventory';

const { readInventory } = vi.hoisted(() => ({ readInventory: vi.fn() }));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: { readAssemblyAnnotationProductSetInventoryV1: readInventory },
  }),
}));

const SEED_PRODUCT = {
  assemblyId: 'grch38',
} as unknown as AssemblyAnnotationSceneReadRequest;

describe('useAnnotationPyramidInventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not republish empty track inventory on every render while source admission is pending', () => {
    const onInventory = vi.fn();
    const { rerender } = renderHook(() => {
      const inventory = useAnnotationPyramidInventory({ seedProduct: null, requestKey: null });
      React.useEffect(() => onInventory(inventory), [inventory]);
    });

    rerender();
    rerender();

    expect(onInventory).toHaveBeenCalledTimes(1);
    expect(readInventory).not.toHaveBeenCalled();
  });

  it('reads and sorts only the atomically admitted product-set catalog', async () => {
    readInventory.mockResolvedValue({
      status: 'ready',
      sourceFingerprint: 'source',
      inventoryFingerprint: 'inventory',
      trackTypes: ['mRNA', 'lnc_RNA', 'mRNA', 'enhancer'],
    });

    const { result } = renderHook(() =>
      useAnnotationPyramidInventory({ seedProduct: SEED_PRODUCT, requestKey: 'grch38-light' })
    );

    await waitFor(() => expect(result.current).toEqual(['enhancer', 'lnc_RNA', 'mRNA']));
    expect(readInventory).toHaveBeenCalledWith({ seedProduct: SEED_PRODUCT });
  });

  it.each([
    { status: 'unavailable' as const },
    {
      status: 'source-inventory' as const,
      sourceFingerprint: 'source',
      trackTypes: ['lnc_RNA', 'mRNA'],
    },
  ])('fails closed before the complete set is admitted: $status', async (response) => {
    readInventory.mockResolvedValue(response);

    const { result } = renderHook(() =>
      useAnnotationPyramidInventory({ seedProduct: SEED_PRODUCT, requestKey: 'grch38-light' })
    );

    await waitFor(() => expect(readInventory).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('survives the development StrictMode mount cycle', async () => {
    readInventory.mockResolvedValue({
      status: 'ready',
      sourceFingerprint: 'source',
      inventoryFingerprint: 'inventory',
      trackTypes: ['lnc_RNA'],
    });

    const { result } = renderHook(
      () =>
        useAnnotationPyramidInventory({
          seedProduct: SEED_PRODUCT,
          requestKey: 'grch38-light',
        }),
      { wrapper: React.StrictMode }
    );

    await waitFor(() => expect(result.current).toEqual(['lnc_RNA']));
  });

  it('does not restart admission for an equivalent request object', async () => {
    let release!: (value: {
      status: 'ready';
      sourceFingerprint: string;
      inventoryFingerprint: string;
      trackTypes: string[];
    }) => void;
    readInventory.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { result, rerender } = renderHook(
      ({ seedProduct }: { seedProduct: AssemblyAnnotationSceneReadRequest }) =>
        useAnnotationPyramidInventory({ seedProduct, requestKey: 'grch38-light' }),
      { initialProps: { seedProduct: SEED_PRODUCT } }
    );

    await waitFor(() => expect(readInventory).toHaveBeenCalledTimes(1));
    rerender({ seedProduct: { ...SEED_PRODUCT } });
    await Promise.resolve();
    expect(readInventory).toHaveBeenCalledTimes(1);

    release({
      status: 'ready',
      sourceFingerprint: 'source',
      inventoryFingerprint: 'inventory',
      trackTypes: ['mRNA'],
    });
    await waitFor(() => expect(result.current).toEqual(['mRNA']));
  });
});
