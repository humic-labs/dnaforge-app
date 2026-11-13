import type { AgentAuthEnvelopeShape, AgentTraceEnvelopeShape } from '../agent-runtime-ipc';
import { defineGroup, event } from './contract';

export const agentSdkContract = defineGroup('agentSdk', {
  onTraceEvent: event<[payload: AgentTraceEnvelopeShape]>().channel('agentSdk:traceEvent'),
  onAuthEvent: event<[payload: AgentAuthEnvelopeShape]>().channel('agentSdk:authEvent'),
});
