import type {
  RelocateEntityFileInput,
  RelocateEntityFileResult,
} from '../workspace-relocate-types';
import { defineGroup, invoke } from './contract';

export const workspaceRelocateContract = defineGroup('workspace', {
  relocateEntityFile: invoke<[request: RelocateEntityFileInput], RelocateEntityFileResult>(),
  relinkMovedEntityFile: invoke<[request: RelocateEntityFileInput], RelocateEntityFileResult>(),
});
