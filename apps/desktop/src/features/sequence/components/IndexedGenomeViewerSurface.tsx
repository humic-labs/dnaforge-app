import type { SequenceDataLayerTrackControls } from '../data-layers/useSequenceDataLayers';
import type { ComparisonProjectionProps } from './comparison-projection-props';
import type { ContactProjectionProps } from './contact-projection-props';
import type {
  ComponentProps,
  CSSProperties,
  MutableRefObject,
  ReactNode,
  RefCallback,
} from 'react';

import type {
  GenomeAssembly,
  IndexedGenomeManifest,
  TrackAdmissionRequestV1,
} from '@waypoint/genome-data';
import {
  resolveAnnotationTrackIdentity,
  webglThemeForMode,
  webglThemeColorToCss,
  type AnnotationFlatPresentationSnapshot,
  type AnnotationResidentPagePublication,
  type Assembly,
  type Feature,
  type Genome,
} from '@waypoint/genome-renderer';

import type {
  AssemblyAnnotationSceneSourceRequest,
  AssemblyReferenceAssetGenerationV1,
} from '../../../shared/indexed-genome';
import type { AnnotationSearchReveal } from '../annotation-search-reveal';
import type { AnnotationTrackDefinition } from '../annotation-track-registry';
import { AnnotationSummaryStatus } from './AnnotationSummaryStatus';
import {
  AssemblyCompiledAnnotationTrack,
  type IndexedGenomeAnnotationMapperPolicy,
} from './AssemblyCompiledAnnotationTrack';
import type { AssemblyAnnotationPolicyRequest } from './assembly-annotation-policy-transaction';
import type { IndexedGenomeCompatibilityProjection } from './IndexedGenomeCompatibilityScene';
import { IndexedGenomeCompatibilityScene } from './IndexedGenomeCompatibilityScene';
import {
  IndexedGenomeTileNativeMap,
  type IndexedGenomeTileNativeMapHandle,
  type IndexedGenomeSelectedAnnotation,
} from './IndexedGenomeTileNativeMap';
import { IndexedViewerTrackGutter } from './IndexedViewerTrackGutter';
import type { AnnotationTilePending } from './indexed-annotation-tile-policy';
import type { LaneLimit } from './indexed-genome-legacy-adapter';
import type { TranscriptDisplayMode } from './isoform-collapse';
import type { IndexedGenomeViewerSequenceWindowState } from './indexed-genome-viewer-scene-state';
import type { AnnotationViewportTileState } from './indexed-genome-viewer-viewport';
import {
  annotationSummarySourceRecordCount,
  assemblyDisplayName,
  indexedGenomeMapCanvasWidth,
  indexedGenomeMapSequenceWindow,
  indexedGenomeViewerIsDeferred,
  optionalFiniteLaneLimit,
  prepackedAnnotationLayoutOwnerKey,
  temporaryAnnotationRevealProps,
  visibleAnnotationSearchFocusProps,
} from './indexed-genome-viewer-presentation';
import type {
  SequenceViewportRange,
  SequenceWindowPending,
} from './indexed-sequence-window-policy';
import type { LaneScreenBands } from './lane-screen-bands';
import type {
  AssemblyOverviewTexture,
  AssemblyOverviewTextureStatus,
} from './useAssemblyOverviewTexture';
import type { AssemblyPrepackedAnnotationSceneCacheState } from './useAssemblyPrepackedAnnotationSceneCache';
import type { BamTrackImportController } from './useBamTrackImport';
import type { PrepackedAssemblyAnnotationScenePresentationReceipt } from './usePrepackedAssemblyAnnotationScene';
import type { AlignmentReferenceIdentity } from '../alignment-header-client';
import type { AlignedReadTrackStatusSnapshot } from '../aligned-read-track-lifecycle';
import type { PileupSource } from '../pileup-source';

