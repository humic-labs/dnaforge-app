export type RendererFeatureViewId = 'remote-hosts' | 'terminal' | 'ai' | 'inventory';

export type ShellActivityView =
  | 'home'
  | 'files'
  | 'search'
  | 'jobs'
  | 'source-control'
  | 'lims'
  | 'references'
  | 'settings'
  | 'toolbox';

export type ActivityView = ShellActivityView | RendererFeatureViewId;
