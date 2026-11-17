import type { ComparisonProjectionProps } from './comparison-projection-props';
import type { ContactProjectionProps } from './contact-projection-props';
import {
  type UserMessage,
  userMessage,
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
} from '@waypoint/user-messages';

import { useEffect, useRef, type ReactNode } from 'react';
import { annotationTypeBadgeStyle } from '@waypoint/genome-renderer/pure';
import type { GenomeAssembly, TrackAdmissionRequestV1 } from '@waypoint/genome-data';
import { FindBar } from '@waypoint/workspace-editor/find-bar';

import { formatFileSize } from '../../../shared/oversized-guard';
import type {
  AssemblyAnnotationSceneSourceRequest,
  AssemblyReferenceAssetGenerationV1,
  GenomeTrackDescriptor,
  IndexedGenomeManifest,
  IndexedGenomeScope,
  IndexedGenomeTabState,
  IndexedGenomeVariantSourceState,
} from '../../../shared/indexed-genome';
import type { AnnotationIndex } from '../genome-annotation-index';
import type { UseGenomeSearchReturn } from '../hooks/useGenomeSearch';
import type { MutationAnnotationImpactState } from '../mutation-annotation-impact';
import { formatLengthForPicker } from '../reference-catalog';
import type { VariantSummary } from '../variant-client';
import type { ActiveStressDataset } from '../lane-contract-store';
import type { AssemblySessionChromConfig } from './assembly-session-registry';
import type { LoadPhase } from './indexed-genome-load-phase';
import { indexedAnnotationBadgeType } from './indexed-genome-tab-status';
import {
  IndexedGenomeViewer,
  type IndexedGenomeAnnotationMapperPolicy,
} from './IndexedGenomeViewer';
import { MutationNavigatorDrawer } from './MutationNavigatorDrawer';
import { GUTTER_COLLAPSED_WIDTH } from './TrackGutter';
import { useTrackGutterLayoutStore } from './track-gutter-layout-store';
import type { IndexedSequenceOverlays } from './indexed-sequence-overlays';
import type { AssemblyAnnotationResult } from './useAssemblyAnnotationFeatures';
import type { AssemblyPrepackedAnnotationSceneCacheState } from './useAssemblyPrepackedAnnotationSceneCache';
import type { FeatureDetailsState } from './useIndexedFeatureDetails';
import { indexedGenomeLoadingOverlayPhase } from './indexed-genome-tab-readiness';
import type {
  IndexedGenomeContextMenuHandler,
  IndexedGenomeSelectionChangeHandler,
} from './IndexedGenomeTileNativeMap';

type RangeStatus = 'idle' | 'loading' | 'error';

type MutationNavigatorView = {
  isOpen: boolean;
  source: IndexedGenomeVariantSourceState | null;
  variants: ReadonlyArray<VariantSummary>;
  annotationImpacts: ReadonlyMap<string, MutationAnnotationImpactState>;
  selectedVariantId: string | null;
  nextCursor: string | null;
  phase: 'idle' | 'preparing' | 'loading' | 'loading-more';
  error: UserMessage | null;
  trimmed: boolean;
  closeNavigator: () => void;
  openNavigator: () => void | Promise<void>;
  chooseSource: () => void | Promise<void>;
  attachNetworkRequest: (request: TrackAdmissionRequestV1) => Promise<void>;
  loadMore: () => void | Promise<void>;
};

type ViewerSearchHighlight = {
  id: number;
  start: number;
  end: number;
  featureType?: string;
  annotationTrackId?: string;
  canonicalIdentity?: string;
  annotationFeatureIndex?: number;
  proteinSegments?: ReadonlyArray<Readonly<{ start: number; end: number }>>;
};

const GENOME_DRAWING_MIN_WIDTH = 160;

