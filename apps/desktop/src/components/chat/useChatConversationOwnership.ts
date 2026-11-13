import { useEffect, useRef } from 'react';

interface ChatConversationOwnershipOptions {
  scoped: boolean;
  isOpen: boolean;
  conversationId: string | null | undefined;
  currentConversationId: string | null;
  conversationIsKnown: boolean;
  conversationHasState: boolean;
  switchConversation: (conversationId: string) => unknown;
  hydrateConversation: (conversationId: string) => unknown;
}

export function useChatConversationOwnership({
  scoped,
  isOpen,
  conversationId,
  currentConversationId,
  conversationIsKnown,
  conversationHasState,
  switchConversation,
  hydrateConversation,
}: ChatConversationOwnershipOptions): void {
  const claimedBindingRef = useRef<string | null>(null);

  useEffect(() => {
    if (scoped || !isOpen) {
      claimedBindingRef.current = null;
      return;
    }
    if (!conversationId || !conversationIsKnown) return;

    if (conversationId === currentConversationId) {
      claimedBindingRef.current = conversationId;
      if (!conversationHasState) {
        void hydrateConversation(conversationId);
      }
      return;
    }
    if (claimedBindingRef.current === conversationId && conversationHasState) return;

    claimedBindingRef.current = conversationId;
    void switchConversation(conversationId);
  }, [
    scoped,
    isOpen,
    conversationId,
    currentConversationId,
    conversationIsKnown,
    conversationHasState,
    switchConversation,
    hydrateConversation,
  ]);

  useEffect(() => {
    if (conversationId && (scoped || !isOpen)) {
      void hydrateConversation(conversationId);
    }
  }, [scoped, isOpen, conversationId, hydrateConversation]);
}
