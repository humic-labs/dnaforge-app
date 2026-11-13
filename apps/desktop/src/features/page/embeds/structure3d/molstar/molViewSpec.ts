import {
  constructMolecularBindingRegions,
  requireMolecularSurfaceOwnership,
  requireComputedMolecularInterfaceSurfaces,
} from './molecularSurfaceOwnership';
import { GlobalMetadata, MVSData, type MVSData_State } from 'molstar/lib/extensions/mvs/mvs-data';
import { binaryCoordinateText } from '../../../../../shared/binary-coordinates';
import type { Parse } from 'molstar/lib/extensions/mvs/tree/mvs/mvs-builder';
import { BuiltinLoadingExtensions, loadMVS } from 'molstar/lib/extensions/mvs/load';
import { MolecularInterfaceSurfaceExtension } from './molecularInterfaceSurface';
import {
  appendNativeMolecularRepresentations,
  MolecularNativeCaptureExtension,
  NATIVE_CAPTURE_ROOT_CUSTOM,
} from './molViewSpecNativeCapture';
import { resolveMolecularHydrogenDisplay } from './molecularHydrogenDisplay';
import { Model } from 'molstar/lib/mol-model/structure';
import { invalidateMolecularScientificReview } from './molecularScientificReview';
import { MmcifFormat } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { setSubtreeVisibility } from 'molstar/lib/mol-plugin/behavior/static/state';
import { ComponentExpressionT } from 'molstar/lib/extensions/mvs/tree/mvs/param-types';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import { Asset } from 'molstar/lib/mol-util/assets';
import { fovNormalizedCameraPosition } from 'molstar/lib/mol-util/camera';
import type { MolstarPlugin } from './cache';
import type { StructureCoordinateModelSelection } from '../types';
import { findDuplicateMolViewSpecGeometry } from './molViewSpecGeometry';
import { MVS_BACKGROUND_LOCK, MVS_DUPLICATE_GEOMETRY_RULE } from './agentScenePolicy';
import {
  STRUCTURE_FIRST_PAINT_HARD_CEILING_MS,
  STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE,
  waitForPluginInteractionReady,
} from './viewerReadiness';
import type { PinnedMolecularAsset } from '../../../../../shared/molecular-view';
import { canonicalJson } from '../../../../../shared/canonical-json';
import { notifyStructureSceneReplaced } from './sceneReplacement';
import {
  bindMolViewSpecRepresentations,
  updateMolViewSpecAppearance,
} from './molViewSpecAppearance';
import {
  getMolViewSpecRenderProfile,
  currentMolecularRenderProfile,
  MOLECULAR_RENDER_PROFILE_GUIDANCE,
  resolveMolViewSpecRenderProfile,
  type MolecularRenderProfileSelection,
} from './molecularRenderProfile';
import { resolveNucleotideAppearance } from './nucleotideAppearance';
import { constructPrimaryConformerDisplays } from './molecularPrimaryConformer';
import { registerMolecularRenderProfileVisuals } from './nucleotidePresentation';
import { IsMVSModelProvider } from 'molstar/lib/extensions/mvs/components/is-mvs-model-prop';
import { captureNativeMolViewSpec, nativeSizeThemeExtension } from './nativeMolViewSpec';
import { decodedCoordinateExtension } from './decodedCoordinates';
import {
  DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
  useMolecularPresentationPreferences,
} from './molecularPresentationPreferences';
import {
  readMolecularConnectionCoverage,
  molecularRepresentationOwnerRef,
  requireMolecularAttachmentCoverage,
  resolveMolViewSpecAttachments,
  resolveMolViewSpecNativeContactOwners,
  omitNativeOwnedContactGuideGeometry,
  requireMolViewSpecNativeContactOwners,
} from './molecularConnections';

import {
  pageMolecularConnections,
  type MolecularConnectionQuery,
} from './molecularConnectionReadback';
import {
  readManagedInteractionContacts,
  resolveMolecularContactCenterMarkers,
} from './molecularInteractionContext';
import {
  resolveMolecularDisplayGroups,
  requireMolecularDisplayGroups,
} from './molecularDisplayGroups';
import {
  molecularSceneSelections,
  molecularPolymerContextBaselineIndex,
  requirePreservedPolymerContext,
} from './molecularSceneSelections';
import { molecularPresentationOverrideSchema } from './molecularPresentationPreferences';
import {
  assignMolViewSpecStructureRefs,
  molViewSpecStructureBindings,
  molViewSpecStructureBindingKey,
  resolveMolViewSpecStructureRef,
  preserveSharedComparisonSources,
  MOLECULAR_COMPARISON_DISPLAY_GUIDANCE,
  readSharedComparisonRegistration,
} from './molViewSpecStructureIdentity';

export { readMolecularConnections, readMolecularConnectionCoverage } from './molecularConnections';

export {
  DEFAULT_MOLECULAR_RENDER_PROFILE,
  getMolViewSpecRenderProfile,
  setMolViewSpecRenderProfile,
  resolveMolViewSpecRenderProfile,
  type MolecularRenderProfileSelection,
} from './molecularRenderProfile';

import { MolViewSpecSceneError } from './molViewSpecError';
export { MolViewSpecSceneError } from './molViewSpecError';

export function requireSerializableMolViewSpecVisibility(
  hiddenChainInstanceIds: readonly string[] | undefined
): void {
  if (!hiddenChainInstanceIds?.length) return;
  throw new MolViewSpecSceneError(
    'MVS_VIEW_VISIBILITY_MASK',
    'Restore the hidden chains or hide them in the MolViewSpec scene before saving this view.'
  );
}

type CoordinateResource = {
  name: string;
  format: 'pdb' | 'mmcif' | 'bcif';
  data: string | Uint8Array;
  sourceUrl: string;
  asset: ReturnType<typeof Asset.Url>;
};
type SceneRuntime = {
  resource: CoordinateResource;
  pinnedAssets?: readonly PinnedMolecularAsset[];
  pinnedResourceAssets?: Array<{
    descriptor: PinnedMolecularAsset;
    asset: ReturnType<typeof Asset.Url>;
  }>;
  scene?: string;
  nativeSnapshotIds?: string[];
  representationRefs?: Map<string, string>;
  nativeRepresentationRefs?: Map<string, string>;
  committedCamera?: { scene: string; cameraSnapshot?: string };
  nativeCaptureMetadata?: { key: string; timestamp: string };
  starterTimestamp?: string;
};
const runtimes = new WeakMap<MolstarPlugin, SceneRuntime>();
const coordinateModels = new WeakMap<MolstarPlugin, StructureCoordinateModelSelection>();
export function setMolViewSpecCoordinateModel(
  plugin: MolstarPlugin,
  model: StructureCoordinateModelSelection | undefined
): void {
  if (model) coordinateModels.set(plugin, model);
  else coordinateModels.delete(plugin);
}
export type SceneApplyOptions = {
  appearanceOnly?: boolean;
  isCurrent?: () => boolean;
  initialSnapshotIndex?: number;
  beforeApply?: () => void;
  validateNative?: () => void;
};
type SceneController = (
  scene: string,
  onRendered?: () => void,
  options?: SceneApplyOptions
) => Promise<void>;
export type MolViewSpecApplyOptions = SceneApplyOptions;
const controllers = new WeakMap<MolstarPlugin, SceneController>();

export async function waitForMolViewSpecViewReady(plugin: MolstarPlugin): Promise<void> {
  try {
    await waitForPluginInteractionReady(plugin, { includeCamera: true, hardCeilingMs: 5_000 });
  } catch {
    throw new MolViewSpecSceneError(
      'MVS_VIEW_NOT_STABLE',
      'The view did not stop moving before capture. Stop camera animation and retry.'
    );
  }
}

function requireNonduplicatedGeometry(plugin: MolstarPlugin): void {
  try {
    requireMolecularAttachmentCoverage(plugin);
  } catch (error) {
    throw new MolViewSpecSceneError(
      (error as { code?: string }).code ?? 'MVS_ATTACHMENT_INCOMPLETE',
      error instanceof Error ? error.message : String(error)
    );
  }
  const duplicates = findDuplicateMolViewSpecGeometry(plugin);
  if (!duplicates.length) return;
  const first = duplicates[0];
  throw new MolViewSpecSceneError(
    MVS_DUPLICATE_GEOMETRY_RULE.errorCode,
    `${first.type}${first.type === first.largerType ? '' : ` and ${first.largerType}`} draw ${first.repeatedElementCount} ${first.feature ?? 'molecular'} features in both "${first.largerComponent}" and "${first.smallerComponent}". One visual role must own each feature; recolor an existing representation or use disjoint component selections instead of stacking the same geometry. ${duplicates.length} overlapping pair${duplicates.length === 1 ? '' : 's'} found.`
  );
}

