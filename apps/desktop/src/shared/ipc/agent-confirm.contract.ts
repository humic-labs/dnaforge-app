import type {
  AgentUserInputCancel,
  AgentUserInputRequest,
  DestructiveFileConfirmCancel,
  DestructiveFileConfirmRequest,
} from '../agent-confirm-types';
import { defineGroup, event } from './contract';

export const agentConfirmContract = defineGroup('agentConfirm', {
  onRequest: event<[payload: DestructiveFileConfirmRequest]>().channel(
    'agent:confirm-destructive-file'
  ),
  onUserInputRequest: event<[payload: AgentUserInputRequest]>().channel('agent:user-input'),
  onCancel: event<[payload: DestructiveFileConfirmCancel]>()
    .projected((payload) => payload.requestId)
    .channel('agent:confirm-destructive-file:cancel'),
  onUserInputCancel: event<[payload: AgentUserInputCancel]>()
    .projected((payload) => payload.requestId)
    .channel('agent:user-input:cancel'),
});
