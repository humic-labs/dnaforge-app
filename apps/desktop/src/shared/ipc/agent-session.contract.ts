import type {
  AgentAlwaysAllowRuleShape,
  AgentScheduleCancelResultShape,
  AgentScheduleRecordShape,
  AgentSessionCancelResultShape,
  AgentSessionRecordShape,
  AgentSessionRunResultShape,
  AgentSessionStartRequestShape,
  AgentSessionEventEnvelopeShape,
} from '../agent-runtime-ipc';
import type { AgentPermissionCatalog } from '../agent-permissions';
import { defineGroup, invoke, event } from './contract';

export const agentSessionContract = defineGroup('agentSession', {
  start: invoke<[request: AgentSessionStartRequestShape], AgentSessionRunResultShape>(),
  cancel: invoke<[sessionId: string], AgentSessionCancelResultShape>(),
  get: invoke<[sessionId: string], AgentSessionRecordShape | null>(),
  listSchedules: invoke<[], AgentScheduleRecordShape[]>(),
  cancelSchedule: invoke<[scheduleId: string], AgentScheduleCancelResultShape>(),
  listAlwaysAllowRules: invoke<[], AgentAlwaysAllowRuleShape[]>(),
  setAlwaysAllowRuleEnabled: invoke<[key: string, enabled: boolean], AgentAlwaysAllowRuleShape[]>(),
  removeAlwaysAllowRule: invoke<[key: string], AgentAlwaysAllowRuleShape[]>(),
  permissionCatalog: invoke<[], AgentPermissionCatalog>(),
  onEvent: event<[payload: AgentSessionEventEnvelopeShape]>().channel('agentSession:event'),
});