async function requireNonduplicatedStoryGeometry(
  plugin: MolstarPlugin,
  document: MVSData,
  isCurrent: () => boolean
): Promise<void> {
  if (document.kind !== 'multiple') {
    requireNonduplicatedGeometry(plugin);
    requireMolViewSpecNativeContactOwners(plugin, document.root, (node) =>
      node.ref ? resolveMolViewSpecStructureRef(plugin, node.ref) : undefined
    );
    return;
  }
  const snapshotIds = plugin.managers.snapshot.state.entries
    .toArray()
    .map((entry) => entry.snapshot.id);
  if (snapshotIds.length !== document.snapshots.length)
    throw new MolViewSpecSceneError(
      'MVS_STORY_UNAVAILABLE',
      'The native story snapshot count differs from the authored MolViewSpec story.'
    );
  const currentId = plugin.managers.snapshot.current?.snapshot.id;
  const initialId = currentId && snapshotIds.includes(currentId) ? currentId : snapshotIds[0];
  const initialCamera = plugin.canvas3d?.camera.getSnapshot();
  const initialState = plugin.state.getSnapshot({
    data: true,
    camera: true,
    canvas3d: true,
    canvas3dContext: true,
    structureSelection: true,
    interactivity: true,
    componentManager: true,
    animation: true,
  });
  const heldCamera = initialCamera
    ? {
        current: structuredClone(initialCamera),
        transitionStyle: 'animate' as const,
        transitionDurationInMs: 0,
      }
    : undefined;
  let validationError: unknown;
  let restorationError: unknown;
  await holdMolViewSpecStoryFrames(plugin, async () => {
    try {
      for (const [index, snapshot] of document.snapshots.entries()) {
        const id = snapshotIds[index];
        if (plugin.managers.snapshot.current?.snapshot.id !== id) {
          const entry = plugin.managers.snapshot.getEntry(id);
          if (!entry)
            throw new MolViewSpecSceneError(
              'MVS_STORY_UNAVAILABLE',
              'The loaded story steps changed during validation.'
            );
          plugin.managers.snapshot.setCurrent(id);

          await plugin.state.setSnapshot({
            ...entry.snapshot,
            camera: heldCamera,
            startAnimation: false,
            transition: undefined,
            onLoadMarkdownCommands: undefined,
          });
        }
        plugin.canvas3d?.commit(true);
        if (!isCurrent())
          throw new MolViewSpecSceneError(
            'VIEW_CHANGED',
            'The structure view changed during story validation.'
          );
        configureMolViewSpecCanvasBackground(plugin, {
          root: snapshot.root,
          metadata: document.metadata,
        });
        const ready = await waitForPluginInteractionReady(plugin, {
          isCurrent,
          includeCamera: true,
        });
        if (!ready?.structureCount || !ready.representationCount)
          throw new MolViewSpecSceneError(
            'MVS_RENDER_FAILED',
            `Story step ${index + 1} has no visible molecular representation.`
          );
        try {
          requireNonduplicatedGeometry(plugin);
          requireMolViewSpecNativeContactOwners(plugin, snapshot.root, (node) =>
            node.ref ? resolveMolViewSpecStructureRef(plugin, node.ref) : undefined
          );
        } catch (error) {
          if (error instanceof MolViewSpecSceneError) {
            throw new MolViewSpecSceneError(
              error.code,
              `Story step ${index + 1}${snapshot.metadata?.title ? ` (${snapshot.metadata.title})` : ''}: ${error.message}`
            );
          }
          throw error;
        }
      }
    } catch (error) {
      validationError = error;
    }
    if (isCurrent()) {
      try {
        if (!plugin.managers.snapshot.getEntry(initialId))
          throw new Error('The original story step is unavailable.');
        plugin.managers.snapshot.setCurrent(initialId);
        await plugin.state.setSnapshot({
          ...initialState,
          camera: heldCamera,
          startAnimation: false,
          transition: undefined,
          onLoadMarkdownCommands: undefined,
        });
        plugin.canvas3d?.commit(true);
        const initialIndex = snapshotIds.indexOf(initialId);
        configureMolViewSpecCanvasBackground(plugin, {
          root: document.snapshots[initialIndex].root,
          metadata: document.metadata,
        });
        if (initialCamera) plugin.canvas3d?.camera.setState(initialCamera, 0);
        const ready = await waitForPluginInteractionReady(plugin, {
          isCurrent,
          includeCamera: true,
        });
        if (!ready?.structureCount || !ready.representationCount)
          throw new MolViewSpecSceneError(
            'MVS_RENDER_FAILED',
            'The initial story step did not restore.'
          );
      } catch (error) {
        restorationError = new MolViewSpecSceneError(
          'MVS_ROLLBACK_FAILED',
          `The story could not restore its original step after validation: ${error instanceof Error ? error.message : String(error)}`,
          'unknown'
        );
      }
    }
  });
  if (restorationError) throw restorationError;
  if (validationError) throw validationError;
}

export async function validateMolViewSpecViewGeometry(
  plugin: MolstarPlugin,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const scene = runtimeFor(plugin).scene;
  if (!scene) return;
  await requireNonduplicatedStoryGeometry(plugin, MVSData.fromMVSJ(scene), isCurrent);
}

export function getMolViewSpecCoordinates(plugin: MolstarPlugin) {
  const runtime = runtimeFor(plugin);
  if (typeof runtime.resource.data !== 'string' || runtime.resource.format === 'bcif')
    throw new MolViewSpecSceneError(
      'MVS_VIEW_BINARY_UNSUPPORTED',
      'Data publications currently support text PDB and mmCIF coordinates.'
    );
  return {
    text: runtime.resource.data,
    format: runtime.resource.format === 'pdb' ? ('pdb' as const) : ('cif' as const),
  };
}

export type MolViewSpecCameraPolicy = 'capture-current' | 'preserve-authored';
export type MolViewSpecCaptureOptions = {
  cameraPolicy?: MolViewSpecCameraPolicy;
  authoredCameraSnapshot?: string;

  savedCameraBaseline?: { scene: string; cameraSnapshot?: string };
};

function sameSingleViewAuthoredCamera(scene: MVSData, baseline: string): boolean {
  try {
    const saved = MVSData.fromMVSJ(baseline);
    if (scene.kind === 'multiple' || saved.kind === 'multiple') return false;
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, sorted(item)])
            )
          : value;
    const cameras = (state: MVSData_State) =>
      sorted(state.root.children?.filter((node) => node.kind === 'camera') ?? []);
    return JSON.stringify(cameras(scene)) === JSON.stringify(cameras(saved));
  } catch {
    return false;
  }
}

