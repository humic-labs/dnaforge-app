import type { ComponentType, ReactNode } from 'react';
import type { ScreenCategory } from '../lib/screen-telemetry';
import type { CommandId } from '../commands/types';
import type { RendererFeatureViewId } from '../shared/activity-view';

export type { RendererFeatureViewId } from '../shared/activity-view';

export type RendererFeaturePlacement = 'workspace' | 'sidebar';

export interface RendererFeatureContext {
  readonly openView: (view: RendererFeatureViewId | 'files' | 'lims') => void;
}

export interface RendererFeatureActivityButton {
  readonly label: string;
  readonly icon: ReactNode;
  readonly testId: string;
  readonly command?: CommandId;
  readonly badge?: ReactNode;
}

export interface RendererFeatureView {
  readonly view: RendererFeatureViewId;
  readonly Component: ComponentType;
  readonly placement?: RendererFeaturePlacement;
  readonly screenCategory: ScreenCategory;
  readonly activityButton?: RendererFeatureActivityButton;
}

export interface RendererFeature {
  readonly id: string;
  readonly views?: readonly RendererFeatureView[];
  readonly Activation?: ComponentType<RendererFeatureContext>;
}
