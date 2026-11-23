import type { AssistantRouteSelection } from '../assistant-routes';
import { getCustomCliHarnessDefinition } from '../custom-cli-harnesses';
import {
  DEFAULT_CLI_REASONING_EFFORTS,
  type CliModelSettings,
  type CliModelSettingsByTransport,
} from '../settings';

export function captureCliModelSettings(
  route: AssistantRouteSelection,
  settings: CliModelSettingsByTransport | undefined
): CliModelSettings | undefined {
  if (route.kind !== 'cli') return undefined;
  const selected = route.customHarnessId
    ? getCustomCliHarnessDefinition(route.customHarnessId)
    : settings?.[route.transport];
  return {
    model: selected?.model ?? null,
    reasoningEffort: selected
      ? selected.reasoningEffort
      : DEFAULT_CLI_REASONING_EFFORTS[route.transport],
    serviceTier: selected?.serviceTier ?? null,
    personality: selected?.personality ?? null,
  };
}