export function captureMolViewSpecView(
  plugin: MolstarPlugin,
  options: MolViewSpecCaptureOptions = {}
) {
  const runtime = runtimeFor(plugin);
  requireNonduplicatedGeometry(plugin);
  let scene: MVSData;
  if (runtime.scene) scene = MVSData.fromMVSJ(runtime.scene);
  else {
    const builder = MVSData.createBuilder();
    builder.extendRootCustomState(NATIVE_CAPTURE_ROOT_CUSTOM);
    const parsed = builder
      .download({ url: runtime.resource.name })
      .parse({ format: runtime.resource.format });
    const source = nativeStarterStructure(parsed, plugin, runtime.resource.format);
    appendNativeMolecularRepresentations(plugin, source);
    scene = builder.getState({ title: 'Structure view' });
    runtime.nativeCaptureMetadata ??= {
      key: `view:${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
    };
    scene.metadata = { ...scene.metadata, ...runtime.nativeCaptureMetadata };
  }
  requireMolecularDisplayGroups(scene, !runtime.scene);
  const camera = plugin.canvas3d?.camera.getSnapshot();
  if (!camera)
    throw new MolViewSpecSceneError('PLUGIN_NOT_READY', 'The visible camera is not ready.');
  const initialSnapshotIndex = activeMolViewSpecSnapshotIndex(plugin);
  const preserveCamera = options.cameraPolicy === 'preserve-authored' && !!runtime.scene;
  const root = scene.kind === 'multiple' ? scene.snapshots[initialSnapshotIndex].root : scene.root;
  if (!preserveCamera) {
    root.children = (root.children ?? []).filter((node) => node.kind !== 'camera');
    const position = fovNormalizedCameraPosition(
      camera.target,
      camera.position,
      camera.mode,
      camera.fov
    );
    root.children.push({
      kind: 'camera',
      params: {
        target: [camera.target[0], camera.target[1], camera.target[2]],
        position: [position[0], position[1], position[2]],
        up: [camera.up[0], camera.up[1], camera.up[2]],
        near: camera.minNear,
      },
    });
  }
  const authoredCameraSnapshot =
    runtime.committedCamera && runtime.committedCamera.scene === runtime.scene
      ? runtime.committedCamera.cameraSnapshot
      : options.savedCameraBaseline &&
          sameSingleViewAuthoredCamera(scene, options.savedCameraBaseline.scene)
        ? options.savedCameraBaseline.cameraSnapshot
        : options.authoredCameraSnapshot;
  return {
    scene: JSON.stringify(scene),
    cameraSnapshot:
      scene.kind === 'multiple'
        ? undefined
        : preserveCamera
          ? authoredCameraSnapshot
          : JSON.stringify(camera),
    initialSnapshotIndex: scene.kind === 'multiple' ? initialSnapshotIndex : undefined,
    coordinates:
      typeof runtime.resource.data === 'string'
        ? {
            text: runtime.resource.data,
            format: runtime.resource.format === 'mmcif' ? ('cif' as const) : ('pdb' as const),
          }
        : { text: binaryCoordinateText(runtime.resource.data), format: 'bcif' as const },
    pinnedAssets: runtime.pinnedAssets ?? [],
  };
}

export function acceptSavedMolViewSpecView(
  plugin: MolstarPlugin,
  captured: ReturnType<typeof captureMolViewSpecView>,
  savedScene: string,
  options: MolViewSpecCaptureOptions = {}
): boolean {
  const runtime = runtimes.get(plugin);
  if (!runtime) return false;
  let latest: ReturnType<typeof captureMolViewSpecView>;
  try {
    latest = captureMolViewSpecView(plugin, options);
  } catch {
    return false;
  }

  if (
    latest.scene !== captured.scene ||
    latest.cameraSnapshot !== captured.cameraSnapshot ||
    latest.initialSnapshotIndex !== captured.initialSnapshotIndex ||
    latest.coordinates.text !== captured.coordinates.text ||
    latest.coordinates.format !== captured.coordinates.format ||
    JSON.stringify(latest.pinnedAssets) !== JSON.stringify(captured.pinnedAssets)
  )
    return false;
  const camera = plugin.canvas3d?.camera.getSnapshot();
  if (!camera) return false;
  const document = MVSData.fromMVSJ(savedScene);
  const preserveCamera = options.cameraPolicy === 'preserve-authored' && !!runtime.scene;
  if (document.kind === 'multiple') {
    const entries = plugin.managers.snapshot.state.entries.toArray();
    const index = captured.initialSnapshotIndex ?? 0;
    if (entries.length !== document.snapshots.length || !entries[index]) return false;
    if (!preserveCamera)
      entries[index].snapshot.camera = {
        ...entries[index].snapshot.camera,
        transitionStyle: entries[index].snapshot.camera?.transitionStyle ?? 'instant',
        current: structuredClone(camera),
        focus: undefined,
      };

    for (const [viewIndex, entry] of entries.entries())
      entry.key = document.snapshots[viewIndex].metadata?.key;
  }
  runtime.scene = savedScene;
  runtime.committedCamera =
    preserveCamera && runtime.committedCamera
      ? { ...runtime.committedCamera, scene: savedScene }
      : undefined;
  runtime.nativeSnapshotIds = plugin.managers.snapshot.state.entries
    .toArray()
    .map((entry) => entry.snapshot.id);
  return true;
}

export function commitCurrentMolViewSpecCamera(plugin: MolstarPlugin): {
  scene: string;
  initialSnapshotIndex?: number;
  cameraSnapshot?: string;
} {
  const runtime = runtimeFor(plugin);
  if (!runtime.scene)
    throw new MolViewSpecSceneError(
      'MVS_STORY_UNAVAILABLE',
      'Apply a MolViewSpec scene before setting authored framing.'
    );
  const previous = runtime.scene;
  const captured = captureMolViewSpecView(plugin);
  if (!acceptSavedMolViewSpecView(plugin, captured, captured.scene))
    throw new MolViewSpecSceneError(
      'VIEW_CHANGED',
      'The view changed before its framing could be recorded.'
    );
  const entry =
    plugin.managers.snapshot.state.entries.toArray()[captured.initialSnapshotIndex ?? 0];
  const camera = plugin.canvas3d?.camera.getSnapshot();
  if (entry && camera)
    entry.snapshot.camera = {
      ...entry.snapshot.camera,
      transitionStyle: entry.snapshot.camera?.transitionStyle ?? 'instant',
      current: structuredClone(camera),
      focus: undefined,
    };
  runtime.committedCamera = { scene: captured.scene, cameraSnapshot: captured.cameraSnapshot };
  if (previous !== captured.scene) invalidateMolecularScientificReview(plugin);
  return {
    scene: captured.scene,
    initialSnapshotIndex: captured.initialSnapshotIndex,
    cameraSnapshot: captured.cameraSnapshot,
  };
}

const expressionFields = new Set(
  Object.keys((ComponentExpressionT as unknown as { props: Record<string, unknown> }).props)
);

export function resetMolViewSpecRuntime(plugin: MolstarPlugin): void {
  invalidateMolecularScientificReview(plugin);
  runtimes.delete(plugin);
  coordinateModels.delete(plugin);
  plugin.managers.asset.clearTag('dnaforge-mvs-coordinate');
  plugin.managers.asset.clearTag('dnaforge-mvs-pinned-asset');
  plugin.canvas3d?.setProps({ transparentBackground: true });
}

export function clearMolViewSpecScene(plugin: MolstarPlugin): void {
  const runtime = runtimes.get(plugin);
  if (!runtime) return;
  runtime.scene = undefined;
  runtime.representationRefs = undefined;
  runtime.nativeRepresentationRefs = undefined;
  runtime.nativeSnapshotIds = undefined;
}

export function configureMolViewSpecCanvasBackground(
  plugin: MolstarPlugin,
  _document: MVSData_State
): void {
  plugin.canvas3d?.setProps({ transparentBackground: true });
}

export function stripMolViewSpecCanvasNodes(document: MVSData): MVSData {
  const states = document.kind === 'multiple' ? document.snapshots : [document];
  for (const state of states)
    state.root.children = state.root.children?.filter((node) => node.kind !== 'canvas');
  return document;
}

export function sameLoadedMolViewSpecScene(
  loadedScene: string | undefined,
  savedScene: string | undefined
): boolean {
  if (!loadedScene || !savedScene) return loadedScene === savedScene;
  try {
    const normalized = (scene: string) =>
      MVSData.toMVSJ(stripMolViewSpecCanvasNodes(MVSData.fromMVSJ(scene)));
    return normalized(loadedScene) === normalized(savedScene);
  } catch {
    return false;
  }
}

export function activeMolViewSpecScene(plugin: MolstarPlugin): string | undefined {
  const runtime = runtimes.get(plugin);
  if (!runtime?.scene) return undefined;
  const document = MVSData.fromMVSJ(runtime.scene);
  if (document.kind === 'multiple') {
    const entries = plugin.managers.snapshot.state.entries.toArray();
    if (
      entries.length !== document.snapshots.length ||
      entries.some((entry, index) => {
        const key = document.snapshots[index].metadata?.key;
        return (
          (key !== undefined && entry.key !== key) ||
          (runtime.nativeSnapshotIds !== undefined &&
            runtime.nativeSnapshotIds[index] !== entry.snapshot.id)
        );
      })
    )
      return undefined;
  }
  return runtime.scene;
}

export function activeMolViewSpecSnapshotIndex(plugin: MolstarPlugin): number {
  const runtime = runtimes.get(plugin);
  if (!runtime?.scene) return 0;

  if (MVSData.fromMVSJ(runtime.scene).kind !== 'multiple') return 0;
  const snapshotIds = plugin.managers.snapshot.state.entries
    .toArray()
    .map((entry) => entry.snapshot.id);
  const currentId = plugin.managers.snapshot.current?.snapshot.id;
  const index = currentId ? snapshotIds.indexOf(currentId) : -1;
  return index >= 0 ? index : 0;
}

type MolViewSpecCanvas = NonNullable<MolstarPlugin['canvas3d']>;
type MolViewSpecFrameHold = {
  depth: number;
  manualReset: boolean;
  pause: MolViewSpecCanvas['pause'];
  resume: MolViewSpecCanvas['resume'];
  animate: MolViewSpecCanvas['animate'];
  tick: MolViewSpecCanvas['tick'];
};
const frameHolds = new WeakMap<MolViewSpecCanvas, MolViewSpecFrameHold>();

function acquireMolViewSpecFrameHold(canvas: MolViewSpecCanvas): () => boolean {
  let hold = frameHolds.get(canvas);
  if (hold) hold.depth++;
  else {
    hold = {
      depth: 1,
      manualReset: canvas.props.camera.manualReset,
      pause: canvas.pause,
      resume: canvas.resume,
      animate: canvas.animate,
      tick: canvas.tick,
    };
    const original = hold;
    frameHolds.set(canvas, original);

    canvas.resume = () => {};
    canvas.animate = () => {};
    canvas.pause = () => original.pause.call(canvas, true);
    if (typeof original.tick === 'function') {
      canvas.tick = (time, options) =>
        original.tick.call(canvas, time, { ...options, manualDraw: true });
    }
  }
  const acquired = hold;
  return () => {
    if (--acquired.depth > 0) return false;
    frameHolds.delete(canvas);
    canvas.pause = acquired.pause;
    canvas.resume = acquired.resume;
    canvas.animate = acquired.animate;
    canvas.tick = acquired.tick;
    try {
      canvas.setProps({ camera: { manualReset: acquired.manualReset } }, true);
    } finally {
      canvas.resume();
    }
    return true;
  };
}

export async function holdMolViewSpecStoryFrames(
  plugin: MolstarPlugin,
  apply: () => Promise<void>
): Promise<void> {
  const canvas = plugin.canvas3d;
  if (!canvas) return apply();
  const release = acquireMolViewSpecFrameHold(canvas);
  let released = false;

  try {
    canvas.pause(true);
    canvas.setProps({ camera: { manualReset: true } }, true);
    await apply();
    canvas.commit(true);
  } finally {
    released = release();
    if (released && !plugin.animationLoop.isAnimating) canvas.animate();
  }
  if (!released) return;

  let subscription: { unsubscribe(): void } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let armed = false;
      subscription = canvas.didDraw.subscribe(() => {
        if (armed) resolve();
      });
      timeout = setTimeout(
        () => reject(new Error(STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE)),
        STRUCTURE_FIRST_PAINT_HARD_CEILING_MS
      );
      armed = true;
      canvas.requestDraw();
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    subscription?.unsubscribe();
  }
}

export async function selectMolViewSpecSnapshot(
  plugin: MolstarPlugin,
  index: number,
  isCurrent: () => boolean = () => true
): Promise<{ index: number; title?: string }> {
  const runtime = runtimes.get(plugin);
  if (!runtime?.scene)
    throw new MolViewSpecSceneError(
      'MVS_STORY_UNAVAILABLE',
      'No authored MolViewSpec story is loaded.'
    );
  const document = MVSData.fromMVSJ(runtime.scene);
  if (document.kind !== 'multiple') {
    if (index !== 0)
      throw new MolViewSpecSceneError('MVS_STORY_STEP_INVALID', 'The story step does not exist.');
    if (!isCurrent())
      throw new MolViewSpecSceneError('VIEW_CHANGED', 'The structure view changed.');
    return { index: 0, title: document.metadata.title };
  }
  if (!Number.isInteger(index) || index < 0 || index >= document.snapshots.length)
    throw new MolViewSpecSceneError('MVS_STORY_STEP_INVALID', 'The story step does not exist.');
  const entries = plugin.managers.snapshot.state.entries.toArray();
  if (entries.length !== document.snapshots.length)
    throw new MolViewSpecSceneError(
      'MVS_STORY_UNAVAILABLE',
      'The loaded story snapshot count changed.'
    );
  if (!isCurrent()) throw new MolViewSpecSceneError('VIEW_CHANGED', 'The structure view changed.');
  {
    const snapshot = entries[index].snapshot;
    const id = snapshot.id;
    if (!plugin.managers.snapshot.getEntry(id))
      throw new MolViewSpecSceneError('MVS_STORY_UNAVAILABLE', 'The loaded story steps changed.');

    const duration =
      useMolecularPresentationPreferences.getState().preferences.cameraTransitionMs ??
      DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES.cameraTransitionMs!;
    if (snapshot.camera) {
      snapshot.camera = {
        ...snapshot.camera,

        transitionStyle: 'animate',
        transitionDurationInMs: duration,
      };
    }
    const destination = snapshot.camera;
    const sourceCamera = plugin.canvas3d?.camera.getSnapshot();
    await holdMolViewSpecStoryFrames(plugin, async () => {
      plugin.managers.snapshot.setCurrent(id);
      await plugin.state.setSnapshot({
        ...snapshot,
        camera:
          destination && sourceCamera
            ? {
                current: sourceCamera,
                transitionStyle: 'animate',
                transitionDurationInMs: 0,
              }
            : destination,
      });
      if (destination && sourceCamera) {
        plugin.canvas3d?.commit(true);
        plugin.canvas3d?.camera.setState(sourceCamera, 0);
      }
    });
    if (!isCurrent())
      throw new MolViewSpecSceneError('VIEW_CHANGED', 'The structure view changed.', 'unknown');
    if (destination && sourceCamera) {
      if (destination.current) {
        await PluginCommands.Camera.Reset(plugin, {
          snapshot: destination.current,
          durationMs: duration,
        });
      } else if (destination.focus) {
        await PluginCommands.Camera.FocusObject(plugin, {
          ...destination.focus,
          durationMs: duration,
        });
      }
    }
    configureMolViewSpecCanvasBackground(plugin, {
      root: document.snapshots[index].root,
      metadata: document.metadata,
    });
    const ready = await waitForPluginInteractionReady(plugin, { isCurrent, includeCamera: true });
    if (!ready?.structureCount || !ready.representationCount)
      throw new MolViewSpecSceneError(
        'MVS_RENDER_FAILED',
        'The selected story step has no visible structure.',
        'unknown'
      );
    plugin.canvas3d?.requestDraw();
  }
  notifyStructureSceneReplaced(plugin);
  return { index, title: document.snapshots[index].metadata?.title };
}

export function registerMolViewSpecController(
  plugin: MolstarPlugin,
  apply: SceneController
): () => void {
  controllers.set(plugin, apply);
  return () => {
    if (controllers.get(plugin) === apply) controllers.delete(plugin);
  };
}

export function hasMolViewSpecController(plugin: MolstarPlugin): boolean {
  return controllers.has(plugin);
}

export async function applyMolViewSpecScene(
  plugin: MolstarPlugin,
  scene: string,
  onRendered?: () => void,
  options?: SceneApplyOptions
): Promise<void> {
  const apply = controllers.get(plugin);
  if (!apply)
    throw new MolViewSpecSceneError(
      'PLUGIN_NOT_READY',
      'The visible structure renderer is not ready for scene control.'
    );
  await apply(scene, onRendered, options);
}

function runtimeFor(plugin: MolstarPlugin): SceneRuntime {
  const existing = runtimes.get(plugin);
  if (existing) return existing;
  const raw = [...plugin.state.data.cells.values()].find(
    (cell) =>
      PluginStateObject.Data.String.is(cell.obj) || PluginStateObject.Data.Binary.is(cell.obj)
  )?.obj;
  if (!raw || !(PluginStateObject.Data.String.is(raw) || PluginStateObject.Data.Binary.is(raw))) {
    throw new MolViewSpecSceneError(
      'MVS_COORDINATES_UNAVAILABLE',
      'The loaded coordinate resource is unavailable.'
    );
  }
  const data = raw.data instanceof Uint8Array ? new Uint8Array(raw.data) : String(raw.data);
  const format =
    typeof data !== 'string' ? 'bcif' : /^\s*(?:#[^\n]*\n\s*)*data_/i.test(data) ? 'mmcif' : 'pdb';
  return bindMolViewSpecCoordinates(plugin, data, format);
}

export function bindMolViewSpecCoordinates(
  plugin: MolstarPlugin,
  data: string | Uint8Array,
  format: 'pdb' | 'mmcif' | 'bcif'
): SceneRuntime {
  if (data instanceof Uint8Array) format = 'bcif';
  const name = format === 'mmcif' ? 'structure.cif' : `structure.${format}`;
  const sourceUrl = `arcp://uuid,${crypto.randomUUID()}/scene.mvsj`;
  const asset = Asset.Url(new URL(name, sourceUrl).href);
  const bytes = typeof data === 'string' ? data : new Uint8Array(data);
  plugin.managers.asset.set(asset, new File([bytes], name), {
    isStatic: true,
    tag: 'dnaforge-mvs-coordinate',
  });
  const runtime: SceneRuntime = { resource: { name, format, data, sourceUrl, asset } };
  runtimes.set(plugin, runtime);
  return runtime;
}

export function bindMolViewSpecPinnedAssets(
  plugin: MolstarPlugin,
  assets: readonly PinnedMolecularAsset[] = []
): void {
  const runtime = runtimeFor(plugin);

  if (!plugin.managers.asset.get(runtime.resource.asset)) {
    plugin.managers.asset.set(
      runtime.resource.asset,
      new File([runtime.resource.data], runtime.resource.name),
      { isStatic: true, tag: 'dnaforge-mvs-coordinate' }
    );
  }
  const sameAssets =
    runtime.pinnedResourceAssets?.length === assets.length &&
    runtime.pinnedResourceAssets.every(
      (item, index) =>
        item.descriptor.name === assets[index].name &&
        item.descriptor.sha256 === assets[index].sha256
    );
  if (!sameAssets) {
    invalidateMolecularScientificReview(plugin);
    plugin.managers.asset.clearTag('dnaforge-mvs-pinned-asset');
    runtime.pinnedResourceAssets = [];
  }
  const names = new Set<string>([runtime.resource.name]);
  for (const [index, asset] of assets.entries()) {
    if (!/^asset-[2-4]\.(?:pdb|cif)$/.test(asset.name) || names.has(asset.name))
      throw new MolViewSpecSceneError('MVS_UNSUPPORTED_RESOURCE', 'Invalid pinned asset name.');
    if (!asset.name.endsWith(`.${asset.format}`))
      throw new MolViewSpecSceneError('MVS_UNSUPPORTED_RESOURCE', 'Pinned asset format mismatch.');
    names.add(asset.name);
    const bound = sameAssets
      ? runtime.pinnedResourceAssets![index]
      : {
          descriptor: asset,
          asset: Asset.Url(new URL(asset.name, runtime.resource.sourceUrl).href),
        };
    if (!plugin.managers.asset.get(bound.asset))
      plugin.managers.asset.set(bound.asset, new File([asset.text], asset.name), {
        isStatic: true,
        tag: 'dnaforge-mvs-pinned-asset',
      });
    if (!sameAssets) runtime.pinnedResourceAssets!.push(bound);
  }
  runtime.pinnedAssets = assets;
}

export function activeMolViewSpecResourceNames(plugin: MolstarPlugin): string[] {
  const runtime = runtimeFor(plugin);
  return [runtime.resource.name, ...(runtime.pinnedAssets ?? []).map((asset) => asset.name)];
}

export function prepareMolViewSpecForOpening(document: MVSData): {
  document: MVSData;
  wraparoundTransitionMs?: number;
} {
  document = resolveMolecularHydrogenDisplay(document, { kind: 'replay' });
  type VisibilityNode = {
    kind?: unknown;
    params?: Record<string, unknown>;
    custom?: Record<string, unknown>;
    children?: VisibilityNode[];
  };
  const inheritVisibility = (node: VisibilityNode, parentHidden = false): void => {
    const hidden = parentHidden || node.custom?.is_hidden === true;
    if (parentHidden) node.custom = { ...node.custom, is_hidden: true };

    if (hidden && node.kind === 'primitives')
      node.params = { ...node.params, opacity: 0, label_opacity: 0 };

    node.children = node.children?.filter(
      (child) =>
        child.kind !== 'primitives_from_uri' || !(hidden || child.custom?.is_hidden === true)
    );
    for (const child of node.children ?? []) inheritVisibility(child, hidden);
  };
  const roots =
    document.kind === 'multiple'
      ? document.snapshots.map((snapshot) => snapshot.root)
      : [document.root];
  for (const root of roots) {
    inheritVisibility(root);
    omitNativeOwnedContactGuideGeometry(root);
  }
  if (document.kind !== 'multiple' || document.snapshots.length === 0) return { document };

  for (const snapshot of document.snapshots)
    snapshot.metadata = {
      ...snapshot.metadata,
      linger_duration_ms: snapshot.metadata?.linger_duration_ms ?? 1000,
    };
  const lastIndex = document.snapshots.length - 1;
  const last = document.snapshots[lastIndex];
  const wraparoundTransitionMs = last.metadata.transition_duration_ms;
  if (!wraparoundTransitionMs) return { document };
  return {
    document: {
      ...document,
      snapshots: document.snapshots.map((snapshot, index) =>
        index === lastIndex
          ? {
              ...snapshot,
              metadata: { ...snapshot.metadata, transition_duration_ms: 0 },
            }
          : snapshot
      ),
    },
    wraparoundTransitionMs,
  };
}

export function authorMolViewSpecRoot(root: unknown, resourceName: string): string {
  let scene: string;
  try {
    scene = JSON.stringify({ kind: 'single', root, metadata: GlobalMetadata.create() });
  } catch {
    throw new MolViewSpecSceneError(
      'MVS_INVALID_SCENE',
      'The authored root must be JSON-serializable.'
    );
  }
  if (scene.length > 2_000_000)
    throw new MolViewSpecSceneError(
      'MVS_INVALID_SCENE',
      'The authored scene exceeds the 2,000,000-character limit.'
    );
  return MVSData.toMVSJ(validateMolViewSpecScene(scene, resourceName));
}

function inheritMolViewSpecNativeVisibility(plugin: MolstarPlugin): void {
  for (const entry of plugin.managers.snapshot.state.entries) {
    const hidden = new Set<string>();
    for (const transform of entry.snapshot.data?.tree.transforms ?? []) {
      if (transform.state?.isHidden || hidden.has(transform.parent)) {
        hidden.add(transform.ref);
        transform.state = { ...transform.state, isHidden: true };
      }
    }
  }
  const state = plugin.state.data;
  for (const cell of state.cells.values()) {
    if (
      cell.state.isHidden &&
      (cell.transform.parent === cell.transform.ref ||
        !state.cells.get(cell.transform.parent)?.state.isHidden)
    )
      setSubtreeVisibility(state, cell.transform.ref, true);
  }
}

export function validateMolViewSpecScene(
  scene: string,
  resourceNames: string | readonly string[]
): MVSData {
  const allowedResources = new Set(
    typeof resourceNames === 'string' ? [resourceNames] : resourceNames
  );
  let document: MVSData;
  try {
    document = JSON.parse(scene) as MVSData;
    if (!document || typeof document !== 'object' || !document.metadata)
      throw new Error('Missing MolViewSpec metadata.');
    const version = document.metadata.version;
    if (typeof version !== 'string' || Number(version.split('.')[0]) !== MVSData.SupportedVersion) {
      throw new MolViewSpecSceneError(
        'MVS_UNSUPPORTED_VERSION',
        `This Molstar runtime supports MolViewSpec major version ${MVSData.SupportedVersion}.`
      );
    }
    const issues = MVSData.validationIssues(document, { noExtra: true });
    if (issues?.length) throw new Error(issues.slice(0, 12).join('\n'));
  } catch (error) {
    if (error instanceof MolViewSpecSceneError) throw error;
    throw new MolViewSpecSceneError(
      'MVS_INVALID_SCENE',
      error instanceof Error ? error.message : 'Invalid MVSJ document.'
    );
  }
  if (document.kind === 'multiple' && !document.snapshots.length)
    throw new MolViewSpecSceneError('MVS_INVALID_SCENE', 'A story must contain at least one view.');
  type SceneNode = { kind: string; params?: unknown; children?: SceneNode[] };
  const pending: SceneNode[] =
    document.kind === 'multiple'
      ? document.snapshots.map((snapshot) => snapshot.root)
      : [document.root];
  let nodes = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++nodes > 2_000)
      throw new MolViewSpecSceneError(
        'MVS_INVALID_SCENE',
        'The scene exceeds the 2,000-node limit.'
      );
    const params = node.params as Record<string, unknown> | undefined;
    if (node.kind === 'component' && typeof params?.selector === 'object' && params.selector) {
      const expressions = Array.isArray(params.selector) ? params.selector : [params.selector];
      for (const expression of expressions) {
        const unknown = Object.keys(expression).filter((key) => !expressionFields.has(key));
        if (unknown.length)
          throw new MolViewSpecSceneError(
            'MVS_INVALID_SCENE',
            `Unknown MolViewSpec selector fields: ${unknown.join(', ')}. Use the installed official component expression schema; unsupported fields are not silently ignored.`
          );
      }
    }
    for (const key of ['url', 'uri']) {
      const uri = params?.[key];
      if (uri !== undefined && !allowedResources.has(String(uri))) {
        throw new MolViewSpecSceneError(
          'MVS_UNSUPPORTED_RESOURCE',
          `Scene resource ${String(uri)} is not pinned to this view. Available resources: ${[...allowedResources].join(', ')}.`
        );
      }
    }
    pending.push(...(node.children ?? []));
  }
  return document;
}

