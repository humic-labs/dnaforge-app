import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DBEntityReference } from '../../db/entity-references';
import { useChatStore } from '../../features/ai/hooks/useChat';
import type { AttachedFile } from './FilePill';

export { useComposerSequencePaste } from '../../features/ai/paste-copied-sequence';

interface ConversationComposerDraftOptions {
  conversationId: string | null;
  text: string;
  attachments: AttachedFile[];
  references: DBEntityReference[];
  setText: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<AttachedFile[]>>;
  setReferences: Dispatch<SetStateAction<DBEntityReference[]>>;
}

export function useConversationComposerDraft({
  conversationId,
  text,
  attachments,
  references,
  setText,
  setAttachments,
  setReferences,
}: ConversationComposerDraftOptions): void {
  const setComposerDraft = useChatStore((state) => state.setComposerDraft);
  const restoringRef = useRef(false);

  useLayoutEffect(() => {
    if (!conversationId) return;
    restoringRef.current = true;
    const savedDraft = useChatStore.getState().composerDrafts.get(conversationId);
    setText(savedDraft?.text ?? '');
    setAttachments(savedDraft?.attachments ?? []);
    setReferences(savedDraft?.references ?? []);
  }, [conversationId, setAttachments, setReferences, setText]);

  useEffect(() => {
    if (!conversationId) return;
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    setComposerDraft(conversationId, {
      text,
      attachments,
      references,
    });
  }, [attachments, conversationId, references, setComposerDraft, text]);
}
