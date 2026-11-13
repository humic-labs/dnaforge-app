import type {
  AgentCliModelCapabilityShape,
  AgentCliModelCatalogDiscoveryShape,
  AgentCliModelCatalogSource,
} from '../../shared/agent-runtime-ipc';

export interface CapturedModelCatalogDiscovery {
  models: AgentCliModelCapabilityShape[];
  modelCatalog: AgentCliModelCatalogDiscoveryShape;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || 'Unknown model discovery failure.').slice(0, 500);
}

export async function captureModelCatalogDiscovery(input: {
  source: AgentCliModelCatalogSource;
  executablePath: string | null;
  eligible: boolean;
  probe: () => Promise<AgentCliModelCapabilityShape[]>;
}): Promise<CapturedModelCatalogDiscovery> {
  const base = {
    source: input.source,
    executablePath: input.executablePath,
  } as const;
  if (!input.eligible) {
    return {
      models: [],
      modelCatalog: {
        ...base,
        status: 'not_attempted',
        observedModelCount: 0,
        error: null,
      },
    };
  }

  try {
    const models = await input.probe();
    if (models.length === 0) {
      throw new Error(`${input.source} advertised no models.`);
    }
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.id)) {
        throw new Error(`${input.source} advertised duplicate model id “${model.id}”.`);
      }
      seen.add(model.id);
    }
    return {
      models,
      modelCatalog: {
        ...base,
        status: 'complete',
        observedModelCount: models.length,
        error: null,
      },
    };
  } catch (error) {
    return {
      models: [],
      modelCatalog: {
        ...base,
        status: 'failed',
        observedModelCount: 0,
        error: errorMessage(error),
      },
    };
  }
}
