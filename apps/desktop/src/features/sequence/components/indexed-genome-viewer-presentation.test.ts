import { describe, expect, it } from 'vitest';

import { COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 } from '@waypoint/genome-renderer';

import { ASSEMBLY_REFERENCE_ASSET_GENERATION_V1 } from '../../../shared/indexed-genome';
import type { AssemblyAnnotationSceneSourceRequest } from '../../../shared/indexed-genome';

import type { AnnotationSearchReveal } from '../annotation-search-reveal';
import {
  admittedAnnotationSceneSourceIdentity,
  admittedAnnotationSourceFingerprint,
  annotationPreparationUiState,
  annotationPresentationPolicyKey,
  annotationPresentationSnapshotForMap,
  annotationPresentationSourceIdentity,
  annotationResidentPagePublicationForMap,
  annotationSummarySourceRecordCount,
  assemblyDisplayName,
  assemblyShellAnnotationSourcePlacementProvenance,
  compiledBroadMaxSupportedFiniteLaneLimit,
  compiledBroadBootstrapTrackType,
  compiledBroadOverviewTexture,
  compiledBroadOverviewTextureStatus,
  compiledBroadOwnsSceneViewport,
  compiledBroadRasterSourceRequest,
  compiledBroadRasterThemeMode,
  compiledBroadSelectedTargetRosterKey,
  compiledResidentOwnerReadinessScopeKey,
  createIndexedGenomeViewerInstanceId,
  descriptorAnnotationSourceIdentity,
  firstPresent,
  indexedGenomeMapCanvasWidth,
  indexedGenomeMapSequenceWindow,
  indexedGenomeViewerIsDeferred,
  isActivePrepackedMrnaPresentation,
  isCompiledBroadOwnedAssembly,
  isExactMrnaLayerContract,
  isIndexedGenomeAnnotationOwnerPending,
  isIndexedGenomeAssemblyRoutingEnabled,
  isPendingAnnotationRasterReady,
  laneAssemblyId,
  livePresentedPrepackedOwnerMatch,
  nextRetainedAnnotationSourceIdentity,
  overviewAnnotationAuthorityComplete,
  pendingAnnotationRasterCommitted,
  pendingAnnotationTargetCache,
  prepackedAnnotationLayoutOwnerKey,
  prepackedSceneEffectiveLayerTypes,
  presentationAnnotationMapperPolicy,
  presentationCacheForCompiledBroad,
  presentationPolicyRequestId,
  raiseSearchLaneLimitAction,
  rendererAnnotationSearchFocusForMap,
  rendererGenomeForMap,
  rendererGenomeSourceIdentity,
  residentCoordinatePagesCoverSceneViewport,
  retainCompiledBroadTrackMountTypes,
  sceneAnnotationViewportTileForAssembly,
  sceneAnnotationViewportTilesForAssembly,
  shouldClearCompatibilityProjection,
  stickyActivatedTick,
  stickyTrue,
  suppliedOrLocalAnnotationMapperPolicy,
  temporaryAnnotationRevealProps,
  visibleAnnotationSearchFocusProps,
  viewerDevicePixelRatio,
  type RetainedAssemblyAnnotationSourceIdentity,
} from './indexed-genome-viewer-presentation';

const UNAVAILABLE_REVEAL: AnnotationSearchReveal = {
  kind: 'unavailable',
  focusRange: null,
};

function sourceRequest(
  extra: Partial<AssemblyAnnotationSceneSourceRequest> = {}
): AssemblyAnnotationSceneSourceRequest {
  return {
    assemblyId: 'grch38',
    workspaceRoot: '/references/grch38',
    chromosomes: [{ chrom: 'chr1', length: 1000, sourcePath: 'chr1.gff3.gz' }],
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'chr1', length: 1000, annotationCoverage: 'sourced' }],
    },
    ...extra,
  };
}

