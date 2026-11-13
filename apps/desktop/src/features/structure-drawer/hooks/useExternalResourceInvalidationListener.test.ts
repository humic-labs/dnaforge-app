// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('./useExternalResourceCache', () => ({
  invalidateCacheByExternalIds: vi.fn(),
}));

import {
  _resetSubscribersForTesting,
  dispatchExternalResourceInvalidation,
} from '../api/external-resources-invalidate';
import { invalidateCacheByExternalIds } from './useExternalResourceCache';
import { useExternalResourceInvalidationListener } from './useExternalResourceInvalidationListener';

const mockedInvalidate = vi.mocked(invalidateCacheByExternalIds);

beforeEach(() => {
  _resetSubscribersForTesting();
  mockedInvalidate.mockReset();
  mockedInvalidate.mockResolvedValue(0);
});

describe('useExternalResourceInvalidationListener', () => {
  it('subscribes on mount and forwards entries to the L1 invalidator', () => {
    renderHook(() => useExternalResourceInvalidationListener());
    dispatchExternalResourceInvalidation({
      event: 'invalidate',
      reason: 'refreshed',
      entries: [
        { provider: 'uniprot', externalId: 'P0AD86', newVersion: '178' },
        { provider: 'uniprot', externalId: 'P00875', newVersion: '14' },
      ],
    });
    expect(mockedInvalidate).toHaveBeenCalledTimes(1);
    expect(mockedInvalidate).toHaveBeenCalledWith([
      { provider: 'uniprot', externalId: 'P0AD86' },
      { provider: 'uniprot', externalId: 'P00875' },
    ]);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useExternalResourceInvalidationListener());
    unmount();
    dispatchExternalResourceInvalidation({
      event: 'invalidate',
      reason: 'evicted',
      entries: [{ provider: 'uniprot', externalId: 'P0AD86', newVersion: null }],
    });
    expect(mockedInvalidate).not.toHaveBeenCalled();
  });
});
