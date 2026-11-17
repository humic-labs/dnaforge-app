import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveGenomicMarkup } from '@waypoint/genome-data';
import {
  PixiGenomicSignalTrackRenderer,
  type SupplementalLinearTrack,
} from '@waypoint/genome-renderer';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { platform } from '../../../platform';
import {
  fingerprintSequenceDataLayerAnnotations,
  sequenceDataLayerAnnotationCandidates,
} from '../../../shared/sequence-data-layer-annotations';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import {
  SEQUENCE_DATA_LAYERS_CHANGED,
  sequenceDataLayerPresentationSchema,
  type PublishedSequenceDataLayer,
  type SequenceDataLayerPresentation,
} from '../../../shared/sequence-data-layer';
import { useWorkspaceStore, type WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import type { SequenceDataLayerViewSelection, Tab } from '../../canvas/public/types';
import { visibleSequenceDataLayerIds } from './sequence-data-layer-selection';

export type SequenceDataLayerTargetFingerprints = {
  sequenceFingerprint: string;
  annotationFingerprint: string;
};
type FingerprintState =
  | { kind: 'checking' }
  | { kind: 'ready'; capture: object; value: SequenceDataLayerTargetFingerprints }
  | { kind: 'error'; message: string };
type Resource =
  | { kind: 'loading'; key: string }
  | {
      kind: 'loaded';
      key: string;
      layers: readonly PublishedSequenceDataLayer[];
      errors: readonly { id: string; message: string }[];
    }
  | { kind: 'error'; key: string; message: string };

export interface SequenceDataLayerTrackRow {
  readonly id: string;
  readonly label: string;
  readonly visible: boolean;
  readonly samples: readonly { id: string; label: string }[];
  readonly presentation: SequenceDataLayerPresentation;
  readonly unavailable: string | null;
  readonly annotationColorsSupported?: boolean;
}

export interface SequenceDataLayerTrackControls {
  readonly annotationColorsSupported?: boolean;
  readonly rows: readonly SequenceDataLayerTrackRow[];
  readonly errors: readonly string[];
  readonly onVisibilityChange: (layerId: string, visible: boolean) => void;
  readonly onPresentationChange: (
    layerId: string,
    presentation: SequenceDataLayerPresentation
  ) => void;
}

const EMPTY_TRACKS: readonly SupplementalLinearTrack[] = [];
const EMPTY_LAYERS: readonly PublishedSequenceDataLayer[] = [];
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function sequenceDataLayerProject(
  folders: readonly WorkspaceFolder[],
  tab: Tab | undefined,
  selectedProject?: string
): string {
  const document = tab?.sequenceDocument;
  const path =
    document?.kind === 'managed-sequence'
      ? document.packageRoot
      : document?.kind === 'import-source-sequence'
        ? document.sourcePath
        : tab?.trackView?.workspaceRoot;
  if (path) return findContainingPathBoundary(folders, path)?.path ?? '';
  if (selectedProject && folders.some((folder) => folder.path === selectedProject))
    return selectedProject;
  return folders.length === 1 ? folders[0].path : '';
}

export function sequenceDataLayerRenderAvailability(
  layer: PublishedSequenceDataLayer,
  documentId: string,
  fingerprints: SequenceDataLayerTargetFingerprints | null,
  expectedRevision?: string
): string | null {
  if (!fingerprints) return 'Checking the displayed sequence.';
  if (layer.document.target.documentId !== documentId)
    return 'This layer belongs to another sequence.';
  if (expectedRevision !== undefined && layer.revision !== expectedRevision)
    return 'The saved dataset revision has changed. Restore its original artifact or choose this version explicitly.';
  if (layer.availability.status !== 'current')
    return `Saved layer unavailable: ${layer.availability.reason}.`;
  if (layer.document.target.sequenceFingerprint !== fingerprints.sequenceFingerprint)
    return 'The displayed sequence has changed. Save it and create a new mapping.';
  if (
    layer.document.target.annotationFingerprint !== undefined &&
    layer.document.target.annotationFingerprint !== fingerprints.annotationFingerprint
  )
    return 'The displayed annotations have changed. Save them and create a new mapping.';
  return null;
}

export async function fingerprintSequenceDataLayerTarget(
  sequence: AnnotatedSequence
): Promise<SequenceDataLayerTargetFingerprints> {
  const bytes = new TextEncoder().encode(sequence.sequence.toUpperCase());
  const [digest, annotationFingerprint] = await Promise.all([
    globalThis.crypto.subtle.digest('SHA-256', bytes),
    fingerprintSequenceDataLayerAnnotations(sequenceDataLayerAnnotationCandidates(sequence)),
  ]);
  return {
    sequenceFingerprint: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    annotationFingerprint,
  };
}

export function useSequenceDataLayers({
  documentId,
  sequence: displayedSequence,
  dataLayerSourceSequence,
  selection,
  onSelectionChange,
  signalsSupported = true,
  enabled = true,
}: {
  documentId?: string;
  sequence: AnnotatedSequence;
  dataLayerSourceSequence?: AnnotatedSequence;
  selection?: SequenceDataLayerViewSelection;
  onSelectionChange: (selection: SequenceDataLayerViewSelection | null) => void;
  signalsSupported?: boolean;
  enabled?: boolean;
}) {
  const sequence = dataLayerSourceSequence ?? displayedSequence;
  const folders = useWorkspaceStore((state) => state.folders);
  const tab = useCanvasStore((state) =>
    Object.values(state.panels)
      .flatMap((panel) => panel.tabs)
      .find((candidate) => candidate.entityId === documentId && candidate.type === 'sequence')
  );
  const project = sequenceDataLayerProject(folders, tab, selection?.project);
  const [fingerprintState, setFingerprintState] = useState<FingerprintState>({ kind: 'checking' });
  const capture = useMemo(
    () => ({ documentId, sequence }),
    [
      documentId,
      sequence,
      sequence.sequence,
      sequence.annotations,
      sequence.circular,
      sequence.id,
      sequence.name,
      sequence.metadata,
      sequence.quality,
      sequence.length,
    ]
  );
  const fingerprints =
    fingerprintState.kind === 'ready' && fingerprintState.capture === capture
      ? fingerprintState.value
      : null;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setFingerprintState({ kind: 'checking' });
    void fingerprintSequenceDataLayerTarget(sequence).then(
      (value) => {
        if (current) setFingerprintState({ kind: 'ready', capture, value });
      },
      (error: unknown) => {
        if (current) setFingerprintState({ kind: 'error', message: messageOf(error) });
      }
    );
    return () => {
      current = false;
    };
  }, [capture, enabled]);

  const layers = useSavedSequenceDataLayers({
    documentId,
    project,
    fingerprints,
    selection,
    onSelectionChange,
    signalsSupported,
    enabled,
  });
  return {
    ...layers,
    ownerTabId: tab?.id,
    trackControls: {
      ...layers.trackControls,
      errors: [
        ...(enabled && fingerprintState.kind === 'error' ? [fingerprintState.message] : []),
        ...layers.trackControls.errors,
      ],
    },
  };
}

