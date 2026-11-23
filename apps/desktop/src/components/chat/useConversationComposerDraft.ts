import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DBEntityReference } from '../../db/entity-references';
import { readChatComposerDraft } from '../../db/chat-composer-draft';
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
  const readVersion = useRef(0);

  useLayoutEffect(() => {
    if (!conversationId) return;
    restoringRef.current = true;
    const version = ++readVersion.current;
    const savedDraft = useChatStore.getState().composerDrafts.get(conversationId);
    setText(savedDraft?.text ?? '');
    setAttachments(savedDraft?.attachments ?? []);
    setReferences(savedDraft?.references ?? []);
    if (!savedDraft) {
      void readChatComposerDraft(conversationId)
        .then((draft) => {
          if (
            !draft ||
            readVersion.current !== version ||
            useChatStore.getState().composerDrafts.has(conversationId)
          )
            return;
          setText(draft.text);
          setAttachments(draft.attachments);
          setReferences(draft.references);
        })
        .catch((error) => console.warn('[Chat] Could not read the composer draft:', error));
    }
    return () => {
      readVersion.current++;
    };
  }, [conversationId, setAttachments, setReferences, setText]);

  useEffect(() => {
    if (!conversationId) return;
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    if (text || attachments.length || references.length) readVersion.current++;
    setComposerDraft(conversationId, {
      text,
      attachments,
      references,
    });
  }, [attachments, conversationId, references, setComposerDraft, text]);
}
