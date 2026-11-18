import { rendererIpc } from '../shared/ipc-contract';
import type {
  AssemblyAnnotationProductSetInventoryReadRequestV1,
  AssemblyAnnotationProductSetInventoryReadResultV1,
  AssemblyAnnotationRasterReadRequestV2,
  AssemblyAnnotationRasterReadResultV2,
  AssemblyAnnotationSceneDetailReadRequestV1,
  AssemblyAnnotationSceneDetailWireReadResultV1,
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSceneWireReadResult,
  AssemblyAnnotationSceneWriteRequest,
  AssemblyAnnotationSceneWriteResult,
  AssemblyAnnotationSearchCancelRequestV1,
  AssemblyAnnotationSearchQueryRequestV1,
  AssemblyAnnotationSearchQueryResultV1,
  AssemblyCompiledBroadRasterCellsRequestV1,
  AssemblyCompiledBroadRasterCellsResultV1,
  AssemblyCompiledBroadRasterManifestRequestV1,
  AssemblyCompiledBroadRasterManifestResultV1,
  AssemblyCompiledBroadInteractionWireHitResultV1,
  AssemblyFeaturesReadRequest,
  AssemblyFeaturesWriteRequest,
  AssemblyFeaturesWriteResult,
  AssemblyOverviewFeaturesReadResult,
  AssemblyOverviewRequest,
  AssemblyOverviewResult,
  AssemblyOverviewTextureReadResult,
  AssemblyProteinSearchCancelRequestV1,
  AssemblyProteinSearchQueryRequestV1,
  AssemblyProteinSearchQueryResultV1,
  AssemblySequenceSearchRequestV1,
  AssemblySequenceSearchResultV1,
  AssemblyTextureReadRequest,
  AssemblyTextureWriteRequest,
  AssemblyTextureWriteResult,
  GenomeAnnotationTileRequest,
  GenomeCancelRequestResult,
  GenomeDebugSnapshot,
  GenomeFeature,
  GenomeFeatureDetails,
  GenomeFeatureDetailsRequest,
  GenomeOpenSource,
  GenomeSearchHit,
  GenomeSearchOptions,
  GenomeSearchRequestIdentityV1,
  GenomeSequenceWindow,
  GenomeSequenceWindowRequest,
  GenomeSessionShell,
  GenomeSessionReleaseResult,
  GenomeTileRequest,
  GenomeTrackTile,
  IndexedGenomeManifest,
} from '../shared/indexed-genome';