function canvasInSnapshot(document: MVSData, index: number): string | null {
  const snapshot = document.kind === 'multiple' ? document.snapshots[index] : document;
  if (!snapshot)
    throw new MolViewSpecSceneError('MVS_STORY_STEP_INVALID', 'The story step does not exist.');
  const canvas = snapshot.root.children?.find((node) => node.kind === 'canvas');
  return canvas ? JSON.stringify(canvas) : null;
}

export function resolveMolViewSpecDataAppearanceScene(
  plugin: MolstarPlugin,
  scene: string
): string {
  const current = getMolViewSpecDataScene(plugin);
  const document = assignMolViewSpecStructureRefs(
    validateMolViewSpecScene(
      scene,
      current.resources.map((resource) => resource.uri)
    )
  );
  const currentDocument = assignMolViewSpecStructureRefs(MVSData.fromMVSJ(current.scene));
  const currentBindings = molViewSpecStructureBindings(
    currentDocument,
    current.story?.activeIndex ?? 0
  );
  const entries = plugin.managers.structure.hierarchy.current.structures;
  const singleSource = entries.length === 1 ? entries[0].cell.obj?.data : undefined;
  const sources = new Map(
    currentBindings.map((binding) => [
      molViewSpecStructureBindingKey(binding),
      singleSource && currentBindings.length === 1
        ? singleSource
        : resolveMolViewSpecStructureRef(plugin, binding.ref),
    ])
  );
  return MVSData.toMVSJ(
    resolveMolecularDisplayGroups(document, undefined, (node, index) => {
      const binding = molViewSpecStructureBindings(document, index).find(
        (binding) => binding.ref === node.ref
      );
      const source = binding && sources.get(molViewSpecStructureBindingKey(binding));
      if (!source)
        throw new MolViewSpecSceneError(
          'DATA_COORDINATE_MISMATCH',
          'The data scene does not belong to the currently loaded molecular source.'
        );
      return molecularSceneSelections(source);
    })
  );
}

