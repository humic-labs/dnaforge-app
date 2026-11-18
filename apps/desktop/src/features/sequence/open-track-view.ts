import { withUserMessage } from '@waypoint/user-messages';
import type { IndexedGenomeTabState } from '../../shared/indexed-genome';
import type { SavedTrackView, TrackViewDocument } from '../../shared/track-view';
import { useCanvasStore } from '../canvas/public/store';
import { platform } from '../../platform';
import { openAssembly } from './openAssembly';
import { projectSavedTrackView } from './track-view-library';
import { recoverScenarioTrackView } from './recover-scenario-track-view';
import type { OpenStrategy } from '../canvas/public/document-presentation';
import {
  referenceViewCompatibility,
  savedReferenceContentIdentity,
  reconcileReferenceAnnotationTracks,
  restoredReferenceAnnotationVisibility,
} from './reference-view-compatibility';

interface OpenTrackViewOptions {
  signal?: AbortSignal;
  placement?: OpenStrategy;
  intoTabId?: string;
  commitGuard?: () => boolean;
}

function assertCurrentRequest(options: OpenTrackViewOptions): void {
  if (options.signal?.aborted || options.commitGuard?.() === false)
    throw new Error('The opening request was cancelled.');
}

export function trackViewReference(state: IndexedGenomeTabState): TrackViewDocument['reference'] {
  const assembly = state.assembly;
  if (!assembly) throw new Error('A Track view must be built against a reference assembly.');
  return {
    assemblyId: assembly.assemblyId,
    name: assembly.displayName,
    chromosomes: assembly.chromosomes.map(({ chrom, length }) => ({ chrom, length })),
    sourceFingerprint: state.assemblyAssetGeneration?.sourceFingerprint ?? null,
    inventoryFingerprint: state.assemblyAssetGeneration?.inventoryFingerprint ?? null,
    bundleFingerprint: state.assemblyPortableBundleFingerprint ?? null,
    ...state.assemblyReferenceIdentity,
  };
}

export function assertTrackViewReference(
  document: TrackViewDocument,
  state: IndexedGenomeTabState
): void {
  const current = trackViewReference(state);
  const saved = document.reference;
  const savedIdentity = savedReferenceContentIdentity(saved, state.assemblyReferenceVersionHistory);
  const contentIdentity = state.assemblyReferenceIdentity;
  if (
    savedIdentity &&
    contentIdentity &&
    saved.assemblyId === current.assemblyId &&
    JSON.stringify(saved.chromosomes) === JSON.stringify(current.chromosomes)
  ) {
    const compatibility = referenceViewCompatibility(savedIdentity, contentIdentity);
    if (compatibility.compatible) {
      if (compatibility.annotationsUpdated) {
        state.referenceAnnotationUpdateNotice = reconcileReferenceAnnotationTracks(
          document.annotation,
          state.assemblyAnnotationTrackTypes ?? []
        ).notice;
      }
      return;
    }
    throw withUserMessage(
      new Error(
        'This reference sequence has changed since the Track view was saved. The saved view has not been opened or changed.'
      ),
      'reference.sequenceChanged'
    );
  }
  if (
    saved.assemblyId !== current.assemblyId ||
    JSON.stringify(saved.chromosomes) !== JSON.stringify(current.chromosomes) ||
    (saved.sourceFingerprint && saved.sourceFingerprint !== current.sourceFingerprint) ||
    (saved.inventoryFingerprint && saved.inventoryFingerprint !== current.inventoryFingerprint) ||
    (saved.bundleFingerprint && saved.bundleFingerprint !== current.bundleFingerprint)
  ) {
    throw new Error(
      'This reference has changed since the Track view was saved. The saved view has not been opened or changed.'
    );
  }
}

