import { useCanvasStore } from '../../canvas/public/store';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import { hasActiveMolstarViewerHost } from '../../page/public/embeds/structure3d/molstar/cache';

export interface RegisteredStructureVisibilityCandidate {
  registrationId: string;
  structureId: string;
  structureViewId: string;
  bindingId: string | null;
  interactionKey: string;
  viewerId: string;
  entry: ReturnType<typeof useStructure3dStore.getState>['expandedStructures'][string];
}

export function isRegisteredStructureAgentVisible(
  candidate: RegisteredStructureVisibilityCandidate
): boolean {
  const targetIds = new Set(
    [
      candidate.registrationId,
      candidate.structureId,
      candidate.structureViewId,
      candidate.bindingId,
      candidate.viewerId,
    ].filter((value): value is string => Boolean(value))
  );
  const tabs = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .filter((tab) => tab.type === 'structure');
  const hasOpenTab = tabs.some(
    (tab) =>
      targetIds.has(tab.entityId) ||
      tab.initialStructureAttrs?.structureViewIdentity?.structureViewId ===
        candidate.structureViewId
  );
  if (hasOpenTab) return true;
  const ownerId = candidate.entry.data.structureLinkOwnerId;
  const inspectionTab = tabs.find(
    (tab) => tab.structureInspection && ownerId?.endsWith(`\u0000${tab.id}`)
  );
  if (inspectionTab)
    return (
      inspectionTab.structureInspection?.viewSettings?.structureViewId === candidate.structureViewId
    );
  return hasActiveMolstarViewerHost(candidate.viewerId, candidate.registrationId);
}
