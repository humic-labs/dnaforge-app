import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { fingerprintAnnotationFeatureSet } from './annotation-feature-fingerprint';

export const RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES = 4096;

export const RETAINED_LINEAR_SOURCE_WINDOW_MIN_BP = 5_000_000;
export const RETAINED_LINEAR_SOURCE_WINDOW_VISIBLE_MULTIPLIER = 4;
export const RETAINED_LINEAR_SOURCE_WINDOW_MAX_MARGIN_BP = 50_000_000;

export type RetainedLinearSourceWindow = {
  inputKey: string;
  startBp: number;
  endBp: number;
  features: Feature[];
};

export type RetainedLinearSourceWindowHost = {
  features: Feature[];
  genomeLength: number;
  retainedLinearSourceWindow: RetainedLinearSourceWindow | null;
  retainedLinearTranscriptFeatureKeyCache: WeakMap<readonly Feature[], string>;
  retainedLinearTranscriptFeatureKey(features: Feature[]): string;
  featuresInRange(startBp: number, endBp: number): Feature[];
};

export function hashRetainedLinearTranscriptFeatureKey(
  host: Pick<RetainedLinearSourceWindowHost, 'retainedLinearTranscriptFeatureKeyCache'>,
  featuresToRender: readonly Feature[]
): string {
  const memoize = featuresToRender.length >= RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES;
  if (memoize) {
    const cached = host.retainedLinearTranscriptFeatureKeyCache.get(featuresToRender);
    if (cached !== undefined) {
      const gg = globalThis as { __webglFeatureKeyHit?: number };
      gg.__webglFeatureKeyHit = (gg.__webglFeatureKeyHit ?? 0) + 1;
      return cached;
    }
  }
  const gm = globalThis as { __webglFeatureKeyMiss?: number; __webglFeatureKeyMissN?: number };
  gm.__webglFeatureKeyMiss = (gm.__webglFeatureKeyMiss ?? 0) + 1;
  gm.__webglFeatureKeyMissN = (gm.__webglFeatureKeyMissN ?? 0) + featuresToRender.length;
  const key = fingerprintAnnotationFeatureSet(featuresToRender);
  if (memoize) host.retainedLinearTranscriptFeatureKeyCache.set(featuresToRender, key);
  return key;
}

export function retainedLinearSourceFeaturesForViewport(
  host: RetainedLinearSourceWindowHost,
  path: PathMapper
): Feature[] {
  const inputKey = host.retainedLinearTranscriptFeatureKey(host.features);
  const viewportStart = Math.max(0, Math.min(host.genomeLength, path.viewStartBp));
  const viewportEnd = Math.max(viewportStart, Math.min(host.genomeLength, path.viewEndBp));
  const visibleBp = Math.max(1, viewportEnd - viewportStart);
  const overfetchPerSideBp = Math.min(
    (visibleBp * (RETAINED_LINEAR_SOURCE_WINDOW_VISIBLE_MULTIPLIER - 1)) / 2,
    RETAINED_LINEAR_SOURCE_WINDOW_MAX_MARGIN_BP
  );
  const targetSpanBp = Math.min(
    host.genomeLength,
    Math.max(RETAINED_LINEAR_SOURCE_WINDOW_MIN_BP, visibleBp + 2 * overfetchPerSideBp)
  );
  const current = host.retainedLinearSourceWindow;
  const currentSpanBp = current ? current.endBp - current.startBp : 0;
  const currentCoversViewport =
    current !== null && current.startBp <= viewportStart && current.endBp >= viewportEnd;
  const currentIsWholeGenome =
    current !== null && currentSpanBp >= Math.max(1, host.genomeLength - 1);
  const currentIsNotOversized =
    current !== null && (!currentIsWholeGenome || currentSpanBp <= targetSpanBp * 4);
  if (current?.inputKey === inputKey && currentCoversViewport && currentIsNotOversized) {
    return current.features;
  }

  if (currentCoversViewport && currentIsNotOversized && current) {
    const features = host.featuresInRange(current.startBp, current.endBp);
    host.retainedLinearSourceWindow = {
      inputKey,
      startBp: current.startBp,
      endBp: current.endBp,
      features,
    };
    return features;
  }

  const centerBp = (viewportStart + viewportEnd) / 2;
  let startBp = Math.max(0, centerBp - targetSpanBp / 2);
  const endBp = Math.min(host.genomeLength, startBp + targetSpanBp);
  startBp = Math.max(0, endBp - targetSpanBp);
  const features = host.featuresInRange(startBp, endBp);
  host.retainedLinearSourceWindow = {
    inputKey,
    startBp,
    endBp,
    features,
  };
  return features;
}
