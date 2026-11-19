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
  readRevision,
  saveNow,
  onDiscard,
}: {
  pageId: string;
  tabId?: string;
  owner: { isDestroyed: boolean } | null;
  contentRef: React.MutableRefObject<JSONContent | null>;
  readRevision?: () => number;
  saveNow: () => Promise<boolean>;
  onDiscard: () => void | Promise<void>;
}) {
  const cached = useRef<{ content: JSONContent | null; canonical: string }>({
    content: null,
    canonical: '',
  });
  const contentRevision = () => {
    if (readRevision) return readRevision();
    const content = contentRef.current;
    if (content !== cached.current.content) {
      cached.current = { content, canonical: content ? canonicalNotebookJson(content) : '' };
    }
    return cached.current.canonical;
  };
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
          readRevision: contentRevision,
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