export function resolveMolViewSpecAgentScene(
  plugin: MolstarPlugin,
  scene: string,
  resourceName: string | readonly string[],
  explicitProfile?: MolecularRenderProfileSelection,
  nativeAlignmentChange = false,
  userHydrogenRequest?: string
): string {
  if (explicitProfile !== undefined && explicitProfile !== 'default')
    throw new MolViewSpecSceneError(
      'MVS_AGENT_RENDER_PROFILE_OWNED',
      'Agent scene edits use the viewer-bound construction profile. Historical/native profiles are available only for saved replay.'
    );
  const current = getMolViewSpecScene(plugin);
  const viewerSelection = getMolViewSpecRenderProfile(plugin);
  if (typeof viewerSelection === 'object' && viewerSelection.version < 12)
    throw new MolViewSpecSceneError(
      'MVS_AGENT_RENDER_PROFILE_OUTDATED',
      'This viewer is bound to a historical construction profile. Start a fresh authoring viewer with the current profile; preserve this saved replay.'
    );
  const comparisonPresentation =
    typeof viewerSelection === 'object'
      ? (viewerSelection.presentation?.comparisonPresentation ?? 'authored')
      : (useMolecularPresentationPreferences.getState().preferences.comparisonPresentation ??
        'authored');

  const selection =
    viewerSelection === 'native' ? currentMolecularRenderProfile() : viewerSelection;
  const document = assignMolViewSpecStructureRefs(
    preserveSharedComparisonSources(
      validateMolViewSpecScene(scene, resourceName),
      assignMolViewSpecStructureRefs(MVSData.fromMVSJ(current.scene)),
      current.story?.activeIndex ?? 0,
      comparisonPresentation,
      nativeAlignmentChange,
      (ref, selector) =>
        molecularSceneSelections(resolveMolViewSpecStructureRef(plugin, ref)).select(selector)
          .elementCount
    )
  );

  const roots =
    document.kind === 'multiple' ? document.snapshots.map((s) => s.root) : [document.root];
  for (const root of roots) {
    if (root.custom) delete root.custom.dnaforge_render_profile;
  }
  const entries = plugin.managers.structure.hierarchy.current.structures;
  const source = entries.length === 1 ? entries[0].cell.obj?.data : undefined;

  const downloads: string[] = [];
  const pending: Array<{ kind: string; params?: Record<string, unknown>; children?: unknown[] }> = [
    ...roots,
  ];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === 'download') downloads.push(String(node.params?.url));
    pending.push(...((node.children ?? []) as typeof pending));
  }
  const singleSource = source && downloads.every((uri) => uri === current.resource.uri);
  const selections = source && singleSource ? molecularSceneSelections(source) : undefined;
  const currentDocument = assignMolViewSpecStructureRefs(MVSData.fromMVSJ(current.scene));
  const currentBindings = molViewSpecStructureBindings(
    currentDocument,
    current.story?.activeIndex ?? 0
  );
  const sourcesByBinding = new Map(
    currentBindings.map((binding) => [
      molViewSpecStructureBindingKey(binding),
      source && currentBindings.length === 1
        ? source
        : resolveMolViewSpecStructureRef(plugin, binding.ref),
    ])
  );
  const currentStoryBindings =
    currentDocument.kind === 'multiple'
      ? currentDocument.snapshots.flatMap((_, index) =>
          molViewSpecStructureBindings(currentDocument, index)
        )
      : currentBindings;
  const qualifiedSelections = new Map(
    currentStoryBindings.flatMap((binding) => {
      const parent = sourcesByBinding.get(molViewSpecStructureBindingKey(binding));
      return parent ? [[binding.ref, molecularSceneSelections(parent)] as const] : [];
    })
  );
  const profiled = resolveMolViewSpecRenderProfile(document, selection, (selector, ref) =>
    ref
      ? (qualifiedSelections.get(ref)?.hasNucleotides(selector) ?? false)
      : (selections?.hasNucleotides(selector) ?? false)
  );
  const profiledRoots =
    profiled.kind === 'multiple' ? profiled.snapshots.map((s) => s.root) : [profiled.root];
  for (const [index, root] of profiledRoots.entries()) {
    const presentation = (
      root.custom?.dnaforge_render_profile as
        | { presentation?: { preservePolymerContext?: boolean } }
        | undefined
    )?.presentation;
    const override = root.custom?.dnaforge_presentation_override;
    if (
      !presentation?.preservePolymerContext ||
      (override &&
        molecularPresentationOverrideSchema
          .parse(override)
          .fields.includes('preservePolymerContext'))
    )
      continue;
    const baselineIndex = molecularPolymerContextBaselineIndex(
      currentDocument,
      current.story?.activeIndex ?? 0,
      profiled,
      index
    );
    const baselineBindings = molViewSpecStructureBindings(currentDocument, baselineIndex);
    const proposedBindings = molViewSpecStructureBindings(profiled, index);
    for (const binding of baselineBindings) {
      const proposedBinding = proposedBindings.find((b) => b.ref === binding.ref);
      if (root.custom?.dnaforge_comparison && proposedBinding?.node.custom?.is_hidden === true)
        continue;
      if (
        proposedBinding &&
        molViewSpecStructureBindingKey(proposedBinding) !== molViewSpecStructureBindingKey(binding)
      )
        throw new MolViewSpecSceneError(
          'MVS_CONTEXT_SOURCE_UNSUPPORTED',
          'An existing structure identity was rebound to different coordinates or assembly/model parameters. Retain its identity and context or record a scientific preservePolymerContext exception.'
        );

      const parent = sourcesByBinding.get(molViewSpecStructureBindingKey(binding));
      if (!parent)
        throw new MolViewSpecSceneError(
          'MVS_CONTEXT_SOURCE_UNSUPPORTED',
          'The retained story step has no available exact coordinate source for polymer-context validation.'
        );
      requirePreservedPolymerContext(
        currentDocument,
        baselineIndex,
        { kind: 'single', root, metadata: profiled.metadata },
        parent,
        binding.ref
      );
    }
  }
  const proposedSources = profiledRoots.map((_, index) => {
    const sources = new Map<string, import('molstar/lib/mol-model/structure').Structure>();
    for (const binding of molViewSpecStructureBindings(profiled, index)) {
      const parent = sourcesByBinding.get(molViewSpecStructureBindingKey(binding));
      if (parent) sources.set(binding.ref, parent);
    }
    return sources;
  });
  const constructed = constructMolecularBindingRegions(profiled, (node, index) =>
    typeof node.ref === 'string' ? proposedSources[index].get(node.ref) : undefined
  );
  const attached = constructPrimaryConformerDisplays(
    resolveMolViewSpecAttachments(plugin, constructed, (node, index) =>
      typeof node.ref === 'string' ? proposedSources[index].get(node.ref) : undefined
    ),
    (node, index) =>
      typeof node.ref === 'string' ? proposedSources[index].get(node.ref) : undefined
  );

  const attachmentRoots =
    attached.kind === 'multiple' ? attached.snapshots.map((s) => s.root) : [attached.root];
  const attachmentNodes = [...attachmentRoots] as Array<{
    kind: string;
    params?: Record<string, unknown>;
    custom?: Record<string, unknown>;
    children?: unknown[];
  }>;
  while (attachmentNodes.length) {
    const node = attachmentNodes.pop()!;
    if (node.kind === 'component' && node.custom?.dnaforge_binding_region)
      node.custom.dnaforge_binding_region = {
        ...(node.custom.dnaforge_binding_region as Record<string, unknown>),
        detail: node.params?.selector,
      };
    attachmentNodes.push(...((node.children ?? []) as typeof attachmentNodes));
  }
  const designated = resolveMolecularDisplayGroups(
    attached,
    selections?.describe,
    (node, index) => {
      const parent =
        typeof node.ref === 'string' ? proposedSources[index].get(node.ref) : undefined;
      return parent ? molecularSceneSelections(parent) : undefined;
    }
  );
  const coherent = resolveMolViewSpecNativeContactOwners(
    resolveNucleotideAppearance(designated, (node, index) =>
      typeof node.ref === 'string' ? proposedSources[index].get(node.ref) : undefined
    ),
    (node, index) =>
      typeof node.ref === 'string' ? proposedSources[index].get(node.ref) : undefined
  );
  for (const root of coherent.kind === 'multiple'
    ? coherent.snapshots.map((snapshot) => snapshot.root)
    : [coherent.root])
    resolveMolecularContactCenterMarkers(root);
  requireComputedMolecularInterfaceSurfaces(coherent);
  requireMolecularSurfaceOwnership(
    coherent,
    (node, index) =>
      typeof node.ref === 'string' ? proposedSources[index].get(node.ref) : undefined,
    true
  );
  requireMolecularDisplayGroups(coherent);
  const compiled = MVSData.toMVSJ(
    resolveMolecularHydrogenDisplay(coherent, {
      kind: 'author',
      userRequest: userHydrogenRequest,
    })
  );
  validateMolViewSpecScene(compiled, resourceName);
  return compiled;
}