export function IndexedGenomeTabRuntime({
  tabId,
  allowAutomaticSignalReadPileupViews = true,
  comparisonProjection,
  comparisonCamera,
  onComparisonCameraChange,
  contactProjection,
  contactCamera,
  contactUnit,
  onContactCameraChange,
  assembly,
  canShowViewer,
  rangeStatus,
  rangeError,
  manifest,
  sessionId,
  themeMode,
  length,
  isActive,
  targetViewport,
  searchHighlight,
  onContextMenu,
  onSelectionChange,
  onSelectionClear,
  sequenceOverlays,
  onCameraSample,
  userAnnotationDataset,
  onTargetViewportCommitted,
  onViewportPresented,
  onViewportRangeChange,
  onAnnotationIndexBuilt,
  onVisibleAnnotationTypesChange,
  onAnnotationTrackOrderChange,
  annotationVisibilityCommand,
  onViewerLoadPhase,
  onTrackError,
  onFeatureDetailsStateChange,
  assemblyChromIds,
  chromGffPaths,
  scope,
  assemblyAnnotations,
  assemblyAnnotationTrackTypes,
  assemblySessionConfigs,
  annotationSceneSourceRequest,
  prepackedAnnotationSceneCache,
  annotationAssetGeneration,
  annotationProductPublicationReady,
  annotationInteractionPayloadEnabled,
  annotationInteractionPreparationGeneration,
  annotationMapperPolicy,
  onAnnotationMapperPolicyChange,
  allocateAnnotationMapperPolicyRequestId,
  requireFullAssemblyReadiness,
  allowTrackOnlyInteraction,
  loadPhase,
  visualChrom,
  fileName,
  sourceSizeBytes,
  tabFileSizeBytes,
  prepareError,
  viewerLoadError,
  sequenceSearchReady,
  search,
  assemblyAnnotationSearchReady,
  assemblyAnnotationSearchNotApplicable,
  mutationNavigator,
  onSelectMutation,
  toolRail,
  drawerSlot,
  onViewerWidthChange,
}: {
  tabId: string;
  allowAutomaticSignalReadPileupViews?: boolean;
  comparisonProjection?: ComparisonProjectionProps['comparisonProjection'];
  comparisonCamera?: ComparisonProjectionProps['comparisonCamera'];
  onComparisonCameraChange?: ComparisonProjectionProps['onComparisonCameraChange'];
  contactProjection?: ContactProjectionProps['contactProjection'];
  contactCamera?: ContactProjectionProps['contactCamera'];
  contactUnit?: ContactProjectionProps['contactUnit'];
  onContactCameraChange?: ContactProjectionProps['onContactCameraChange'];
  assembly: GenomeAssembly | undefined;
  canShowViewer: boolean;
  rangeStatus: RangeStatus;
  rangeError: UserMessage | null;
  manifest: IndexedGenomeManifest | null;
  sessionId: string | undefined;
  themeMode: 'light' | 'dark';
  length: number;
  isActive: boolean;
  targetViewport: { id: number; start: number; end: number } | null;
  searchHighlight: ViewerSearchHighlight | null;
  onContextMenu?: IndexedGenomeContextMenuHandler;
  onSelectionChange?: IndexedGenomeSelectionChangeHandler;
  onSelectionClear?: () => void;
  sequenceOverlays?: IndexedSequenceOverlays;
  onCameraSample?: (range: Readonly<{ start: number; end: number }>) => void;
  userAnnotationDataset?: ActiveStressDataset | null;
  onTargetViewportCommitted: (viewport: { id: number; start: number; end: number }) => void;
  onViewportPresented?: (sessionId: string, commandId: number | null) => void;
  onViewportRangeChange: (range: { start: number; end: number } | null) => void;
  onAnnotationIndexBuilt: (index: AnnotationIndex | null) => void;
  onVisibleAnnotationTypesChange: (types: ReadonlySet<string>) => void;
  onAnnotationTrackOrderChange: (orderedTrackIds: ReadonlyArray<string>) => void;
  annotationVisibilityCommand: Readonly<{
    id: string;
    visibleTrackIds: ReadonlyArray<string>;
    orderedTrackIds: ReadonlyArray<string>;
  }> | null;
  onViewerLoadPhase: (phase: 'loading' | 'ready' | 'error', message?: string) => void;
  onTrackError: (kind: GenomeTrackDescriptor['kind'], message: string) => void;
  onFeatureDetailsStateChange: (state: FeatureDetailsState) => void;
  assemblyChromIds: readonly string[] | undefined;
  chromGffPaths: ReadonlyMap<string, string> | undefined;
  scope: IndexedGenomeScope | undefined;
  assemblyAnnotations: AssemblyAnnotationResult | null;
  assemblyAnnotationTrackTypes: IndexedGenomeTabState['assemblyAnnotationTrackTypes'];
  assemblySessionConfigs: AssemblySessionChromConfig[] | undefined;
  annotationSceneSourceRequest: AssemblyAnnotationSceneSourceRequest | null;
  prepackedAnnotationSceneCache: AssemblyPrepackedAnnotationSceneCacheState;
  annotationAssetGeneration: AssemblyReferenceAssetGenerationV1 | null | undefined;
  annotationProductPublicationReady: boolean;
  annotationInteractionPayloadEnabled: boolean;
  annotationInteractionPreparationGeneration: number;
  annotationMapperPolicy: IndexedGenomeAnnotationMapperPolicy;
  onAnnotationMapperPolicyChange: (policy: IndexedGenomeAnnotationMapperPolicy) => void;
  allocateAnnotationMapperPolicyRequestId: () => number;
  requireFullAssemblyReadiness: boolean;
  allowTrackOnlyInteraction: boolean;
  loadPhase: LoadPhase;
  visualChrom: string;
  fileName: string;
  sourceSizeBytes: number | undefined;
  tabFileSizeBytes: number | undefined;
  prepareError: UserMessage | null;
  viewerLoadError: UserMessage | null;
  sequenceSearchReady: boolean;
  search: UseGenomeSearchReturn;
  assemblyAnnotationSearchReady: boolean;
  assemblyAnnotationSearchNotApplicable: boolean;
  mutationNavigator: MutationNavigatorView;
  onSelectMutation: (variant: VariantSummary) => void;
  toolRail?: ReactNode;
  drawerSlot?: ReactNode;
  onViewerWidthChange?: (widthPx: number) => void;
}) {
  const sourceDetails = loadingSourceDetails({
    assembly,
    length,
    sourceSizeBytes,
    tabFileSizeBytes,
  });
  const overlayPhase = indexedGenomeLoadingOverlayPhase(loadPhase, allowTrackOnlyInteraction);
  const loadingChrom = assembly?.displayName ?? visualChrom;
  const loadingFileName = assembly?.displayName ?? fileName;
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const gutterWidth = useTrackGutterLayoutStore((state) =>
    state.collapsedByTabId[tabId] ? GUTTER_COLLAPSED_WIDTH : state.width
  );
  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host || !onViewerWidthChange) return;
    onViewerWidthChange(host.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => onViewerWidthChange(host.clientWidth));
    observer.observe(host);
    return () => observer.disconnect();
  }, [onViewerWidthChange]);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="indexed-genome-runtime-area"
    >
      {loadPhase !== 'error' && (
        <IndexedGenomeTabRangeStatus
          canShowViewer={canShowViewer}
          rangeStatus={rangeStatus}
          rangeError={rangeError}
        />
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollHostRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          style={{ minWidth: gutterWidth + GENOME_DRAWING_MIN_WIDTH }}
          data-testid="indexed-genome-viewer-scroll-host"
        >
          <IndexedGenomeTabViewerSurface
            tabId={tabId}
            allowAutomaticSignalReadPileupViews={allowAutomaticSignalReadPileupViews}
            comparisonProjection={comparisonProjection}
            comparisonCamera={comparisonCamera}
            onComparisonCameraChange={onComparisonCameraChange}
            contactProjection={contactProjection}
            contactCamera={contactCamera}
            contactUnit={contactUnit}
            onContactCameraChange={onContactCameraChange}
            canShowViewer={canShowViewer}
            manifest={manifest}
            sessionId={sessionId}
            themeMode={themeMode}
            length={length}
            isActive={isActive}
            targetViewport={targetViewport}
            searchHighlight={searchHighlight}
            onContextMenu={onContextMenu}
            onSelectionChange={onSelectionChange}
            onSelectionClear={onSelectionClear}
            sequenceOverlays={sequenceOverlays}
            onCameraSample={onCameraSample}
            userAnnotationDataset={userAnnotationDataset}
            onTargetViewportCommitted={onTargetViewportCommitted}
            onViewportPresented={onViewportPresented}
            onViewportRangeChange={onViewportRangeChange}
            onAnnotationIndexBuilt={onAnnotationIndexBuilt}
            onVisibleAnnotationTypesChange={onVisibleAnnotationTypesChange}
            onAnnotationTrackOrderChange={onAnnotationTrackOrderChange}
            annotationVisibilityCommand={annotationVisibilityCommand}
            onViewerLoadPhase={onViewerLoadPhase}
            onTrackError={onTrackError}
            onFeatureDetailsStateChange={onFeatureDetailsStateChange}
            assembly={assembly}
            assemblyChromIds={assemblyChromIds}
            chromGffPaths={chromGffPaths}
            scope={scope}
            assemblyAnnotations={assemblyAnnotations}
            assemblyAnnotationTrackTypes={assemblyAnnotationTrackTypes}
            assemblySessionConfigs={assemblySessionConfigs}
            annotationSceneSourceRequest={annotationSceneSourceRequest}
            prepackedAnnotationSceneCache={prepackedAnnotationSceneCache}
            annotationAssetGeneration={annotationAssetGeneration}
            annotationProductPublicationReady={annotationProductPublicationReady}
            annotationInteractionPayloadEnabled={annotationInteractionPayloadEnabled}
            annotationInteractionPreparationGeneration={annotationInteractionPreparationGeneration}
            annotationMapperPolicy={annotationMapperPolicy}
            onAnnotationMapperPolicyChange={onAnnotationMapperPolicyChange}
            allocateAnnotationMapperPolicyRequestId={allocateAnnotationMapperPolicyRequestId}
            requireFullAssemblyReadiness={requireFullAssemblyReadiness}
            loadPhase={loadPhase}
            overlayPhase={overlayPhase}
            loadingChrom={loadingChrom}
            loadingFileName={loadingFileName}
            sourceDetails={sourceDetails}
            prepareError={prepareError}
            viewerLoadError={viewerLoadError}
            onAddVariantTrackRequest={mutationNavigator.attachNetworkRequest}
            onOpenMutationNavigator={() => void mutationNavigator.openNavigator()}
          />
          <IndexedGenomeTabFindBar
            sequenceSearchReady={sequenceSearchReady}
            isActive={isActive}
            search={search}
            assemblyAnnotationSearchReady={assemblyAnnotationSearchReady}
            assemblyAnnotationSearchNotApplicable={assemblyAnnotationSearchNotApplicable}
            themeMode={themeMode}
          />
        </div>
        <MutationNavigatorDrawer
          open={mutationNavigator.isOpen}
          source={mutationNavigator.source}
          variants={mutationNavigator.variants}
          annotationImpacts={mutationNavigator.annotationImpacts}
          selectedVariantId={mutationNavigator.selectedVariantId}
          nextCursor={mutationNavigator.nextCursor}
          phase={mutationNavigator.phase}
          error={mutationNavigator.error}
          trimmed={mutationNavigator.trimmed}
          themeMode={themeMode}
          onClose={mutationNavigator.closeNavigator}
          onChooseSource={() => void mutationNavigator.chooseSource()}
          onLoadMore={() => void mutationNavigator.loadMore()}
          onSelectVariant={onSelectMutation}
        />
        {drawerSlot}
        {toolRail}
      </div>
    </div>
  );
}