describe('indexed-genome-viewer presentation helpers', () => {
  it('admits a dataset-contract source identity and ignores source-only requests', () => {
    const sha = 'a'.repeat(64);
    expect(
      admittedAnnotationSceneSourceIdentity({
        datasetContract: { sourceSha256: sha },
      })
    ).toBe(`assembly-annotation-source-sha256.v1:${sha}`);
    expect(admittedAnnotationSceneSourceIdentity({ assemblyId: 'hg38' })).toBeNull();
    expect(admittedAnnotationSceneSourceIdentity(null)).toBeNull();
  });

  it('prefers admitted identity over a trimmed descriptor identity', () => {
    expect(descriptorAnnotationSourceIdentity('admitted', '  descriptor  ')).toBe('admitted');
    expect(descriptorAnnotationSourceIdentity(null, '  descriptor  ')).toBe('descriptor');
    expect(descriptorAnnotationSourceIdentity(null, '   ')).toBeNull();
    expect(descriptorAnnotationSourceIdentity(null, undefined)).toBeNull();
  });

  it('exposes a hit-cache fingerprint only', () => {
    expect(
      admittedAnnotationSourceFingerprint({ status: 'hit', result: { fingerprint: 'abc' } })
    ).toBe('abc');
    expect(admittedAnnotationSourceFingerprint({ status: 'hit', result: null })).toBeNull();
    expect(
      admittedAnnotationSourceFingerprint({ status: 'miss', result: { fingerprint: 'abc' } })
    ).toBeNull();
  });

  it('retains source identity only while the source scope stays put', () => {
    const retained: RetainedAssemblyAnnotationSourceIdentity = {
      sourceScopeKey: 'scope-a',
      sourceIdentity: 'old',
    };
    expect(nextRetainedAnnotationSourceIdentity(null, 'fresh', retained)).toEqual({
      retained: null,
      stableIdentity: null,
    });
    expect(nextRetainedAnnotationSourceIdentity('scope-a', 'fresh', retained)).toEqual({
      retained: { sourceScopeKey: 'scope-a', sourceIdentity: 'fresh' },
      stableIdentity: 'fresh',
    });
    expect(nextRetainedAnnotationSourceIdentity('scope-a', null, retained)).toEqual({
      retained,
      stableIdentity: 'old',
    });
    expect(nextRetainedAnnotationSourceIdentity('scope-b', null, retained)).toEqual({
      retained: { sourceScopeKey: 'scope-b', sourceIdentity: null },
      stableIdentity: null,
    });
  });

  it('detects compiled-broad ownership and assembly routing', () => {
    expect(isCompiledBroadOwnedAssembly({ id: 'a' }, { identityKey: 'k' })).toBe(true);
    expect(isCompiledBroadOwnedAssembly(null, { identityKey: 'k' })).toBe(false);
    expect(isIndexedGenomeAssemblyRoutingEnabled({ id: 'a' }, [{ chrom: 'chr1' }])).toBe(true);
    expect(isIndexedGenomeAssemblyRoutingEnabled({ id: 'a' }, [])).toBe(false);
    expect(isIndexedGenomeAssemblyRoutingEnabled(null, [{ chrom: 'chr1' }])).toBe(false);
  });

  it('clamps mapper policy and lane capability to the compiled-broad contract', () => {
    const local = { isoformMode: 'canonical' as const, laneLimit: 2 };
    const controlled = { isoformMode: 'expanded' as const, laneLimit: 4 };
    expect(suppliedOrLocalAnnotationMapperPolicy(undefined, local)).toBe(local);
    expect(suppliedOrLocalAnnotationMapperPolicy(controlled, local)).toBe(controlled);
    expect(compiledBroadMaxSupportedFiniteLaneLimit({ identityKey: 'k' })).toBe(
      COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
    );
    expect(compiledBroadMaxSupportedFiniteLaneLimit(null)).toBeNull();
  });

  it('selects a pending annotation cache only while a request is in flight', () => {
    const cache = { status: 'hit' as const };
    expect(pendingAnnotationTargetCache({ policy: { laneLimit: 1 } }, () => cache)).toBe(cache);
    expect(pendingAnnotationTargetCache(null, () => cache)).toBeNull();
  });

  it('recognizes the exact mRNA layer contract and joins the readiness scope', () => {
    expect(isExactMrnaLayerContract(null, ['mRNA'])).toBe(true);
    expect(isExactMrnaLayerContract({ identityKey: 'k' }, ['mRNA'])).toBe(false);
    expect(isExactMrnaLayerContract(null, ['mRNA', 'gene'])).toBe(false);
    expect(
      compiledResidentOwnerReadinessScopeKey({
        identityKey: null,
        sourceScopeKey: null,
        runtimeCacheKey: undefined,
        assetGenerationKey: 'gen',
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 2,
      })
    ).toBe(['not-compiled', 'no-source-scope', 'no-scene-descriptor', 'gen', 1, 2].join('\n'));
  });

  it('keys the compiled-broad roster only when the selected set is ready', () => {
    expect(
      compiledBroadSelectedTargetRosterKey(true, [
        { trackType: 'mRNA', receipt: { targetIdentityKey: 'a' } },
      ])
    ).toBe('mRNA:a');
    expect(compiledBroadSelectedTargetRosterKey(false, [])).toBeNull();
    expect(overviewAnnotationAuthorityComplete(false, true)).toBe(true);
    expect(overviewAnnotationAuthorityComplete(false, false)).toBe(false);
  });

  it('treats missing viewport or requirement as not owning the scene', () => {
    expect(
      compiledBroadOwnsSceneViewport({
        requirement: null,
        sceneViewportRange: { start: 0, end: 1_000 },
        containerWidth: 800,
      })
    ).toBe(false);
    expect(
      compiledBroadOwnsSceneViewport({
        requirement: { broadCorridorFinestSpanBp: 1 },
        sceneViewportRange: null,
        containerWidth: 800,
      })
    ).toBe(false);
  });

  it('covers a viewport only when one resident page fully contains it', () => {
    const range = { start: 100, end: 200 };
    expect(residentCoordinatePagesCoverSceneViewport(null, [{ startBp: 0, endBp: 400 }])).toBe(
      false
    );
    expect(residentCoordinatePagesCoverSceneViewport(range, [{ startBp: 100, endBp: 200 }])).toBe(
      true
    );
    expect(residentCoordinatePagesCoverSceneViewport(range, [{ startBp: 150, endBp: 180 }])).toBe(
      false
    );
  });

  it('marks annotation-owner pending only in the compiled-broad gap', () => {
    expect(
      isIndexedGenomeAnnotationOwnerPending({
        annotationsVisible: true,
        compiledBroadSurfaceRequirement: { identityKey: 'k' },
        sceneViewportRange: { start: 0, end: 10 },
        compiledBroadOwnsSceneViewport: false,
        compiledResidentSceneCoversViewport: false,
        residentCoordinatePagesCoverSceneViewport: false,
      })
    ).toBe(true);
    expect(
      isIndexedGenomeAnnotationOwnerPending({
        annotationsVisible: true,
        compiledBroadSurfaceRequirement: { identityKey: 'k' },
        sceneViewportRange: { start: 0, end: 10 },
        compiledBroadOwnsSceneViewport: true,
        compiledResidentSceneCoversViewport: false,
        residentCoordinatePagesCoverSceneViewport: false,
      })
    ).toBe(false);
    expect(
      isIndexedGenomeAnnotationOwnerPending({
        annotationsVisible: false,
        compiledBroadSurfaceRequirement: { identityKey: 'k' },
        sceneViewportRange: { start: 0, end: 10 },
        compiledBroadOwnsSceneViewport: false,
        compiledResidentSceneCoversViewport: false,
        residentCoordinatePagesCoverSceneViewport: false,
      })
    ).toBe(false);
  });

  it('creates a debug instance id and sticky activation tick', () => {
    expect(createIndexedGenomeViewerInstanceId()).toEqual(expect.any(String));
    expect(stickyTrue(false, true)).toBe(true);
    expect(stickyTrue(true, false)).toBe(true);
    expect(stickyTrue(false, false)).toBe(false);
    expect(stickyActivatedTick(true)).toBe(1);
    expect(stickyActivatedTick(false)).toBe(0);
    expect(viewerDevicePixelRatio()).toBeGreaterThanOrEqual(1);
  });

  it('falls back assembly lane identity and display name', () => {
    expect(laneAssemblyId('tracks', 'asm', 'chr1')).toBe('tracks');
    expect(laneAssemblyId(undefined, 'asm', 'chr1')).toBe('asm');
    expect(laneAssemblyId(undefined, undefined, 'chr1')).toBe('chr1');
    expect(assemblyDisplayName('Human', 'GRCh38', 'asm')).toBe('Human');
    expect(assemblyDisplayName(undefined, 'GRCh38', 'asm')).toBe('GRCh38');
    expect(assemblyDisplayName(undefined, undefined, 'asm')).toBe('asm');
    expect(firstPresent(undefined, 'mid', 'end')).toBe('mid');
  });

  it('gates pending raster policy until request, status, and policy match', () => {
    const policy = { isoformMode: 'canonical' as const, laneLimit: 2 };
    const pending = { requestId: 7, policy };
    expect(
      isPendingAnnotationRasterReady({
        pendingAnnotationMapperPolicy: pending,
        annotationMapperPolicyRasterPreparation: {
          requestId: 7,
          policy,
          status: 'ready',
        },
      })
    ).toBe(true);
    expect(
      isPendingAnnotationRasterReady({
        pendingAnnotationMapperPolicy: pending,
        annotationMapperPolicyRasterPreparation: {
          requestId: 7,
          policy,
          status: 'loading',
        },
      })
    ).toBe(false);
    expect(
      isPendingAnnotationRasterReady({
        pendingAnnotationMapperPolicy: pending,
        annotationMapperPolicyRasterPreparation: null,
      })
    ).toBe(false);
  });

  it('suppresses overview texture while compiled-broad owns the surface', () => {
    const texture = { image: {} as ImageBitmap, manifest: {} };
    expect(compiledBroadOverviewTexture({ identityKey: 'k' }, texture as never)).toBeNull();
    expect(compiledBroadOverviewTexture(null, texture as never)).toBe(texture);
    expect(compiledBroadOverviewTextureStatus({ identityKey: 'k' }, 'loaded')).toBe(
      'not-applicable'
    );
    expect(compiledBroadOverviewTextureStatus(null, 'loaded')).toBe('loaded');
  });

  it('retains compiled-broad mount types across hides and adds a missing bootstrap', () => {
    const current = { scopeKey: 'scope', trackTypes: new Set(['gene']) };
    const same = retainCompiledBroadTrackMountTypes(current, 'scope', ['mRNA'], 'mRNA');
    expect(same).toBe(current);
    expect([...same.trackTypes].sort()).toEqual(['gene', 'mRNA']);
    const next = retainCompiledBroadTrackMountTypes(current, 'other', ['CDS'], 'gene');
    expect(next.scopeKey).toBe('other');
    expect([...next.trackTypes].sort()).toEqual(['CDS', 'gene']);
  });

  it('keeps the admitted dataset version on every derived compiled-broad track', () => {
    const portable = sourceRequest({
      datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
    });
    const admittedGeneration = {
      contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
      sourceFingerprint: 'source',
      inventoryFingerprint: 'inventory',
      themeMode: 'dark' as const,
    };
    const derived = compiledBroadRasterSourceRequest({
      annotationSceneSourceRequest: null,
      descriptorRequest: portable,
      annotationAssetGeneration: admittedGeneration,
    });
    expect(derived?.datasetVersion).toBe(portable.datasetVersion);
    expect(derived?.expectedAssetGeneration).toEqual(admittedGeneration);
    expect(derived).not.toHaveProperty('artifact');

    const local = compiledBroadRasterSourceRequest({
      annotationSceneSourceRequest: sourceRequest(),
      descriptorRequest: portable,
      annotationAssetGeneration: null,
    });
    expect(local?.datasetVersion).toBeUndefined();
    expect(
      compiledBroadRasterSourceRequest({
        annotationSceneSourceRequest: sourceRequest({ datasetVersion: '   ' }),
        descriptorRequest: null,
        annotationAssetGeneration: null,
      })
    ).toEqual(local);
    expect(
      compiledBroadRasterSourceRequest({
        annotationSceneSourceRequest: null,
        descriptorRequest: null,
        annotationAssetGeneration: null,
      })
    ).toBeNull();
  });

  it('keeps the seed track until a published roster can accept or reject it', () => {
    expect(compiledBroadBootstrapTrackType('mRNA', undefined)).toBe('mRNA');
    expect(compiledBroadBootstrapTrackType('mRNA', ['CDS', 'gene'])).toBeNull();
    expect(compiledBroadBootstrapTrackType('mRNA', ['gene', 'mRNA'])).toBe('mRNA');
  });

  it('commits pending raster policy only after the renderer transaction lands', () => {
    const policy = { isoformMode: 'canonical' as const, laneLimit: 2 };
    const pending = { requestId: 3, policy };
    expect(
      pendingAnnotationRasterCommitted({
        compiledBroadSurfaceRequirement: { identityKey: 'k' },
        annotationRasterPolicyGateEnabled: true,
        pendingAnnotationMapperPolicy: pending,
        annotationRasterAtomicCommit: {
          status: 'committed',
          requestId: 3,
          policy,
        },
      })
    ).toBe(false);
    expect(
      pendingAnnotationRasterCommitted({
        compiledBroadSurfaceRequirement: null,
        annotationRasterPolicyGateEnabled: true,
        pendingAnnotationMapperPolicy: pending,
        annotationRasterAtomicCommit: {
          status: 'committed',
          requestId: 3,
          policy,
        },
      })
    ).toBe(true);
    expect(
      pendingAnnotationRasterCommitted({
        compiledBroadSurfaceRequirement: null,
        annotationRasterPolicyGateEnabled: false,
        pendingAnnotationMapperPolicy: pending,
        annotationRasterAtomicCommit: { status: 'idle', requestId: null, policy: null },
      })
    ).toBe(true);
  });

  it('selects presentation policy, cache, and request id from the commit gate', () => {
    const committed = { isoformMode: 'canonical' as const, laneLimit: 2 };
    const pending = {
      requestId: 9,
      policy: { isoformMode: 'expanded' as const, laneLimit: 4 },
    };
    const cache = { status: 'hit' as const };
    const notApplicable = { status: 'not-applicable' as const };
    expect(presentationAnnotationMapperPolicy(pending, true, committed)).toBe(pending.policy);
    expect(presentationAnnotationMapperPolicy(pending, false, committed)).toBe(committed);
    expect(presentationCacheForCompiledBroad({ identityKey: 'k' }, cache, notApplicable)).toBe(
      notApplicable
    );
    expect(presentationCacheForCompiledBroad(null, cache, notApplicable)).toBe(cache);
    expect(presentationPolicyRequestId(true, pending)).toBe(9);
    expect(presentationPolicyRequestId(false, pending)).toBeNull();
    expect(prepackedSceneEffectiveLayerTypes(true, ['gene', 'mRNA'])).toEqual(['mRNA']);
    expect(prepackedSceneEffectiveLayerTypes(false, ['gene', 'mRNA'])).toEqual(['gene', 'mRNA']);
    expect(compiledBroadRasterThemeMode('dark')).toBe('dark');
    expect(compiledBroadRasterThemeMode(undefined)).toBe('light');
  });

  it('classifies preparation UI and live prepacked presentation', () => {
    expect(annotationPreparationUiState('failed', { requestId: 1 })).toBe('error');
    expect(annotationPreparationUiState('preparing', { requestId: 1 })).toBe('preparing');
    expect(annotationPreparationUiState('idle', null)).toBe('idle');
    expect(livePresentedPrepackedOwnerMatch(null, () => true)).toBeNull();
    expect(livePresentedPrepackedOwnerMatch({ receipt: 'r' }, () => true)).toBe(true);
    expect(
      isActivePrepackedMrnaPresentation({
        livePresentedPrepackedOwnerMatch: false,
        exactActive: true,
      })
    ).toBe(false);
    expect(
      isActivePrepackedMrnaPresentation({
        livePresentedPrepackedOwnerMatch: null,
        exactActive: true,
      })
    ).toBe(true);
  });

  it('clears compatibility projection once compiled-broad owns the assembly', () => {
    expect(shouldClearCompatibilityProjection(true, { resolverOutput: null })).toBe(true);
    expect(shouldClearCompatibilityProjection(true, null)).toBe(false);
    expect(shouldClearCompatibilityProjection(false, { resolverOutput: null })).toBe(false);
  });

  it('picks map genome, source identity, and presentation sidecars', () => {
    const assemblyShell = { name: 'asm', sourceIdentity: 'src-a', length: 100 };
    const tileGenome = { name: 'chr1', sourceIdentity: undefined, length: 50 };
    expect(rendererGenomeForMap({ id: 'a' }, assemblyShell, tileGenome)).toBe(assemblyShell);
    expect(rendererGenomeForMap(null, assemblyShell, tileGenome)).toBe(tileGenome);
    expect(rendererGenomeSourceIdentity(tileGenome)).toBe('chr1');
    expect(rendererGenomeSourceIdentity(null)).toBeNull();
    expect(
      annotationPresentationSourceIdentity({
        compiledBroadOwnsAssembly: true,
        stableAnnotationSourceIdentity: null,
        annotationSourceScopeKey: 'scope',
        rendererAssemblyId: 'asm',
        tileNativeRendererGenome: tileGenome,
      })
    ).toBe('scope');
    expect(
      annotationPresentationSourceIdentity({
        compiledBroadOwnsAssembly: false,
        stableAnnotationSourceIdentity: null,
        annotationSourceScopeKey: 'scope',
        rendererAssemblyId: 'asm',
        tileNativeRendererGenome: tileGenome,
      })
    ).toBe('chr1');
    expect(annotationPresentationPolicyKey({ id: 'a' }, 'stream')).toBe('stream');
    expect(annotationPresentationPolicyKey(null, 'stream')).toBeNull();
    expect(
      assemblyShellAnnotationSourcePlacementProvenance({ identityKey: 'k' }, 'prov')
    ).toBeNull();
    expect(assemblyShellAnnotationSourcePlacementProvenance(null, 'prov')).toBe('prov');
    const snapshot = { sourceIdentity: 'src-a', genomeLengthBp: 100 };
    expect(annotationPresentationSnapshotForMap(false, snapshot, 'src-a', 100)).toBe(snapshot);
    expect(annotationPresentationSnapshotForMap(true, snapshot, 'src-a', 100)).toBeUndefined();
    const pages = { sourceIdentity: 'src-a', genomeLengthBp: 100 };
    expect(annotationResidentPagePublicationForMap(pages, 'src-a', 100)).toBe(pages);
    expect(annotationResidentPagePublicationForMap(pages, 'other', 100)).toBeUndefined();
  });

  it('suppresses legacy viewport tiles and search focus on assemblies', () => {
    const tile = { startBp: 0, endBp: 10 };
    const tiles = [tile];
    const focus = { trackId: 'mRNA' };
    expect(sceneAnnotationViewportTileForAssembly({ id: 'a' }, tile)).toBeNull();
    expect(sceneAnnotationViewportTileForAssembly(null, tile)).toBe(tile);
    expect(sceneAnnotationViewportTilesForAssembly({ id: 'a' }, tiles)).toEqual([]);
    expect(sceneAnnotationViewportTilesForAssembly(null, tiles)).toBe(tiles);
    expect(rendererAnnotationSearchFocusForMap({ id: 'a' }, null, focus)).toBe(focus);
    expect(rendererAnnotationSearchFocusForMap(null, null, focus)).toBeNull();
    expect(rendererAnnotationSearchFocusForMap(null, { id: 'f' }, focus)).toBe(focus);
  });

  it('builds gutter search-reveal props and map surface values', () => {
    const raise = () => undefined;
    const show = () => undefined;
    const temporary: AnnotationSearchReveal = {
      kind: 'temporary',
      focusRange: [1, 2],
      trackId: 'enhancer',
      featureType: 'enhancer',
      canonicalIdentity: 'enhancer:1',
    };
    const visible: AnnotationSearchReveal = {
      kind: 'visible',
      focusRange: [1, 2],
      trackId: 'mRNA',
      featureType: 'mRNA',
      canonicalIdentity: 'NM_1',
    };
    expect(temporaryAnnotationRevealProps(temporary, show)).toEqual({
      trackId: 'enhancer',
      onShowTrack: show,
    });
    expect(temporaryAnnotationRevealProps(UNAVAILABLE_REVEAL, show)).toBeNull();
    expect(visibleAnnotationSearchFocusProps(visible, 2, 8, raise)).toEqual({
      trackId: 'mRNA',
      canonicalIdentity: 'NM_1',
      onKeepAdditionalLane: raise,
    });
    expect(
      visibleAnnotationSearchFocusProps(visible, 8, 8, raise)?.onKeepAdditionalLane
    ).toBeUndefined();
    expect(raiseSearchLaneLimitAction(null, 8)).toBe(false);
    expect(prepackedAnnotationLayoutOwnerKey(true, { receipt: { ownerKey: 'o1' } })).toBe(
      'prepacked-owner:o1'
    );
    expect(prepackedAnnotationLayoutOwnerKey(true, null)).toBeNull();
    expect(
      indexedGenomeViewerIsDeferred({
        stateKind: 'loading',
        rendererAssembly: null,
        assemblyRendererGenomeShell: null,
        tileNativeRendererGenome: {},
        activeFilteredRendererFeatures: {},
        activeTileNativeScene: {},
      })
    ).toBe(true);
    expect(
      indexedGenomeViewerIsDeferred({
        stateKind: 'ready',
        rendererAssembly: { id: 'a' },
        assemblyRendererGenomeShell: { name: 'asm' },
        tileNativeRendererGenome: null,
        activeFilteredRendererFeatures: null,
        activeTileNativeScene: null,
      })
    ).toBe(false);
    expect(
      indexedGenomeViewerIsDeferred({
        stateKind: 'ready',
        rendererAssembly: null,
        assemblyRendererGenomeShell: null,
        tileNativeRendererGenome: {},
        activeFilteredRendererFeatures: { features: [] },
        activeTileNativeScene: {},
      })
    ).toBe(false);
    expect(indexedGenomeMapSequenceWindow(true, 'assembly', 'chrom')).toBe('assembly');
    expect(indexedGenomeMapSequenceWindow(false, 'assembly', null)).toBeUndefined();
    expect(indexedGenomeMapCanvasWidth(0)).toBe(800);
    expect(indexedGenomeMapCanvasWidth(1200)).toBe(1200);
    expect(annotationSummarySourceRecordCount({ sourceRecordCount: 4, tileFeatures: [1, 2] })).toBe(
      4
    );
    expect(annotationSummarySourceRecordCount({ tileFeatures: [1, 2] })).toBe(2);
  });
});
