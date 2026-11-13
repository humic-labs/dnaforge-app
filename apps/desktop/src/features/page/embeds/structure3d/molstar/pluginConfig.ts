import { DefaultTrackballBindings } from 'molstar/lib/mol-canvas3d/controls/trackball';
import { Binding } from 'molstar/lib/mol-util/binding';
import { ButtonsType, ModifiersKeys } from 'molstar/lib/mol-util/input/input-observer';
import type { MolstarPlugin } from './cache';
import { installViewerSelectionInteractions } from './viewerSelection';
import { shouldEnableTestBridge } from '../../../../../lib/test-bridge-gate';

const SPIN_AXIS: [number, number, number] = [0, -1, 0];
const SPIN_ROTATIONS_PER_SECOND = 0.02;
const SCROLL_ZOOM_BINDING = Binding(
  [
    Binding.Trigger(ButtonsType.Flag.Auxilary, ModifiersKeys.create()),
    Binding.Trigger(ButtonsType.Flag.Auxilary, ModifiersKeys.create({ alt: true })),
    Binding.Trigger(ButtonsType.Flag.Auxilary, ModifiersKeys.create({ control: true })),
  ],
  DefaultTrackballBindings.scrollZoom.action,
  DefaultTrackballBindings.scrollZoom.description
);
const DRAG_PAN_BINDING = Binding(
  [
    ...DefaultTrackballBindings.dragPan.triggers,
    Binding.Trigger(ButtonsType.Flag.Primary, ModifiersKeys.create({ alt: true })),
  ],
  DefaultTrackballBindings.dragPan.action,
  DefaultTrackballBindings.dragPan.description
);

type PluginInitializationTimings = {
  startedAt: number;
  moduleImportsMs: number;
  createSpecMs: number;
  constructContextMs: number;
  pluginInitMs: number;
  initViewerMs: number;
  configureCanvasMs: number;
  totalMs: number;
};

function recordPluginInitializationTimings(timings: PluginInitializationTimings): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __molstarPluginInitializationTimings?: PluginInitializationTimings[];
  };
  testWindow.__molstarPluginInitializationTimings = [
    ...(testWindow.__molstarPluginInitializationTimings ?? []),
    timings,
  ].slice(-20);
}

export function buildInitialCanvas3dProps(canvasProps: {
  renderer?: Record<string, unknown>;
  postprocessing?: Record<string, unknown>;
  marking?: Record<string, unknown>;
  trackball?: Record<string, unknown>;
}) {
  return {
    transparentBackground: true,
    multiSample: { mode: 'off' as const, reduceFlicker: true },
    renderer: {
      ...canvasProps.renderer,

      selectStrength: 0,
    },
    marking: {
      ...canvasProps.marking,

      edgeScale: 2,
      selectInnerEdgeStrength: 0,
    },
    postprocessing: {
      ...canvasProps.postprocessing,
      occlusion: { name: 'off' as const, params: {} },
      outline: { name: 'off' as const, params: {} },
    },
    trackball: {
      ...canvasProps.trackball,
      zoomSpeed: 2,
    },
  };
}

export function configureCanvas3dZoomBindings(plugin: MolstarPlugin): void {
  const canvas = plugin.canvas3d;
  if (!canvas) return;
  canvas.setAttribs({
    trackball: {
      bindings: {
        ...DefaultTrackballBindings,
        ...canvas.attribs?.trackball?.bindings,
        scrollZoom: SCROLL_ZOOM_BINDING,
        dragPan: DRAG_PAN_BINDING,
      },
    },
  });
}

export function shouldAllowMajorPerformanceCaveat(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const strict = document
      .createElement('canvas')
      .getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (strict) return false;

    const relaxed = document.createElement('canvas').getContext('webgl2');
    return relaxed != null;
  } catch {
    return false;
  }
}

function pluginBehaviorTransformerId(behavior: unknown): string {
  if (!behavior || typeof behavior !== 'object') return '';
  const transformer = Reflect.get(behavior, 'transformer');
  if (!transformer || typeof transformer !== 'object') return '';
  const id = Reflect.get(transformer, 'id');
  return typeof id === 'string' ? id : '';
}

