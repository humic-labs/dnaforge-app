import {
  ANNOTATION_EVIDENCE_LABELS,
  FEATURE_KINDS,
  FEATURE_KIND_LABELS,
  applyAnnotationTrackCommand,
  parseAnnotationTrackLayout,
  validateAnnotationTrackLayout,
  type AnnotationEvidenceClass,
  type AnnotationTrackBinding,
  type AnnotationTrackCommand,
  type AnnotationTrackLayout,
  type FeatureKind,
  type LayoutIssue,
  type SourceAvailability,
  type SourceId,
  type VisualizationId,
} from '@waypoint/genome-data/annotation-catalog';

import { useCanvasStore } from '../../canvas/public/store';
import type { Tab } from '../../canvas/public/types';
import {
  modelPatchToTabViewState,
  readSequenceViewMemory,
  resolveSeededViewState,
  tabViewStateToModelPatch,
  writeSequenceViewMemory,
} from '../view-state/sequence-view-state';
import {
  readAnnotationCatalogWiring,
  subscribeAnnotationCatalogWiring,
  type AnnotationCatalogDrawingPhase,
} from './annotation-catalog-wiring-status';
import {
  annotationCatalogForAccession,
  type AnnotationCatalogForAssembly,
} from './annotation-catalog-registry';

export type SequenceAnnotationTracksCommand =
  | AnnotationTrackCommand
  | { readonly kind: 'set-layout'; readonly layout: unknown }
  | { readonly kind: 'clear-layout' };

export interface SequenceAnnotationTracksIssue {
  readonly trackId: string | null;
  readonly code: LayoutIssue['code'] | 'no-layout' | 'invalid-layout' | 'unknown-assembly';
  readonly message: string;
}

export type UpdateSequenceAnnotationTracksResult =
  | { readonly status: 'updated'; readonly layout: AnnotationTrackLayout | null }
  | { readonly status: 'missing' }
  | {
      readonly status: 'invalid';
      readonly issues: readonly [SequenceAnnotationTracksIssue, ...SequenceAnnotationTracksIssue[]];
    };

interface OwnedSequenceTab {
  readonly panelId: string;
  readonly tab: Tab;
}

function findSequenceTab(ownerTabId: string): OwnedSequenceTab | null {
  for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
    const tab = panel.tabs.find((candidate) => candidate.id === ownerTabId);
    if (tab) return tab.type === 'sequence' ? { panelId, tab } : null;
  }
  return null;
}

function currentLayout(tab: Tab): AnnotationTrackLayout | null {
  const resolved = resolveSeededViewState({
    memory: readSequenceViewMemory(tab.entityId),
    tab: tabViewStateToModelPatch(tab.viewState),
  });
  return resolved.annotationCatalogLayout ?? null;
}

function invalid(
  first: SequenceAnnotationTracksIssue,
  ...rest: SequenceAnnotationTracksIssue[]
): UpdateSequenceAnnotationTracksResult {
  return { status: 'invalid', issues: [first, ...rest] };
}

function nextLayoutFor(
  layout: AnnotationTrackLayout | null,
  command: SequenceAnnotationTracksCommand
):
  | { readonly ok: true; readonly layout: AnnotationTrackLayout | null }
  | { readonly ok: false; readonly result: UpdateSequenceAnnotationTracksResult } {
  if (command.kind === 'clear-layout') return { ok: true, layout: null };

  if (command.kind === 'set-layout') {
    const parsed = parseAnnotationTrackLayout(command.layout);
    if (!parsed.ok) {
      return {
        ok: false,
        result: invalid({ trackId: null, code: 'invalid-layout', message: parsed.error }),
      };
    }
    const catalog = annotationCatalogForAccession(parsed.layout.assembly);
    if (!catalog) {
      return {
        ok: false,
        result: invalid({
          trackId: null,
          code: 'unknown-assembly',
          message: `No annotation sources are available for ${parsed.layout.assembly}`,
        }),
      };
    }
    const [first, ...rest] = validateAnnotationTrackLayout({ ...catalog, layout: parsed.layout });
    return first
      ? { ok: false, result: invalid(first, ...rest) }
      : { ok: true, layout: parsed.layout };
  }

  if (!layout) {
    return {
      ok: false,
      result: invalid({
        trackId: null,
        code: 'no-layout',
        message: 'This tab has no annotation tracks yet. Set a layout first.',
      }),
    };
  }
  const catalog = annotationCatalogForAccession(layout.assembly);
  if (!catalog) {
    return {
      ok: false,
      result: invalid({
        trackId: null,
        code: 'unknown-assembly',
        message: `No annotation sources are available for ${layout.assembly}`,
      }),
    };
  }
  const applied = applyAnnotationTrackCommand({ ...catalog, layout, command });
  return applied.ok
    ? { ok: true, layout: applied.layout }
    : { ok: false, result: invalid(...applied.issues) };
}

