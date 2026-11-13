import type {
  LimsImportColumnMappingOverride,
  LimsImportPlan,
  LimsImportPlanMappingConfidence,
} from '../../shared/lims';
import * as core from './ingress-core';
export * from './ingress-core';

let operations: Promise<typeof import('./operations')> | undefined;
const loadOperations = () => (operations ??= import('./operations'));
const defaultDependencies: core.LimsImportPlannerDependencies = {
  queryEntities: async (input) => (await loadOperations()).queryLimsEntities(input),
  applyBatch: async (input, token) => (await loadOperations()).applyLimsImportBatch(input, token),
};
export const dryRunLimsImport = (
  input: core.DryRunLimsImportInput,
  dependencies = defaultDependencies
) => core.dryRunLimsImport(input, dependencies);
export const createLimsImportPlan = (
  input: core.DryRunLimsImportInput,
  dependencies = defaultDependencies
) => core.createLimsImportPlan(input, dependencies);
export const attachProvisionalStubsToImportPlan = (
  plan: LimsImportPlan,
  dependencies = defaultDependencies
) => core.attachProvisionalStubsToImportPlan(plan, dependencies);
export const applyAcceptedLimsImportPlan = (
  plan: LimsImportPlan,
  options: Parameters<typeof core.applyAcceptedLimsImportPlan>[1] = {},
  dependencies = defaultDependencies
) => core.applyAcceptedLimsImportPlan(plan, options, dependencies);
export const applyImportPlanColumnMappings = (
  plan: LimsImportPlan,
  mappings: readonly LimsImportColumnMappingOverride[],
  confidence: LimsImportPlanMappingConfidence = 'user_overridden',
  dependencies = defaultDependencies
) => core.applyImportPlanColumnMappings(plan, mappings, confidence, dependencies);
export const applyImportPlanRecordKind = (
  plan: LimsImportPlan,
  id: string,
  kind: Parameters<typeof core.applyImportPlanRecordKind>[2],
  dependencies = defaultDependencies
) => core.applyImportPlanRecordKind(plan, id, kind, dependencies);
