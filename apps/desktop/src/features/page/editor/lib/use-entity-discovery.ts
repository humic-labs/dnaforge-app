import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityDiscoveryScope } from '../../../../shared/entity-discovery';
import {
  getRecentlyViewedEntityGroups,
  groupSearchResults,
  searchEntities,
  type Entity,
  type EntityGroup,
  type EntityLinkFilter,
} from './search';

export interface EntityDiscoveryView {
  items: Entity[];
  groups: EntityGroup[];
  status: 'loading' | 'ready' | 'error' | 'refresh-required';
  error: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
}

interface DiscoveryRequest {
  contextKey: string;
  query: string;
  refresh: number;
  recent: boolean;
  enabled: boolean;
}

interface DiscoverySnapshot {
  request: DiscoveryRequest;
  view: EntityDiscoveryView;
}

const INITIAL: EntityDiscoveryView = {
  items: [],
  groups: [],
  status: 'loading',
  error: null,
  nextCursor: null,
  loadingMore: false,
};

export function useEntityDiscovery({
  query,
  filter,
  workspaceRoot,
  scope,
  recent = false,
  enabled = true,
}: {
  query: string;
  filter?: EntityLinkFilter | null;
  workspaceRoot?: string | null;
  scope?: EntityDiscoveryScope;
  recent?: boolean;
  enabled?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<DiscoverySnapshot | null>(null);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const cursorRequest = useRef<string | null>(null);
  const contextKey = JSON.stringify([filter ?? null, scope ?? null, workspaceRoot]);
  const request = useMemo(
    () => ({ contextKey, query, refresh, recent, enabled }),
    [contextKey, query, refresh, recent, enabled]
  );
  const active = useRef({ request, query, filter, workspaceRoot, scope, recent, enabled });
  active.current = { request, query, filter, workspaceRoot, scope, recent, enabled };
  const view: EntityDiscoveryView = !enabled
    ? { ...INITIAL, status: 'ready' }
    : snapshot?.request === request
      ? snapshot.view
      : {
          ...(snapshot?.request.contextKey === contextKey ? snapshot.view : INITIAL),
          status: 'loading',
          error: null,
          nextCursor: null,
          loadingMore: false,
        };

  useEffect(() => {
    const generation = ++epoch.current;
    cursorRequest.current = null;
    const current = active.current;
    if (!current.enabled) return;
    const result = current.recent
      ? getRecentlyViewedEntityGroups(current.query, current.scope).then((groups) => ({
          groups,
          items: groups.flatMap((group) => group.items),
          nextCursor: null,
        }))
      : searchEntities(current.query, current.workspaceRoot, current.filter, {
          scope: current.scope,
        }).then((page) => ({
          groups: groupSearchResults(page, current.query),
          items: page.items,
          nextCursor: page.nextCursor,
        }));
    void result
      .then((page) => {
        if (epoch.current === generation && active.current.request === request)
          setSnapshot({
            request,
            view: { ...page, status: 'ready', error: null, loadingMore: false },
          });
      })
      .catch((error: unknown) => {
        if (epoch.current === generation && active.current.request === request)
          setSnapshot((previous) => ({
            request,
            view: {
              ...(previous?.request.contextKey === request.contextKey ? previous.view : INITIAL),
              status: 'error',
              error: discoveryError(error),
              nextCursor: null,
              loadingMore: false,
            },
          }));
      });
    return () => {
      epoch.current += 1;
    };
  }, [request]);

  const loadMore = useCallback(async () => {
    if (
      active.current.request !== request ||
      !view.nextCursor ||
      view.status !== 'ready' ||
      view.loadingMore ||
      cursorRequest.current
    )
      return;
    const generation = epoch.current;
    const cursor = view.nextCursor;
    cursorRequest.current = cursor;
    setSnapshot((value) =>
      value?.request === request
        ? { ...value, view: { ...value.view, loadingMore: true, error: null } }
        : value
    );
    try {
      const current = active.current;
      const page = await searchEntities(current.query, current.workspaceRoot, current.filter, {
        scope: current.scope,
        cursor,
      });
      if (epoch.current !== generation || active.current.request !== request) return;
      setSnapshot((value) => {
        if (value?.request !== request) return value;
        const ids = new Set(value.view.items.map((item) => item.id));
        const items = [...value.view.items, ...page.items.filter((item) => !ids.has(item.id))];
        return {
          ...value,
          view: {
            ...value.view,
            items,
            groups: groupSearchResults({ items }, current.query),
            nextCursor: page.nextCursor,
            loadingMore: false,
          },
        };
      });
    } catch (error) {
      if (epoch.current !== generation || active.current.request !== request) return;
      const message = discoveryError(error);
      setSnapshot((value) =>
        value?.request === request
          ? {
              ...value,
              view: {
                ...value.view,
                status: message.includes('changed') ? 'refresh-required' : 'error',
                error: message,
                loadingMore: false,
              },
            }
          : value
      );
    } finally {
      if (epoch.current === generation) cursorRequest.current = null;
    }
  }, [request, view.nextCursor, view.status, view.loadingMore]);

  return {
    ...view,
    requestToken: request,
    loadMore,
    retry: () => setRefresh((value) => value + 1),
  };
}

function discoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ENTITY_DISCOVERY_REFRESH_REQUIRED'))
    return 'Entities changed. Refresh the results to continue.';
  if (message.includes('ENTITY_DISCOVERY_CURSOR_INVALID'))
    return 'This search expired. Refresh the results to continue.';
  return 'Could not load entities. Try again.';
}
