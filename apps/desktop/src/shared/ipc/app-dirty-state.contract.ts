import type { DirtyWorkState } from '../dirty-work-state';
import { defineGroup, send } from './contract';

export const appDirtyStateContract = defineGroup('app', {
  reportDirtyState: send<[state: DirtyWorkState]>().channel('app:dirtyStateChanged'),
});
