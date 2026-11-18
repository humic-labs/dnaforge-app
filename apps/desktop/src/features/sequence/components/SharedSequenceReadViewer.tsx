import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';
import type { SharedSequenceColumnNavigation } from './alignment-mutation-navigation';
import { buildAlignmentCodingProjection } from './alignment-coding-genome';
import {
  computeAlignmentCdsComparison,
  presentAlignmentCdsComparison,
  rebindCdsAnnotationColors,
  type CdsComparisonLayout,
} from './alignment-cds-comparison';
import {
  DEFAULT_EDITOR_CONFIG,
  MAX_ZOOM,
  MIN_ZOOM,
  useHoveredCodon,
  useHoveredCodonStore,
  useSelectedCodons,
  type HoveredCodonKey,
} from '@waypoint/workspace-editor';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, PointerEvent as ReactPointerEvent } from 'react';
import type { ResolvedDataColor } from '@waypoint/platform';
import type { CoordinateSpace, AnnotationStateIdentity } from '@waypoint/workspace-editor';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import {
  CDS_MUTATION_MARKUP,
  sequenceEditMarkupStyle,
} from '@waypoint/sequence-utils/sequence-edit-markup';
import type { ParsedPlasmid } from '@waypoint/plasmid-viewer';
import { convertPlasmid } from '@waypoint/plasmid-viewer';
import {
  PixiSequenceReadTrackRenderer,
  SEQUENCE_READ_TRACK_TYPE,
  type Track,
  type AnnotationChangeDecoration,
  type LinearSequencePresentation,
} from '@waypoint/genome-renderer';
import { useDarkMode } from '../../../shared/context/DarkModeContext';
import { useAttachedReadsStore } from '../tracks/attached-reads-store';
import { getTraceData } from '../tracks/SequenceTracksView';
import {
  buildSharedSequenceReadScene,
  type SharedAlignmentLane,
  type SharedSequenceReadScene,
} from './shared-sequence-read-model';
import {
  IndexedGenomeTileNativeMap,
  type IndexedGenomeTileNativeMapHandle,
  type IndexedGenomeSelectedAnnotation,
  type IndexedGenomeContextMenuHandler,
} from './IndexedGenomeTileNativeMap';
import {
  buildNativeSequenceComparisonScene,
  remapNativeSequenceComparisonColors,
  mapSequenceComparisonDataColors,
  type ComparisonColorOverrides,
  type SequenceComparisonColorTarget,
} from './native-sequence-comparison';
import { alignmentColumnChanges, annotationDnaData } from './alignment-annotation-data';
import { annotationDnaColors, comparisonChangeColor } from './sequence-comparison-colors';
import { ComparisonColorControls } from './ComparisonColorControls';
import { SequenceComparisonKey } from './SequenceComparisonKey';
import type { SequenceComparisonInput } from './sequence-comparison-input';
import {
  primaryBiologicalSelectionForColumns,
  primaryColumnSelectionForBiological,
} from './shared-sequence-read-selection';

interface SharedSequenceReadViewerProps {
  readonly sequence: AnnotatedSequence;
  readonly plasmid: ParsedPlasmid;
  readonly coordinateSpace?: CoordinateSpace;
  readonly alignmentLanes?: ReadonlyArray<SharedAlignmentLane>;
  readonly comparison?: SequenceComparisonInput;
  readonly comparisonDataColors?: readonly ResolvedDataColor<SequenceComparisonColorTarget>[];
  readonly trackOwnerId?: string;
  readonly changedAnnotationNames?: ReadonlySet<string>;
  readonly hideReverseComplement?: boolean;
  readonly selectedAnnotation?: AnnotationStateIdentity | null;
  readonly onSelectedAnnotationChange?: (annotation: AnnotationStateIdentity | null) => void;
  readonly onSelectionClear?: () => void;
  readonly selectionSource?: 'before' | 'after';
  readonly onSelectionSourceChange?: (source: 'before' | 'after') => void;
  readonly onComparisonContextMenu?: (
    event: MouseEvent,
    source: 'before' | 'after',
    range: { start: number; end: number } | null,
    position: number | null
  ) => void;
  readonly onSequenceContextMenu?: (
    event: MouseEvent,
    range: { start: number; end: number } | null,
    info: { position: number | null; isOnNucleotideRow: boolean; annotation: Annotation | null }
  ) => void;
  readonly columnNavigation?: SharedSequenceColumnNavigation;
  readonly selection: { start: number; end: number; wraps?: boolean } | null;
  readonly onSelectionChange: (selection: { start: number; end: number } | null) => void;
  readonly onViewportChange: (range: { start: number; end: number; centerColumn?: number }) => void;
  readonly scrollToPosition?: number | null;
  readonly scrollCommandId?: number | null;
  readonly scrollCommandRequestId?: number | string | null;
  readonly onScrollToPositionComplete?: () => void;
  readonly zoomPercent: number;
  readonly aaColorScheme?: string;
  readonly showTranslation?: boolean;
  readonly showResidueNumbers?: boolean;
  readonly onZoomChange?: (zoomPercent: number) => void;
}