function IndexedGenomeTabRangeStatus({
  canShowViewer,
  rangeStatus,
  rangeError,
}: {
  canShowViewer: boolean;
  rangeStatus: RangeStatus;
  rangeError: UserMessage | null;
}) {
  if (canShowViewer && rangeStatus !== 'loading' && !rangeError) return null;
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-bg px-4 py-2 text-xs text-fg-muted">
      {!canShowViewer ? 'Preparing index' : rangeStatus === 'loading' ? 'Loading range' : null}
      {rangeError && (
        <span className="ml-3 text-red-500">{toUserMessage(rangeError, 'tracks.loadFailed')}</span>
      )}
    </div>
  );
}

function IndexedGenomeTabViewerSurface({
  tabId,
  allowAutomaticSignalReadPileupViews = true,
  comparisonProjection,
  comparisonCamera,
  onComparisonCameraChange,
  contactProjection,
  contactCamera,
  contactUnit,
  onContactCameraChange,
  canShowViewer,
  manifest,
  sessionId,
  themeMode,
  length,
  isActive,
  targetViewport,
  searchHighlight,
  onContextMenu,
  onSelectionChange,
  onSelectionClear,
  sequenceOverlays,
  onCameraSample,
  userAnnotationDataset,
  onTargetViewportCommitted,
  onViewportPresented,
  onViewportRangeChange,
  onAnnotationIndexBuilt,
  onVisibleAnnotationTypesChange,
  onAnnotationTrackOrderChange,
  annotationVisibilityCommand,
  onViewerLoadPhase,
  onTrackError,
  onFeatureDetailsStateChange,
  assembly,
  assemblyChromIds,
  chromGffPaths,
  scope,
  assemblyAnnotations,
  assemblyAnnotationTrackTypes,
  assemblySessionConfigs,
  annotationSceneSourceRequest,
  prepackedAnnotationSceneCache,
  annotationAssetGeneration,
  annotationProductPublicationReady,
  annotationInteractionPayloadEnabled,
  annotationInteractionPreparationGeneration,
  annotationMapperPolicy,
  onAnnotationMapperPolicyChange,
  allocateAnnotationMapperPolicyRequestId,
  requireFullAssemblyReadiness,
  loadPhase,
  overlayPhase,
  loadingChrom,
  loadingFileName,
  sourceDetails,
  prepareError,
  viewerLoadError,
  onAddVariantTrackRequest,
  onOpenMutationNavigator,
}: {
  tabId: string;
  allowAutomaticSignalReadPileupViews?: boolean;
  comparisonProjection?: ComparisonProjectionProps['comparisonProjection'];
  comparisonCamera?: ComparisonProjectionProps['comparisonCamera'];
  onComparisonCameraChange?: ComparisonProjectionProps['onComparisonCameraChange'];
  contactProjection?: ContactProjectionProps['contactProjection'];
  contactCamera?: ContactProjectionProps['contactCamera'];
  contactUnit?: ContactProjectionProps['contactUnit'];
  onContactCameraChange?: ContactProjectionProps['onContactCameraChange'];
  canShowViewer: boolean;
  manifest: IndexedGenomeManifest | null;
  sessionId: string | undefined;
  themeMode: 'light' | 'dark';
  length: number;
  isActive: boolean;
  targetViewport: { id: number; start: number; end: number } | null;
  searchHighlight: ViewerSearchHighlight | null;
  onContextMenu?: IndexedGenomeContextMenuHandler;
  onSelectionChange?: IndexedGenomeSelectionChangeHandler;
  onSelectionClear?: () => void;
  sequenceOverlays?: IndexedSequenceOverlays;
  onCameraSample?: (range: Readonly<{ start: number; end: number }>) => void;
  userAnnotationDataset?: ActiveStressDataset | null;
  onTargetViewportCommitted: (viewport: { id: number; start: number; end: number }) => void;
  onViewportPresented?: (sessionId: string, commandId: number | null) => void;
  onViewportRangeChange: (range: { start: number; end: number } | null) => void;
  onAnnotationIndexBuilt: (index: AnnotationIndex | null) => void;
  onVisibleAnnotationTypesChange: (types: ReadonlySet<string>) => void;
  onAnnotationTrackOrderChange: (orderedTrackIds: ReadonlyArray<string>) => void;
  annotationVisibilityCommand: Readonly<{
    id: string;
    visibleTrackIds: ReadonlyArray<string>;
    orderedTrackIds: ReadonlyArray<string>;
  }> | null;
  onViewerLoadPhase: (phase: 'loading' | 'ready' | 'error', message?: string) => void;
  onTrackError: (kind: GenomeTrackDescriptor['kind'], message: string) => void;
  onFeatureDetailsStateChange: (state: FeatureDetailsState) => void;
  assembly: GenomeAssembly | undefined;
  assemblyChromIds: readonly string[] | undefined;
  chromGffPaths: ReadonlyMap<string, string> | undefined;
  scope: IndexedGenomeScope | undefined;
  assemblyAnnotations: AssemblyAnnotationResult | null;
  assemblyAnnotationTrackTypes: IndexedGenomeTabState['assemblyAnnotationTrackTypes'];
  assemblySessionConfigs: AssemblySessionChromConfig[] | undefined;
  annotationSceneSourceRequest: AssemblyAnnotationSceneSourceRequest | null;
  prepackedAnnotationSceneCache: AssemblyPrepackedAnnotationSceneCacheState;
  annotationAssetGeneration: AssemblyReferenceAssetGenerationV1 | null | undefined;
  annotationProductPublicationReady: boolean;
  annotationInteractionPayloadEnabled: boolean;
  annotationInteractionPreparationGeneration: number;
  annotationMapperPolicy: IndexedGenomeAnnotationMapperPolicy;
  onAnnotationMapperPolicyChange: (policy: IndexedGenomeAnnotationMapperPolicy) => void;
  allocateAnnotationMapperPolicyRequestId: () => number;
  requireFullAssemblyReadiness: boolean;
  loadPhase: LoadPhase;
  overlayPhase: Exclude<LoadPhase, 'ready'> | null;
  loadingChrom: string;
  loadingFileName: string;
  sourceDetails: string | undefined;
  prepareError: UserMessage | null;
  viewerLoadError: UserMessage | null;
  onAddVariantTrackRequest: (request: TrackAdmissionRequestV1) => Promise<void>;
  onOpenMutationNavigator: () => void;
}) {
  return (
    <>
      {}
      {canShowViewer && manifest ? (
        <IndexedGenomeViewer
          laneOwnerId={tabId}
          allowAutomaticSignalReadPileupViews={allowAutomaticSignalReadPileupViews}
          comparisonProjection={comparisonProjection}
          comparisonCamera={comparisonCamera}
          onComparisonCameraChange={onComparisonCameraChange}
          contactProjection={contactProjection}
          contactCamera={contactCamera}
          contactUnit={contactUnit}
          onContactCameraChange={onContactCameraChange}
          manifest={manifest}
          sessionId={sessionId}
          themeMode={themeMode}
          length={length}
          height={480}
          isActive={isActive}
          targetViewport={targetViewport}
          searchHighlight={searchHighlight}
          onContextMenu={onContextMenu}
          onSelectionChange={onSelectionChange}
          onSelectionClear={onSelectionClear}
          sequenceOverlays={sequenceOverlays}
          onCameraSample={onCameraSample}
          userAnnotationDataset={userAnnotationDataset}
          onTargetViewportCommitted={onTargetViewportCommitted}
          onViewportPresented={onViewportPresented}
          onViewportRangeChange={onViewportRangeChange}
          onAnnotationIndexBuilt={onAnnotationIndexBuilt}
          onVisibleAnnotationTypesChange={onVisibleAnnotationTypesChange}
          onAnnotationTrackOrderChange={onAnnotationTrackOrderChange}
          annotationVisibilityCommand={annotationVisibilityCommand}
          onLoadPhase={onViewerLoadPhase}
          onTrackError={onTrackError}
          onFeatureDetailsStateChange={onFeatureDetailsStateChange}
          assemblyChromIds={assemblyChromIds}
          assemblyDefinition={assembly}
          trackAssemblyId={assembly?.assemblyId ?? manifest.chrom}
          chromGffPaths={chromGffPaths}
          scope={scope?.kind ?? 'all'}
          assemblyFeatures={assemblyAnnotations?.features}
          assemblyByChrom={assemblyAnnotations?.byChrom}
          assemblyAnnotationTrackTypes={assemblyAnnotationTrackTypes}
          assemblySessionConfigs={assemblySessionConfigs}
          annotationSceneSourceRequest={annotationSceneSourceRequest}
          prepackedAnnotationSceneCache={prepackedAnnotationSceneCache}
          annotationAssetGeneration={annotationAssetGeneration}
          annotationProductPublicationReady={annotationProductPublicationReady}
          annotationInteractionPayloadEnabled={annotationInteractionPayloadEnabled}
          annotationInteractionPreparationGeneration={annotationInteractionPreparationGeneration}
          annotationMapperPolicy={annotationMapperPolicy}
          onAnnotationMapperPolicyChange={onAnnotationMapperPolicyChange}
          allocateAnnotationMapperPolicyRequestId={allocateAnnotationMapperPolicyRequestId}
          requireFullAssemblyReadiness={requireFullAssemblyReadiness}
          onAddVariantTrackRequest={onAddVariantTrackRequest}
          onOpenMutationNavigator={onOpenMutationNavigator}
        />
      ) : (
        <LoadingScreen
          phase={loadPhase === 'ready' ? 'opening' : loadPhase}
          chrom={loadingChrom}
          fileName={loadingFileName}
          sourceDetails={sourceDetails}
          errorMessage={loadPhase === 'error' ? (prepareError ?? undefined) : undefined}
        />
      )}
      {canShowViewer && overlayPhase && (
        <div className="absolute inset-0 z-20 bg-bg">
          <LoadingScreen
            phase={overlayPhase}
            chrom={loadingChrom}
            fileName={loadingFileName}
            sourceDetails={sourceDetails}
            errorMessage={
              overlayPhase === 'error' ? (prepareError ?? viewerLoadError ?? undefined) : undefined
            }
          />
        </div>
      )}
    </>
  );
}