export function AlignedReadRepairNotice({ bamImport }: { bamImport: BamTrackImportController }) {
  if (bamImport.lastOperation !== 'repair' || (!bamImport.busy && !bamImport.notice)) {
    return null;
  }
  const isError = bamImport.notice?.kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-testid="aligned-read-repair-notice"
      data-notice-kind={bamImport.notice?.kind ?? 'progress'}
      className={`absolute left-1/2 top-2 z-30 flex max-w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-md border bg-bg/95 px-3 py-2 text-xs shadow-sm backdrop-blur-sm ${
        isError ? 'border-danger/40 text-danger' : 'border-border text-fg'
      }`}
    >
      <span>{bamImport.busy ?? bamImport.notice?.text}</span>
      {bamImport.notice ? (
        <button
          type="button"
          onClick={bamImport.clearNotice}
          aria-label="Dismiss aligned-read Repair status"
          className="shrink-0 rounded px-1.5 py-0.5 font-semibold hover:bg-bg-muted"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

export function IndexedGenomeAnnotationOwnerPendingNotice({ pending }: { pending: boolean }) {
  if (!pending) return null;
  return (
    <div
      data-testid="indexed-genome-annotation-owner-pending"
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-2 right-2 z-10 rounded-md border border-border bg-bg/90 px-3 py-2 text-xs text-fg-muted shadow-sm"
    >
      Preparing annotation detail for this zoom level…
    </div>
  );
}

type CompatibilitySceneState = ComponentProps<typeof IndexedGenomeCompatibilityScene>['state'];
type MapHandle = IndexedGenomeTileNativeMapHandle;
type CompiledTrackProps = ComponentProps<typeof AssemblyCompiledAnnotationTrack>;

export function IndexedGenomeViewerSurface({
  comparisonProjection,
  comparisonCamera,
  onComparisonCameraChange,
  contactProjection,
  contactCamera,
  contactUnit,
  onContactCameraChange,
  dataLayerControls,
  annotationColorsByIdentity,
  annotationSourceBindings,
  missingAnnotationColor,
  compiledBroadOwnsAssembly,
  state,
  manifest,
  sessionId,
  length,
  height,
  containerWidth,
  glyphV2Enabled,
  rendererAssembly,
  assemblyByChrom,
  assemblyFeatures,
  rendererEffectiveVisibleTypes,
  rendererEffectiveVisibleLayerTypes,
  laneLimit,
  transcriptDisplayMode,
  expandedGeneIds,
  annotationViewportTiles,
  annotationViewportTile,
  pendingAnnotationViewportTile,
  sceneViewportRange,
  sequenceWindow,
  pendingSequenceWindow,
  overviewTexture,
  overviewTextureStatus,
  stableAnnotationSourceIdentity,
  assemblyExactAnnotationCoverage,
  activePrepackedMrnaPresentation,
  presentedPrepackedAnnotationOwner,
  recordEvent,
  onProjectionChange,
  assemblyRendererGenomeShell,
  tileNativeRendererGenome,
  activeFilteredRendererFeatures,
  activeTileNativeScene,
  mountedCompiledBroadTrackTypes,
  compiledBroadTrackMountScopeKey,
  prepackedAnnotationSceneCache,
  annotationAssetGeneration,
  annotationProductPublicationReady,
  compiledBroadRasterSourceRequest,
  annotationInteractionPayloadEnabled,
  annotationInteractionPreparationGeneration,
  compiledBroadRasterThemeMode,
  compiledBroadSurfaceRequirement,
  pendingAnnotationMapperPolicy,
  annotationMapperPolicy,
  rendererReadyEpoch,
  rendererGenomeCommitEpoch,
  annotationDetailRosterAdmissionEpoch,
  webglRef,
  registerCompiledBroadRasterTrackCameraNotifier,
  registerCompiledBroadRasterTrackPolicyRefresher,
  registerCompiledBroadRasterTrackDiagnostics,
  overviewFeaturesComplete,
  handleCompiledBroadRasterPolicyCommitted,
  handleCompiledBroadRasterTrackUnavailable,
  handleCompiledBroadRasterTrackReadinessChanged,
  handleAnnotationDetailRosterAdmission,
  debugInstanceId,
  compiledResidentOwnerReadinessScopeKey,
  laneOwnerId,
  laneAssemblyId,
  assemblyDefinition,
  trackAssemblyReferences,
  visibleTypes,
  toggleAnnotationLane,
  annotationTrackRegistry,
  toggleVisibleType,
  setVisibleTypesFromPicker,
  annotationSearchReveal,
  showTemporarilyRevealedTrack,
  raiseSearchLaneLimitByOne,
  maxSupportedFiniteLaneLimit,
  changeLaneLimit,
  toggleTranscriptDisplayMode,
  annotationPreparationState,
  ucscTrackErrors,
  onRetryUcscTracks,
  pileupTrackStatuses,
  onRetryPileupTrack,
  bamImport,
  onAddVariantTrackRequest,
  onOpenMutationNavigator,
  laneScreenBands,
  canvasHostRef,
  rendererGenomeForMap,
  themeMode,
  annotationPresentationSnapshotForMap,
  annotationResidentPagePublicationForMap,
  rendererAnnotationSearchFocusForMap,
  rendererAnnotationSearchFocusFeature,
  annotationsVisible,
  readSourcesByTrackId,
  hasDataTracks,
  hasQuantitativeTracks,
  hasPileupTracks = false,
  referencePathsByChrom,
  assemblyRoutingEnabled,
  assemblySequenceWindow,
  measuredCanvasHeight,
  handleCameraChange,
  handleRendererReady,
  handleRendererGenomeCommit,
  fullAssemblyInteractionReady,
  selectedAnnotation,
  handleSelectedAnnotationChange,
  onContextMenu,
  onSelectionChange,
  onSelectionClear,
  sequenceOverlays,
  annotationOwnerPending,
}: {
  dataLayerControls?: SequenceDataLayerTrackControls;
  compiledBroadOwnsAssembly: boolean;
  comparisonProjection?: ComparisonProjectionProps['comparisonProjection'];
  comparisonCamera?: ComparisonProjectionProps['comparisonCamera'];
  onComparisonCameraChange?: ComparisonProjectionProps['onComparisonCameraChange'];
  contactProjection?: ContactProjectionProps['contactProjection'];
  contactCamera?: ContactProjectionProps['contactCamera'];
  contactUnit?: ContactProjectionProps['contactUnit'];
  onContactCameraChange?: ContactProjectionProps['onContactCameraChange'];
  annotationColorsByIdentity?: ReadonlyMap<string, string>;
  annotationSourceBindings?: readonly import('@waypoint/genome-renderer/pure').SourceAnnotationAliasBindingV1[];
  missingAnnotationColor?: string;
  state: CompatibilitySceneState;
  manifest: IndexedGenomeManifest;
  sessionId?: string;
  length: number;
  height: number;
  containerWidth: number;
  glyphV2Enabled: boolean;
  rendererAssembly: Assembly | null;
  assemblyByChrom?: ReadonlyMap<string, ReadonlyArray<Feature>>;
  assemblyFeatures?: ReadonlyArray<Feature>;
  rendererEffectiveVisibleTypes: ReadonlySet<string>;
  rendererEffectiveVisibleLayerTypes: string[];
  laneLimit: LaneLimit;
  transcriptDisplayMode: TranscriptDisplayMode;
  expandedGeneIds: ReadonlySet<string>;
  annotationViewportTiles: AnnotationViewportTileState[];
  annotationViewportTile: AnnotationViewportTileState | null | undefined;
  pendingAnnotationViewportTile: AnnotationTilePending | null;
  sceneViewportRange: SequenceViewportRange | null;
  sequenceWindow: IndexedGenomeViewerSequenceWindowState | null;
  pendingSequenceWindow: SequenceWindowPending | null;
  overviewTexture?: AssemblyOverviewTexture | null;
  overviewTextureStatus: AssemblyOverviewTextureStatus;
  stableAnnotationSourceIdentity: string | null;
  assemblyExactAnnotationCoverage: ReadonlyArray<Readonly<{ startBp: number; endBp: number }>>;
  activePrepackedMrnaPresentation: boolean;
  presentedPrepackedAnnotationOwner: {
    receipt: PrepackedAssemblyAnnotationScenePresentationReceipt;
    rendererEpoch: number;
  } | null;
  recordEvent: (event: string, detail?: Record<string, unknown>) => void;
  onProjectionChange: (projection: IndexedGenomeCompatibilityProjection) => void;
  assemblyRendererGenomeShell: Genome | null;
  tileNativeRendererGenome: Genome | null;
  activeFilteredRendererFeatures: object | null | undefined;
  activeTileNativeScene: object | null | undefined;
  mountedCompiledBroadTrackTypes: readonly string[];
  compiledBroadTrackMountScopeKey: string;
  prepackedAnnotationSceneCache: AssemblyPrepackedAnnotationSceneCacheState;
  annotationAssetGeneration: AssemblyReferenceAssetGenerationV1 | null;
  annotationProductPublicationReady: boolean;
  compiledBroadRasterSourceRequest: AssemblyAnnotationSceneSourceRequest | null;
  annotationInteractionPayloadEnabled: boolean;
  annotationInteractionPreparationGeneration: number;
  compiledBroadRasterThemeMode: 'light' | 'dark';
  compiledBroadSurfaceRequirement: {
    identityKey: string;
    genomeLengthBp: number;
    broadCorridorFinestSpanBp: number;
  } | null;
  pendingAnnotationMapperPolicy: AssemblyAnnotationPolicyRequest | null;
  annotationMapperPolicy: IndexedGenomeAnnotationMapperPolicy;
  rendererReadyEpoch: number;
  rendererGenomeCommitEpoch: number;
  annotationDetailRosterAdmissionEpoch: number;
  webglRef: MutableRefObject<MapHandle | null>;
  registerCompiledBroadRasterTrackCameraNotifier: CompiledTrackProps['registerCameraNotifier'];
  registerCompiledBroadRasterTrackPolicyRefresher: CompiledTrackProps['registerPolicyRefresher'];
  registerCompiledBroadRasterTrackDiagnostics: CompiledTrackProps['registerDiagnostics'];
  overviewFeaturesComplete: boolean;
  handleCompiledBroadRasterPolicyCommitted: CompiledTrackProps['onPolicyCommitted'];
  handleCompiledBroadRasterTrackUnavailable: CompiledTrackProps['onPolicyUnavailable'];
  handleCompiledBroadRasterTrackReadinessChanged: CompiledTrackProps['onReadinessChanged'];
  handleAnnotationDetailRosterAdmission: CompiledTrackProps['onDetailRendererAdmission'];
  debugInstanceId: string;
  compiledResidentOwnerReadinessScopeKey: string;
  laneOwnerId: string;
  laneAssemblyId: string;
  assemblyDefinition?: GenomeAssembly;
  trackAssemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  visibleTypes: ReadonlySet<string>;
  toggleAnnotationLane: () => void;
  annotationTrackRegistry: ReadonlyArray<AnnotationTrackDefinition>;
  toggleVisibleType: (type: string) => void;
  setVisibleTypesFromPicker: (types: ReadonlySet<string>) => void;
  annotationSearchReveal: AnnotationSearchReveal;
  showTemporarilyRevealedTrack: () => void;
  raiseSearchLaneLimitByOne: () => void;
  maxSupportedFiniteLaneLimit: number | null;
  changeLaneLimit: (next: LaneLimit) => void;
  toggleTranscriptDisplayMode: () => void;
  annotationPreparationState: 'idle' | 'preparing' | 'error';
  ucscTrackErrors: Readonly<Record<string, string>>;
  onRetryUcscTracks: () => void;
  pileupTrackStatuses: AlignedReadTrackStatusSnapshot;
  onRetryPileupTrack: (trackId: string) => void;
  bamImport: BamTrackImportController;
  onAddVariantTrackRequest?: (request: TrackAdmissionRequestV1) => Promise<void>;
  onOpenMutationNavigator?: () => void;
  laneScreenBands: LaneScreenBands;
  canvasHostRef: RefCallback<HTMLDivElement>;
  rendererGenomeForMap: Genome | null;
  themeMode: 'light' | 'dark';
  annotationPresentationSnapshotForMap: AnnotationFlatPresentationSnapshot | undefined;
  annotationResidentPagePublicationForMap: AnnotationResidentPagePublication | undefined;
  rendererAnnotationSearchFocusForMap: ComponentProps<
    typeof IndexedGenomeTileNativeMap
  >['annotationSearchFocus'];
  rendererAnnotationSearchFocusFeature: Feature | null;
  annotationsVisible: boolean;
  readSourcesByTrackId: ReadonlyMap<string, PileupSource>;
  hasDataTracks: boolean;
  hasQuantitativeTracks: boolean;
  hasPileupTracks?: boolean;
  referencePathsByChrom?: ReadonlyMap<string, string>;
  assemblyRoutingEnabled: boolean;
  assemblySequenceWindow: IndexedGenomeViewerSequenceWindowState | null;
  measuredCanvasHeight: number;
  handleCameraChange: ComponentProps<typeof IndexedGenomeTileNativeMap>['onCameraChange'];
  handleRendererReady: (epoch: number) => void;
  handleRendererGenomeCommit: (epoch: number) => void;
  fullAssemblyInteractionReady: boolean;
  selectedAnnotation: IndexedGenomeSelectedAnnotation | null;
  handleSelectedAnnotationChange: (annotation: IndexedGenomeSelectedAnnotation | null) => void;
  onContextMenu: ComponentProps<typeof IndexedGenomeTileNativeMap>['onContextMenu'];
  onSelectionChange: ComponentProps<typeof IndexedGenomeTileNativeMap>['onSelectionChange'];
  onSelectionClear: ComponentProps<typeof IndexedGenomeTileNativeMap>['onSelectionClear'];
  sequenceOverlays?: ComponentProps<typeof IndexedGenomeTileNativeMap>['sequenceOverlays'];
  annotationOwnerPending: boolean;
}): ReactNode {
  const compatibilityScene = compiledBroadOwnsAssembly ? null : (
    <IndexedGenomeCompatibilityScene
      state={state}
      manifest={manifest}
      sessionId={sessionId}
      length={length}
      height={height}
      containerWidth={containerWidth}
      glyphV2Enabled={glyphV2Enabled}
      rendererAssembly={rendererAssembly}
      assemblyByChrom={assemblyByChrom}
      assemblyFeatures={assemblyFeatures}
      rendererEffectiveVisibleTypes={rendererEffectiveVisibleTypes}
      rendererEffectiveVisibleLayerTypes={rendererEffectiveVisibleLayerTypes}
      laneLimit={laneLimit}
      transcriptDisplayMode={transcriptDisplayMode}
      expandedGeneIds={expandedGeneIds}
      annotationViewportTiles={annotationViewportTiles}
      annotationViewportTile={annotationViewportTile ?? null}
      pendingAnnotationViewportTile={pendingAnnotationViewportTile}
      sceneViewportRange={sceneViewportRange}
      sequenceWindow={sequenceWindow}
      pendingSequenceWindow={pendingSequenceWindow}
      overviewTexture={overviewTexture}
      overviewTextureStatus={overviewTextureStatus}
      stableAnnotationSourceIdentity={stableAnnotationSourceIdentity}
      assemblyExactAnnotationCoverage={assemblyExactAnnotationCoverage}
      prepackedAnnotationLayoutOwnerKey={prepackedAnnotationLayoutOwnerKey(
        activePrepackedMrnaPresentation,
        presentedPrepackedAnnotationOwner
      )}
      recordEvent={recordEvent}
      onProjectionChange={onProjectionChange}
    />
  );

  if (
    indexedGenomeViewerIsDeferred({
      stateKind: state.kind,
      rendererAssembly,
      assemblyRendererGenomeShell,
      tileNativeRendererGenome,
      activeFilteredRendererFeatures,
      activeTileNativeScene,
    }) ||
    !rendererGenomeForMap ||
    state.kind !== 'ready'
  ) {
    return (
      <>
        {compatibilityScene}
        <div data-testid="indexed-genome-viewer-deferred" className="h-full bg-bg" />
      </>
    );
  }

  const trackBackground = webglThemeColorToCss(webglThemeForMode(themeMode).background);
  const trackSurfaceStyle: CSSProperties & { '--indexed-viewer-track-background': string } = {
    backgroundColor: trackBackground,
    '--indexed-viewer-track-background': trackBackground,
  };
  return (
    <>
      {compatibilityScene}
      <div
        className="relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-bg"
        style={trackSurfaceStyle}
        data-testid="indexed-genome-viewer"
        data-viewer-mode={
          comparisonProjection
            ? 'aligned-comparison'
            : contactProjection
              ? 'contact-matrix'
              : 'continuous-overview'
        }
      >
        {mountedCompiledBroadTrackTypes.map((trackType) => (
          <AssemblyCompiledAnnotationTrack
            key={`${compiledBroadTrackMountScopeKey}:${trackType}`}
            trackType={trackType}
            annotationColorsByIdentity={annotationColorsByIdentity}
            prepareAnnotationAliases={dataLayerControls?.annotationSourceAliasesRequired}
            missingAnnotationColor={missingAnnotationColor}
            selected={
              resolveAnnotationTrackIdentity(
                trackType,
                rendererEffectiveVisibleLayerTypes,
                (selectedTrackType) => selectedTrackType
              ).status === 'matched'
            }
            seedCache={prepackedAnnotationSceneCache}
            assetGeneration={annotationAssetGeneration}
            productPublicationReady={annotationProductPublicationReady}
            sourceRequest={compiledBroadRasterSourceRequest}
            interactionPayloadEnabled={annotationInteractionPayloadEnabled}
            interactionPreparationGeneration={annotationInteractionPreparationGeneration}
            themeMode={compiledBroadRasterThemeMode}
            assemblyRequirement={compiledBroadSurfaceRequirement}
            surfacePolicy={pendingAnnotationMapperPolicy?.policy ?? annotationMapperPolicy}
            interactionPolicy={annotationMapperPolicy}
            policyRequestId={pendingAnnotationMapperPolicy?.requestId ?? null}
            rendererReadyEpoch={rendererReadyEpoch}
            rendererGenomeCommitEpoch={rendererGenomeCommitEpoch}
            rendererAdmissionEpoch={annotationDetailRosterAdmissionEpoch}
            webglRef={webglRef}
            recordEvent={recordEvent}
            registerCameraNotifier={registerCompiledBroadRasterTrackCameraNotifier}
            registerPolicyRefresher={registerCompiledBroadRasterTrackPolicyRefresher}
            registerDiagnostics={registerCompiledBroadRasterTrackDiagnostics}
            overviewFeaturesComplete={overviewFeaturesComplete}
            onPolicyCommitted={handleCompiledBroadRasterPolicyCommitted}
            onPolicyUnavailable={handleCompiledBroadRasterTrackUnavailable}
            onReadinessChanged={handleCompiledBroadRasterTrackReadinessChanged}
            onDetailRendererAdmission={handleAnnotationDetailRosterAdmission}
            readinessGeneration={debugInstanceId}
            ownerReadinessScopeKey={compiledResidentOwnerReadinessScopeKey}
            viewportCssWidthPx={containerWidth}
          />
        ))}
        <div className="flex min-h-0 flex-1" data-testid="indexed-genome-visible-viewer">
          <IndexedViewerTrackGutter
            dataLayerControls={dataLayerControls}
            laneOwnerId={laneOwnerId}
            assemblyId={laneAssemblyId}
            assemblyDisplayName={assemblyDisplayName(
              assemblyDefinition?.displayName,
              rendererAssembly?.displayName,
              laneAssemblyId
            )}
            assemblyReferences={trackAssemblyReferences}
            assemblyUcscTrackTarget={assemblyDefinition?.ucscTrackTarget ?? null}
            visibleTypes={visibleTypes}
            onToggleAnnotationLane={toggleAnnotationLane}
            annotationTrackRegistry={annotationTrackRegistry}
            onToggleVisibleType={toggleVisibleType}
            onSetVisibleTypes={setVisibleTypesFromPicker}
            temporaryAnnotationReveal={temporaryAnnotationRevealProps(
              annotationSearchReveal,
              showTemporarilyRevealedTrack
            )}
            visibleAnnotationSearchFocus={visibleAnnotationSearchFocusProps(
              annotationSearchReveal,
              laneLimit,
              maxSupportedFiniteLaneLimit,
              raiseSearchLaneLimitByOne
            )}
            laneLimit={laneLimit}
            onChangeLaneLimit={changeLaneLimit}
            maxSupportedFiniteLaneLimit={optionalFiniteLaneLimit(maxSupportedFiniteLaneLimit)}
            transcriptDisplayMode={transcriptDisplayMode}
            onToggleTranscriptDisplayMode={toggleTranscriptDisplayMode}
            expandedGeneCount={expandedGeneIds.size}
            annotationPreparationState={annotationPreparationState}
            rendererReadyEpoch={rendererReadyEpoch}
            ucscTrackErrors={ucscTrackErrors}
            onRetryUcscTracks={onRetryUcscTracks}
            pileupTrackStatuses={pileupTrackStatuses}
            onRetryPileupTrack={onRetryPileupTrack}
            bamImport={bamImport}
            onAddVariantTrackRequest={onAddVariantTrackRequest}
            onOpenMutationNavigator={onOpenMutationNavigator}
            bands={laneScreenBands}
            webglRef={webglRef}
          />
          <div
            ref={canvasHostRef}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            data-testid="indexed-genome-canvas-host"
          >
            <AlignedReadRepairNotice bamImport={bamImport} />
            <IndexedGenomeTileNativeMap
              comparisonProjection={comparisonProjection}
              comparisonCamera={comparisonCamera}
              onComparisonCameraChange={onComparisonCameraChange}
              contactProjection={contactProjection}
              contactCamera={contactCamera}
              contactUnit={contactUnit}
              onContactCameraChange={onContactCameraChange}
              annotationColorsByIdentity={annotationColorsByIdentity}
              annotationSourceBindings={annotationSourceBindings}
              missingAnnotationColor={missingAnnotationColor}
              ref={webglRef}
              genome={rendererGenomeForMap}
              themeMode={themeMode}
              compiledBroadSurfaceRequirement={compiledBroadSurfaceRequirement ?? undefined}
              annotationPresentationSnapshot={annotationPresentationSnapshotForMap}
              annotationResidentPagePublication={annotationResidentPagePublicationForMap}
              annotationSearchFocus={rendererAnnotationSearchFocusForMap}
              annotationSearchFocusFeature={rendererAnnotationSearchFocusFeature}
              annotationsVisible={annotationsVisible}
              readSourcesByTrackId={readSourcesByTrackId}
              allowSparseCanvasCrop={!hasDataTracks && !contactProjection && !comparisonProjection}
              hasQuantitativeTracks={
                hasQuantitativeTracks || Boolean(contactProjection || comparisonProjection)
              }
              hasPileupTracks={hasPileupTracks}
              canvasLayoutKey={`${rendererEffectiveVisibleLayerTypes.join(',')}:${laneLimit}:${transcriptDisplayMode}`}
              referencePathsByChrom={referencePathsByChrom}
              sequenceWindow={indexedGenomeMapSequenceWindow(
                assemblyRoutingEnabled,
                assemblySequenceWindow,
                sequenceWindow
              )}
              height={measuredCanvasHeight}
              geometryHeight={measuredCanvasHeight}
              width={indexedGenomeMapCanvasWidth(containerWidth)}
              onCameraChange={handleCameraChange}
              onRendererReady={handleRendererReady}
              onRendererGenomeCommit={handleRendererGenomeCommit}
              interactionEnabled={fullAssemblyInteractionReady}
              selectedAnnotation={selectedAnnotation}
              onSelectedAnnotationChange={handleSelectedAnnotationChange}
              onContextMenu={onContextMenu}
              onSelectionChange={onSelectionChange}
              onSelectionClear={onSelectionClear}
              sequenceOverlays={sequenceOverlays}
              syncViewportRangeOnCameraScroll
            />
            <AnnotationSummaryStatus
              state={state.summaryTileState}
              fidelity={state.summaryTileFidelity}
              message={state.summaryTileMessage}
              recordCount={state.tileFeatures.length}
              sourceRecordCount={annotationSummarySourceRecordCount(state)}
            />
            <IndexedGenomeAnnotationOwnerPendingNotice pending={annotationOwnerPending} />
          </div>
        </div>
      </div>
    </>
  );
}
