import type { StructureDrawerRequest } from '../types/structure-drawer';

export type ViewStructureByLabelHandler = (
  labelToken: string
) => Promise<{ ok: boolean; reason?: string; request?: StructureDrawerRequest }>;

const handlers = new Map<string, ViewStructureByLabelHandler>();

export function hasViewStructureByLabelHandler(entityId: string): boolean {
  return handlers.has(entityId);
}

export function registerViewStructureByLabelHandler(
  entityId: string,
  handler: ViewStructureByLabelHandler
): () => void {
  handlers.set(entityId, handler);
  return () => {
    if (handlers.get(entityId) === handler) {
      handlers.delete(entityId);
    }
  };
}

export function invokeViewStructureByLabelHandler(
  entityId: string,
  labelToken: string
): Promise<{ ok: boolean; reason?: string; request?: StructureDrawerRequest }> {
  const handler = handlers.get(entityId);
  if (!handler) {
    return Promise.resolve({ ok: false, reason: `no mounted sequence tab for ${entityId}` });
  }
  return handler(labelToken);
}
