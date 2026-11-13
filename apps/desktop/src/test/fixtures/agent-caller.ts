import type { AgentCaller } from '../../shared/agent-caller';

export const TEST_AGENT_CALLER: AgentCaller = {
  agentIdentityId: 'local-in-app-chat',
  effectiveCapabilities: [
    'read-workspace',
    'edit-primers',
    'edit-assembly',
    'edit-protocols',
    'finalize-protocol',
    'modify-tabs',
    'create-entity',
    'read-sequences',
    'external-fetch:annotation',
    'external-fetch:paper',
  ],
};