export function updateSequenceAnnotationTracks(input: {
  readonly ownerTabId: string;
  readonly command: SequenceAnnotationTracksCommand;
}): UpdateSequenceAnnotationTracksResult {
  const owned = findSequenceTab(input.ownerTabId);
  if (!owned) return { status: 'missing' };
  const next = nextLayoutFor(currentLayout(owned.tab), input.command);
  if (!next.ok) return next.result;
  const patch = { annotationCatalogLayout: next.layout };
  useCanvasStore
    .getState()
    .setTabViewState(owned.panelId, owned.tab.id, modelPatchToTabViewState(patch));
  writeSequenceViewMemory(owned.tab.entityId, patch);
  return { status: 'updated', layout: next.layout };
}

interface InspectedTabFields {
  readonly found: boolean;
  readonly type: Tab['type'] | null;
  readonly entityId: string | null;
  readonly layout: unknown;
}

function inspectedTabFields(
  panels: ReturnType<typeof useCanvasStore.getState>['panels'],
  ownerTabId: string
): InspectedTabFields {
  for (const panel of Object.values(panels)) {
    const tab = panel.tabs.find((candidate) => candidate.id === ownerTabId);
    if (tab) {
      return {
        found: true,
        type: tab.type,
        entityId: tab.entityId,
        layout: tab.viewState?.sequenceAnnotationCatalogLayout,
      };
    }
  }
  return { found: false, type: null, entityId: null, layout: undefined };
}

function sameTabFields(a: InspectedTabFields, b: InspectedTabFields): boolean {
  return (
    a.found === b.found && a.type === b.type && a.entityId === b.entityId && a.layout === b.layout
  );
}

export function subscribeSequenceAnnotationTracks(
  ownerTabId: string,
  listener: () => void
): () => void {
  let fields = inspectedTabFields(useCanvasStore.getState().panels, ownerTabId);
  let wiring = readAnnotationCatalogWiring(ownerTabId);
  const stopCanvas = useCanvasStore.subscribe((state, previous) => {
    if (state.panels === previous.panels) return;
    const next = inspectedTabFields(state.panels, ownerTabId);
    if (sameTabFields(fields, next)) return;
    fields = next;
    listener();
  });
  const stopWiring = subscribeAnnotationCatalogWiring(() => {
    const next = readAnnotationCatalogWiring(ownerTabId);
    if (next === wiring) return;
    wiring = next;
    listener();
  });
  return () => {
    stopCanvas();
    stopWiring();
  };
}

export interface InspectedAnnotationSource {
  readonly id: SourceId;
  readonly label: string;
  readonly evidence: AnnotationEvidenceClass;
  readonly evidenceLabel: string;
  readonly availability: SourceAvailability;
  readonly citation: string | null;
  readonly url: string | null;
  readonly doi: string | null;
  readonly datasetVersion: string | null;
  readonly license: {
    readonly spdx: string | null;
    readonly attribution: string;
    readonly evidenceUrl: string | null;
  };
}

export type InspectedTrackResolution =
  | { readonly status: 'hidden' }
  | { readonly status: 'not-drawn'; readonly reason: string }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly recordCount: number; readonly totalBeforeFilter: number }
  | { readonly status: 'error'; readonly message: string; readonly detail: string | null };

export interface InspectedAnnotationTrack {
  readonly binding: AnnotationTrackBinding;
  readonly label: string;
  readonly kindLabel: string;
  readonly source: InspectedAnnotationSource | null;
  readonly visualization: { readonly id: VisualizationId; readonly label: string } | null;
  readonly resolution: InspectedTrackResolution;
}

export interface AnnotationKindChoices {
  readonly kind: FeatureKind;
  readonly label: string;
  readonly sources: readonly InspectedAnnotationSource[];
  readonly visualizations: readonly {
    readonly id: VisualizationId;
    readonly label: string;
    readonly description: string;
  }[];
}