export async function createPluginSpec() {
  const [{ DefaultPluginSpec, PluginSpec }, { PluginConfig }, { MolViewSpec }] = await Promise.all([
    import('molstar/lib/mol-plugin/spec'),
    import('molstar/lib/mol-plugin/config'),
    import('molstar/lib/extensions/mvs/behavior'),
  ]);

  const spec = DefaultPluginSpec();
  spec.behaviors = [...(spec.behaviors ?? []), PluginSpec.Behavior(MolViewSpec)];
  spec.config = [...(spec.config ?? []), [PluginConfig.General.DisablePreserveDrawingBuffer, true]];

  if (PluginConfig.General.AllowMajorPerformanceCaveat) {
    spec.config.push([
      PluginConfig.General.AllowMajorPerformanceCaveat,
      shouldAllowMajorPerformanceCaveat(),
    ]);
  }
  spec.canvas3d = {
    ...spec.canvas3d,
    transparentBackground: true,
  };

  if (spec.behaviors) {
    const originalLength = spec.behaviors.length;
    spec.behaviors = spec.behaviors.filter((behavior) => {
      const id = pluginBehaviorTransformerId(behavior);

      return !id.includes('focus-loci');
    });

    if (spec.behaviors.length !== originalLength) {
      console.log('[pluginConfig] Filtered out focus-loci behaviors:', {
        removed: originalLength - spec.behaviors.length,
      });
    }
  }

  return spec;
}

export async function initializePlugin(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement
): Promise<MolstarPlugin> {
  const startedAt = performance.now();
  const { PluginContext } = await import('molstar/lib/mol-plugin/context');
  await import('molstar/build/viewer/molstar.css');
  const modulesReadyAt = performance.now();

  const spec = await createPluginSpec();
  const specReadyAt = performance.now();
  const plugin = new PluginContext(spec);
  const contextReadyAt = performance.now();

  await plugin.init();
  await plugin.managers.structure.component.setOptions({
    ...plugin.managers.structure.component.state.options,
    hydrogens: 'hide-all',
  });
  const pluginReadyAt = performance.now();

  const success = await plugin.initViewerAsync(canvas, container);
  const viewerReadyAt = performance.now();
  if (!success) throw new Error('Failed to initialize 3D canvas');

  if (plugin.canvas3d) {
    plugin.canvas3d.setProps(buildInitialCanvas3dProps(plugin.canvas3d.props));
    configureCanvas3dZoomBindings(plugin);
    installViewerSelectionInteractions(plugin);
  }

  const configuredAt = performance.now();
  recordPluginInitializationTimings({
    startedAt,
    moduleImportsMs: modulesReadyAt - startedAt,
    createSpecMs: specReadyAt - modulesReadyAt,
    constructContextMs: contextReadyAt - specReadyAt,
    pluginInitMs: pluginReadyAt - contextReadyAt,
    initViewerMs: viewerReadyAt - pluginReadyAt,
    configureCanvasMs: configuredAt - viewerReadyAt,
    totalMs: configuredAt - startedAt,
  });

  if (typeof window !== 'undefined' && shouldEnableTestBridge(import.meta.env)) {
    const gate = (
      window as typeof window & {
        __holdMolstarPluginInitializationForTest?: (plugin: MolstarPlugin) => Promise<void>;
      }
    ).__holdMolstarPluginInitializationForTest;
    if (gate) await gate(plugin);
  }

  return plugin;
}

export function setPluginSpin(plugin: MolstarPlugin, enabled: boolean): void {
  if (plugin?.canvas3d) {
    const currentTrackball = plugin.canvas3d.props?.trackball ?? {};
    plugin.canvas3d.setProps({
      trackball: {
        ...currentTrackball,
        animate: enabled
          ? {
              name: 'spin',
              params: {
                speed: SPIN_ROTATIONS_PER_SECOND,
                axis: SPIN_AXIS,
              },
            }
          : { name: 'off', params: {} },
      },
    });
    if (enabled) {
      plugin.canvas3d.animate();
    }
  }
}
