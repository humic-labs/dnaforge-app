import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from 'pixi.js';
import type { RenderState } from './types';
import type { PrepackedAnnotationSceneLoadInput } from './renderers/pixi/overview/prepacked-annotation-scene';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  prepackedAnnotationSceneArtifactKey,
} from './renderers/pixi/overview/prepacked-annotation-scene';
import { buildPrepackedAnnotationInteractionIndexV2 } from './renderers/pixi/overview/prepacked-annotation-interaction-index-v2';
import {
  activateActivePrepackedAnnotationScene,
  clearActivePrepackedAnnotationScene,
  loadActivePrepackedAnnotationScene,
  prepareActivePrepackedAnnotationScene,
  registerWebGLInstance,
  snapshotActivePrepackedAnnotationSceneOwner,
  unregisterWebGLInstance,
} from './webgl-registry';

const ID = 'prepacked-registry-test';
const ID_B = 'prepacked-registry-test-visible-second-full-id';

afterEach(() => {
  unregisterWebGLInstance(ID);
  unregisterWebGLInstance(ID_B);
});

function input(): PrepackedAnnotationSceneLoadInput {
  return {
    ownerKey: 'owner-a',
    scene: {
      primitives: [],
      featureFamilyIndices: new Uint32Array(0),
      families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
    },
    interactionIndex: buildPrepackedAnnotationInteractionIndexV2([], []),
    metadata: {
      genomeIdentity: 'assembly-source',
      genomeLengthBp: 1000,
      partitionSpanBp: 100,
      artifactKey: prepackedAnnotationSceneArtifactKey({
        themeMode: 'light',
        trackType: 'mRNA',
      }),
      themeMode: 'light',
      trackType: 'mRNA',
      annotationBarHeightPx: 14,
      laneAlgorithmToken: 'source-lanes.v1',
      mapperContractToken: 'annotation-isoform-mapper.v2',
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    },
  };
}

function register(
  renderer: unknown,
  instanceId = ID,
  visible = true,
  connected = true,
  appDestroyed = false
): void {
  registerWebGLInstance({
    instanceId,
    createdAt: 0,
    containerRef: { current: { isConnected: connected } as HTMLElement },
    appRef: { current: { destroyed: appDestroyed } as unknown as Application },
    rendererRef: { current: renderer },
    stateRef: { current: {} as RenderState },
    visibleRef: { current: visible },
    genomeRef: { current: null },
    frameCountRef: { current: 0 },
    lastFrameTRef: { current: 0 },
  });
}

