import { useLayoutEffect, useRef } from 'react';
import type { JSONContent } from '@tiptap/core';
import { canonicalNotebookJson } from '../../../db/notebook-markdown-codec';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { usePageStore } from '../store';

export function useNotebookCloseRequests({
  pageId,
  tabId,
  owner,
  contentRef,
  saveNow,
  onDiscard,
}: {
  pageId: string;
  tabId?: string;
  owner: { isDestroyed: boolean } | null;
  contentRef: React.MutableRefObject<JSONContent | null>;
  saveNow: () => Promise<boolean>;
  onDiscard: () => void | Promise<void>;
}) {
  const generation = useRef(0);
  useLayoutEffect(
    () => () => {
      generation.current += 1;
    },
    [owner, pageId]
  );
  useDocumentLifecycle(
    owner && !owner.isDestroyed
      ? {
          target: { kind: 'page', pageId },
          tabId,
          isDirty: () => usePageStore.getState().dirtyIds.has(pageId),
          save: async () => {
            if (owner.isDestroyed) return false;
            const captured = generation.current;
            const content = contentRef.current;
            const capturedContent = content === null ? null : canonicalNotebookJson(content);
            const accepted = await saveNow();
            return (
              accepted &&
              !owner.isDestroyed &&
              generation.current === captured &&
              capturedContent !== null &&
              contentRef.current !== null &&
              canonicalNotebookJson(contentRef.current) === capturedContent
            );
          },
          discard: () => {
            if (owner.isDestroyed) throw new Error('The notebook editor is unavailable.');
            generation.current += 1;
            return onDiscard();
          },
        }
      : null
  );
}
