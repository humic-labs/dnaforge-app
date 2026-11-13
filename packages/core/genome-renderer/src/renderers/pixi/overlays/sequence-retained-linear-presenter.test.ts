import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { SequenceAnnotationOverlay } from './sequence-annotation-overlay';
import {
  SequenceRetainedLinearPresenter,
  RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES,
  type SequenceRetainedLinearGlue,
} from './sequence-retained-linear-presenter';
import type { RetainedLinearTranscriptLayer } from '../overview/retained-linear-transcript-layer';
import type { RetainedOverviewAnnotationLayer } from '../overview/retained-overview-layer';
import type { RetainedLinearFeatureLayer } from '../overview/retained-linear-feature-layer';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'sequence-annotation-overlay.ts'), 'utf8');
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

function feature(id: number, start = id * 10, end = id * 10 + 5): Feature {
  return {
    id,
    type: 'gene',
    start,
    end,
    direction: 'forward',
    displayName: `f${id}`,
    color: 0,
    lane: 0,
  };
}

function glue(overrides: Partial<SequenceRetainedLinearGlue> = {}): SequenceRetainedLinearGlue {
  return {
    container: new Container(),
    features: () => [],
    genomeLength: () => 0,
    featuresInRange: () => [],
    clearDrawState: () => {},
    clearDecorationCache: () => {},
    resetDecorationBookkeeping: () => {},
    resetOverviewLodBlendStats: () => {},
    ...overrides,
  };
}