export function createIndexedGenomeIpc() {
  const api = {
    genome: {
      open: (source: GenomeOpenSource): Promise<GenomeSessionShell> =>
        rendererIpc.invoke('genome:open', source),
      closeSession: (sessionId: string): Promise<GenomeSessionReleaseResult> =>
        rendererIpc.invoke('genome:closeSession', sessionId),
      upgradeSessionCapabilities: (
        sessionId: string,
        source: GenomeOpenSource
      ): Promise<GenomeSessionShell> =>
        rendererIpc.invoke('genome:upgradeSessionCapabilities', sessionId, source),
      getAssemblyOverview: (input: AssemblyOverviewRequest): Promise<AssemblyOverviewResult> =>
        rendererIpc.invoke('genome:getAssemblyOverview', input),
      readAssemblyOverviewTexture: (
        input: AssemblyTextureReadRequest
      ): Promise<AssemblyOverviewTextureReadResult | null> =>
        rendererIpc.invoke('genome:readAssemblyOverviewTexture', input),
      readAssemblyAnnotationRasterV2: (
        input: AssemblyAnnotationRasterReadRequestV2
      ): Promise<AssemblyAnnotationRasterReadResultV2 | null> =>
        rendererIpc.invoke('genome:readAssemblyAnnotationRasterV2', input),
      prepareAssemblyAnnotationAppearanceV1: (
        input: import('../shared/indexed-genome').AssemblyAnnotationAppearancePrepareRequestV1
      ) => rendererIpc.invoke('genome:prepareAssemblyAnnotationAppearanceV1', input),
      readAssemblyCompiledBroadRasterManifestV1: (
        input: AssemblyCompiledBroadRasterManifestRequestV1
      ): Promise<AssemblyCompiledBroadRasterManifestResultV1 | null> =>
        rendererIpc.invoke('genome:readAssemblyCompiledBroadRasterManifestV1', input),
      readAssemblyCompiledBroadRasterCellsV1: (
        input: AssemblyCompiledBroadRasterCellsRequestV1
      ): Promise<AssemblyCompiledBroadRasterCellsResultV1> =>
        rendererIpc.invoke('genome:readAssemblyCompiledBroadRasterCellsV1', input),
      writeAssemblyOverviewTexture: (
        input: AssemblyTextureWriteRequest
      ): Promise<AssemblyTextureWriteResult | null> =>
        rendererIpc.invoke('genome:writeAssemblyOverviewTexture', input),
      readAssemblyAnnotationScene: (
        input: AssemblyAnnotationSceneReadRequest
      ): Promise<AssemblyAnnotationSceneWireReadResult | null> =>
        rendererIpc.invoke('genome:readAssemblyAnnotationScene', input),
      readAssemblyAnnotationSceneDetailV1: (
        input: AssemblyAnnotationSceneDetailReadRequestV1
      ): Promise<AssemblyAnnotationSceneDetailWireReadResultV1 | null> =>
        rendererIpc.invoke('genome:readAssemblyAnnotationSceneDetailV1', input),
      readAssemblyCompiledBroadInteractionV1: (
        input: AssemblyAnnotationSceneReadRequest
      ): Promise<AssemblyCompiledBroadInteractionWireHitResultV1 | null> =>
        rendererIpc.invoke('genome:readAssemblyCompiledBroadInteractionV1', input),
      queryAssemblyAnnotationSearch: (
        input: AssemblyAnnotationSearchQueryRequestV1
      ): Promise<AssemblyAnnotationSearchQueryResultV1 | null> =>
        rendererIpc.invoke('genome:queryAssemblyAnnotationSearch', input),
      cancelAssemblyAnnotationSearch: (
        input: AssemblyAnnotationSearchCancelRequestV1
      ): Promise<boolean> => rendererIpc.invoke('genome:cancelAssemblyAnnotationSearch', input),
      queryAssemblyProteinSearch: (
        input: AssemblyProteinSearchQueryRequestV1
      ): Promise<AssemblyProteinSearchQueryResultV1 | null> =>
        rendererIpc.invoke('genome:queryAssemblyProteinSearch', input),
      cancelAssemblyProteinSearch: (
        input: AssemblyProteinSearchCancelRequestV1
      ): Promise<boolean> => rendererIpc.invoke('genome:cancelAssemblyProteinSearch', input),
      readAssemblyAnnotationProductSetInventoryV1: (
        input: AssemblyAnnotationProductSetInventoryReadRequestV1
      ): Promise<AssemblyAnnotationProductSetInventoryReadResultV1> =>
        rendererIpc.invoke('genome:readAssemblyAnnotationProductSetInventoryV1', input),
      writeAssemblyAnnotationScene: (
        input: AssemblyAnnotationSceneWriteRequest
      ): Promise<AssemblyAnnotationSceneWriteResult | null> =>
        rendererIpc.invoke('genome:writeAssemblyAnnotationScene', input),
      readAssemblyOverviewFeatures: (
        input: AssemblyFeaturesReadRequest
      ): Promise<AssemblyOverviewFeaturesReadResult | null> =>
        rendererIpc.invoke('genome:readAssemblyOverviewFeatures', input),
      writeAssemblyOverviewFeatures: (
        input: AssemblyFeaturesWriteRequest
      ): Promise<AssemblyFeaturesWriteResult | null> =>
        rendererIpc.invoke('genome:writeAssemblyOverviewFeatures', input),
      init: (manifest: IndexedGenomeManifest): Promise<{ length: number }> =>
        rendererIpc.invoke('genome:init', manifest),
      getTrackTile: (
        sessionId: string,
        request: GenomeTileRequest,
        requestId?: string
      ): Promise<GenomeTrackTile> =>
        rendererIpc.invoke('genome:getTrackTile', sessionId, request, requestId),
      getAnnotationTile: (
        sessionId: string,
        request: GenomeAnnotationTileRequest,
        requestId?: string
      ): Promise<GenomeTrackTile> =>
        rendererIpc.invoke('genome:getAnnotationTile', sessionId, request, requestId),
      getDebugSnapshot: (sessionId: string): Promise<GenomeDebugSnapshot> =>
        rendererIpc.invoke('genome:getDebugSnapshot', sessionId),
      getSession: (sessionId: string): Promise<GenomeSessionShell> =>
        rendererIpc.invoke('genome:getSession', sessionId),
      cancelRequest: (sessionId: string, requestId: string): Promise<GenomeCancelRequestResult> =>
        rendererIpc.invoke('genome:cancelRequest', sessionId, requestId),
      getFeatureDetails: (
        sessionId: string,
        request: GenomeFeatureDetailsRequest,
        requestId?: string
      ): Promise<GenomeFeatureDetails> =>
        rendererIpc.invoke('genome:getFeatureDetails', sessionId, request, requestId),
      getFeatureDetailsByManifest: (
        manifest: IndexedGenomeManifest,
        request: GenomeFeatureDetailsRequest
      ): Promise<GenomeFeatureDetails> =>
        rendererIpc.invoke('genome:getFeatureDetailsByManifest', manifest, request),
      getSequenceWindow: (
        sessionId: string,
        request: GenomeSequenceWindowRequest,
        requestId?: string
      ): Promise<GenomeSequenceWindow> =>
        rendererIpc.invoke('genome:getSequenceWindow', sessionId, request, requestId),
      getSequence: (
        manifest: IndexedGenomeManifest,
        chrom: string,
        start: number,
        end: number
      ): Promise<string> => rendererIpc.invoke('genome:getSequence', manifest, chrom, start, end),
      getFeatures: (
        manifest: IndexedGenomeManifest,
        chrom: string,
        start: number,
        end: number,
        zoomLevel: number
      ): Promise<GenomeFeature[]> =>
        rendererIpc.invoke('genome:getFeatures', manifest, chrom, start, end, zoomLevel),
      searchSequence: (
        manifest: IndexedGenomeManifest,
        chrom: string,
        motif: string,
        opts: GenomeSearchOptions | undefined,
        control: GenomeSearchRequestIdentityV1
      ): Promise<GenomeSearchHit[]> =>
        rendererIpc.invoke('genome:searchSequence', manifest, chrom, motif, opts, control),
      searchAssemblySequence: (
        request: AssemblySequenceSearchRequestV1
      ): Promise<AssemblySequenceSearchResultV1> =>
        rendererIpc.invoke('genome:searchAssemblySequence', request),
      cancelSequenceSearch: (request: GenomeSearchRequestIdentityV1): Promise<boolean> =>
        rendererIpc.invoke('genome:cancelSequenceSearch', request),
    },
  };
  return api.genome;
}
