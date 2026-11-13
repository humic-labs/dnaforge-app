import type { AgentFeedbackInput, AgentFeedbackResult } from '../agent-feedback';
import { defineGroup, invoke } from './contract';

export const agentFeedbackContract = defineGroup('feedback', {
  report: invoke<[input: AgentFeedbackInput], AgentFeedbackResult>(),
});
