import type {
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../inline-reference-ipc';
import { defineGroup, invoke } from './contract';

export const fsInlineReferenceTargetContract = defineGroup('fs', {
  resolveInlineReferenceTarget: invoke<
    [input: ResolveInlineReferenceTargetRequest],
    ResolveInlineReferenceTargetResult
  >(),
});
