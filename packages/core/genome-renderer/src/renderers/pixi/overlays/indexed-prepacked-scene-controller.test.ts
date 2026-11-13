// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartitionedInstancedTranscriptLayer } from '../overview/partitioned-instanced-transcript-layer';
import type {
  PrepackedAnnotationSceneLoadInput,
  PrepackedAnnotationSceneMetadata,
} from '../overview/prepacked-annotation-scene';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import {
  PrepackedAnnotationSceneController,
  type ResidentPrepackedAnnotationScene,
} from './indexed-prepacked-scene-controller';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function fakeLayer(overrides: Partial<PartitionedInstancedTranscriptLayer> = {}): {
  destroyed: number;
  hidden: number;
} {
  const layer = {
    destroyed: 0,
    hidden: 0,
    isGpuPrepared: true,
    isPresenting: false,
    container: { parent: null },
    hide() {
      layer.hidden += 1;
    },
    show() {},
    destroy() {
      layer.destroyed += 1;
    },
    getAnnotationPolicyTrackLaneMaxima: () => null,
    updateVisibleRange: () => [],
    updateCamera() {},
    ...overrides,
  };
  return layer;
}

function fakeResident(
  ownerKey: string,
  layer: { destroyed: number; hidden: number }
): ResidentPrepackedAnnotationScene {
  const metadata = {
    trackType: 'mRNA',
    themeMode: 'light',
  } as PrepackedAnnotationSceneMetadata;
  const input = {
    ownerKey,
    metadata,
  } as PrepackedAnnotationSceneLoadInput;
  return {
    ownerKey,
    input,
    sourceInput: input,
    metadata,
    layer: layer as unknown as PartitionedInstancedTranscriptLayer,
    policyTrackLaneMaxima: null,
    policyGeneration: 0,
    viewportDetailPresentationAdmitted: true,
    lastUsed: 0,
    visiblePartitionCount: 0,
    visibleInstanceCount: 0,
  };
}

describe('PrepackedAnnotationSceneController', () => {
  it('materializes, activates, and disposes residents on the controller itself', () => {
    const controller = new PrepackedAnnotationSceneController();
    const layer = fakeLayer();
    const resident = fakeResident('mrna', layer);

    controller.installResident(resident);

    expect(controller.size).toBe(1);
    expect(controller.get('mrna')).toBe(resident);
    expect(controller.residents.get('mrna')).toBe(resident);
    expect(controller.activate('mrna')).toBe(true);
    expect(controller.prepackedAnnotationSceneOwnerKey).toBe('mrna');
    expect(controller.prepackedAnnotationSceneLayer).toBe(layer);
    expect(controller.prepackedAnnotationSceneStatus).toBe('eligible');

    controller.dispose();

    expect(controller.size).toBe(0);
    expect(controller.get('mrna')).toBeUndefined();
    expect(controller.prepackedAnnotationSceneOwnerKey).toBeNull();
    expect(controller.prepackedAnnotationSceneLayer).toBeNull();
    expect(layer.destroyed).toBe(1);
  });

  it('does not keep prepackedAnnotationSceneResidents as an overlay-owned field', () => {
    const overlay = new IndexedAnnotationOverlay();
    const controller = overlay.getPrepackedControllerForTest();

    expect(Object.hasOwn(overlay, 'prepackedAnnotationSceneResidents')).toBe(false);
    expect(overlay.prepackedAnnotationSceneResidents).toBe(
      controller.prepackedAnnotationSceneResidents
    );
    expect(controller).toBeInstanceOf(PrepackedAnnotationSceneController);
    expect(controller.residents).toBeInstanceOf(Map);
    expect(controller.residents).toBe(controller.prepackedAnnotationSceneResidents);

    const source = overlaySource();
    expect(source).not.toMatch(/private(?: readonly)? prepackedAnnotationSceneResidents\b/);
    expect(source).toContain('private readonly prepacked = new PrepackedAnnotationSceneController');
    expect(source).not.toContain('this as unknown as PrepackedMaterializeOverlayBindings');
    expect(source).not.toContain('this as unknown as PrepackedPolicyOverlayBindings');
    expect(source).not.toContain('this as unknown as PrepackedPresentFrameOverlayBindings');
    expect(source).not.toContain('this as unknown as PrepackedSceneTeardownHost');
  });
});
