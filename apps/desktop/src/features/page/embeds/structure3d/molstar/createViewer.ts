import { toUserMessage } from '@waypoint/user-messages';
import type { StructureFetchIdentity } from '../utils/structureData';
import type { CachedViewer, MolstarPlugin } from './cache';
import { initializePlugin, setPluginSpin } from './pluginConfig';
import { loadStructure } from './structureBuilder';
import { createViewerDOM } from './viewerDom';
import { createStructureLoadLifecycle } from './viewerLoadLifecycle';
import {
  waitForDimensions,
  waitForFirstPaintBeforeReveal,
  waitForPluginInteractionReady,
} from './viewerReadiness';
import { createRendererHostActivationState } from './rendererHostActivation';
import { yieldToMain } from './yieldToMain';
import { CANCELLED_VIEWER_LOAD_ERROR } from '../molstar-viewer-error';
import { registerMolecularRenderProfileVisuals } from './nucleotidePresentation';

export {
  MOLSTAR_VIEWER_GENERIC_LOADING_ERROR,
  createMolstarLoadingIndicator,
  formatMolstarLoadingErrorText,
} from './viewerDom';
export {
  STRUCTURE_LOAD_HARD_CEILING_MS,
  STRUCTURE_LOAD_HARD_TIMEOUT_MESSAGE,
  STRUCTURE_LOAD_TIMEOUT_MS,
} from './viewerLoadLifecycle';
export type { StructureLoadLeg, StructureLoadLegTimings } from './viewerLoadLifecycle';
export { structureLoadSizeBucket } from './viewerLoadLifecycle';
export type { StructureLoadSizeBucket } from './viewerLoadLifecycle';
export {
  STRUCTURE_FIRST_PAINT_HARD_CEILING_MS,
  STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE,
} from './viewerReadiness';
export type { CanvasPaintState, FirstPaintReadiness } from './viewerReadiness';

export { CANCELLED_VIEWER_LOAD_ERROR };

export type CreateViewerBeforeRevealResult = void | { status: 'cancelled' };

export interface CreateViewerOptions {
  structureKey: string;
  pdbId?: string;
  uniprotId?: string;
  url?: string;
  structureData?: string | Uint8Array;
  structureDataFormat?: 'pdb' | 'mmcif';
  coordinateModel?: { blockIndex: number; modelIndex: number };
  structureIdentity?: StructureFetchIdentity;
  coordinatesOnly?: boolean;

  coordinateOnlyInitialLoad?: true;
  height?: number;
  onBeforeReveal?: (
    plugin: MolstarPlugin
  ) => CreateViewerBeforeRevealResult | Promise<CreateViewerBeforeRevealResult>;
  onComplete?: () => void;
  onError?: (error: string) => void;

  onSlowLoad?: () => void;
  onLoad?: () => void;
}

function isCancelledBeforeRevealResult(
  result: CreateViewerBeforeRevealResult
): result is { status: 'cancelled' } {
  return result?.status === 'cancelled';
}

