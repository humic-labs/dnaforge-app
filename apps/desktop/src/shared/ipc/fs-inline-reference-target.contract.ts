import type {
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../inline-reference-ipc';
import { defineGroup, invoke } from './contract';
import type {
  ProjectResourceReference,
  ResolvedProjectResourceReference,
} from '../project-resource-reference';

export const fsInlineReferenceTargetContract = defineGroup('fs', {
  resolveProjectResourceReference: invoke<
    [reference: string | ProjectResourceReference],
    ResolvedProjectResourceReference
  >(),
  resolveInlineReferenceTarget: invoke<
    [input: ResolveInlineReferenceTargetRequest],
    ResolveInlineReferenceTargetResult
  >(),
});
