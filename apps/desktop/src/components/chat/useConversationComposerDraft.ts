import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DBEntityReference } from '../../db/entity-references';
import { useChatStore } from '../../features/ai/hooks/useChat';
import type { ChatMessage } from '../../features/ai/orchestration/chat-types';
import type { AttachedFile } from './FilePill';

export { useComposerSequencePaste } from '../../features/ai/paste-copied-sequence';

interface ConversationComposerDraftOptions {
  refusedMessage?: ChatMessage | null;
  refusedReferenceIds?: string[];
  referenceMap?: ReadonlyMap<string, DBEntityReference>;
  composerBusy?: boolean;
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
  refusedMessage,
  refusedReferenceIds,
  referenceMap,
  composerBusy,
  text,
  attachments,
  references,
  setText,
  setAttachments,
  setReferences,
}: ConversationComposerDraftOptions): void {
  const setComposerDraft = useChatStore((state) => state.setComposerDraft);
  const restoringRef = useRef(false);
  const handledRefusal = useRef<string | null>(null);

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

  useEffect(() => {
    if (!conversationId || !refusedMessage || handledRefusal.current === refusedMessage.id) return;
    if (composerBusy) return;
    if (
      text ||
      attachments.length ||
      references.length ||
      useChatStore.getState().composerDrafts.has(conversationId)
    ) {
      handledRefusal.current = refusedMessage.id;
      return;
    }
    if (!refusedReferenceIds || !referenceMap) return;
    const restored: DBEntityReference[] = [];
    for (const id of refusedReferenceIds) {
      const reference = referenceMap.get(id);
      if (!reference) return;
      restored.push(reference);
    }
    handledRefusal.current = refusedMessage.id;
    const draft = {
      text: refusedMessage.content,
      attachments: refusedMessage.attachments ?? [],
      references: restored,
    };
    setComposerDraft(conversationId, draft);
    setText(draft.text);
    setAttachments(draft.attachments);
    setReferences(draft.references);
  }, [
    attachments,
    composerBusy,
    conversationId,
    referenceMap,
    references,
    refusedMessage,
    refusedReferenceIds,
    setAttachments,
    setComposerDraft,
    setReferences,
    setText,
    text,
  ]);
}
