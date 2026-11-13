import { useCanvasStore } from '../../canvas/public/store';
import { createStructureDrawerStore } from './use-structure-drawer-store';

const sessions = new Map<string, Map<string, ReturnType<typeof createStructureDrawerStore>>>();
type InspectionSession = ReturnType<typeof createStructureDrawerStore>;
const pinnedViews = new WeakMap<
  InspectionSession,
  {
    referenceId: string;
    structureViewId: string;
    resolved: NonNullable<ReturnType<InspectionSession['getState']>['resolved']>;
    candidateId: string;
  }
>();

export function retainPinnedInspectionView(
  tabId: string,
  proteinKey: string,
  referenceId: string,
  structureViewId: string
): void {
  const session = sessions.get(tabId)?.get(proteinKey);
  const state = session?.getState();
  if (!session || !state?.resolved || !state.committedCandidateId || state.status !== 'ready')
    return;
  pinnedViews.set(session, {
    referenceId,
    structureViewId,
    resolved: state.resolved,
    candidateId: state.committedCandidateId,
  });
}

export function isPinnedInspectionViewLoaded(
  session: InspectionSession,
  referenceId: string | undefined,
  structureViewId: string | undefined
): boolean {
  const pin = pinnedViews.get(session);
  const state = session.getState();
  return (
    !!pin &&
    pin.referenceId === referenceId &&
    pin.structureViewId === structureViewId &&
    pin.resolved === state.resolved &&
    pin.candidateId === state.committedCandidateId &&
    state.status === 'ready'
  );
}

export function getStructureInspectionSession(tabId: string, proteinKey: string) {
  let proteinSessions = sessions.get(tabId);
  if (!proteinSessions) {
    proteinSessions = new Map();
    sessions.set(tabId, proteinSessions);
  }
  let store = proteinSessions.get(proteinKey);
  if (!store) {
    store = createStructureDrawerStore();
    proteinSessions.set(proteinKey, store);
  }
  return store;
}

export function inspectionViewStatus(tabId: string, proteinKey: string) {
  return sessions.get(tabId)?.get(proteinKey)?.getState().status ?? null;
}

const unsubscribe = useCanvasStore.subscribe((state, previous) => {
  if (state.panels === previous.panels || sessions.size === 0) return;
  const retained = new Set(
    Object.values(state.panels).flatMap((panel) =>
      panel.tabs.filter((tab) => tab.structureInspection).map((tab) => tab.id)
    )
  );
  for (const [tabId, proteinSessions] of sessions) {
    if (retained.has(tabId)) continue;
    for (const store of proteinSessions.values()) store.getState().close();
    sessions.delete(tabId);
  }
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe();
    for (const proteinSessions of sessions.values()) {
      for (const store of proteinSessions.values()) store.getState().close();
    }
    sessions.clear();
  });
}
