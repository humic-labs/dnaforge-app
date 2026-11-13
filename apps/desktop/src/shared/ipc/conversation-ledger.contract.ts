import type {
  ConversationLedgerAppendInputShape,
  ConversationLedgerAppendResultShape,
  ConversationLedgerUnlinkResultShape,
} from '../conversation-ledger-ipc';
import { defineGroup, invoke } from './contract';

export const conversationLedgerContract = defineGroup('conversationLedger', {
  appendEvent: invoke<
    [input: ConversationLedgerAppendInputShape],
    ConversationLedgerAppendResultShape
  >(),
  unlinkConversation: invoke<[conversationId: string], ConversationLedgerUnlinkResultShape>(),
});
