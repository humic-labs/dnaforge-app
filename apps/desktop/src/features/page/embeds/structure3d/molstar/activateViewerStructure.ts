import type { StructureFetchIdentity } from '../utils/structureData';
import type { CachedViewer } from './cache';
import {
  createRendererHostActivationState,
  enqueueRendererHostActivation,
  type RendererHostActivationResult,
} from './rendererHostActivation';
import { loadStructure } from './structureBuilder';
import { createStructureLoadLifecycle } from './viewerLoadLifecycle';
import { waitForFirstPaintBeforeReveal } from './viewerReadiness';
import { MolViewSpecSceneError } from './molViewSpecError';

export interface ActivateViewerStructureOptions {
  structureKey: string;
  pdbId?: string;
  uniprotId?: string;
  url?: string;
  structureData?: string | Uint8Array;
  structureDataFormat?: 'pdb' | 'mmcif';
  coordinateModel?: { blockIndex: number; modelIndex: number };
  structureIdentity?: StructureFetchIdentity;
  coordinatesOnly?: boolean;
  height: number;

  cameraSnapshot?: string;
  onBeforeReveal?: (plugin: NonNullable<CachedViewer['plugin']>) => void | Promise<void>;
  onSlowLoad?: () => void;
  onLoad?: () => void;
}

function restoreLogicalCamera(
  plugin: NonNullable<CachedViewer['plugin']>,
  cameraSnapshot: string | undefined
): void {
  if (!cameraSnapshot) return;
  try {
    plugin.canvas3d?.camera?.setState?.(JSON.parse(cameraSnapshot), 0);
  } catch (error) {
    console.warn('[activateViewerStructure] Failed to restore logical camera:', error);
  }
}

export async function activateViewerStructure(
  cached: CachedViewer,
  options: ActivateViewerStructureOptions
): Promise<RendererHostActivationResult> {
  const plugin = cached.plugin;
  if (!plugin) throw new Error('Mol* pane renderer is not initialized.');
  const canvas = cached.container.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Mol* pane renderer canvas is unavailable.');
  }

  const activationState =
    cached.rendererHostActivation ??
    createRendererHostActivationState(cached.loadedStructureKey ?? null);
  cached.rendererHostActivation = activationState;

  try {
    return await enqueueRendererHostActivation(activationState, {
      structureKey: options.structureKey,
      activate: async ({ isCurrent }) => {
        cached.isLoading = true;
        cached.error = null;
        const lifecycle = createStructureLoadLifecycle({
          source: options,
          onSlow: options.onSlowLoad,
        });

        try {
          if (!options.coordinatesOnly) {
            const canvas3d = plugin.canvas3d;
            const manualReset = canvas3d?.props.camera.manualReset;
            canvas3d?.setProps({ camera: { manualReset: true } }, true);
            if (canvas3d?.camera.transition.inTransition)
              canvas3d.camera.transition.inTransition = false;
            try {
              await Promise.resolve(plugin.clear());
              canvas3d?.commit(true);
            } finally {
              if (manualReset !== undefined) canvas3d?.setProps({ camera: { manualReset } }, true);
            }
          }
          lifecycle.checkTimeout();
          await lifecycle.awaitLeg(
            'loadStructure',
            loadStructure(
              plugin,
              {
                pdbId: options.pdbId,
                uniprotId: options.uniprotId,
                url: options.url,
                structureData: options.structureData,
                structureDataFormat: options.structureDataFormat,
                coordinateModel: options.coordinateModel,
                structureIdentity: options.structureIdentity,
                coordinatesOnly: options.coordinatesOnly,
              },
              lifecycle.checkTimeout
            )
          );
          lifecycle.checkTimeout();

          if (!isCurrent()) {
            lifecycle.finish('cancelled');
            return { status: 'cancelled' as const };
          }

          await lifecycle.awaitLeg(
            'onBeforeReveal',
            Promise.resolve(options.onBeforeReveal?.(plugin))
          );
          lifecycle.checkTimeout();
          if (!isCurrent()) {
            lifecycle.finish('cancelled');
            return { status: 'cancelled' as const };
          }

          restoreLogicalCamera(plugin, options.cameraSnapshot);
          lifecycle.timings.firstPaint = await lifecycle.awaitLeg(
            'waitForFirstPaint',
            waitForFirstPaintBeforeReveal(plugin, canvas, lifecycle.checkTimeout)
          );
          lifecycle.checkTimeout();
          lifecycle.finish('ready');
          options.onLoad?.();
        } catch (error) {
          if (error instanceof MolViewSpecSceneError && error.code === 'VIEW_CHANGED') {
            lifecycle.finish('cancelled');
            return { status: 'cancelled' as const };
          }
          const message = error instanceof Error ? error.message : 'Failed to activate structure';
          cached.error = message;
          lifecycle.finish('error', message);
          throw error;
        } finally {
          cached.isLoading = false;
          lifecycle.dispose();
        }
      },
    });
  } finally {
    cached.loadedStructureKey = activationState.loadedStructureKey;
    cached.lastUsed = Date.now();
  }
}
