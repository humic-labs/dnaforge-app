import { inspectAdministrationSettings } from '../../lib/administration-client';
import { isDesktopRuntime } from '../../utils/environment';
import type { AgentPresentationInstructions } from '../../shared/agent-presentation-instructions';

export async function readAgentPresentationPreferences(): Promise<AgentPresentationInstructions> {
  if (!isDesktopRuntime()) return {};
  const snapshot = await inspectAdministrationSettings();
  if (
    snapshot.unsavedKeys.some(
      (key) => key === 'molecularAgentInstructions' || key === 'rememberedAgentPreferences'
    )
  )
    throw new Error('Agent preferences have unsaved changes. Save or retry them in Settings > AI.');
  return {
    molecularAgentInstructions: snapshot.values.molecularAgentInstructions,
    rememberedAgentPreferences: snapshot.values.rememberedAgentPreferences,
  };
}
