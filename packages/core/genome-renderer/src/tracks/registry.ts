import { BUILTIN_TRACK_TYPE_DEFINITIONS } from './builtins';
import type { TrackType, TrackTypeDefinition, TrackTypeRegistry } from './types';

export function createTrackTypeRegistry(): TrackTypeRegistry {
  const byType = new Map<TrackType, TrackTypeDefinition>();
  const insertionOrder: TrackType[] = [];

  function registerTrackType(definition: TrackTypeDefinition): void {
    if (!byType.has(definition.type)) {
      insertionOrder.push(definition.type);
    }
    byType.set(definition.type, definition);
  }

  function getTrackTypeDefinition(type: TrackType): TrackTypeDefinition | undefined {
    return byType.get(type);
  }

  function listTrackTypeDefinitions(): ReadonlyArray<TrackTypeDefinition> {
    const out: TrackTypeDefinition[] = new Array(insertionOrder.length);
    for (let i = 0; i < insertionOrder.length; i++) {
      const def = byType.get(insertionOrder[i]);
      if (def) out[i] = def;
    }
    return out;
  }

  return { registerTrackType, getTrackTypeDefinition, listTrackTypeDefinitions };
}

export function defaultBuiltinRegistry(): TrackTypeRegistry {
  const registry = createTrackTypeRegistry();
  for (const def of BUILTIN_TRACK_TYPE_DEFINITIONS) {
    registry.registerTrackType(def);
  }
  return registry;
}
