import { type WorkflowResultMetadata, observeWorkflowAction } from '../../lib/workflow-telemetry';
import type { SequenceDesign } from '../design/public/types';
import {
  isPcrTemplateRegion,
  isRestrictionDigestRegion,
} from '../design/public/restriction-digest';
import {
  ASSEMBLY_METHODS,
  type AssemblyMethodTelemetry,
} from '../../shared/scientific-workflow-vocab';

interface ReopenIdentity {
  designId: string;
  constructId: string;
  parentAcceptedAssemblyVersionId: string;
}
type ReopenReceipt = ReopenIdentity & { actionId: string };
const pendingReopens = new Map<string, ReopenReceipt>();

export function assemblyInputObservation(design: Pick<SequenceDesign, 'id' | 'regions'>) {
  const filled = design.regions.filter(
    (region) =>
      !region.isPlaceholder &&
      typeof region.sequence === 'string' &&
      region.sequence.trim().length > 0
  ).length;
  return {
    workflow: 'assembly' as const,
    action: 'inspect' as const,
    initiator: 'system' as const,
    artifactCorrelationId: design.id,
    resultCount: design.regions.length,
    selectedCount: filled,
    status: filled < 2 ? ('needs_action' as const) : ('ready' as const),
    ...(filled < 2 ? { outcomeKind: 'input_required' as const } : {}),
    valueDelivered: false,
    usableResult: false,
  };
}

export function assemblyMethodTelemetry(method: unknown): AssemblyMethodTelemetry {
  return ASSEMBLY_METHODS.find((known) => known === method) ?? 'unknown';
}

export function assemblyValidationErrorClass(
  errors: readonly { code?: unknown; severity?: unknown }[]
): string {
  const code = errors.find((item) => item.severity === 'error')?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,50}$/.test(code)
    ? `validation_${code}`
    : 'validation';
}

export function assemblyComputeContext(
  design:
    | (Pick<SequenceDesign, 'regions'> & Partial<Pick<SequenceDesign, 'assemblyMethod'>>)
    | undefined,
  command: 'validate' | 'run'
): Pick<
  WorkflowResultMetadata,
  'assemblyComputeStage' | 'assemblyMaterialRoute' | 'pcrTemplateCount' | 'assemblyMethod'
> {
  const pcrTemplateCount = Math.min(
    100000,
    design?.regions.filter(isPcrTemplateRegion).length ?? 0
  );
  const hasDigest = design?.regions.some(isRestrictionDigestRegion) ?? false;
  return {
    assemblyComputeStage: command === 'validate' ? 'draft_primers' : 'construct_preview',
    assemblyMaterialRoute:
      pcrTemplateCount > 0 ? (hasDigest ? 'mixed' : 'pcr') : hasDigest ? 'digest' : 'none',
    pcrTemplateCount,
    assemblyMethod: assemblyMethodTelemetry(design?.assemblyMethod),
  };
}

export function observeAssemblyRefusal(input: {
  designId: string;
  operationId: string;
  action: 'compute' | 'inspect' | 'export';
  reason: 'bad_input' | 'state_conflict' | 'stale_state' | 'validation';
  inputRequired?: boolean;
  computeContext?: ReturnType<typeof assemblyComputeContext>;
}): void {
  captureAssemblyObservation({
    workflow: 'assembly',
    ...input.computeContext,
    action: input.action,
    actionId: input.operationId,
    operationId: input.operationId,
    artifactCorrelationId: input.designId,
    initiator: 'system',
    success: false,
    status: 'blocked',
    errorClass: input.reason,
    outcomeKind: input.inputRequired ? 'input_required' : 'validation_refused',
    valueDelivered: false,
    usableResult: false,
  });
}

export function observeAssemblySaved(constructId: string, actionId?: string): void {
  captureAssemblyObservation({
    workflow: 'assembly',
    action: 'save',
    actionId,
    operationId: actionId,
    artifactCorrelationId: constructId,
    initiator: 'system',
    status: 'saved',
    outcomeKind: 'display_pending',
    resultCount: 1,
    valueDelivered: false,
    usableResult: false,
  });
}

export function rememberAssemblyReopen(result: ReopenIdentity): void {
  if (!result.designId || !result.constructId || !result.parentAcceptedAssemblyVersionId) return;
  const receipt = {
    designId: result.designId,
    constructId: result.constructId,
    parentAcceptedAssemblyVersionId: result.parentAcceptedAssemblyVersionId,
    actionId: crypto.randomUUID(),
  };
  pendingReopens.set(result.designId, receipt);
  captureAssemblyObservation({
    workflow: 'assembly',
    action: 'open',
    actionId: receipt.actionId,
    artifactCorrelationId: receipt.constructId,
    initiator: 'system',
    status: 'needs_action',
    outcomeKind: 'display_pending',
    valueDelivered: false,
    usableResult: false,
  });
}

export function observeVisibleAssemblyReopen(
  design: Pick<SequenceDesign, 'id' | 'constructId' | 'parentAcceptedAssemblyVersionId'>
): boolean {
  const receipt = pendingReopens.get(design.id);
  if (
    !receipt ||
    design.constructId !== receipt.constructId ||
    design.parentAcceptedAssemblyVersionId !== receipt.parentAcceptedAssemblyVersionId
  )
    return false;
  pendingReopens.delete(design.id);
  return captureAssemblyObservation({
    workflow: 'assembly',
    action: 'open',
    actionId: receipt.actionId,
    artifactCorrelationId: receipt.constructId,
    initiator: 'system',
    status: 'viewed',
    outcomeKind: 'reopened_confirmed',
    resultCount: 1,
    valueDelivered: false,
    usableResult: false,
  });
}

export function discardAssemblyReopen(designId: string): void {
  pendingReopens.delete(designId);
}

export function observeAssemblyInputs(design: Pick<SequenceDesign, 'id' | 'regions'>): void {
  captureAssemblyObservation(assemblyInputObservation(design));
}

function captureAssemblyObservation(input: Parameters<typeof observeWorkflowAction>[0]): boolean {
  try {
    return observeWorkflowAction(input);
  } catch {
    return false;
  }
}
