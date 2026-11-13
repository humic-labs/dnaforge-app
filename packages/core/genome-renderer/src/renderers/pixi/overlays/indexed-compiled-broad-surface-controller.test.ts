// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { CompiledBroadSurfaceController } from './indexed-compiled-broad-surface-controller';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function fakeOwner(trackId: string): CompiledBroadSurfaceTrackOwnerV2 {
  return {
    manifest: { trackId, manifestFingerprint: `${trackId}-fp` },
    provenance: { prepackedOwnerKey: trackId },
    presenter: { hide() {}, destroy() {}, isPresenting: false },
  } as unknown as CompiledBroadSurfaceTrackOwnerV2;
}

describe('CompiledBroadSurfaceController', () => {
  it('holds the track-owner map on the controller itself', () => {
    const controller = new CompiledBroadSurfaceController();
    const owner = fakeOwner('mRNA');

    controller.compiledBroadSurfaceTrackOwners.set('mRNA', owner);

    expect(controller.compiledBroadSurfaceTrackOwners.get('mRNA')).toBe(owner);
    expect(controller.compiledBroadSurfaceTrackOwners.size).toBe(1);
    expect(controller.compiledBroadSurfaceOwnerForTrack('mRNA')?.manifest.trackId).toBe('mRNA');

    controller.installCompiledBroadSurfaceActiveOwner(owner);

    expect(controller.compiledBroadSurfaceManifest).toBe(owner.manifest);
    expect(controller.compiledBroadSurfacePresenter).toBe(owner.presenter);
    expect(controller.compiledBroadSurfaceProvenance).toBe(owner.provenance);
  });

  it('installs case-distinct scientific track owners without evicting either one', () => {
    const controller = new CompiledBroadSurfaceController();
    const lower = fakeOwner('transposon:Dm88');
    const upper = fakeOwner('transposon:DM88');

    controller.installCompiledBroadSurfaceActiveOwner(lower);
    controller.installCompiledBroadSurfaceActiveOwner(upper);

    expect(controller.compiledBroadSurfaceTrackOwners.size).toBe(2);
    expect(controller.compiledBroadSurfaceOwnerForTrack(lower.manifest.trackId)).toBe(lower);
    expect(controller.compiledBroadSurfaceOwnerForTrack(upper.manifest.trackId)).toBe(upper);
    expect(controller.compiledBroadSurfaceOwnerForTrack('transposon:dm88')).toBeNull();
  });

  it('does not keep compiledBroadSurfaceTrackOwners as an overlay-owned field', () => {
    const overlay = new IndexedAnnotationOverlay();
    const controller = overlay.getCompiledBroadControllerForTest();

    expect(Object.hasOwn(overlay, 'compiledBroadSurfaceTrackOwners')).toBe(false);
    expect(controller).toBeInstanceOf(CompiledBroadSurfaceController);
    expect(controller.compiledBroadSurfaceTrackOwners).toBeInstanceOf(Map);

    const source = overlaySource();
    expect(source).not.toMatch(/private(?: readonly)? compiledBroadSurfaceTrackOwners\b/);
    expect(source).toContain('private readonly compiledBroad = new CompiledBroadSurfaceController');
    expect(source).not.toContain('this as unknown as CompiledBroadFrameOverlayBindings');
    expect(source).not.toContain('this as unknown as CompiledBroadDemandOverlayBindings');
    expect(source).not.toContain('this as unknown as CompiledBroadLoadOverlayBindings');
    expect(source).not.toContain('this as unknown as CompiledBroadAdmitOverlayBindings');
    expect(source).not.toContain('this as unknown as CompiledBroadOwnerLifecycleHost');
    expect(source).not.toContain('this as unknown as CompiledBroadInteractionResidentHost');
  });
});
