import { useEffect, useRef } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';

export function useNotebookEditorHydration({
  editor,
  content,
  blocked,
  canApply,
  onHydrated,
}: {
  editor: Editor | null;
  content: JSONContent | undefined;
  blocked: boolean;
  canApply: () => boolean;
  onHydrated: () => void;
}) {
  const current = useRef({ canApply, onHydrated });
  current.current = { canApply, onHydrated };
  useEffect(() => {
    if (!editor || !content || editor.isDestroyed || blocked) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || editor.isDestroyed || !current.current.canApply()) return;
      if (JSON.stringify(editor.getJSON()) === JSON.stringify(content)) return;
      editor.commands.setContent(content, { emitUpdate: false });
      current.current.onHydrated();
    });
    return () => {
      cancelled = true;
    };
  }, [editor, content, blocked]);
}
