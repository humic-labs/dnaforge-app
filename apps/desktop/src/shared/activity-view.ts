export type RendererFeatureViewId = 'remote-hosts' | 'ai';

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
