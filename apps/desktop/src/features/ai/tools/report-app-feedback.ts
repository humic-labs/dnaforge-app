import { platform } from '../../../platform';
import { agentFeedbackSchema } from '../../../shared/agent-feedback';
import { resultTool } from '../../agent-bridge/public/tool-result';

export { agentFeedbackSchema };
export const REPORT_APP_FEEDBACK_DESCRIPTION =
  'Report an observed DNAForge app bug or product feedback to the DNAForge team, including problems with no telemetry event. ' +
  'Use kind=bug with expected and actual behavior and useful reproduction steps; distinguish a suspected cause from observations. ' +
  'Keep the complete report within 2000 characters. Include only relevant evidence, never credentials, private project contents, full conversations, or unrelated logs. ' +
  'App version and platform are added automatically; no open workspace is required. ' +
  'Supply a new observationId UUID for each distinct observation, and reuse it with unchanged evidence on retries. ' +
  'Only a submitted result confirms delivery. Preserve the returned report ID; on a retryable failure retry the same evidence after any retry delay, rather than repeatedly reporting or abandoning the user task.';

export function createReportAppFeedbackTool() {
  return resultTool({
    description: REPORT_APP_FEEDBACK_DESCRIPTION,
    inputSchema: agentFeedbackSchema,
    execute: async (input) => platform().feedback.report(input),
  });
}