export function requireMolViewSpecSurfaceOwnership(plugin: MolstarPlugin, scene: string): void {
  const document = assignMolViewSpecStructureRefs(MVSData.fromMVSJ(scene));
  requireMolecularSurfaceOwnership(document, (node) =>
    typeof node.ref === 'string' ? resolveMolViewSpecStructureRef(plugin, node.ref) : undefined
  );
}

export function requireUnchangedMolViewSpecBackground(
  currentScene: string,
  proposedScene: string,
  resourceName: string | readonly string[],
  currentSnapshotIndex = 0,
  proposedSnapshotIndex?: number
): void {
  const current = validateMolViewSpecScene(currentScene, resourceName);
  const proposed = validateMolViewSpecScene(proposedScene, resourceName);
  const currentCanvas = canvasInSnapshot(current, currentSnapshotIndex);
  const indices =
    proposedSnapshotIndex === undefined
      ? proposed.kind === 'multiple'
        ? proposed.snapshots.map((_, index) => index)
        : [0]
      : [proposedSnapshotIndex];
  for (const index of indices) {
    if (canvasInSnapshot(proposed, index) === currentCanvas) continue;
    throw new MolViewSpecSceneError(
      MVS_BACKGROUND_LOCK.errorCode,
      `Story step ${index + 1} changes the current background. Keep the canvas node and background_color from mol_get_scene unchanged in every step.`
    );
  }
}

export function sameMolViewSpecDisplayTree(
  proposedScene: string,
  currentScene: string,
  resourceName: string | readonly string[]
): boolean {
  const display = (scene: string) => {
    const document = validateMolViewSpecScene(scene, resourceName);
    return canonicalJson(document.kind === 'multiple' ? document.snapshots : document.root);
  };
  return display(proposedScene) === display(currentScene);
}

function nativeStarterStructure(
  parsed: Parse,
  plugin: MolstarPlugin,
  format: CoordinateResource['format']
) {
  const entries = plugin.managers.structure.hierarchy.current.structures;
  const entry = entries[0];
  const source = entry?.transform?.cell.obj?.data ?? entry?.cell.obj?.data;
  if (!source)
    throw new MolViewSpecSceneError(
      'PLUGIN_NOT_READY',
      'The native structure is not ready to identify the starter scene.'
    );
  if (entries.length !== 1 || source.models.length !== 1)
    throw new MolViewSpecSceneError(
      'MVS_STARTER_IDENTITY_UNSUPPORTED',
      'A starter for several native structures or models cannot preserve their identities yet.'
    );

  const model = source.models[0];
  const params = {
    model_index: Model.TrajectoryInfo.get(model).index,
    ...(format !== 'pdb' && MmcifFormat.is(model.sourceData)
      ? { block_header: model.sourceData.data.frame.header }
      : {}),
  };

  const assemblyId = source.coordinateSystem.assembly?.id;
  const nativeType = entry.cell.params?.values.type?.name;
  if (!assemblyId && nativeType && !['model', 'auto', 'assembly'].includes(nativeType))
    throw new MolViewSpecSceneError(
      'MVS_STARTER_IDENTITY_UNSUPPORTED',
      `A starter cannot yet preserve the native ${nativeType} operators.`
    );
  const structure = assemblyId
    ? parsed.assemblyStructure({ ...params, assembly_id: assemblyId })
    : parsed.modelStructure(params);
  if (!source.coordinateSystem.isIdentity)
    structure.transform({ matrix: Array.from(source.coordinateSystem.matrix) });
  return structure;
}

