export { DesignTab } from './components/DesignTab';
export { DesignDrawer } from './components/DesignDrawer';

export { useDesignStore } from './store';
export type { CopiedRegion } from './store';
export {
  startDesignArtifactMirroring,
  stopDesignArtifactMirroring,
} from './design-artifact-mirror';
export {
  reconcileMocloFactoryStageOutputsNow,
  startMocloFactoryStageOutputSync,
  stopMocloFactoryStageOutputSync,
} from './moclo-stage-output-live';
export { useResizableDrawer } from './hooks/useResizableDrawer';

export type {
  AssemblyState,
  SequenceDesign,
  DesignRegion,
  DesignStatus,
  DesignAnnotation,
  ValidationError,
} from './types';
export { getComposedSequence } from './types';
export type { DesignPrimer } from './types';
