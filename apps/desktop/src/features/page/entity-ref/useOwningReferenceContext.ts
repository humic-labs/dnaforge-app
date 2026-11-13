import { useEffect, useState, useSyncExternalStore } from 'react';

import { getCurrentCatalogFileForEntity } from '../../../db/workspace-catalog';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { resolveOwningReferenceContext } from './resolve-owning-root';
import {
  getReferenceGeneration,
  startReferenceInvalidationListeners,
  subscribeToReferenceGeneration,
} from './reference-generation';
import type { ReferenceContext } from './reference-context';

export function useOwningReferenceContext(pageId: string): ReferenceContext | null {
  const folders = useWorkspaceStore((state) => state.folders);
  const [resolved, setResolved] = useState<{
    pageId: string;
    context: ReferenceContext | null;
  } | null>(null);

  const generation = useSyncExternalStore(subscribeToReferenceGeneration, getReferenceGeneration);
  useEffect(() => startReferenceInvalidationListeners(), []);

  useEffect(() => {
    let cancelled = false;

    const roots = folders
      .filter((folder) => !folder.pinned)
      .map((folder) => ({ path: folder.path }));

    getCurrentCatalogFileForEntity(pageId)
      .then((file) => {
        if (cancelled) return;
        setResolved({
          pageId,
          context: resolveOwningReferenceContext({
            pageId,
            pageFilePath: file?.path ?? null,
            roots,
          }),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[useOwningReferenceContext] Catalog lookup failed:', error);
        setResolved({
          pageId,
          context: resolveOwningReferenceContext({ pageId, pageFilePath: null, roots }),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [pageId, foldersKey(folders), generation]);

  return resolved?.pageId === pageId ? resolved.context : null;
}

function foldersKey(folders: readonly { path: string; pinned?: boolean }[]): string {
  return folders
    .filter((folder) => !folder.pinned)
    .map((folder) => folder.path)
    .join('\u0000');
}