export function getMolViewSpecScene(
  plugin: MolstarPlugin,
  connectionQuery?: MolecularConnectionQuery
) {
  const runtime = runtimeFor(plugin);
  const builder = MVSData.createBuilder();
  const parsed = builder
    .download({ url: runtime.resource.name })
    .parse({ format: runtime.resource.format });
  const structure = runtime.scene
    ? parsed.modelStructure()
    : nativeStarterStructure(parsed, plugin, runtime.resource.format);
  structure
    .component({ selector: 'polymer' })
    .representation({ type: 'cartoon' })
    .color({ color: '#3388ff' });
  structure
    .component({ selector: 'ligand' })
    .representation({ type: 'ball_and_stick' })
    .color({ color: '#ff9900' });
  const starter = builder.getState();

  starter.metadata.timestamp = runtime.starterTimestamp ??= starter.metadata.timestamp;
  const pending: Array<{
    kind: string;
    params?: Record<string, unknown>;
    custom?: Record<string, unknown>;
    children?: unknown[];
  }> = [starter.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === 'representation' && node.params?.type === 'ball_and_stick') {
      const color = (node.children as typeof pending | undefined)?.find(
        (child) => child.kind === 'color'
      );
      if (color)
        color.custom = {
          molstar_color_theme_name: 'element-symbol',
          molstar_color_theme_params: {
            carbonColor: { name: 'uniform', params: { value: 0xff9900 } },
            saturation: 0,
            lightness: 0,
            colors: { name: 'default', params: {} },
          },
        };
    }
    pending.push(...((node.children ?? []) as typeof pending));
  }
  const selection = getMolViewSpecRenderProfile(plugin);
  const proposedStarter = resolveMolViewSpecRenderProfile(starter, selection);
  const saved = runtime.scene ? MVSData.fromMVSJ(runtime.scene) : undefined;
  const activeRoot =
    saved?.kind === 'multiple'
      ? saved.snapshots[activeMolViewSpecSnapshotIndex(plugin)]?.root
      : saved?.root;
  const recorded = (activeRoot as { custom?: Record<string, unknown> } | undefined)?.custom
    ?.dnaforge_render_profile;

  return {
    format: 'mvsj' as const,
    sceneOrigin: runtime.scene ? ('authored' as const) : ('starter' as const),
    scene: runtime.scene ?? MVSData.toMVSJ(proposedStarter, 2),
    renderProfile: {
      selection,
      resolvedProfile:
        recorded === 'native'
          ? null
          : (recorded ??
            (selection === 'native'
              ? null
              : selection === 'default'
                ? currentMolecularRenderProfile()
                : selection)),
    },
    renderProfileGuidance: MOLECULAR_RENDER_PROFILE_GUIDANCE,
    primaryConformers: {
      default: 'primary-deposited-conformer-v1',
      recorded: activeRoot?.custom?.dnaforge_primary_conformers ?? null,
      comparison: activeRoot?.custom?.dnaforge_conformer_comparison ?? null,
      guidance:
        'New atomic authoring and computed contexts share one coherent occupancy-selected deposited residue alternative. Use root.custom.dnaforge_conformer_comparison:{reason:"scientific reason"} to compare alternatives; independent aligned structures are unaffected. Historical scenes retain their recorded atom/guide sets.',
    },
    interactionContacts: runtime.scene ? readManagedInteractionContacts(runtime.scene) : [],
    story:
      runtime.scene && MVSData.fromMVSJ(runtime.scene).kind === 'multiple'
        ? (() => {
            const document = MVSData.fromMVSJ(runtime.scene!);
            if (document.kind !== 'multiple') return undefined;
            return {
              activeIndex: activeMolViewSpecSnapshotIndex(plugin),
              steps: document.snapshots.map((snapshot, index) => ({
                index,
                title: snapshot.metadata?.title ?? `View ${index + 1}`,
                description: snapshot.metadata?.description,
                key: snapshot.metadata?.key,
              })),
            };
          })()
        : undefined,
    resource: {
      uri: runtime.resource.name,
      format: runtime.resource.format,
      boundTo: 'current-structure-view',
    },
    resources: [
      {
        uri: runtime.resource.name,
        format: runtime.resource.format,
        boundTo: 'current-structure-view',
      },
      ...(runtime.pinnedAssets ?? []).map((asset) => ({
        uri: asset.name,
        format: asset.format === 'cif' ? 'mmcif' : 'pdb',
        boundTo: 'pinned-comparison-asset',
        label: asset.label,
        sha256: asset.sha256,
      })),
    ],
    structureIdentities: molViewSpecStructureBindings(
      assignMolViewSpecStructureRefs(
        MVSData.fromMVSJ(runtime.scene ?? MVSData.toMVSJ(proposedStarter))
      ),
      activeMolViewSpecSnapshotIndex(plugin)
    ).map((binding) => ({
      ref: binding.ref,
      resourceUri: binding.resourceUri,
      structureParams: binding.node.params,
    })),
    supportedMajorVersion: MVSData.SupportedVersion,
    comparisonContract:
      runtime.scene && MVSData.fromMVSJ(runtime.scene).kind
        ? (() => {
            const doc = MVSData.fromMVSJ(runtime.scene!);
            const root =
              doc.kind === 'multiple'
                ? doc.snapshots[activeMolViewSpecSnapshotIndex(plugin)].root
                : doc.root;
            return root.custom?.dnaforge_comparison
              ? {
                  ...(root.custom.dnaforge_comparison as Record<string, unknown>),
                  registration: readSharedComparisonRegistration(
                    doc,
                    activeMolViewSpecSnapshotIndex(plugin)
                  ),
                  displayFraming: root.custom?.dnaforge_comparison_display ?? null,
                  displayFramingGuidance: MOLECULAR_COMPARISON_DISPLAY_GUIDANCE,
                  authoringContract: {
                    default: 'co-loaded-author-selected-story',
                    preference:
                      'The comparison mode comes from the bound viewer configuration; a submitted renderProfile cannot change it.',
                    alignmentOwnership:
                      'Only mol_align_structures can introduce or revise recorded alignment and its placement. Ordinary scene edits retain the existing frame.',
                    staging:
                      'Sources remain loaded across steps. If an overlay serves the question, establish its coordinate correspondence before claiming a registered comparison.',
                    stateJourney:
                      'With comparisonPresentation:"overlay", multi-step or state-hiding edits require recorded alignment covering every source. The constructor adds an all-visible correspondence step when authored views show the states separately.',
                    exception: {
                      field: 'root.custom.dnaforge_comparison_exception',
                      kind: 'no-corresponding-region',
                      reason: 'Explain why scientifically meaningful correspondence is absent.',
                      sources: 'Account for every pinned source as {uri,limitation}.',
                      scope: 'Record the same exception on every step.',
                    },
                    recordedException: root.custom.dnaforge_comparison_exception,
                  },
                  guidance:
                    'All comparison sources are already loaded together. The authored default retains their identities and placements while leaving step order and simultaneous visibility to the scientific explanation. An overlay is optional; when it serves the question, read registration and use mol_align_structures on scientifically justified corresponding regions before claiming a registered comparison. Co-loading and camera travel do not establish alignment. An explicit viewer comparisonPresentation:"overlay" preference requires recorded correspondence for every source and supplies an all-visible correspondence step when needed. If that chosen comparison genuinely has no corresponding region, record custom.dnaforge_comparison_exception:{kind:"no-corresponding-region",reason:"scientific limitation",sources:[{uri:"listed source URI",limitation:"source-specific limitation"}]} identically on every step. An unattempted fit is not evidence of absent correspondence. Author one ordered journey in this viewer. Hide a whole structure with custom.is_hidden:true without unloading it. Keep corresponding group colors consistent. Frame the deciding feature and its partners where foreground geometry does not hide them; maintain comparable orientation and scale across registered states.',
                }
              : undefined;
          })()
        : undefined,
    limitations: [
      runtime.pinnedAssets?.length
        ? 'Only listed pinned coordinate resources are available; external assets and MVSX import are not implemented. Use mol_align_structures with exact structureIdentities and declared regions for a source-verified overlay.'
        : 'External scene assets, MVSX import, and stories involving multiple coordinate resources are not implemented.',
      'Whole-scene edits must retain each complete native computed contact group in a relevant detail step. Styling is editable; contact deletion or guessed chemical guides fail before mutation. Choose physical focus participants through the native interaction-context tool rather than editing its derived contact set.',
    ],
    displayGroupContract:
      'Every displayed molecular representation receives an automatic designation and legend during authoring. Name scientific groups when useful; omitting names does not omit the legend. Equivalent ion copies share a chemical designation. Scene apply/save validates all story steps. Exact selection still requires verified physical selectors; automatic naming cannot choose the scientifically relevant ligand copy.',
    guidance:
      'Edit standard MVS nodes in scene and pass the complete JSON to mol_apply_scene. One view or an ordered kind:"multiple" story is supported. Use only the listed resource URI(s) and correct parse format; a snapshot may include more than one pinned resource. An aligned overlay needs an explicit transform grounded in corresponding regions; do not infer alignment from co-loading. Each snapshot can have its own title, description, camera, focus and appearance; mol_select_story_step changes the active step. Selectors are named sets (polymer, protein, ligand, water), an expression object such as {label_asym_id:"A"}, or an array of expressions (OR); keys within an expression are AND. Read mol_get_state for label/auth chain identities and molecularConnections. Use cartoon, ball_and_stick, spacefill, surface or native carbohydrate symbols, opacity nodes, component focus, and root camera {target:[x,y,z],position:[x,y,z],up:[x,y,z]}. Preserve canvas/background exactly; changes fail with MVS_BACKGROUND_LOCKED. One native owner draws each visual feature, including attachment bonds and nucleotide connectors; duplicate geometry fails with MVS_DUPLICATE_GEOMETRY. Known covalent ligand attachments are resolved into their atomic owner and validated; molecularConnections readback distinguishes deposited covalent bonds, disulfides, coordination and computed contacts. Never invent a covalent bond from proximity. Use the active render profile controls below for element-colored atoms, group carbon tints and independent nucleotide planes. Name meaningful groups with custom.dnaforge_legend_label; keep labels in the swatch legend unless on-structure labels are explicitly requested. Distances must name verified endpoint atoms, not guessed coordinates. Official primitive syntax: https://molstar.org/mol-view-spec-docs/primitives/. A starter is proposed, not a legacy recipe export. Native readback reports effective visuals, sizing, colors, alpha and attachment coverage.',
    native: readMolViewSpecNativeState(plugin, connectionQuery),
  };
}

export function getMolViewSpecDataScene(plugin: MolstarPlugin) {
  const current = getMolViewSpecScene(plugin);
  if (current.sceneOrigin === 'authored') return current;
  return {
    ...current,
    scene: captureNativeMolViewSpec(
      plugin,
      runtimeFor(plugin).resource,
      coordinateModels.get(plugin)
    ).scene,
  };
}

export function readMolViewSpecNativeState(
  plugin: MolstarPlugin,
  connectionQuery?: MolecularConnectionQuery
) {
  const connections = pageMolecularConnections(
    readMolecularConnectionCoverage(plugin),
    connectionQuery
  );
  return {
    colorSelectionGuidance:
      'Compiled native color-layer expressions are summarized with paramsSummarized:true. Their exact editable selectors remain in the complete MolViewSpec scene; layer order, themes and color settings are retained.',
    camera: plugin.canvas3d?.camera.getSnapshot() ?? null,
    componentRefs: plugin.managers.structure.hierarchy.current.structures.flatMap((structure) =>
      structure.components.map(molecularRepresentationOwnerRef)
    ),
    molecularConnections: connections.connections,
    molecularConnectionSummary: connections.summary,
    components: plugin.managers.structure.hierarchy.current.structures.flatMap((structure) =>
      structure.components.map((component) => ({
        label: component.cell.obj?.label ?? null,
        elementCount: component.cell.obj?.data.elementCount ?? 0,
        representations: component.representations.map((representation) => {
          const params = representation.cell.params?.values;
          return {
            type: params?.type.name ?? null,
            alpha: params?.type.params.alpha ?? null,
            colorTheme: params?.colorTheme.name ?? null,
            color: params?.colorTheme.params.value ?? null,
            visuals:
              params?.type.params.visuals ?? representation.cell.obj?.data.repr.props.visuals ?? [],
            typeParams: structuredClone(params?.type.params ?? {}),
            colorThemeParams: nativeColorThemeReadback(params?.colorTheme.params ?? {}),
            sizeTheme: structuredClone(params?.sizeTheme ?? null),
          };
        }),
      }))
    ),
  };
}