function IndexedGenomeTabFindBar({
  sequenceSearchReady,
  isActive,
  search,
  assemblyAnnotationSearchReady,
  assemblyAnnotationSearchNotApplicable,
  themeMode,
}: {
  sequenceSearchReady: boolean;
  isActive: boolean;
  search: UseGenomeSearchReturn;
  assemblyAnnotationSearchReady: boolean;
  assemblyAnnotationSearchNotApplicable: boolean;
  themeMode: 'light' | 'dark';
}) {
  if (!sequenceSearchReady || !isActive) return null;
  const searchErrorMessage: UserMessage | null = search.errorMessage;
  return (
    <div style={{ display: search.isOpen ? undefined : 'none' }}>
      <FindBar
        query={search.query}
        mode={search.mode}
        minQueryLength={search.minQueryLength}
        matchCount={search.matchCount}
        isTruncated={search.isTruncated}
        activeIndex={search.activeIndex}
        isActiveReverse={search.isActiveReverse}
        isSearching={search.isSearching}
        isError={search.isError}
        errorMessage={searchErrorMessage}
        matches={search.matches}
        modeToggleDisabled={!assemblyAnnotationSearchReady}
        modeToggleDisabledReason={
          assemblyAnnotationSearchNotApplicable
            ? userMessage('sequenceSearch.noAnnotations')
            : userMessage('sequenceSearch.annotationsPending')
        }
        onQueryChange={search.setQuery}
        onModeChange={(mode) => {
          if (mode === 'aminoAcid' && !assemblyAnnotationSearchReady) return;
          search.setMode(mode);
        }}
        onNext={search.next}
        onPrev={search.prev}
        onClose={search.close}
        onActivateMatch={search.goToMatch}
        resolveAnnotationBadgeStyle={(match) =>
          annotationTypeBadgeStyle(indexedAnnotationBadgeType(match), themeMode)
        }
      />
    </div>
  );
}

