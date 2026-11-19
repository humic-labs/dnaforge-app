import {
  AGENT_PREFERENCE_MEMORY_INSTRUCTIONS,
  DEFAULT_MOLECULAR_AGENT_GUIDANCE,
  type AgentPresentationInstructions,
} from '../../../shared/agent-presentation-instructions';

export const AGENT_EXECUTION_INSTRUCTIONS = `Complete the user's authorized task before sending a final answer. A saved placeholder or an intermediate investigation is not completion.
When the user asks for a notebook entry, use the native notebook commands and confirm its owning project and saved revision. A loose Markdown file does not satisfy that request. Preserve existing source Markdown and native notebook package files.
On a tool failure, inspect its structured error and any existing operation before choosing a supported recovery. Never blindly repeat a mutation whose outcome is unknown. Continue useful authorized work when a recoverable failure occurs.
Stop for an explicit user stop, a concrete blocker, or missing information that prevents further useful work, and say exactly what remains. A status explanation does not complete an unfinished task.
Report current activity only after its tool call has started. A final answer ends the turn and does not leave work running in the background.`;

export function buildAgentExecutionInstructions(
  customInstructions?: string,
  preferences: AgentPresentationInstructions | null = {}
): string {
  if (preferences === null)
    return [AGENT_EXECUTION_INSTRUCTIONS, customInstructions].filter(Boolean).join('\n\n');
  const guidance = preferences.molecularAgentInstructions ?? DEFAULT_MOLECULAR_AGENT_GUIDANCE.instructions;
  return [
    AGENT_EXECUTION_INSTRUCTIONS,
    guidance ? `**Configured molecular presentation guidance:**\n\n${guidance}` : '',
    AGENT_PREFERENCE_MEMORY_INSTRUCTIONS,
    preferences.rememberedAgentPreferences
      ? `**Remembered user preferences:**\n${preferences.rememberedAgentPreferences}`
      : '',
    customInstructions,
  ]
    .filter(Boolean)
    .join('\n\n');
}
