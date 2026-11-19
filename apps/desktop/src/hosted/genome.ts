import { HostedCapabilityError } from './errors';
import type { PlatformBridge } from '../platform/types';
import type { BrowserPreparedReferencesV1 } from './reference-genomes/browser-prepared-references';

export function createHostedGenome(
  references: () => Promise<BrowserPreparedReferencesV1>
): PlatformBridge['genome'] {
  const unavailable = (capability: string): never => {
    throw new HostedCapabilityError(capability);
  };

  return new Proxy(
    {
      open: async (source) => (await references()).open(source),
      closeSession: async (sessionId) => (await references()).closeSession(sessionId),
      upgradeSessionCapabilities: async (sessionId, source) =>
        (await references()).upgradeSessionCapabilities(sessionId, source),
      getAssemblyOverview: async () => unavailable('genome.getAssemblyOverview'),
      readAssemblyOverviewTexture: async () => null,
      readAssemblyAnnotationRasterV2: async () => null,
      prepareAssemblyAnnotationAppearanceV1: async () => ({
        status: 'unavailable',
        reason: 'source-unavailable',
      }),
      readAssemblyCompiledBroadRasterManifestV1: async (request) =>
        (await references()).readAssemblyCompiledBroadRasterManifestV1(request),
      readAssemblyCompiledBroadRasterCellsV1: async (request) =>
        (await references()).readAssemblyCompiledBroadRasterCellsV1(request),
      writeAssemblyOverviewTexture: async () => unavailable('genome.writeAssemblyOverviewTexture'),
      readAssemblyAnnotationScene: async (request, options) =>
        (await references()).readAssemblyAnnotationScene(request, options),
      readAssemblyAnnotationSceneDetailV1: async (request, options) =>
        (await references()).readAssemblyAnnotationSceneDetailV1(request, options),
      readAssemblyCompiledBroadInteractionV1: async (request, options) =>
        (await references()).readAssemblyCompiledBroadInteractionV1(request, options),
      queryAssemblyAnnotationSearch: async () => null,
      cancelAssemblyAnnotationSearch: async () => false,
      queryAssemblyProteinSearch: async () => null,
      cancelAssemblyProteinSearch: async () => false,
      getTrustedAssemblyAnnotationScene: () => null,
      readAssemblyAnnotationProductSetInventoryV1: async (request) =>
        (await references()).readAssemblyAnnotationProductSetInventoryV1(request),
      writeAssemblyAnnotationScene: async () => unavailable('genome.writeAssemblyAnnotationScene'),
      readAssemblyOverviewFeatures: async () => null,
      writeAssemblyOverviewFeatures: async () =>
        unavailable('genome.writeAssemblyOverviewFeatures'),
      init: async () => unavailable('genome.init'),
      getTrackTile: async () => unavailable('genome.getTrackTile'),
      getAnnotationTile: async (sessionId, request, requestId) =>
        (await references()).getAnnotationTile(sessionId, request, requestId),
      getDebugSnapshot: async () => unavailable('genome.getDebugSnapshot'),
      getSession: async (sessionId) => (await references()).getSession(sessionId),
      cancelRequest: async (sessionId, requestId) => ({
        sessionId,
        requestId,
        cancelled: false,
      }),
      getFeatureDetails: async () => unavailable('genome.getFeatureDetails'),
      getFeatureDetailsByManifest: async () => unavailable('genome.getFeatureDetailsByManifest'),
      getSequenceWindow: async (sessionId, request, requestId) =>
        (await references()).getSequenceWindow(sessionId, request, requestId),
      getSequence: async () => unavailable('genome.getSequence'),
      getFeatures: async () => unavailable('genome.getFeatures'),
      searchSequence: async () => unavailable('genome.searchSequence'),
      searchAssemblySequence: async () => unavailable('genome.searchAssemblySequence'),
      cancelSequenceSearch: async () => false,
    } as PlatformBridge['genome'],
    {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
        if (prop in target) return Reflect.get(target, prop, receiver);
        return (..._args: unknown[]) => unavailable(`genome.${String(prop)}`);
      },
    }
  );
}
