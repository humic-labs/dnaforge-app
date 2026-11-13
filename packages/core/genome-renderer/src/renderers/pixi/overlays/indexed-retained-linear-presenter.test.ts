// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { RetainedLinearPresenter } from './indexed-retained-linear-presenter';
import type { RetainedLinearTranscriptLayer } from '../overview/retained-linear-transcript-layer';
import type { RetainedOverviewAnnotationLayer } from '../overview/retained-overview-layer';
import type { RetainedLinearFeatureLayer } from '../overview/retained-linear-feature-layer';
import type { GenomeWideTextureCacheLayer } from '../overview/genome-wide-texture-cache-layer';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function fakeLayer<T>(label: string): T {
  return {
    label,
    hide() {},
    destroy() {},
    resetData() {},
    container: { parent: null },
  } as unknown as T;
}

describe('RetainedLinearPresenter', () => {
  it('holds retained-linear layers and maps on the presenter itself', () => {
    const presenter = new RetainedLinearPresenter();
    const overview = fakeLayer<RetainedOverviewAnnotationLayer>('overview');
    const feature = fakeLayer<RetainedLinearFeatureLayer>('feature');
    const transcript = fakeLayer<RetainedLinearTranscriptLayer>('transcript');
    const texture = fakeLayer<GenomeWideTextureCacheLayer>('texture');

    presenter.retainedOverviewLayer = overview;
    presenter.retainedLinearFeatureLayer = feature;
    presenter.retainedLinearTranscriptLayer = transcript;
    presenter.genomeWideTextureCacheLayer = texture;
    presenter.retainedLinearTranscriptFeatureSet = new Set();
    presenter.retainedLinearTranscriptKey = 'linear-tx|g:1';
    presenter.presentationVisible = false;
    presenter.lastRenderKey = 'k';
    presenter.retainedDrawStateClean = true;

    expect(presenter.retainedOverviewLayer).toBe(overview);
    expect(presenter.retainedLinearFeatureLayer).toBe(feature);
    expect(presenter.retainedLinearTranscriptLayer).toBe(transcript);
    expect(presenter.genomeWideTextureCacheLayer).toBe(texture);
    expect(presenter.retainedLinearTranscriptFeatureSet).toBeInstanceOf(Set);
    expect(presenter.retainedLinearTranscriptFeatureKeyCache).toBeInstanceOf(WeakMap);
    expect(presenter.presentationVisible).toBe(false);
    expect(presenter.lastRenderKey).toBe('k');
    expect(presenter.retainedDrawStateClean).toBe(true);
  });

  it('does not keep retainedLinearTranscriptLayer as an overlay-owned field', () => {
    const overlay = new IndexedAnnotationOverlay();
    const presenter = overlay.getRetainedLinearPresenterForTest();

    expect(Object.hasOwn(overlay, 'retainedLinearTranscriptLayer')).toBe(false);
    expect(Object.hasOwn(overlay, 'retainedOverviewLayer')).toBe(false);
    expect(Object.hasOwn(overlay, 'retainedLinearFeatureLayer')).toBe(false);
    expect(Object.hasOwn(overlay, 'genomeWideTextureCacheLayer')).toBe(false);
    expect(Object.hasOwn(overlay, 'graphics')).toBe(false);
    expect(Object.hasOwn(overlay, 'overviewCache')).toBe(false);
    expect(Object.hasOwn(overlay, 'labelPool')).toBe(false);
    expect(Object.hasOwn(presenter, 'graphics')).toBe(true);
    expect(Object.hasOwn(presenter, 'overviewCache')).toBe(true);
    expect(presenter).toBeInstanceOf(RetainedLinearPresenter);
    expect(Object.hasOwn(presenter, 'retainedLinearTranscriptLayer')).toBe(true);
    expect(presenter.retainedLinearTranscriptLayer).toBeNull();

    const source = overlaySource();
    expect(source).not.toMatch(/private(?: readonly)? retainedLinearTranscriptLayer\b/);
    expect(source).not.toMatch(/private(?: readonly)? retainedOverviewLayer\b/);
    expect(source).not.toMatch(/private(?: readonly)? retainedLinearFeatureLayer\b/);
    expect(source).not.toMatch(/private(?: readonly)? genomeWideTextureCacheLayer\b/);
    expect(source).toContain('private readonly retainedLinear = new RetainedLinearPresenter');
    expect(source).not.toContain('createStadiumRetainedCameraHost');
    expect(source).not.toContain('createRetainedDrawHost');
    expect(source).not.toContain('createBeginDrawAuditHost');
    expect(source).not.toContain('createPrepackedSceneLifecycleHost');
    expect(source).not.toContain('createTilePyramidCompositeHost');
    expect(source).not.toContain('createFlatPresentationSnapshotHost');
    expect(source).not.toContain('createPrebuiltTexturePolicyHost');
    expect(source).not.toContain('createPresentationAuditHost');
    expect(source).toContain('renderAnnotationOverlayFrame(this.retainedLinear, path, state)');
    expect(source).not.toContain('this as unknown as StadiumRetainedCameraHost');
    expect(source).not.toContain('this as unknown as RetainedLinearSyncHost');
    expect(source).not.toContain('this as unknown as RetainedLinearCameraHost');
    expect(source).not.toContain('this as unknown as EmptyRetainedViewportHost');
    expect(source).not.toContain('this as unknown as RetainedOverviewResetHost');
    expect(source).not.toContain('this as unknown as PrebuiltRasterEligibilityHost');
    expect(source).not.toContain('this as unknown as InvariantGuardHost');
    expect(source).not.toContain('this as unknown as PresentBookkeepingHost');
    expect(source).not.toContain('this as unknown as ResetPresentersHost');
    expect(source).not.toContain('this as unknown as RetainedLinearSourceWindowHost');
    expect(source).not.toContain(
      'ensureRetainedOverviewLayerFn(this as unknown as OverlayLifecycleHost)'
    );
    expect(source).not.toContain('setRendererFn(this as unknown as OverlayLifecycleHost');
    expect(source).not.toContain('buildRetainedDataFn(this as unknown as OverlayLifecycleHost');
    expect(source).not.toContain(
      'destroyAnnotationOverlayFn(this as unknown as OverlayLifecycleHost)'
    );
  });

  it('invalidates the decoration cache key when clearing decoration graphics', () => {
    const overlay = new IndexedAnnotationOverlay();
    const presenter = overlay.getRetainedLinearPresenterForTest();
    presenter.decorationCacheKey = 'chev|must-not-survive';
    presenter.retainedTranscriptDecorationGraphics.position.x = 12;
    presenter.clearDecorationCache();
    expect(presenter.decorationCacheKey).toBe('');
    expect(presenter.retainedTranscriptDecorationGraphics.position.x).toBe(0);
  });

  it('does not hop leftover overviewCacheContext through the retained presenter', () => {
    const overlay = new IndexedAnnotationOverlay();
    const presenter = overlay.getRetainedLinearPresenterForTest();
    const leftover = (
      presenter as unknown as {
        overlay: { overviewCacheContext: () => ReturnType<typeof presenter.overviewCacheContext> };
      }
    ).overlay;
    const fromLeftover = leftover.overviewCacheContext();
    const fromPresenter = presenter.overviewCacheContext();
    expect(fromLeftover.genomeLength).toBe(fromPresenter.genomeLength);
    expect(fromLeftover.features).toBe(fromPresenter.features);
    expect(typeof fromLeftover.getOffset).toBe('function');
    expect(typeof fromPresenter.getOffset).toBe('function');
  });
});
