import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useCanvasStore } from '../../canvas/public/store';
import { useTabViewState } from '../../canvas/public/hooks/useTabViewState';
import type { TabViewState } from '../../canvas/public/types';
import {
  applicableViewStatePatch,
  modelPatchToTabViewState,
  mergeSequenceViewStatePatch,
  readSequenceViewMemory,
  resolveSeededViewState,
  sequenceViewPatchMissingFrom,
  tabViewStateToModelPatch,
  writeSequenceViewMemory,
  type SequenceViewContext,
  type SequenceViewState,
  type SequenceViewStatePatch,
} from './sequence-view-state';

const PERSIST_DEBOUNCE_MS = 120;

export interface SequenceViewStatePatchOptions {
  debounce?: boolean;
  debounceMs?: number;
}

export type SequenceViewStatePatchFn = (
  patch: SequenceViewStatePatch,
  opts?: SequenceViewStatePatchOptions
) => void;

function readModelPatchForDocument(documentId: string): SequenceViewStatePatch {
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    const tab = panel.tabs.find((t) => t.entityId === documentId);
    if (tab) return tabViewStateToModelPatch(tab.viewState as TabViewState | undefined);
  }
  return {};
}

function hasLiveTabForDocument(documentId: string): boolean {
  return Object.values(useCanvasStore.getState().panels).some((panel) =>
    panel.tabs.some((tab) => tab.entityId === documentId)
  );
}

export function useSequenceViewState(
  documentId: string,
  context?: SequenceViewContext
): readonly [SequenceViewState, SequenceViewStatePatchFn] {
  const [tabViewState, setTabViewState] = useTabViewState(documentId);

  const circular = context?.circular;
  const surface = context?.surface;
  const capabilityCtx = useMemo<SequenceViewContext | undefined>(
    () => (circular === undefined ? undefined : { circular, surface }),
    [circular, surface]
  );
  const capabilityCtxRef = useRef(capabilityCtx);
  capabilityCtxRef.current = capabilityCtx;
  const gate = (patch: SequenceViewStatePatch, ctx = capabilityCtxRef.current) =>
    ctx ? applicableViewStatePatch(patch, ctx) : patch;

  const seedRef = useRef<{ documentId: string; memory: SequenceViewStatePatch }>({
    documentId,
    memory: readSequenceViewMemory(documentId),
  });
  if (seedRef.current.documentId !== documentId) {
    seedRef.current = { documentId, memory: readSequenceViewMemory(documentId) };
  }

  const tabPatch = useMemo(() => tabViewStateToModelPatch(tabViewState), [tabViewState]);
  const viewState = useMemo(
    () =>
      resolveSeededViewState({
        memory: gate(seedRef.current.memory, capabilityCtx),
        tab: gate(tabPatch, capabilityCtx),
        circular: capabilityCtx?.circular,
        surface,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabPatch, documentId, capabilityCtx, surface]
  );

  const setTabViewStateRef = useRef(setTabViewState);
  setTabViewStateRef.current = setTabViewState;
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;

  const pendingTabRef = useRef<SequenceViewStatePatch>({});
  const pendingMemoryRef = useRef<SequenceViewStatePatch>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const tabPending = pendingTabRef.current;
    if (Object.keys(tabPending).length > 0) {
      pendingTabRef.current = {};
      if (hasLiveTabForDocument(documentIdRef.current)) {
        setTabViewStateRef.current(modelPatchToTabViewState(tabPending));
      }
    }
    const memoryPending = pendingMemoryRef.current;
    if (Object.keys(memoryPending).length > 0) {
      pendingMemoryRef.current = {};
      writeSequenceViewMemory(documentIdRef.current, memoryPending);
    }
  }, []);

  const schedule = useCallback(
    (delayMs = PERSIST_DEBOUNCE_MS) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, delayMs);
    },
    [flush]
  );

  const patch = useCallback<SequenceViewStatePatchFn>(
    (incoming, opts) => {
      const gated = gate(incoming);
      if (Object.keys(gated).length === 0) return;
      pendingMemoryRef.current = mergeSequenceViewStatePatch(pendingMemoryRef.current, gated);
      if (opts?.debounce) {
        pendingTabRef.current = mergeSequenceViewStatePatch(pendingTabRef.current, gated);
        schedule(opts.debounceMs);
      } else {
        const immediate = mergeSequenceViewStatePatch(pendingTabRef.current, gated);
        pendingTabRef.current = {};
        setTabViewStateRef.current(modelPatchToTabViewState(immediate));
        schedule();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedule]
  );

  useEffect(() => {
    if (
      surface === 'sequence' &&
      tabPatch.canvasMode !== '2d' &&
      (tabPatch.canvasMode === 'tracks' || seedRef.current.memory.canvasMode === 'tracks')
    ) {
      patch({ canvasMode: '2d' });
    }
  }, [documentId, surface, tabPatch.canvasMode, patch]);

  useEffect(() => {
    const memory = gate(seedRef.current.memory);
    if (Object.keys(memory).length === 0) return;
    const toSeed = sequenceViewPatchMissingFrom(memory, readModelPatchForDocument(documentId));
    if (Object.keys(toSeed).length > 0) {
      setTabViewStateRef.current(modelPatchToTabViewState(toSeed));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, capabilityCtx]);

  useEffect(() => {
    return () => flush();
  }, [flush, documentId]);

  return [viewState, patch] as const;
}
