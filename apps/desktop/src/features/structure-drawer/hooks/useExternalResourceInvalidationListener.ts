import { useEffect } from 'react';
import {
  subscribeToExternalResourceInvalidations,
  type InvalidationPayload,
} from '../api/external-resources-invalidate';
import { invalidateCacheByExternalIds } from './useExternalResourceCache';

export function useExternalResourceInvalidationListener(): void {
  useEffect(() => {
    const handler = (payload: InvalidationPayload) => {
      void invalidateCacheByExternalIds(
        payload.entries.map((e) => ({
          provider: e.provider,
          externalId: e.externalId,
        }))
      );
    };
    return subscribeToExternalResourceInvalidations(handler);
  }, []);
}