export function useSavedSequenceDataLayers({
  documentId,
  project,
  fingerprints: targetFingerprints,
  pinnedRevisions,
  selection,
  onSelectionChange,
  signalsSupported = true,
  enabled = true,
}: {
  documentId?: string;
  project: string;
  fingerprints: SequenceDataLayerTargetFingerprints | null;
  pinnedRevisions?: Readonly<Record<string, string>>;
  selection?: SequenceDataLayerViewSelection;
  onSelectionChange: (selection: SequenceDataLayerViewSelection | null) => void;
  signalsSupported?: boolean;
  enabled?: boolean;
}) {
  const fingerprints = useMemo(
    () => (targetFingerprints ? { ...targetFingerprints } : null),
    [targetFingerprints?.sequenceFingerprint, targetFingerprints?.annotationFingerprint]
  );
  const resourceKey = `${project}\0${documentId ?? ''}\0${fingerprints?.sequenceFingerprint ?? ''}\0${fingerprints?.annotationFingerprint ?? ''}`;
  const [resource, setResource] = useState<Resource>({ kind: 'loading', key: '' });
  const [refresh, setRefresh] = useState(0);
  const renderer = useMemo(() => new PixiGenomicSignalTrackRenderer(), []);

  useEffect(() => {
    const update = () => setRefresh((value) => value + 1);
    window.addEventListener(SEQUENCE_DATA_LAYERS_CHANGED, update);
    return () => window.removeEventListener(SEQUENCE_DATA_LAYERS_CHANGED, update);
  }, []);

  useEffect(() => {
    if (!enabled || !project || !documentId || !fingerprints) return;
    let current = true;
    setResource({ kind: 'loading', key: resourceKey });
    void platform()
      .sequenceDataLayers.run({ operation: 'list', project, targetDocumentId: documentId })
      .then((result) => {
        if (!current) return;
        if (result.status !== 'listed')
          throw new Error('The native layer owner returned an unexpected list result.');
        setResource({
          kind: 'loaded',
          key: resourceKey,
          layers: result.layers,
          errors: result.errors,
        });
      })
      .catch((error: unknown) => {
        if (current) setResource({ kind: 'error', key: resourceKey, message: messageOf(error) });
      });
    return () => {
      current = false;
    };
  }, [project, documentId, resourceKey, refresh, enabled]);

  const loaded =
    enabled && resource.kind === 'loaded' && resource.key === resourceKey ? resource : null;
  const layers = loaded?.layers ?? EMPTY_LAYERS;
  const currentSelection = selection?.project === project ? selection : undefined;
  const presentations = currentSelection?.presentationByLayerId;
  const visibleLayerIds = useMemo(
    () =>
      visibleSequenceDataLayerIds(
        currentSelection,
        [...layers].sort((a, b) => b.document.createdAt.localeCompare(a.document.createdAt))[0]
          ?.document.id
      ),
    [currentSelection, layers]
  );
  const validatedPresentations = useMemo(
    () =>
      new Map(
        layers.map((layer) => {
          const retained = sequenceDataLayerPresentationSchema.safeParse(
            presentations?.[layer.document.id]
          );
          return [
            layer.document.id,
            retained.success &&
            layer.document.dataset.samples.some((sample) => sample.id === retained.data.sampleId)
              ? retained.data
              : layer.document.presentation,
          ] as const;
        })
      ),
    [layers, presentations]
  );
  const presentationFor = (layer: PublishedSequenceDataLayer) =>
    validatedPresentations.get(layer.document.id) ?? layer.document.presentation;
  const resolvedLayers = useMemo(() => {
    if (!enabled || !documentId) return [];
    return visibleLayerIds.flatMap((id) => {
      const layer = layers.find((candidate) => candidate.document.id === id);
      if (
        !layer ||
        sequenceDataLayerRenderAvailability(
          layer,
          documentId,
          fingerprints,
          pinnedRevisions?.[layer.document.id]
        )
      )
        return [];
      const document = layer.document;
      const presentation = validatedPresentations.get(id) ?? document.presentation;
      return [
        {
          layer,
          presentation,
          resolved: resolveGenomicMarkup({
            dataset: document.dataset,
            sampleId: presentation.sampleId,
            window: {
              reference: document.dataset.reference,
              start: 0,
              end: document.target.length,
            },
            style: presentation.style,
            ...(document.annotationAggregation === 'mean'
              ? { annotationAggregation: 'mean' as const }
              : {}),
          }),
        },
      ];
    });
  }, [
    visibleLayerIds,
    layers,
    validatedPresentations,
    fingerprints,
    pinnedRevisions,
    documentId,
    enabled,
  ]);
  const tracks = useMemo<readonly SupplementalLinearTrack[]>(
    () =>
      signalsSupported && resolvedLayers.length > 0
        ? resolvedLayers.flatMap(({ layer, presentation, resolved }, index) =>
            presentation.signalVisible
              ? [
                  {
                    track: {
                      id: `sequence-data-${layer.document.id}`,
                      type: renderer.type,
                      order: 999 + index,
                      visible: true,
                      assemblyId: resolved.reference.id,
                      label: layer.document.label,
                      zone: 'below-legacy' as const,
                      sizing: {
                        kind: 'fixed' as const,
                        pixels: resolved.style.geometry === 'band' ? 110 : 190,
                      },
                    },
                    renderer,
                    data: resolved,
                  },
                ]
              : []
          )
        : EMPTY_TRACKS,
    [resolvedLayers, signalsSupported, renderer]
  );
  const annotationBindings = useMemo(() => {
    let colors: Map<string, string> | undefined;
    let missingColor: string | undefined;
    for (const { presentation, resolved } of resolvedLayers) {
      if (!presentation.annotationColors) continue;
      colors ??= new Map();
      for (const [id, color] of resolved.annotationColors) colors.set(id, color);
      missingColor = presentation.style.colorScale.missingColor;
    }
    return { colors, missingColor };
  }, [resolvedLayers]);
  const onVisibilityChange = useCallback(
    (layerId: string, visible: boolean) => {
      if (!layers.some((layer) => layer.document.id === layerId)) return;
      const nextIds = visible
        ? [...new Set([...visibleLayerIds, layerId])]
        : visibleLayerIds.filter((id) => id !== layerId);
      if (nextIds.length > 64) return;
      onSelectionChange({
        project,
        layerId: visible ? layerId : (nextIds.at(-1) ?? null),
        visibleLayerIds: nextIds,
        ...(presentations ? { presentationByLayerId: presentations } : {}),
      });
    },
    [layers, onSelectionChange, presentations, project, visibleLayerIds]
  );
  const onPresentationChange = useCallback(
    (layerId: string, next: SequenceDataLayerPresentation) => {
      const layer = layers.find((candidate) => candidate.document.id === layerId);
      const parsed = sequenceDataLayerPresentationSchema.safeParse(next);
      if (
        !layer ||
        !parsed.success ||
        !layer.document.dataset.samples.some((sample) => sample.id === next.sampleId)
      )
        return;
      onSelectionChange({
        project,
        layerId: currentSelection?.layerId ?? visibleLayerIds.at(-1) ?? null,
        visibleLayerIds,
        presentationByLayerId: { ...presentations, [layerId]: parsed.data },
      });
    },
    [currentSelection, visibleLayerIds, layers, onSelectionChange, presentations, project]
  );
  const trackControls: SequenceDataLayerTrackControls = {
    rows: layers.map((layer) => ({
      id: layer.document.id,
      label: layer.document.label,
      visible: visibleLayerIds.includes(layer.document.id),
      samples: layer.document.dataset.samples.map(({ id, label }) => ({ id, label })),
      presentation: presentationFor(layer),
      annotationColorsSupported: layer.document.mapping.kind === 'annotation',
      unavailable: documentId
        ? sequenceDataLayerRenderAvailability(
            layer,
            documentId,
            fingerprints,
            pinnedRevisions?.[layer.document.id]
          )
        : null,
    })),
    errors: [
      ...(enabled && resource.kind === 'error' && resource.key === resourceKey
        ? [resource.message]
        : []),
      ...(loaded?.errors.map((error) => error.message) ?? []),
    ],
    onVisibilityChange,
    onPresentationChange,
  };
  return {
    loadedLayers: loaded?.layers ?? null,
    trackControls,
    tracks,
    annotationColorsByIdentity: annotationBindings.colors,
    missingColor: annotationBindings.missingColor,
  };
}
