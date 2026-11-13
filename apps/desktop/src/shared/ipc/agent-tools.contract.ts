import type {
  RendererAgentBridgeCancelPayload,
  RendererAgentBridgePayload,
  RendererAgentBridgeResourceReadPayload,
} from '../agent-tools-ipc';
import { defineGroup, event } from './contract';

export const agentToolsContract = defineGroup('agentTools', {
  onCall: event<[payload: RendererAgentBridgePayload]>().channel('agent-tools:call'),
  onCancel: event<[payload: RendererAgentBridgeCancelPayload]>().channel('agent-tools:cancel'),
  onReadResource: event<[payload: RendererAgentBridgeResourceReadPayload]>().channel(
    'agent-tools:read-resource'
  ),
});