function nativeColorThemeReadback(params: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(params.layers)) return structuredClone(params);
  const layers = params.layers.map((value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    const layer = value as Record<string, unknown>;
    const selection = layer.selection;
    if (
      !selection ||
      typeof selection !== 'object' ||
      (selection as Record<string, unknown>).name !== 'expression'
    )
      return layer;
    const { params: _compiled, ...descriptor } = selection as Record<string, unknown>;
    return {
      ...layer,
      selection: { ...descriptor, paramsSummarized: true, exactSource: 'canonical-mvs-scene' },
    };
  });
  return structuredClone({ ...params, layers });
}

export async function loadMolViewSpecScene(
  plugin: MolstarPlugin,
  scene: string,
  isCurrent: () => boolean = () => true,
  options: SceneApplyOptions & {
    rejectDuplicateGeometry?: boolean;

    coordinateOnlyInitialLoad?: true;
  } = {}
): Promise<void> {
  const runtime = runtimeFor(plugin);
  registerMolecularRenderProfileVisuals(plugin, () => {
    const current = runtimes.get(plugin);
    if (!current?.scene) return undefined;
    const active = MVSData.fromMVSJ(current.scene);
    const root =
      active.kind === 'multiple'
        ? active.snapshots[activeMolViewSpecSnapshotIndex(plugin)]?.root
        : active.root;
    const recorded = root?.custom?.dnaforge_render_profile;
    return recorded &&
      typeof recorded === 'object' &&
      'version' in recorded &&
      typeof recorded.version === 'number' &&
      recorded.version >= 12
      ? root
      : undefined;
  });
  const document = stripMolViewSpecCanvasNodes(
    validateMolViewSpecScene(scene, activeMolViewSpecResourceNames(plugin))
  );
  const initialIndex = options.initialSnapshotIndex ?? 0;
  if (
    !Number.isInteger(initialIndex) ||
    initialIndex < 0 ||
    (document.kind === 'multiple' ? initialIndex >= document.snapshots.length : initialIndex !== 0)
  )
    throw new MolViewSpecSceneError(
      'MVS_STORY_STEP_INVALID',
      'The requested opening story step does not exist.'
    );
  if (!isCurrent())
    throw new MolViewSpecSceneError(
      'VIEW_CHANGED',
      'The structure view changed before scene application.'
    );
  if (
    runtime.scene &&
    runtime.representationRefs &&
    (await updateMolViewSpecAppearance(
      plugin,
      MVSData.fromMVSJ(runtime.scene),
      document,
      runtime.representationRefs,
      runtime.resource.sourceUrl,
      isCurrent,
      runtime.nativeRepresentationRefs
    ))
  ) {
    runtime.scene = MVSData.toMVSJ(document);
    runtime.nativeSnapshotIds = plugin.managers.snapshot.state.entries
      .toArray()
      .map((entry) => entry.snapshot.id);
    return;
  }
  if (options.appearanceOnly && !runtime.scene) {
    const captured = captureNativeMolViewSpec(
      plugin,
      runtime.resource,
      coordinateModels.get(plugin)
    );
    const bound = bindMolViewSpecRepresentations(captured.document);

    const models = plugin.managers.structure.hierarchy.current.structures[0].cell.obj!.data.models;
    const previousFlags = models.map((model) => IsMVSModelProvider.props(model));
    let adopted = false;
    try {
      models.forEach((model) => IsMVSModelProvider.set(model, { isMvs: true }));
      if (
        await updateMolViewSpecAppearance(
          plugin,
          captured.document,
          document,
          bound.refs,
          runtime.resource.sourceUrl,
          isCurrent,
          captured.nativeRefs
        )
      ) {
        runtime.scene = MVSData.toMVSJ(document);
        runtime.representationRefs = bound.refs;
        runtime.nativeRepresentationRefs = captured.nativeRefs;
        adopted = true;
        return;
      }
    } finally {
      if (!adopted)
        models.forEach((model, index) => IsMVSModelProvider.set(model, previousFlags[index]));
    }
  }
  if (options.appearanceOnly)
    throw new MolViewSpecSceneError(
      'MVS_APPEARANCE_UPDATE_UNAVAILABLE',
      'This edit cannot update the existing representation in place. Prepare an authored single view before applying data; the structure and camera were left unchanged.'
    );
  const previous = plugin.state.getSnapshot({ data: true, camera: true, canvas3d: true });
  const previousSnapshots = await plugin.managers.snapshot.getStateSnapshot({ playOnLoad: false });
  const previousScene = runtime.scene;
  const previousNativeSnapshotIds = runtime.nativeSnapshotIds;
  const previousCommittedCamera = runtime.committedCamera;
  const previousTransparentBackground = plugin.canvas3d?.props.transparentBackground;
  try {
    const bound = bindMolViewSpecRepresentations(
      assignMolViewSpecStructureRefs(structuredClone(document))
    );

    const opening = prepareMolViewSpecForOpening(bound.document);

    const openingRoots =
      opening.document.kind === 'multiple'
        ? opening.document.snapshots.map((snapshot) => snapshot.root)
        : [opening.document.root];
    for (const root of openingRoots) resolveMolecularContactCenterMarkers(root);

    const geometryCommit = plugin.state.data.events.changed.subscribe(() => {
      plugin.canvas3d?.commit(true);
    });
    try {
      await loadMVS(plugin, opening.document, {
        sourceUrl: runtime.resource.sourceUrl,
        doNotReportErrors: true,
        extensions: [
          ...BuiltinLoadingExtensions,
          nativeSizeThemeExtension,
          decodedCoordinateExtension,
          MolecularInterfaceSurfaceExtension,
          MolecularNativeCaptureExtension,
        ],
      });
    } finally {
      geometryCommit.unsubscribe();
    }
    inheritMolViewSpecNativeVisibility(plugin);
    if (opening.wraparoundTransitionMs) {
      const firstSnapshot = plugin.managers.snapshot.state.entries.toArray()[0]?.snapshot;
      if (firstSnapshot?.camera) {
        firstSnapshot.camera.transitionDurationInMs = opening.wraparoundTransitionMs;
        firstSnapshot.durationInMs =
          (firstSnapshot.durationInMs ?? 0) + opening.wraparoundTransitionMs;
      }
    }

    const openingCamera = plugin.canvas3d?.camera;
    if (openingCamera?.transition.inTransition) {
      const destination = openingCamera.transition.target;
      openingCamera.transition.inTransition = false;
      openingCamera.setState(destination, 0);
      plugin.canvas3d?.requestDraw();
    }
    const failed = [...plugin.state.data.cells.values()].find((cell) => cell.status === 'error');
    if (failed) throw new Error(failed.errorText || 'A MolViewSpec transform failed.');
    if (document.kind === 'multiple' && initialIndex !== 0) {
      const entry = plugin.managers.snapshot.state.entries.toArray()[initialIndex];
      if (!entry)
        throw new MolViewSpecSceneError(
          'MVS_STORY_UNAVAILABLE',
          'The requested native story step is unavailable.'
        );
      await PluginCommands.State.Snapshots.Apply(plugin, { id: entry.snapshot.id });
    }
    configureMolViewSpecCanvasBackground(
      plugin,
      document.kind === 'multiple'
        ? { root: document.snapshots[initialIndex].root, metadata: document.metadata }
        : document
    );

    const ready = await waitForPluginInteractionReady(plugin, { isCurrent, includeCamera: true });
    if (!ready)
      throw new MolViewSpecSceneError(
        'VIEW_CHANGED',
        'The structure view changed during scene application.'
      );
    if (!ready.structureCount || (!ready.representationCount && !options.coordinateOnlyInitialLoad))
      throw new Error('The scene contains no visible molecular representation.');
    if (options.rejectDuplicateGeometry)
      await requireNonduplicatedStoryGeometry(plugin, document, isCurrent);
    options.validateNative?.();
    runtime.scene = MVSData.toMVSJ(document);
    runtime.representationRefs = bound.refs;
    runtime.nativeRepresentationRefs = undefined;
    runtime.committedCamera = undefined;
    runtime.nativeSnapshotIds = plugin.managers.snapshot.state.entries
      .toArray()
      .map((entry) => entry.snapshot.id);
    notifyStructureSceneReplaced(plugin);
    plugin.canvas3d?.requestDraw();
  } catch (error) {
    if (!(error instanceof MolViewSpecSceneError))
      console.error('[MolViewSpec] Native scene application failed:', error);

    if (!isCurrent()) {
      throw new MolViewSpecSceneError(
        'VIEW_CHANGED',
        'The structure view changed during scene application.',
        'unknown'
      );
    }
    try {
      await plugin.managers.snapshot.setStateSnapshot(previousSnapshots);
      await plugin.state.setSnapshot(previous);
      runtime.scene = previousScene;
      runtime.nativeSnapshotIds = previousNativeSnapshotIds;
      runtime.committedCamera = previousCommittedCamera;
      if (previousTransparentBackground !== undefined)
        plugin.canvas3d?.setProps({ transparentBackground: previousTransparentBackground });
      notifyStructureSceneReplaced(plugin);
    } catch {
      runtime.scene = undefined;
      runtime.nativeSnapshotIds = undefined;
      runtime.committedCamera = undefined;
      throw new MolViewSpecSceneError(
        'MVS_ROLLBACK_FAILED',
        'Scene application failed and the previous viewer state could not be restored.',
        'unknown'
      );
    }
    throw new MolViewSpecSceneError(
      error instanceof MolViewSpecSceneError ? error.code : 'MVS_RENDER_FAILED',
      `${error instanceof Error ? error.message : String(error)} The previous scene was restored.`
    );
  }
}
