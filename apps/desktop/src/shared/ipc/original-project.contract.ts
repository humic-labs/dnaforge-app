import type {
  IdentifyOriginalDefaultProjectRequest,
  OriginalDefaultProjectResolution,
} from '../first-project';
import { defineGroup, invoke, type ClientOf } from './contract';

export const originalProjectContract = defineGroup('workspace', {
  getOriginalDefaultProject: invoke<[], OriginalDefaultProjectResolution>(),
  identifyOriginalDefaultProject: invoke<
    [request: IdentifyOriginalDefaultProjectRequest],
    OriginalDefaultProjectResolution
  >(),
});

export type OriginalProjectPort = ClientOf<typeof originalProjectContract>;
