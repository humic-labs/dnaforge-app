import { retainedOverviewAnnotationStyle } from '../overview/retained-overview-style';

export type RetainedOverviewResetHost = {
  retainedOverviewMode: string;
  retainedOverviewDataBuilds: number;
  retainedLinearDataBuilds: number;
  retainedLinearBinCount: number;
  retainedLinearTranscriptBuilds: number;
  retainedLinearTranscriptBlockCount: number;
  retainedLinearTranscriptVisibleFeatureCount: number;
  retainedLinearTranscriptKey: string;
  retainedLinearTranscriptFeatureSet: unknown;
  retainedLinearTranscriptMembershipNeedsRebind: boolean;
  retainedLinearSourceWindow: unknown;
  retainedTranscriptDecorationBuilds: number;
  decorationCacheKey: string;
  decorationCacheAnchorViewStartBp: number;
  decorationCacheAnchorPpb: number;
  decorationCacheBuiltLoBp: number;
  decorationCacheBuiltHiBp: number;
  retainedTranscriptDecorationGraphics: { position: { x: number } };
  retainedOverviewCameraUpdates: number;
  retainedOverviewInteractionUpdates: number;
  retainedOverviewFallbackRenders: number;
  retainedOverviewFallbackReason: unknown;
  retainedOverviewStyle: ReturnType<typeof retainedOverviewAnnotationStyle>;
  retainedOverviewInstanceCount: number;
  retainedOverviewVisibleInstanceCount: number;
  immediateDrawStateClearedForRetained: boolean;
  retainedDrawStateClean: boolean;
};

export function resetRetainedOverviewDebug(
  host: RetainedOverviewResetHost,
  opts: { preserveTranscriptMesh?: boolean } = {}
): void {
  host.retainedOverviewMode = 'inactive';
  host.retainedOverviewDataBuilds = 0;
  host.retainedLinearDataBuilds = 0;
  host.retainedLinearBinCount = 0;
  if (!opts.preserveTranscriptMesh) {
    host.retainedLinearTranscriptBuilds = 0;
    host.retainedLinearTranscriptBlockCount = 0;
    host.retainedLinearTranscriptVisibleFeatureCount = 0;
    host.retainedLinearTranscriptKey = '';
    host.retainedLinearTranscriptFeatureSet = null;
    host.retainedLinearTranscriptMembershipNeedsRebind = false;
  }
  host.retainedLinearSourceWindow = null;
  host.retainedTranscriptDecorationBuilds = 0;
  host.decorationCacheKey = '';
  host.decorationCacheAnchorViewStartBp = 0;
  host.decorationCacheAnchorPpb = 0;
  host.decorationCacheBuiltLoBp = 0;
  host.decorationCacheBuiltHiBp = 0;
  host.retainedTranscriptDecorationGraphics.position.x = 0;
  host.retainedOverviewCameraUpdates = 0;
  host.retainedOverviewInteractionUpdates = 0;
  host.retainedOverviewFallbackRenders = 0;
  host.retainedOverviewFallbackReason = null;
  host.retainedOverviewStyle = retainedOverviewAnnotationStyle();
  host.retainedOverviewInstanceCount = 0;
  host.retainedOverviewVisibleInstanceCount = 0;
  host.immediateDrawStateClearedForRetained = false;
  host.retainedDrawStateClean = false;
}