const EMPTY_READS: never[] = [];
const DEFAULT_COMPARISON_COLORS: ComparisonColorOverrides = {};

function sceneFor(
  sequence: AnnotatedSequence,
  plasmid: ParsedPlasmid,
  coordinateSpace: CoordinateSpace | undefined,
  alignmentLanes: ReadonlyArray<SharedAlignmentLane> | undefined,
  attachedReads: ReturnType<typeof useAttachedReadsStore.getState>['attachedBySequenceId'][string]
): { scene: SharedSequenceReadScene; error: null } | { scene: null; error: string } {
  try {
    const directTrace = getTraceData(sequence);
    return {
      scene: buildSharedSequenceReadScene({
        genome: convertPlasmid(plasmid),
        documentId: sequence.id,
        coordinateSpace,
        alignmentLanes,
        directRead: directTrace
          ? { trace: directTrace, sequence: sequence.sequence, quality: sequence.quality }
          : undefined,
        attachedReads,
      }),
      error: null,
    };
  } catch (error) {
    return { scene: null, error: toUserMessage(error, 'sequence.failed') };
  }
}

export function SharedSequenceReadViewer({
  sequence,
  plasmid,
  coordinateSpace,
  alignmentLanes,
  comparison,
  comparisonDataColors,
  changedAnnotationNames,
  hideReverseComplement,
  selectedAnnotation,
  onSelectedAnnotationChange,
  onSelectionClear,
  selectionSource = 'after',
  onSelectionSourceChange,
  onComparisonContextMenu,
  onSequenceContextMenu,
  columnNavigation,
  selection,
  onSelectionChange,
  onViewportChange,
  scrollToPosition,
  scrollCommandId,
  scrollCommandRequestId,
  onScrollToPositionComplete,
  zoomPercent,
  aaColorScheme,
  showTranslation = true,
  showResidueNumbers = false,
  onZoomChange,
}: SharedSequenceReadViewerProps) {
  const { darkMode } = useDarkMode();
  const cdsLayout: CdsComparisonLayout = 'diff';
  const [colorState, setColorState] = useState<{ id: string; colors: ComparisonColorOverrides }>({
    id: '',
    colors: DEFAULT_COMPARISON_COLORS,
  });
  const colorOwnerId = comparison?.id ?? `${sequence.id}:alignment`;
  const comparisonColors =
    colorState.id === colorOwnerId ? colorState.colors : DEFAULT_COMPARISON_COLORS;
  const attachedReads = useAttachedReadsStore(
    (state) => state.attachedBySequenceId[sequence.id] ?? EMPTY_READS
  );
  const {
    scene: sourceScene,
    error,
    nativeComparison: baseComparison,
  } = useMemo(() => {
    if (!comparison) {
      return {
        ...sceneFor(sequence, plasmid, coordinateSpace, alignmentLanes, attachedReads),
        nativeComparison: null,
      };
    }
    try {
      const nativeComparison = buildNativeSequenceComparisonScene(comparison);
      const sourceAxis = nativeComparison.beforeAxis;
      return {
        scene: {
          ...nativeComparison.scene,
          genome: {
            ...nativeComparison.scene.genome,
            formatRulerLabel: (column: number) => {
              const base = sourceAxis.columnToBio(column);
              return base === null ? null : String(comparison.referenceOrigin + base + 1);
            },
          },
        },
        nativeComparison,
        error: null,
      };
    } catch (error) {
      return {
        scene: null,
        nativeComparison: null,
        error: toUserMessage(error, 'sequence.failed'),
      };
    }
  }, [sequence, plasmid, coordinateSpace, alignmentLanes, attachedReads, comparison]);
  const nativeComparison = useMemo(() => {
    if (!baseComparison) return null;
    const defaults = remapNativeSequenceComparisonColors(baseComparison, comparisonColors);
    if (!comparisonDataColors) return defaults;
    return mapSequenceComparisonDataColors(defaults, {
      records: comparisonDataColors,
      bindings: comparisonDataColors.map(({ target }, inputIndex) => ({ inputIndex, target })),
      color: (resolved) => resolved.color,
    });
  }, [baseComparison, comparisonColors, comparisonDataColors]);
  const fileAlignmentData = useMemo(() => {
    if (
      !sourceScene ||
      comparison ||
      coordinateSpace?.mode !== 'gapped' ||
      (alignmentLanes?.length ?? 1) > 1
    )
      return null;
    const reference = sourceScene.genome.sequence!;
    const query = coordinateSpace.alignedQuery!;
    const records = (sourceScene.genome.features ?? []).map((feature) => ({
      featureId: feature.id,
      ...annotationDnaData(feature, reference, query),
    }));
    return { scene: sourceScene, records, changes: alignmentColumnChanges(reference, query) };
  }, [sourceScene, comparison, coordinateSpace, alignmentLanes]);
  const fileAlignment = useMemo(() => {
    if (!fileAlignmentData) return null;
    const appearance = {
      scene: fileAlignmentData.scene,
      annotationColors: annotationDnaColors(fileAlignmentData.records, comparisonColors),
      annotationChangeDecorations: new Map<number, AnnotationChangeDecoration>(),
      nucleotideChanges: fileAlignmentData.changes.map((change) => ({
        ...change,
        color: comparisonChangeColor(change.kind, comparisonColors),
        ...(comparisonColors[change.kind] !== undefined
          ? {
              style: sequenceEditMarkupStyle(
                change.kind,
                comparisonChangeColor(change.kind, comparisonColors)
              ),
            }
          : {}),
      })),
    };
    return comparisonDataColors
      ? mapSequenceComparisonDataColors(appearance, {
          records: comparisonDataColors,
          bindings: comparisonDataColors.map(({ target }, inputIndex) => ({ inputIndex, target })),
          color: (resolved) => resolved.color,
        })
      : appearance;
  }, [fileAlignmentData, comparisonColors, comparisonDataColors]);
  const biologicalGenome = useMemo(
    () => comparison?.after ?? convertPlasmid(plasmid),
    [comparison, plasmid]
  );
  const codingProjection = useMemo(() => {
    if (!sourceScene) return null;
    if (comparison && !comparison.after.features?.length && baseComparison) {
      const inherited = buildAlignmentCodingProjection(
        comparison.before,
        {
          mode: 'gapped',
          gappedSequence: comparison.oldGapped,
          alignedQuery: comparison.newGapped,
        },
        baseComparison.beforeAxis
      );
      return { ...inherited, genome: { ...comparison.after, features: inherited.genome.features } };
    }
    if (!comparison && coordinateSpace?.mode === 'gapped') {
      return buildAlignmentCodingProjection(biologicalGenome, coordinateSpace, sourceScene.axis);
    }
    return { genome: biologicalGenome, axis: sourceScene.axis };
  }, [sourceScene, comparison, baseComparison, coordinateSpace, biologicalGenome]);
  const cdsModel = useMemo(() => {
    if (!sourceScene || !codingProjection || (!comparison && coordinateSpace?.mode !== 'gapped'))
      return null;
    const reference = baseComparison
      ? { genome: baseComparison.referenceCodingGenome, axis: baseComparison.beforeAxis }
      : { genome: biologicalGenome, axis: sourceScene.axis };
    return computeAlignmentCdsComparison(reference, codingProjection);
  }, [
    sourceScene,
    codingProjection,
    comparison,
    coordinateSpace,
    baseComparison,
    biologicalGenome,
  ]);
  const cdsPresentation = useMemo(
    () =>
      sourceScene && cdsModel?.pairs.length
        ? presentAlignmentCdsComparison(sourceScene, cdsModel, cdsLayout)
        : null,
    [sourceScene, cdsModel, cdsLayout]
  );
  const scene = cdsPresentation?.scene ?? sourceScene;
  const sequencePresentation = useMemo((): LinearSequencePresentation | undefined => {
    if (!scene || !codingProjection) return undefined;
    const alignedQuery =
      comparison?.oldGapped ??
      (coordinateSpace?.mode === 'gapped' && (alignmentLanes?.length ?? 1) <= 1
        ? coordinateSpace.alignedQuery
        : undefined);
    return {
      minSequencePixelsPerBp: (DEFAULT_EDITOR_CONFIG.charWidth * MIN_ZOOM) / 100,
      maxSequencePixelsPerBp: (DEFAULT_EDITOR_CONFIG.charWidth * MAX_ZOOM) / 100,
      cdsSizing: 'canvas',
      aminoAcidColorScheme: aaColorScheme ?? 'rasmol',
      showTranslation,
      cdsComparisonLayout: cdsPresentation ? cdsLayout : undefined,
      codingFeatures: cdsPresentation?.codingFeatures,
      referenceCoding: baseComparison
        ? {
            genome: baseComparison.referenceCodingGenome,
            bioToColumn: baseComparison.beforeAxis.bioToColumn,
            columnToBio: baseComparison.beforeAxis.columnToBio,
          }
        : coordinateSpace?.mode === 'gapped'
          ? {
              genome: biologicalGenome,
              bioToColumn: scene.axis.bioToColumn,
              columnToBio: scene.axis.columnToBio,
            }
          : undefined,
      showReverseComplement: !hideReverseComplement && !coordinateSpace && !comparison,
      alignedQuery,
      referenceRow: fileAlignment ? 'forward' : 'secondary',
      nucleotideChanges: (nativeComparison ?? fileAlignment)?.nucleotideChanges,
      annotationColors: rebindCdsAnnotationColors(
        scene.genome.features ?? [],
        (nativeComparison ?? fileAlignment)?.annotationColors
      ),
      annotationUnchangedColor: comparisonChangeColor('unchanged', comparisonColors),
      biologicalGenome: cdsModel?.query.genome ?? codingProjection.genome,
      bioToColumn: codingProjection.axis.bioToColumn,
      columnToBio: codingProjection.axis.columnToBio,
    };
  }, [
    scene,
    comparison,
    nativeComparison,
    baseComparison,
    fileAlignment,
    coordinateSpace,
    alignmentLanes,
    codingProjection,
    biologicalGenome,
    aaColorScheme,
    showTranslation,
    cdsPresentation,
    cdsLayout,
    cdsModel,
    hideReverseComplement,
    comparisonColors,
  ]);
  const annotationChangeDecorations = useMemo(() => {
    if (nativeComparison)
      return new Map(
        [...nativeComparison.annotationChangeDecorations].filter(
          ([, decoration]) => decoration.kind === 'removed'
        )
      );
    if (fileAlignment) return fileAlignment.annotationChangeDecorations;
    const changes = new Map<number, AnnotationChangeDecoration>();
    for (const feature of scene?.genome.features ?? []) {
      if (changedAnnotationNames?.has(feature.displayName))
        changes.set(feature.id, { kind: 'modified' });
    }
    return changes;
  }, [nativeComparison, fileAlignment, scene, changedAnnotationNames]);
  const [dismissedColumnSelection, setDismissedColumnSelection] = useState<number | null>(null);
  const dismissColumnSelection = useCallback(() => {
    if (columnNavigation?.selection) setDismissedColumnSelection(columnNavigation.requestId);
  }, [columnNavigation]);
  const selectionSourceRef = useRef(selectionSource);
  selectionSourceRef.current = selectionSource;
  const selectionAxis = nativeComparison
    ? nativeComparison[selectionSource === 'before' ? 'beforeAxis' : 'afterAxis']
    : scene?.axis;
  const codonAxis = nativeComparison?.beforeAxis ?? scene?.axis;
  const hoveredCodonStore = useHoveredCodonStore();
  const hoveredCodon = useHoveredCodon();
  const selectedCodons = useSelectedCodons();
  const ownedCodonHoverRef = useRef<HoveredCodonKey | null>(null);
  const projectCodon = useCallback(
    (codon: { start: number; end: number; strand: 1 | -1 }) => {
      const columns = codonAxis ? primaryColumnSelectionForBiological(codonAxis, codon) : null;
      return columns ? { ...columns, strand: codon.strand } : null;
    },
    [codonAxis]
  );
  const externalHoveredCodon = useMemo(
    () => (hoveredCodon ? (projectCodon(hoveredCodon) ?? undefined) : undefined),
    [hoveredCodon, projectCodon]
  );
  const externalSelectedCodons = useMemo(
    () =>
      selectedCodons.flatMap((codon) => {
        const projected = projectCodon(codon);
        return projected ? [projected] : [];
      }),
    [selectedCodons, projectCodon]
  );
  const handleCodonHover = useCallback<
    NonNullable<ComponentProps<typeof IndexedGenomeTileNativeMap>['onCodonHover']>
  >(
    (codon) => {
      const mutation = codon?.mutation;
      const resolved =
        codon &&
        codonAxis &&
        !mutation?.frameShifted &&
        !['inserted', 'deleted', 'unknown'].includes(mutation?.kind ?? '')
          ? primaryBiologicalSelectionForColumns(codonAxis, codon)
          : null;
      if (resolved && resolved.end - resolved.start === 2) {
        const next = { ...resolved, strand: codon!.strand, source: 'sequence' as const };
        ownedCodonHoverRef.current = next;
        hoveredCodonStore?.set(next);
        return;
      }
      const previous = hoveredCodonStore?.getSnapshot();
      const owned = ownedCodonHoverRef.current;
      ownedCodonHoverRef.current = null;
      if (
        previous?.source === 'sequence' &&
        owned &&
        previous.start === owned.start &&
        previous.end === owned.end &&
        previous.strand === owned.strand
      )
        hoveredCodonStore?.set(null);
    },
    [codonAxis, hoveredCodonStore]
  );
  const clearNativeSelection = useCallback(() => {
    if (onSelectionClear) onSelectionClear();
    else onSelectionChange(null);
  }, [onSelectionClear, onSelectionChange]);

  const projectedAnnotation = useCallback(
    (
      feature: import('@waypoint/genome-renderer').Feature,
      source: 'before' | 'after'
    ): AnnotationStateIdentity | null => {
      const axis =
        cdsPresentation?.bindings.get(feature.id)?.axis ??
        (nativeComparison
          ? nativeComparison[source === 'before' ? 'beforeAxis' : 'afterAxis']
          : scene?.axis);
      const wrapsOrigin =
        !nativeComparison && scene?.genome.circular && feature.end < feature.start;
      const wrappedStart = wrapsOrigin ? axis?.columnToBio(feature.start) : null;
      const wrappedEnd = wrapsOrigin ? axis?.columnToBio(feature.end - 1) : null;
      const range = axis
        ? wrapsOrigin
          ? wrappedStart != null && wrappedEnd != null
            ? { start: wrappedStart, end: wrappedEnd }
            : null
          : primaryBiologicalSelectionForColumns(axis, {
              start: feature.start,
              end: feature.end - 1,
            })
        : null;
      if (!range) return null;
      const segments = feature.segments?.flatMap((segment) => {
        const biological = primaryBiologicalSelectionForColumns(axis!, {
          start: segment.start - 1,
          end: segment.end - 1,
        });
        return biological ? [{ start: biological.start + 1, end: biological.end + 1 }] : [];
      });
      return {
        type: feature.type,
        name: feature.displayName,
        start: range.start + 1,
        end: range.end + 1,
        direction: feature.direction === 'forward' ? 1 : feature.direction === 'reverse' ? -1 : 0,
        ...(segments?.length ? { segments } : {}),
        ...(feature.sourceId ? { sourceId: feature.sourceId } : {}),
        ...(feature.canonicalIdentity ? { canonicalIdentity: feature.canonicalIdentity } : {}),
      };
    },
    [cdsPresentation, nativeComparison, scene]
  );

  const nativeSelectedAnnotation = useMemo((): IndexedGenomeSelectedAnnotation | null => {
    if (!selectedAnnotation || !scene) return null;
    const identity = selectedAnnotation as AnnotationStateIdentity & {
      sourceId?: string;
      canonicalIdentity?: string;
    };
    const candidates = (scene.genome.features ?? []).filter((feature) => {
      return (
        !nativeComparison ||
        (cdsPresentation?.bindings.has(feature.id)
          ? cdsPresentation.bindings.get(feature.id)!.source === 'reference'
            ? 'before'
            : 'after'
          : nativeComparison.annotationData.get(feature.id)?.source) === selectionSource
      );
    });
    const feature = candidates.find((feature) => {
      if (identity.canonicalIdentity && feature.canonicalIdentity === identity.canonicalIdentity)
        return true;
      if (
        identity.sourceId &&
        feature.sourceId === identity.sourceId &&
        feature.type === identity.type
      )
        return true;
      const projected = projectedAnnotation(feature, selectionSource);
      return (
        projected &&
        projected.type === identity.type &&
        projected.name === identity.name &&
        projected.start === identity.start &&
        projected.end === identity.end &&
        (projected.direction ?? 0) === (identity.direction ?? 0)
      );
    });
    if (!feature) return null;

    return {
      featureId: feature.id,
      type: feature.type,
      name: feature.displayName,
      start: feature.start + 1,
      end: feature.end,
      direction: feature.direction === 'forward' ? 1 : feature.direction === 'reverse' ? -1 : 0,
    };
  }, [
    selectedAnnotation,
    scene,
    cdsPresentation,
    nativeComparison,
    selectionSource,
    projectedAnnotation,
  ]);

  const commitNativeAnnotation = useCallback(
    (annotation: IndexedGenomeSelectedAnnotation | null) => {
      if (!annotation || !scene) {
        onSelectedAnnotationChange?.(null);
        return;
      }
      const feature = scene.genome.features?.find((feature) => feature.id === annotation.featureId);
      if (!feature) {
        onSelectedAnnotationChange?.(null);
        return;
      }
      const binding = cdsPresentation?.bindings.get(feature.id);
      const source = binding
        ? binding.source === 'reference'
          ? 'before'
          : 'after'
        : (nativeComparison?.annotationData.get(feature.id)?.source ?? 'after');
      selectionSourceRef.current = source;
      onSelectionSourceChange?.(source);
      onSelectedAnnotationChange?.(projectedAnnotation(feature, source));
    },
    [
      scene,
      cdsPresentation,
      nativeComparison,
      onSelectionSourceChange,
      onSelectedAnnotationChange,
      projectedAnnotation,
    ]
  );

  const commitColumns = useCallback(
    (range: { start: number; end: number } | null) => {
      const axis = nativeComparison
        ? nativeComparison[selectionSourceRef.current === 'before' ? 'beforeAxis' : 'afterAxis']
        : scene?.axis;
      onSelectionChange(range && axis ? primaryBiologicalSelectionForColumns(axis, range) : null);
    },
    [nativeComparison, scene, onSelectionChange]
  );
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<IndexedGenomeTileNativeMapHandle>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [rendererEpoch, setRendererEpoch] = useState(0);
  const [genomeEpoch, setGenomeEpoch] = useState(0);
  const initialViewportDocumentRef = useRef<string | null>(null);
  const appliedColumnNavigationRef = useRef<{
    documentId: string;
    requestId: number;
    genomeEpoch: number;
  } | null>(null);
  const appliedScrollCommandRef = useRef<{
    documentId: string;
    position: number;
    id: number | null;
  } | null>(null);
  const scrollCompletionCallbackRef = useRef(onScrollToPositionComplete);
  scrollCompletionCallbackRef.current = onScrollToPositionComplete;
  const applyingZoomRef = useRef(false);
  const appliedZoomRef = useRef<{
    documentId: string;
    zoomPercent: number;
    width: number;
    genomeEpoch: number;
  } | null>(null);

  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!scene) return;
    const map = mapRef.current;
    const renderer = map?.getLinearRenderer();
    if (!renderer || !map) return;
    renderer.setChromosome({
      id: sequence.id,
      displayName: scene.genome.name,
      length: scene.axis.length,
      cytobands: [],
    });
    try {
      renderer.registerTrack(new PixiSequenceReadTrackRenderer());
    } catch (error) {
      if (!String(error).includes('already registered')) throw error;
    }
    renderer.setTrackHitHandler((hit) => {
      if (hit.kind !== 'select-bp-range') return;
      mapRef.current?.setSelection(hit.startBp, hit.endBp - 1);
      commitColumns({ start: hit.startBp, end: hit.endBp - 1 });
    });
    const lanes = scene.lanes.filter(
      (lane) => !(lane.kind === 'alignment' && sequencePresentation?.alignedQuery)
    );
    const instances: Track[] = lanes.map((lane, order) => ({
      id: lane.id,
      type: SEQUENCE_READ_TRACK_TYPE,
      order,
      visible: true,
      assemblyId: sequence.id,
      label: lane.label,
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: lane.kind === 'sanger' ? 138 : 42 },
    }));
    renderer.setTrackInstances(instances);
    for (const lane of lanes) renderer.setTrackData(lane.id, lane);
    map.requestRender();
  }, [scene, sequence.id, rendererEpoch, genomeEpoch, commitColumns, sequencePresentation]);

  useLayoutEffect(() => {
    if (!scene || genomeEpoch === 0 || size.width <= 1 || size.height <= 1) return;
    if (initialViewportDocumentRef.current === sequence.id) return;
    const map = mapRef.current;
    if (!map) return;
    const end = Math.max(
      1,
      size.width / (DEFAULT_EDITOR_CONFIG.charWidth * Math.max(0.002, zoomPercent / 100))
    );
    applyingZoomRef.current = true;
    try {
      map.setViewport({ start: 0, end });
    } finally {
      applyingZoomRef.current = false;
    }
    initialViewportDocumentRef.current = sequence.id;
    appliedZoomRef.current = {
      documentId: sequence.id,
      zoomPercent,
      width: size.width,
      genomeEpoch,
    };
  }, [scene, sequence.id, genomeEpoch, size.width, size.height, zoomPercent]);

  useLayoutEffect(() => {
    if (!scene || genomeEpoch === 0 || initialViewportDocumentRef.current !== sequence.id) return;
    const previous = appliedZoomRef.current;

    if (
      previous?.documentId === sequence.id &&
      previous.zoomPercent === zoomPercent &&
      previous.width === size.width &&
      previous.genomeEpoch === genomeEpoch
    )
      return;
    const map = mapRef.current;
    if (!map) return;
    const center = map.getViewCenter() ?? 0;
    const span = Math.max(
      1,
      size.width / (DEFAULT_EDITOR_CONFIG.charWidth * Math.max(0.002, zoomPercent / 100))
    );
    applyingZoomRef.current = true;
    try {
      map.setViewport({ start: center - span / 2, end: center + span / 2 });
      map.setViewCenter(center);
    } finally {
      applyingZoomRef.current = false;
    }
    appliedZoomRef.current = {
      documentId: sequence.id,
      zoomPercent,
      width: size.width,
      genomeEpoch,
    };
  }, [scene, sequence.id, genomeEpoch, size.width, zoomPercent]);

  useLayoutEffect(() => {
    if (scrollToPosition == null) {
      appliedScrollCommandRef.current = null;
      return;
    }

    if (!scene || genomeEpoch === 0 || initialViewportDocumentRef.current !== sequence.id) return;
    const map = mapRef.current;
    if (!map?.getLinearRenderer()) return;
    const commandId = scrollCommandId ?? null;
    const applied = appliedScrollCommandRef.current;
    if (
      applied?.documentId === sequence.id &&
      applied.position === scrollToPosition &&
      applied.id === commandId
    )
      return;
    if (columnNavigation && scrollCommandRequestId === columnNavigation.requestId) {
      scrollCompletionCallbackRef.current?.();
      return;
    }
    const column = scene.axis.bioToColumn(Math.round(scrollToPosition) - 1);
    if (column == null) return;
    map.setViewCenter(column);
    appliedScrollCommandRef.current = {
      documentId: sequence.id,
      position: scrollToPosition,
      id: commandId,
    };
    scrollCompletionCallbackRef.current?.();
  }, [
    scene,
    sequence.id,
    genomeEpoch,
    rendererEpoch,
    size.width,
    size.height,
    scrollToPosition,
    scrollCommandId,
    scrollCommandRequestId,
    columnNavigation,
  ]);

  const exactColumnSelection =
    columnNavigation?.selection &&
    dismissedColumnSelection !== columnNavigation.requestId &&
    selection?.start === columnNavigation.biologicalSelection?.start &&
    selection?.end === columnNavigation.biologicalSelection?.end
      ? columnNavigation.selection
      : undefined;
  useLayoutEffect(() => {
    const columns =
      exactColumnSelection ??
      (selectionAxis ? primaryColumnSelectionForBiological(selectionAxis, selection) : null);
    mapRef.current?.setSelection(columns?.start ?? null, columns?.end ?? null);
  }, [selectionAxis, selection?.start, selection?.end, exactColumnSelection, genomeEpoch]);

  useLayoutEffect(() => {
    if (!columnNavigation) return;
    const applied = appliedColumnNavigationRef.current;
    if (
      applied?.documentId === sequence.id &&
      applied.requestId === columnNavigation.requestId &&
      applied.genomeEpoch === genomeEpoch
    )
      return;
    appliedColumnNavigationRef.current = {
      documentId: sequence.id,
      requestId: columnNavigation.requestId,
      genomeEpoch,
    };
    mapRef.current?.setViewCenter(columnNavigation.column);
    if (columnNavigation.selection) {
      mapRef.current?.setSelection(
        columnNavigation.selection.start,
        columnNavigation.selection.end
      );
    }
  }, [columnNavigation, genomeEpoch, sequence.id]);

  const sourceForPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const top = event.currentTarget.getBoundingClientRect().top;
    const row = mapRef.current?.getLinearRenderer()?.getSequenceRowAt(event.clientY - top);
    return row === 'secondary' ? ('before' as const) : ('after' as const);
  };

  const handleNativeContextMenu = useCallback<IndexedGenomeContextMenuHandler>(
    (event, context) => {
      if (!scene) return;
      const featureId =
        context.featureId ??
        (context.hitResult?.kind === 'feature' ? context.hitResult.payload.id : null);
      const feature =
        featureId == null
          ? undefined
          : scene.genome.features?.find((feature) => feature.id === featureId);
      const top = wrapperRef.current?.getBoundingClientRect().top ?? 0;
      const row = mapRef.current?.getLinearRenderer()?.getSequenceRowAt(event.clientY - top);
      const source =
        (feature && nativeComparison?.annotationData.get(feature.id)?.source) ??
        (row === 'secondary' && nativeComparison ? 'before' : 'after');
      const axis = nativeComparison
        ? nativeComparison[source === 'before' ? 'beforeAxis' : 'afterAxis']
        : scene.axis;
      const columns = context.highlightRange ?? mapRef.current?.getSelection();
      const range = columns
        ? primaryBiologicalSelectionForColumns(axis, { start: columns[0], end: columns[1] })
        : null;
      const position = context.position == null ? null : axis.columnToBio(context.position);
      event.preventDefault();
      if (comparison && nativeComparison && onComparisonContextMenu) {
        selectionSourceRef.current = source;
        onSelectionSourceChange?.(source);
        onComparisonContextMenu(event, source, range, position);
        return;
      }
      const identity = feature ? projectedAnnotation(feature, source) : null;
      const annotation: Annotation | null = identity
        ? {
            ...identity,
            direction: (identity.direction ?? 0) as 1 | -1 | 0,
            ...(feature?.qualifierValues
              ? {
                  qualifiers: Object.fromEntries(
                    Object.entries(feature.qualifierValues).map(([key, values]) => [
                      key,
                      [...values],
                    ])
                  ),
                }
              : {}),
          }
        : null;
      onSequenceContextMenu?.(event, range, {
        position,
        isOnNucleotideRow: feature ? false : row !== null,
        annotation,
      });
    },
    [
      scene,
      nativeComparison,
      comparison,
      onComparisonContextMenu,
      onSequenceContextMenu,
      onSelectionSourceChange,
      projectedAnnotation,
    ]
  );

  const handleCameraChange = useCallback(
    (
      centerBp: number,
      reason: 'scroll' | 'zoom',
      nativeZoom: number,
      viewportRange: Readonly<{ start: number; end: number }>
    ) => {
      if (!scene) return;
      if (
        reason === 'zoom' &&
        !applyingZoomRef.current &&
        size.width > 1 &&
        viewportRange.end > viewportRange.start
      ) {
        const actualPercent = Math.max(
          MIN_ZOOM,
          Math.min(
            MAX_ZOOM,
            ((size.width * nativeZoom) / scene.axis.length / DEFAULT_EDITOR_CONFIG.charWidth) * 100
          )
        );
        if (onZoomChange && Math.abs(actualPercent - zoomPercent) > 0.05) {
          appliedZoomRef.current = {
            documentId: sequence.id,
            zoomPercent: actualPercent,
            width: size.width,
            genomeEpoch,
          };
          onZoomChange(actualPercent);
        }
      }
      onViewportChange({
        start: Math.max(0, Math.floor(viewportRange.start)),
        end: Math.min(scene.axis.length - 1, Math.max(0, Math.ceil(viewportRange.end) - 1)),
        centerColumn: Math.max(0, Math.min(scene.axis.length - 1, Math.round(centerBp))),
      });
    },
    [scene, sequence.id, genomeEpoch, onViewportChange, onZoomChange, size.width, zoomPercent]
  );

  return (
    <div
      data-testid="shared-sequence-read-viewer"
      data-read-lane-ids={scene?.lanes.map((lane) => lane.id).join(',') ?? ''}
      data-selection-start={selection?.start ?? ''}
      data-selection-end={selection?.end ?? ''}
      data-comparison-native={comparison ? 'true' : undefined}
      data-comparison-source={selectionSource}
      data-native-annotation-change-count={annotationChangeDecorations.size}
      onKeyDownCapture={dismissColumnSelection}
      className="flex h-full w-full flex-col overflow-hidden"
    >
      {cdsPresentation && (
        <div
          data-testid="cds-comparison-controls"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-bg py-1 pl-3 pr-72 text-[11px]"
        >
          <span className="font-medium">Final CDS</span>
          <div
            className="flex items-center gap-3 text-fg-muted"
            aria-label="Protein mutation markup"
          >
            {[
              ['Substitution', CDS_MUTATION_MARKUP.substitution.background],
              ['Insertion', CDS_MUTATION_MARKUP.inserted.background],
              ['Frameshift', CDS_MUTATION_MARKUP.frameshifted.background],
              ['New stop', CDS_MUTATION_MARKUP.prematureStop.background],
            ].map(([label, paint]) => (
              <span key={String(label)} className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{
                    backgroundColor:
                      '#' + (paint as { color: number }).color.toString(16).padStart(6, '0'),
                  }}
                />
                {String(label)}
              </span>
            ))}
          </div>
          <span className="inline-block min-w-0 max-w-72">
            <MenuNativeSelect
              density="compact"
              aria-label="Jump to feature"
              data-ui-control="select"
              defaultValue=""
              onChange={(event) => {
                const feature = cdsPresentation.navigationFeatures.find(
                  (feature) => String(feature.id) === event.currentTarget.value
                );
                if (feature) {
                  dismissColumnSelection();
                  clearNativeSelection();
                  mapRef.current?.setSelection(null, null);
                  const length = scene!.axis.length;
                  const span = (feature.end - feature.start + length) % length || length;
                  mapRef.current?.setViewCenter((feature.start + span / 2) % length);
                }
                event.currentTarget.value = '';
              }}
            >
              <option value="" disabled>
                Jump to feature…
              </option>
              {cdsPresentation.navigationFeatures.map((feature) => (
                <option key={feature.id} value={feature.id}>
                  {feature.displayName}
                </option>
              ))}
            </MenuNativeSelect>
          </span>
        </div>
      )}
      <div
        ref={wrapperRef}
        onPointerDownCapture={(event) => {
          dismissColumnSelection();
          if (!comparison) return;
          const source = sourceForPointer(event);
          const changedSource = source !== selectionSourceRef.current;
          const columns = mapRef.current?.getSelection();
          selectionSourceRef.current = source;
          onSelectionSourceChange?.(source);
          if (changedSource && event.button === 0) {
            mapRef.current?.setSelection(null, null);
            clearNativeSelection();
          } else if (changedSource && columns) {
            commitColumns({ start: columns[0], end: columns[1] });
          }
        }}
        className="relative min-h-0 w-full flex-1 overflow-hidden"
      >
        {scene ? (
          <IndexedGenomeTileNativeMap
            ref={mapRef}
            genome={scene.genome}
            annotationChangeDecorations={annotationChangeDecorations}
            sequencePresentation={sequencePresentation}
            showResidueNumbers={showResidueNumbers}
            hoveredCodon={externalHoveredCodon}
            selectedCodons={externalSelectedCodons}
            onCodonHover={handleCodonHover}
            themeMode={darkMode ? 'dark' : 'light'}
            width={size.width}
            height={size.height}
            selectedAnnotation={nativeSelectedAnnotation}
            onSelectedAnnotationChange={commitNativeAnnotation}
            onSelectionClear={clearNativeSelection}
            onContextMenu={handleNativeContextMenu}
            onSelectionChange={(start, end) => commitColumns({ start, end })}
            onCameraChange={handleCameraChange}
            onRendererReady={setRendererEpoch}
            onRendererGenomeCommit={setGenomeEpoch}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <div
            role="alert"
            data-testid="shared-sequence-read-error"
            className="p-3 text-sm text-danger"
          >
            {toUserMessage(error, 'sequence.failed')}
          </div>
        )}
      </div>
      {comparison && nativeComparison && (
        <SequenceComparisonKey
          colorControls={
            <ComparisonColorControls
              colors={comparisonColors}
              onChange={(colors) => setColorState({ id: colorOwnerId, colors })}
            />
          }
          referenceName={comparison.referenceName}
          referenceOrigin={comparison.referenceOrigin}
          selectionSource={selectionSource}
          selection={selection}
        />
      )}
      {fileAlignment && (
        <div className="flex h-6 shrink-0 items-center justify-end border-t border-border bg-bg px-3 text-[11px]">
          <ComparisonColorControls
            colors={comparisonColors}
            onChange={(colors) => setColorState({ id: colorOwnerId, colors })}
          />
        </div>
      )}
    </div>
  );
}