function loadingSourceDetails(input: {
  assembly: GenomeAssembly | undefined;
  length: number;
  sourceSizeBytes: number | undefined;
  tabFileSizeBytes: number | undefined;
}): string | undefined {
  if (input.assembly) {
    const count = input.assembly.chromosomes.length;
    return `${formatLengthForPicker(input.length)} genomic span · ${count} ${
      count === 1 ? 'chromosome' : 'chromosomes'
    }`;
  }
  const sourceSize = input.sourceSizeBytes ?? input.tabFileSizeBytes;
  return sourceSize ? `${formatFileSize(sourceSize)} on disk` : undefined;
}

interface LoadingScreenProps {
  phase: Exclude<LoadPhase, 'ready'>;
  chrom: string;
  fileName: string;
  sourceDetails?: string;
  errorMessage?: UserMessage;
}

function LoadingScreen({
  phase,
  chrom,
  fileName,
  sourceDetails,
  errorMessage,
}: LoadingScreenProps) {
  const headline = LOADING_HEADLINES[phase].replace('{chrom}', chrom);
  const currentStep = phase === 'error' ? null : LOADING_STEPS[phase];
  const subline =
    phase === 'error'
      ? toUserMessage(errorMessage, 'tracks.loadFailed')
      : userMessageWithValues(
          phase === 'indexing' ? 'genome.indexingSource' : 'genome.loadingSource',
          {
            file: userMessageValue(userEntityLabel(fileName)),
            details: userMessageValue(sourceDetails ? ` · ${sourceDetails}` : ''),
          }
        );

  return (
    <div
      className="h-full flex items-center justify-center bg-bg p-6"
      data-testid="indexed-genome-loading"
      data-load-phase={phase}
    >
      <div className="w-full max-w-lg space-y-4 text-center">
        {phase === 'error' ? (
          <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full border border-red-500/40 text-red-500">
            !
          </div>
        ) : (
          <div className="mx-auto h-9 w-9 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        )}
        <div>
          <h2 className="text-base font-medium text-fg">{headline}</h2>
          <p className="mt-2 text-sm text-fg-muted break-words">{subline}</p>
        </div>
        {currentStep && (
          <div className="mx-auto w-full max-w-sm space-y-2">
            <p role="status" aria-live="polite" className="text-xs text-fg-muted">
              {`Current step: ${currentStep}`}
            </p>
            <progress
              aria-label="Genome preparation progress"
              aria-valuetext={currentStep}
              className="h-1.5 w-full overflow-hidden rounded-full accent-accent"
            />
          </div>
        )}
      </div>
    </div>
  );
}

const LOADING_HEADLINES: Record<Exclude<LoadPhase, 'ready'>, string> = {
  indexing: 'Indexing {chrom}',
  opening: 'Opening {chrom}',
  'loading-data': 'Loading {chrom}',
  error: "Couldn't open {chrom}",
};

const LOADING_STEPS: Record<Exclude<LoadPhase, 'ready' | 'error'>, string> = {
  indexing: 'Building genome index',
  opening: 'Opening indexed files',
  'loading-data': 'Loading initial view',
};
