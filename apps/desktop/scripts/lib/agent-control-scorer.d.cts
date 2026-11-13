export const agentControlCorpus: {
  scenarios: Array<{
    id: string;
    oracle: Record<string, unknown>;
    green: Record<string, unknown>;
    red: Record<string, unknown>;
  }>;
};
export function scoreAgentControlScenario(
  scenarioId: string,
  observed: Record<string, unknown>
): {
  scenarioId: string;
  passed: boolean;
  failures: Array<{ field: string; reason: string; expected?: unknown; actual?: unknown }>;
};
