import type { SequenceViewSurface } from '../view-state/sequence-view-state';

export function workspaceViewerOwnsTabCommands(
  surface: SequenceViewSurface,
  commandEntityId: string | undefined,
  tab: { type: string; entityId: string } | undefined
): boolean {
  return Boolean(
    commandEntityId &&
    tab?.entityId === commandEntityId &&
    tab.type === (surface === 'assembly' ? 'design' : 'sequence')
  );
}

export function workspaceViewerEntityKeys(
  entityId: string | undefined,
  sequenceId: string | undefined,
  plasmidName: string | undefined
): {
  tabStateKey: string;
  sequenceViewportScopeKey: string;
  residueSelectionReferenceId: string | null;
  commandEntityId: string | undefined;
  cutSitesScopeKey: string | undefined;
} {
  return {
    tabStateKey: entityId ?? '',
    sequenceViewportScopeKey: entityId ?? sequenceId ?? plasmidName ?? '',
    residueSelectionReferenceId: entityId ?? sequenceId ?? plasmidName ?? null,
    commandEntityId: entityId ?? sequenceId ?? plasmidName,
    cutSitesScopeKey: entityId ?? sequenceId ?? plasmidName,
  };
}
