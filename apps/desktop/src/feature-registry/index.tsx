import type { ReactNode } from 'react';
import { OriginalProjectRecoveryDialog } from '../components/OriginalProjectRecoveryDialog';
import { remoteHostsRendererFeature } from '../features/remote-hosts/public/feature';
import { releaseNotesRendererFeature } from '../features/release-notes/public/feature';
import { pageReferencesRendererFeature } from '../features/page/public/feature';
import { journeyTelemetryRendererFeature } from '../features/journey-telemetry/public/feature';
import { terminalRendererFeature } from '../features/terminal/public/feature';
import { aiRendererFeature } from '../features/ai/public/feature';
import type { ScreenCategory } from '../lib/screen-telemetry';
import type {
  RendererFeature,
  RendererFeatureActivityButton,
  RendererFeatureContext,
  RendererFeatureView,
  RendererFeatureViewId,
  RendererFeaturePlacement,
} from './renderer-feature';

export function assertUniqueRendererFeatures(features: readonly RendererFeature[]): void {
  const ids = new Set<string>();
  const views = new Map<string, string>();
  for (const feature of features) {
    if (ids.has(feature.id))
      throw new Error(`Renderer feature "${feature.id}" is registered twice.`);
    ids.add(feature.id);
    for (const { view } of feature.views ?? []) {
      const owner = views.get(view);
      if (owner) {
        throw new Error(
          `Renderer features "${owner}" and "${feature.id}" both claim the "${view}" view.`
        );
      }
      views.set(view, feature.id);
    }
  }
}

export { openReleaseNotes } from '../features/release-notes/public/feature';
export { openSelectedDocument } from '../features/document-opening/public/open-selected-document';
export { beginAIChatNavigation, resumeAIConversation } from '../features/ai/public/chat-navigation';

export const RENDERER_FEATURES: readonly RendererFeature[] = [
  remoteHostsRendererFeature,
  releaseNotesRendererFeature,
  pageReferencesRendererFeature,
  { id: 'original-project-recovery', Activation: OriginalProjectRecoveryDialog },
  journeyTelemetryRendererFeature,
  terminalRendererFeature,
  aiRendererFeature,
];
assertUniqueRendererFeatures(RENDERER_FEATURES);

function featureView(
  view: string,
  features: readonly RendererFeature[]
): { feature: RendererFeature; entry: RendererFeatureView } | null {
  for (const feature of features) {
    const entry = feature.views?.find((candidate) => candidate.view === view);
    if (entry) return { feature, entry };
  }
  return null;
}

export function RendererFeatureActivations({
  openView,
  features = RENDERER_FEATURES,
}: RendererFeatureContext & { readonly features?: readonly RendererFeature[] }) {
  return (
    <>
      {features.map(({ id, Activation }) =>
        Activation ? <Activation key={id} openView={openView} /> : null
      )}
    </>
  );
}

export function isRendererFeatureView(
  view: string,
  features: readonly RendererFeature[] = RENDERER_FEATURES
): view is RendererFeatureViewId {
  const found = featureView(view, features);
  return Boolean(found && (found.entry.placement ?? 'workspace') === 'workspace');
}

export function rendererFeatureView(
  view: string,
  features: readonly RendererFeature[] = RENDERER_FEATURES
): ReactNode {
  const found = featureView(view, features);
  if (!found || found.entry.placement === 'sidebar') return null;
  const { Component } = found.entry;
  return <Component key={found.feature.id} />;
}

export function isRendererFeatureSidebarView(
  view: string,
  features: readonly RendererFeature[] = RENDERER_FEATURES
): view is RendererFeatureViewId {
  return featureView(view, features)?.entry.placement === 'sidebar';
}

export function rendererFeatureSidebarView(
  view: string,
  features: readonly RendererFeature[] = RENDERER_FEATURES
): ReactNode {
  const found = featureView(view, features);
  if (!found || found.entry.placement !== 'sidebar') return null;
  const { Component } = found.entry;
  return <Component key={found.feature.id} />;
}

export function rendererFeatureScreenCategory(
  view: RendererFeatureViewId,
  features: readonly RendererFeature[] = RENDERER_FEATURES
): ScreenCategory {
  return featureView(view, features)?.entry.screenCategory ?? 'unknown';
}

export function rendererFeatureViewIds(
  features: readonly RendererFeature[] = RENDERER_FEATURES,
  placement: RendererFeaturePlacement = 'workspace'
): RendererFeatureViewId[] {
  return features.flatMap((feature) =>
    (feature.views ?? [])
      .filter((entry) => (entry.placement ?? 'workspace') === placement)
      .map(({ view }) => view)
  );
}

export function rendererFeatureActivityButtons(
  features: readonly RendererFeature[] = RENDERER_FEATURES
): Array<RendererFeatureActivityButton & { readonly view: RendererFeatureViewId }> {
  return features.flatMap((feature) =>
    (feature.views ?? []).flatMap(({ view, activityButton }) =>
      activityButton ? [{ ...activityButton, view }] : []
    )
  );
}