export type SequenceAnnotationTracksInspection =
  | { readonly status: 'missing' }
  | {
      readonly status: 'found';
      readonly ownerTabId: string;
      readonly layout: AnnotationTrackLayout | null;
      readonly assembly: {
        readonly accession: string;
        readonly lengthBp: number;
        readonly displayName: string;
      } | null;
      readonly drawing: AnnotationCatalogDrawingPhase;
      readonly tracks: readonly InspectedAnnotationTrack[];
      readonly choices: readonly AnnotationKindChoices[];
    };

function inspectSource(
  catalog: AnnotationCatalogForAssembly,
  id: SourceId
): InspectedAnnotationSource | null {
  const definition = catalog.sources.get(id);
  if (!definition) return null;
  const { provenance } = definition;
  return {
    id: definition.id,
    label: definition.label,
    evidence: definition.evidence,
    evidenceLabel: ANNOTATION_EVIDENCE_LABELS[definition.evidence],
    availability: definition.availability,
    citation: provenance.citation,
    url: provenance.url,
    doi: provenance.doi,
    datasetVersion: provenance.datasetVersion,
    license: {
      spdx: provenance.license.spdx,
      attribution: provenance.license.attribution,
      evidenceUrl: provenance.license.evidenceUrl,
    },
  };
}

function notDrawnReason(drawing: AnnotationCatalogDrawingPhase): InspectedTrackResolution {
  switch (drawing.phase) {
    case 'map-circular':
      return { status: 'not-drawn', reason: 'The map is circular' };
    case 'view-transformed':
      return { status: 'not-drawn', reason: 'The view is flipped or its origin is moved' };
    case 'waiting-for-map':
      return { status: 'not-drawn', reason: 'The map is not open' };
    case 'error':
      return { status: 'error', message: drawing.message, detail: drawing.detail };
    case 'idle':
    case 'active':
      return { status: 'loading' };
    default: {
      const _exhaustive: never = drawing;
      return _exhaustive;
    }
  }
}

export function inspectSequenceAnnotationTracks(
  ownerTabId: string
): SequenceAnnotationTracksInspection {
  const owned = findSequenceTab(ownerTabId);
  if (!owned) return { status: 'missing' };
  const layout = currentLayout(owned.tab);
  const wiring = readAnnotationCatalogWiring(ownerTabId);
  const catalog =
    (layout ? annotationCatalogForAccession(layout.assembly) : null) ??
    (wiring ? annotationCatalogForAccession(wiring.assembly.accession) : null);
  const drawing: AnnotationCatalogDrawingPhase = wiring?.drawing ?? { phase: 'waiting-for-map' };

  const tracks = (layout?.tracks ?? []).map((binding): InspectedAnnotationTrack => {
    const visualization = catalog?.visualizations.get(binding.visualizationId);
    const drawn = wiring?.tracks.get(binding.id);
    const kindLabel = FEATURE_KIND_LABELS[binding.kind];
    return {
      binding,
      label: binding.label ?? kindLabel,
      kindLabel,
      source: catalog ? inspectSource(catalog, binding.sourceId) : null,
      visualization: visualization ? { id: visualization.id, label: visualization.label } : null,
      resolution: !binding.visible ? { status: 'hidden' } : (drawn ?? notDrawnReason(drawing)),
    };
  });

  const choices = catalog
    ? FEATURE_KINDS.map(
        (kind): AnnotationKindChoices => ({
          kind,
          label: FEATURE_KIND_LABELS[kind],
          sources: catalog.sources
            .forKind({ kind, assembly: catalog.assembly.accession })
            .map((definition) => inspectSource(catalog, definition.id))
            .filter((source): source is InspectedAnnotationSource => source !== null),
          visualizations: catalog.visualizations.forKind(kind).map((definition) => ({
            id: definition.id,
            label: definition.label,
            description: definition.description,
          })),
        })
      )
    : [];

  return {
    status: 'found',
    ownerTabId,
    layout,
    assembly: catalog
      ? {
          accession: catalog.assembly.accession,
          lengthBp: catalog.assembly.lengthBp,
          displayName: catalog.displayName,
        }
      : null,
    drawing,
    tracks,
    choices,
  };
}