describe('SequenceRetainedLinearPresenter', () => {
  it('holds retained-linear layers on the presenter itself', () => {
    const presenter = new SequenceRetainedLinearPresenter();
    const overview = fakeLayer<RetainedOverviewAnnotationLayer>('overview');
    const featureLayer = fakeLayer<RetainedLinearFeatureLayer>('feature');
    const transcript = fakeLayer<RetainedLinearTranscriptLayer>('transcript');

    presenter.retainedOverviewLayer = overview;
    presenter.retainedLinearFeatureLayer = featureLayer;
    presenter.retainedLinearTranscriptLayer = transcript;
    presenter.retainedLinearTranscriptFeatureSet = new Set();
    presenter.retainedLinearTranscriptKey = 'linear-tx|g:1';
    presenter.retainedDrawStateClean = true;

    expect(presenter.retainedOverviewLayer).toBe(overview);
    expect(presenter.retainedLinearFeatureLayer).toBe(featureLayer);
    expect(presenter.retainedLinearTranscriptLayer).toBe(transcript);
    expect(presenter.retainedLinearTranscriptFeatureSet).toBeInstanceOf(Set);
    expect(presenter.retainedLinearTranscriptFeatureKeyCache).toBeInstanceOf(WeakMap);
    expect(presenter.retainedDrawStateClean).toBe(true);
  });

  it('does not keep retainedLinearTranscriptLayer as an overlay-owned field', () => {
    const overlay = new SequenceAnnotationOverlay();
    const presenter = overlay.getRetainedLinearPresenterForTest();

    expect(Object.hasOwn(overlay, 'retainedLinearTranscriptLayer')).toBe(false);
    expect(Object.hasOwn(overlay, 'retainedOverviewLayer')).toBe(false);
    expect(Object.hasOwn(overlay, 'retainedLinearFeatureLayer')).toBe(false);
    expect(Object.hasOwn(overlay, 'lastRenderMode')).toBe(false);
    expect(Object.hasOwn(overlay, 'lastOverviewAggregationEnabled')).toBe(false);
    expect(Object.hasOwn(overlay, 'renderCallCount')).toBe(false);
    expect(Object.hasOwn(overlay, 'lastRenderKey')).toBe(false);
    expect(Object.hasOwn(presenter, 'lastRenderMode')).toBe(true);
    expect(Object.hasOwn(presenter, 'renderCallCount')).toBe(true);
    expect(presenter).toBeInstanceOf(SequenceRetainedLinearPresenter);
    expect(Object.hasOwn(presenter, 'retainedLinearTranscriptLayer')).toBe(true);
    expect(presenter.retainedLinearTranscriptLayer).toBeNull();

    const source = overlaySource();
    expect(source).not.toMatch(/private(?: readonly)? retainedLinearTranscriptLayer\b/);
    expect(source).not.toMatch(/private(?: readonly)? retainedOverviewLayer\b/);
    expect(source).not.toMatch(/private(?: readonly)? retainedLinearFeatureLayer\b/);
    expect(source).not.toMatch(/private lastRenderMode\b/);
    expect(source).not.toMatch(/private lastOverviewAggregationEnabled\b/);
    expect(source).not.toMatch(/private renderCallCount\b/);
    expect(source).not.toMatch(/private lastRenderKey\b/);
    expect(source).not.toContain('private ensureRetainedLinearTranscriptLayer');
    expect(source).not.toContain('private ensureRetainedOverviewLayer');
    expect(source).not.toContain('private ensureRetainedLinearFeatureLayer');
    expect(source).toContain(
      'private readonly retainedLinear = new SequenceRetainedLinearPresenter'
    );
    expect(source).not.toContain('this as unknown as');
  });

  it('owns retained layers after ensure*', () => {
    const overlay = new SequenceAnnotationOverlay();
    const presenter = overlay.getRetainedLinearPresenterForTest();

    const overview = presenter.ensureRetainedOverviewLayer();
    const featureLayer = presenter.ensureRetainedLinearFeatureLayer();
    const transcript = presenter.ensureRetainedLinearTranscriptLayer();

    expect(presenter.retainedOverviewLayer).toBe(overview);
    expect(presenter.retainedLinearFeatureLayer).toBe(featureLayer);
    expect(presenter.retainedLinearTranscriptLayer).toBe(transcript);
    expect(overlay.container.children).toContain(overview.container);
    expect(overlay.container.children).toContain(featureLayer.container);
    expect(overlay.container.children).toContain(transcript.container);
    expect(presenter.ensureRetainedOverviewLayer()).toBe(overview);
    expect(presenter.ensureRetainedLinearFeatureLayer()).toBe(featureLayer);
    expect(presenter.ensureRetainedLinearTranscriptLayer()).toBe(transcript);
  });

  it('hides only retained layers from resetAllPresentersToHidden', () => {
    const presenter = new SequenceRetainedLinearPresenter();
    const hidden: string[] = [];
    presenter.retainedOverviewLayer = fakeLayer<RetainedOverviewAnnotationLayer>('overview');
    presenter.retainedLinearFeatureLayer = fakeLayer<RetainedLinearFeatureLayer>('feature');
    presenter.retainedLinearTranscriptLayer =
      fakeLayer<RetainedLinearTranscriptLayer>('transcript');
    presenter.retainedOverviewLayer.hide = () => hidden.push('overview');
    presenter.retainedLinearFeatureLayer.hide = () => hidden.push('feature');
    presenter.retainedLinearTranscriptLayer.hide = () => hidden.push('transcript');

    presenter.resetAllPresentersToHidden();
    expect(hidden).toEqual(['overview', 'feature', 'transcript']);
  });

  it('memoizes large retained-linear transcript feature keys on the presenter', () => {
    const presenter = new SequenceRetainedLinearPresenter();
    const features = Array.from({ length: RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES }, (_, id) =>
      feature(id)
    );
    const first = presenter.hashRetainedLinearTranscriptFeatureKey(features);
    const second = presenter.hashRetainedLinearTranscriptFeatureKey(features);
    expect(first).toBe(second);
    expect(presenter.retainedLinearTranscriptFeatureKeyCache.get(features)).toBe(first);
  });

  it('caches retained-linear source features on the presenter', () => {
    const features = [feature(1, 100, 200), feature(2, 300, 400)];
    let rangeCalls = 0;
    const presenter = new SequenceRetainedLinearPresenter(
      glue({
        features: () => features,
        genomeLength: () => 10_000_000,
        featuresInRange: (startBp, endBp) => {
          rangeCalls += 1;
          return features.filter((item) => item.end > startBp && item.start < endBp);
        },
      })
    );
    const path = { viewStartBp: 100, viewEndBp: 250 } as PathMapper;
    const first = presenter.retainedLinearSourceFeaturesForViewport(path);
    const second = presenter.retainedLinearSourceFeaturesForViewport(path);
    expect(first).toEqual(second);
    expect(rangeCalls).toBe(1);
    expect(presenter.retainedLinearSourceWindow?.features).toBe(first);
  });
});