describe('active prepacked annotation scene registry routing', () => {
  it('returns the exact full instance id and constant-time owner snapshot for one visible live instance', () => {
    const owner = {
      ownerKey: 'owner-a',
      ownerGeneration: 17,
      loaded: true,
      status: 'outside-corridor' as const,
      gpuPrepared: true,
      metadata: input().metadata,
    };
    const getOwner = vi.fn(() => owner);
    register({ getPrepackedAnnotationSceneOwnerSnapshot: getOwner });

    expect(snapshotActivePrepackedAnnotationSceneOwner()).toEqual({
      verdict: 'exactly-one',
      instanceId: ID,
      instanceCreatedAt: 0,
      visibleLiveInstanceCount: 1,
      candidateInstanceIds: [ID],
      owner,
    });
    expect(getOwner).toHaveBeenCalledOnce();
  });

  it('fails closed without selecting an owner when visible live instances are ambiguous', () => {
    const getA = vi.fn();
    const getB = vi.fn();
    register({ getPrepackedAnnotationSceneOwnerSnapshot: getA });
    register({ getPrepackedAnnotationSceneOwnerSnapshot: getB }, ID_B);

    expect(snapshotActivePrepackedAnnotationSceneOwner()).toEqual({
      verdict: 'ambiguous',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: 2,
      candidateInstanceIds: [ID, ID_B],
      owner: null,
    });
    expect(getA).not.toHaveBeenCalled();
    expect(getB).not.toHaveBeenCalled();
  });

  it('ignores hidden instances when selecting the sole visible live owner', () => {
    const owner = {
      ownerKey: null,
      ownerGeneration: 0,
      loaded: false,
      status: 'not-loaded' as const,
      gpuPrepared: false,
      metadata: null,
    };
    register({ getPrepackedAnnotationSceneOwnerSnapshot: () => owner });
    register({ getPrepackedAnnotationSceneOwnerSnapshot: vi.fn() }, ID_B, false);
    expect(snapshotActivePrepackedAnnotationSceneOwner()).toEqual({
      verdict: 'exactly-one',
      instanceId: ID,
      instanceCreatedAt: 0,
      visibleLiveInstanceCount: 1,
      candidateInstanceIds: [ID],
      owner,
    });
  });

  it('excludes disconnected and destroyed registrations from live ownership', () => {
    const owner = {
      ownerKey: 'owner-a',
      ownerGeneration: 1,
      loaded: true,
      status: 'eligible' as const,
      gpuPrepared: true,
      metadata: input().metadata,
    };
    register({ getPrepackedAnnotationSceneOwnerSnapshot: () => owner });
    register({ getPrepackedAnnotationSceneOwnerSnapshot: vi.fn() }, ID_B, true, false);
    expect(snapshotActivePrepackedAnnotationSceneOwner()).toMatchObject({
      verdict: 'exactly-one',
      instanceId: ID,
      visibleLiveInstanceCount: 1,
    });

    unregisterWebGLInstance(ID_B);
    register({ getPrepackedAnnotationSceneOwnerSnapshot: vi.fn() }, ID_B, true, true, true);
    expect(snapshotActivePrepackedAnnotationSceneOwner()).toMatchObject({
      verdict: 'exactly-one',
      instanceId: ID,
      visibleLiveInstanceCount: 1,
    });
  });

  it('passes the validated scene by reference and clears the accepting active renderer', () => {
    const scene = input();
    const load = vi.fn(() => true);
    const clear = vi.fn();
    register({ loadPrepackedAnnotationScene: load, clearPrepackedAnnotationScene: clear });

    expect(loadActivePrepackedAnnotationScene(scene)).toBe(true);
    expect(load).toHaveBeenCalledWith(scene);
    expect(clearActivePrepackedAnnotationScene()).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('routes inactive preparation and explicit activation as separate operations', () => {
    const scene = input();
    const prepare = vi.fn(() => true);
    const activate = vi.fn(() => true);
    register({
      preparePrepackedAnnotationScene: prepare,
      activatePrepackedAnnotationScene: activate,
    });

    expect(prepareActivePrepackedAnnotationScene(scene)).toBe(true);
    expect(prepare).toHaveBeenCalledWith(scene);
    expect(activate).not.toHaveBeenCalled();
    expect(activateActivePrepackedAnnotationScene(scene.ownerKey)).toBe(true);
    expect(activate).toHaveBeenCalledWith(scene.ownerKey);
  });

  it('routes every mutation to the sole visible live renderer when a hidden older renderer was registered first', () => {
    const scene = input();
    const hiddenOlder = {
      loadPrepackedAnnotationScene: vi.fn(() => true),
      preparePrepackedAnnotationScene: vi.fn(() => true),
      activatePrepackedAnnotationScene: vi.fn(() => true),
      clearPrepackedAnnotationScene: vi.fn(),
    };
    const visibleCurrent = {
      loadPrepackedAnnotationScene: vi.fn(() => true),
      preparePrepackedAnnotationScene: vi.fn(() => true),
      activatePrepackedAnnotationScene: vi.fn(() => true),
      clearPrepackedAnnotationScene: vi.fn(),
    };
    register(hiddenOlder, ID, false);
    register(visibleCurrent, ID_B, true);

    expect(loadActivePrepackedAnnotationScene(scene)).toBe(true);
    expect(prepareActivePrepackedAnnotationScene(scene)).toBe(true);
    expect(activateActivePrepackedAnnotationScene(scene.ownerKey)).toBe(true);
    expect(clearActivePrepackedAnnotationScene()).toBe(true);

    expect(hiddenOlder.loadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(hiddenOlder.preparePrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(hiddenOlder.activatePrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(hiddenOlder.clearPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(visibleCurrent.loadPrepackedAnnotationScene).toHaveBeenCalledOnce();
    expect(visibleCurrent.loadPrepackedAnnotationScene).toHaveBeenCalledWith(scene);
    expect(visibleCurrent.preparePrepackedAnnotationScene).toHaveBeenCalledOnce();
    expect(visibleCurrent.preparePrepackedAnnotationScene).toHaveBeenCalledWith(scene);
    expect(visibleCurrent.activatePrepackedAnnotationScene).toHaveBeenCalledOnce();
    expect(visibleCurrent.activatePrepackedAnnotationScene).toHaveBeenCalledWith(scene.ownerKey);
    expect(visibleCurrent.clearPrepackedAnnotationScene).toHaveBeenCalledOnce();
  });

  it('fails every mutation closed without touching either renderer when visible live ownership is ambiguous', () => {
    const scene = input();
    const first = {
      loadPrepackedAnnotationScene: vi.fn(() => true),
      preparePrepackedAnnotationScene: vi.fn(() => true),
      activatePrepackedAnnotationScene: vi.fn(() => true),
      clearPrepackedAnnotationScene: vi.fn(),
    };
    const second = {
      loadPrepackedAnnotationScene: vi.fn(() => true),
      preparePrepackedAnnotationScene: vi.fn(() => true),
      activatePrepackedAnnotationScene: vi.fn(() => true),
      clearPrepackedAnnotationScene: vi.fn(),
    };
    register(first, ID);
    register(second, ID_B);

    expect(loadActivePrepackedAnnotationScene(scene)).toBe(false);
    expect(prepareActivePrepackedAnnotationScene(scene)).toBe(false);
    expect(activateActivePrepackedAnnotationScene(scene.ownerKey)).toBe(false);
    expect(clearActivePrepackedAnnotationScene()).toBe(false);

    for (const mutation of [
      first.loadPrepackedAnnotationScene,
      first.preparePrepackedAnnotationScene,
      first.activatePrepackedAnnotationScene,
      first.clearPrepackedAnnotationScene,
      second.loadPrepackedAnnotationScene,
      second.preparePrepackedAnnotationScene,
      second.activatePrepackedAnnotationScene,
      second.clearPrepackedAnnotationScene,
    ]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it('fails every mutation closed when no visible live renderer exists', () => {
    const hidden = {
      loadPrepackedAnnotationScene: vi.fn(() => true),
      preparePrepackedAnnotationScene: vi.fn(() => true),
      activatePrepackedAnnotationScene: vi.fn(() => true),
      clearPrepackedAnnotationScene: vi.fn(),
    };
    register(hidden, ID, false);

    expect(loadActivePrepackedAnnotationScene(input())).toBe(false);
    expect(prepareActivePrepackedAnnotationScene(input())).toBe(false);
    expect(activateActivePrepackedAnnotationScene('owner-a')).toBe(false);
    expect(clearActivePrepackedAnnotationScene()).toBe(false);
    expect(hidden.loadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(hidden.preparePrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(hidden.activatePrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(hidden.clearPrepackedAnnotationScene).not.toHaveBeenCalled();
  });

  it('fails closed when the renderer rejects the contract', () => {
    register({ loadPrepackedAnnotationScene: () => false });
    expect(loadActivePrepackedAnnotationScene(input())).toBe(false);
    expect(clearActivePrepackedAnnotationScene()).toBe(false);
  });
});
