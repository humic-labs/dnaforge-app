export {
  type MolstarPlugin,
  type CachedViewer,
  type ActiveMolstarViewer,
  ActiveMolstarViewerError,
  type ActiveMolstarViewerErrorCode,
  viewerCache,
  pendingCreations,
  startCacheCleanup,
  getStructureKey,
  getPaneRendererHostCacheKey,
  getViewerCacheKey,
  clearViewerCache,
  dumpCacheState,
  enforceCacheLimit,
  recordCacheInsert,
  recordPendingCreationAdd,
  recordPendingCreationDelete,
  acquireCachedViewerLease,
  releaseCachedViewerLease,
  PANE_RENDERER_HOST_RELEASE_GRACE_MS,
  deleteCachedViewer,
  getViewerCacheLifecycleDiagnostics,
  clearViewerCacheLifecycleDiagnostics,
  registerActiveWrapper,
  unregisterActiveWrapper,
  hasActiveMolstarViewerHost,
  withActivePlugin,
} from './molstar/cache';

export { createPluginSpec, initializePlugin, setPluginSpin } from './molstar/pluginConfig';

export { buildStructureWithComponents, loadStructure } from './molstar/structureBuilder';

export {
  type CreateViewerBeforeRevealResult,
  type CreateViewerOptions,
} from './molstar/createViewer';

import { createViewerContainer as _createViewerContainer } from './molstar/createViewer';
import type { CreateViewerBeforeRevealResult } from './molstar/createViewer';
import type { MolstarPlugin } from './molstar/cache';
import type { StructureFetchIdentity } from './utils/structureData';

export async function createViewerContainer(
  structureKey: string,
  pdbId?: string,
  uniprotId?: string,
  url?: string,
  structureData?: string | Uint8Array,
  structureIdentity?: StructureFetchIdentity,
  height: number = 400,
  onComplete?: () => void,
  onError?: (error: string) => void,
  onLoad?: () => void,
  onBeforeReveal?: (
    plugin: MolstarPlugin
  ) => CreateViewerBeforeRevealResult | Promise<CreateViewerBeforeRevealResult>,
  onSlowLoad?: () => void,
  structureDataFormat?: 'pdb' | 'mmcif'
) {
  return _createViewerContainer({
    structureKey,
    pdbId,
    uniprotId,
    url,
    structureData,
    structureDataFormat,
    structureIdentity,
    height,
    onBeforeReveal,
    onComplete,
    onError,
    onSlowLoad,
    onLoad,
  });
}
