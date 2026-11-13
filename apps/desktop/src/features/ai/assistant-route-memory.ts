const ASSISTANT_ROUTE_MEMORY_VERSION = 1;

interface AssistantRouteMemoryEnvelope {
  version: typeof ASSISTANT_ROUTE_MEMORY_VERSION;
  selection: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function serializeRememberedAssistantRoute<TSelection>(selection: TSelection): string {
  const envelope: AssistantRouteMemoryEnvelope = {
    version: ASSISTANT_ROUTE_MEMORY_VERSION,
    selection,
  };
  return JSON.stringify(envelope);
}

export function parseRememberedAssistantRoute<TSelection>(
  value: string | null,
  restoreSelection: (candidate: unknown) => TSelection | null
): TSelection | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;

    const looksLikeEnvelope = 'version' in parsed || 'selection' in parsed;
    if (!looksLikeEnvelope) {
      return restoreSelection(parsed);
    }

    if (
      parsed.version !== ASSISTANT_ROUTE_MEMORY_VERSION ||
      !Object.prototype.hasOwnProperty.call(parsed, 'selection') ||
      parsed.selection === null
    ) {
      return null;
    }
    return restoreSelection(parsed.selection);
  } catch {
    return null;
  }
}