export async function openTrackView(
  id: string,
  options: OpenTrackViewOptions = {}
): Promise<string> {
  assertCurrentRequest(options);
  const existing = Object.entries(useCanvasStore.getState().panels)
    .flatMap(([panelId, panel]) => panel.tabs.map((tab) => ({ panelId, tab })))
    .find(({ tab }) => tab.entityId === id || tab.trackView?.path === id);
  if (existing) {
    useCanvasStore.getState().setActiveTab(existing.panelId, existing.tab.id);
    useCanvasStore.getState().focusPanel(existing.panelId);
    return existing.tab.id;
  }
  const saved = await platform().trackViews.read(id);
  assertCurrentRequest(options);
  const mounted = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) => tab.entityId === saved.document.id);
  if (mounted) return openTrackView(saved.document.id, options);
  return openSavedTrackView(saved, options);
}

export async function openSavedTrackView(
  saved: SavedTrackView,
  options: OpenTrackViewOptions
): Promise<string> {
  assertCurrentRequest(options);
  saved = await recoverScenarioTrackView(saved, options.signal);
  assertCurrentRequest(options);
  const document = saved.document;
  const referenceId = document.reference.assemblyId;
  const hosted = (await platform().referenceAssets.listHosted()).find(
    (entry) => entry.id === referenceId
  );
  assertCurrentRequest(options);
  let entry = hosted
    ? (
        await platform().referenceAssets.installHosted({
          catalogId: referenceId,
          themeMode: 'light',
          intent: 'open-view',
        })
      ).entry
    : (await platform().referenceAssets.listLocal()).find((entry) => entry.id === referenceId);
  if (hosted && entry && !Object.keys(entry.portableView?.assetGenerationsByTheme ?? {}).length) {
    entry = (
      await platform().referenceAssets.installHosted({
        catalogId: referenceId,
        themeMode: 'light',
        intent: 'require-ready',
      })
    ).entry;
  }
  assertCurrentRequest(options);
  if (!entry)
    throw new Error(
      `The reference for ${document.name} is unavailable. Add the same reference again to reopen this view.`
    );
  const savedIdentity = savedReferenceContentIdentity(
    document.reference,
    entry.referenceVersionHistory
  );
  const annotationsUpdated =
    savedIdentity &&
    entry.referenceIdentity &&
    referenceViewCompatibility(savedIdentity, entry.referenceIdentity).annotationsUpdated;
  const annotation =
    annotationsUpdated && entry.portableView
      ? {
          ...document.annotation,
          ...reconcileReferenceAnnotationTracks(document.annotation, entry.portableView.trackTypes),
        }
      : document.annotation;
  const tabId = await openAssembly(entry, {
    placement: options.placement,
    intoTabId: options.intoTabId,
    commitGuard: () => !options.signal?.aborted && options.commitGuard?.() !== false,
    viewEntity: { id: document.id, name: document.name },
    initialAnnotationMapperPolicy: document.annotation.policy,
    validateReference: (state) => assertTrackViewReference(document, state),
    restoreView: {
      scope: document.scope,
      dataTracks: document.dataTracks,
      bamTracks: document.bamTracks,
      signalReadPileupViews: document.signalReadPileupViews ?? [],
      variantSource: document.variantSource,
      primerBindings: document.primerBindings,
      userAnnotations: document.userAnnotations,
      annotationTrackTypes: annotation.orderedTrackIds,
      indexedViewport: document.viewport,
      command: {
        id: crypto.randomUUID(),
        viewport: { kind: 'assembly-range', ...document.viewport },
        annotationPolicy: document.annotation.policy,
        orderedAnnotationTrackIds: [...annotation.orderedTrackIds],
        visibleAnnotationTrackIds: restoredReferenceAnnotationVisibility(
          annotation.visibilityByTrackId,
          annotation.orderedTrackIds
        ),
      },
    },
  });
  if (!tabId)
    throw withUserMessage(
      new Error('The reference could not be opened.'),
      'notice.the-reference-could-not-be-opened'
    );
  for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
    if (panel.tabs.some((tab) => tab.id === tabId)) {
      useCanvasStore.getState().updateTab(panelId, tabId, { trackView: saved, isDirty: false });
      break;
    }
  }
  await projectSavedTrackView(saved).catch(() => undefined);
  return tabId;
}