async function waitForConfiguredTestDelay(): Promise<void> {
  const testWindow = window as typeof window & {
    __STRUCTURE_LOAD_TEST_DELAY_MS?: number;
    __test?: unknown;
  };
  const delayMs = testWindow.__STRUCTURE_LOAD_TEST_DELAY_MS;
  if (
    typeof delayMs !== 'number' ||
    delayMs <= 0 ||
    (!import.meta.env.DEV && import.meta.env.MODE !== 'test' && !testWindow.__test)
  ) {
    return;
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

export async function createViewerContainer(options: CreateViewerOptions): Promise<CachedViewer> {
  const {
    pdbId,
    uniprotId,
    url,
    structureData,
    structureDataFormat,
    coordinateModel,
    structureIdentity,
    coordinatesOnly,
    height = 400,
    onBeforeReveal,
    onComplete,
    onError,
    onSlowLoad,
    onLoad,
  } = options;

  const { container, canvas, loadingDiv } = createViewerDOM();
  const rendererHostActivation = createRendererHostActivationState();
  rendererHostActivation.requestedStructureKey = options.structureKey;
  const cached: CachedViewer = {
    container,
    resourcePhase: 'initializing',
    plugin: null,
    isLoading: true,
    isInitializing: true,
    error: null,
    lastUsed: Date.now(),
    loadedStructureKey: null,
    rendererHostActivation,
  };

  const requireActiveResource = () => {
    if (cached.resourcePhase === 'retired') throw new Error(CANCELLED_VIEWER_LOAD_ERROR);
  };

  void (async () => {
    const lifecycle = createStructureLoadLifecycle({
      source: { pdbId, uniprotId, url, structureData },
      onSlow: () => {
        if (cached.resourcePhase === 'retired') return;
        const title = loadingDiv.querySelector('[data-testid="molstar-loading-title"]');
        const detail = loadingDiv.querySelector('[data-testid="molstar-loading-detail"]');
        if (title) title.textContent = 'Rendering large structure…';
        if (detail) {
          detail.textContent = 'Still working — this complex is taking longer than usual.';
        }
        onSlowLoad?.();
      },
    });

    try {
      await waitForConfiguredTestDelay();
      requireActiveResource();
      await lifecycle.awaitLeg(
        'waitForDimensions',
        waitForDimensions(container, canvas, height, lifecycle.checkTimeout)
      );

      await yieldToMain();
      requireActiveResource();

      const plugin = await lifecycle.awaitLeg(
        'initializePlugin',
        initializePlugin(canvas, container).then((plugin) => {
          if (cached.resourcePhase === 'retired') {
            plugin.dispose();
            throw new Error(CANCELLED_VIEWER_LOAD_ERROR);
          }
          cached.plugin = plugin;
          cached.resourcePhase = 'active';
          return plugin;
        })
      );
      requireActiveResource();
      registerMolecularRenderProfileVisuals(plugin);
      requireActiveResource();
      lifecycle.checkTimeout();
      await yieldToMain();
      requireActiveResource();

      await lifecycle.awaitLeg(
        'loadStructure',
        loadStructure(
          plugin,
          {
            pdbId,
            uniprotId,
            url,
            structureData,
            structureDataFormat,
            coordinateModel,
            structureIdentity,
            coordinatesOnly,
          },
          lifecycle.checkTimeout
        )
      );
      requireActiveResource();
      lifecycle.checkTimeout();
      await yieldToMain();
      requireActiveResource();

      const beforeRevealResult = await lifecycle.awaitLeg(
        'onBeforeReveal',
        Promise.resolve(onBeforeReveal?.(plugin))
      );
      requireActiveResource();
      if (isCancelledBeforeRevealResult(beforeRevealResult)) {
        cached.isLoading = false;
        cached.error = CANCELLED_VIEWER_LOAD_ERROR;
        lifecycle.finish('cancelled');
        onComplete?.();
        return;
      }
      requireActiveResource();
      lifecycle.checkTimeout();

      setPluginSpin(plugin, false);
      if (options.coordinateOnlyInitialLoad) {
        const ready = await lifecycle.awaitLeg(
          'waitForInitialCoordinates',
          waitForPluginInteractionReady(plugin, { includeCamera: true })
        );
        if (!ready?.structureCount)
          throw new Error('Fresh authoring did not load native coordinates.');
      } else {
        lifecycle.timings.firstPaint = await lifecycle.awaitLeg(
          'waitForFirstPaint',
          waitForFirstPaintBeforeReveal(plugin, canvas, lifecycle.checkTimeout)
        );
      }
      requireActiveResource();
      lifecycle.checkTimeout();

      cached.isLoading = false;
      cached.isInitializing = false;
      cached.loadedStructureKey = options.structureKey;
      if (cached.rendererHostActivation) {
        cached.rendererHostActivation.loadedStructureKey = options.structureKey;
        cached.rendererHostActivation.requestedStructureKey ??= options.structureKey;
      }
      canvas.style.visibility = 'visible';
      loadingDiv.style.display = 'none';
      lifecycle.finish('ready');
      onLoad?.();
      onComplete?.();
    } catch (error) {
      if (cached.resourcePhase === 'retired') {
        lifecycle.finish('cancelled');
        return;
      }
      console.error('[MolstarViewer] Error:', error);
      cached.isLoading = false;
      cached.isInitializing = false;
      cached.error = error instanceof Error ? error.message : 'Failed to load 3D structure';
      lifecycle.finish('error', cached.error);
      loadingDiv.textContent = toUserMessage(cached.error, 'structure.failed');
      loadingDiv.style.color = '#ef4444';
      loadingDiv.style.background = '#fef2f2';
      onError?.(cached.error);
      onComplete?.();
    } finally {
      lifecycle.dispose();
    }
  })();

  return cached;
}
