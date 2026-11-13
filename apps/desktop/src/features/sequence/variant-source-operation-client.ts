import { withUserMessage } from '@waypoint/user-messages';
import { variantMessageKey } from './variant-user-messages';
import {
  startVariantSourcePreparationOperationOperationsVariantSourcePreparationPost,
  type OperationSnapshot,
  type VariantFileGeneration,
  type VariantSourceRequest,
  type VariantSourceResult,
} from '@waypoint/api-client';

import { managedOperations } from '../../services/managed-operations';

const OPERATION_KIND = 'variant-source-preparation';
const PREPARATION_WAIT_TIMEOUT_MS = 30 * 60_000;

export interface VariantSourceWaitOptions {
  readonly signal?: AbortSignal;
}

export async function startVariantSourceOperation(
  input: VariantSourceRequest
): Promise<OperationSnapshot> {
  return managedOperations.startRegisteredOperation(async ({ scopeId, submissionKey }) => {
    const response =
      await startVariantSourcePreparationOperationOperationsVariantSourcePreparationPost({
        submission_key: submissionKey,
        subject: { scope_id: scopeId },
        input,
      });
    if (response.status !== 202) {
      throw withUserMessage(
        new Error(response.data.detail.message),
        variantMessageKey(response.data.detail.code, 'variant.preparationFailed')
      );
    }
    if (response.data.kind !== OPERATION_KIND || response.data.subject.scope_id !== scopeId) {
      throw new Error('The operation owner returned an invalid variant-source job.');
    }
    return response.data;
  });
}

export async function waitForVariantSourceResult(
  operationId: string,
  options: VariantSourceWaitOptions = {}
): Promise<VariantSourceResult> {
  const terminal = await managedOperations.waitForTerminal(operationId, {
    timeoutMs: PREPARATION_WAIT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (terminal.kind !== OPERATION_KIND || terminal.id !== operationId) {
    throw new Error('The operation owner returned an invalid variant-source job.');
  }
  if (terminal.state !== 'succeeded') {
    throw withUserMessage(
      new Error(
        terminal.error?.message ??
          (terminal.state === 'canceled'
            ? 'Variant source preparation was canceled.'
            : terminal.state === 'interrupted'
              ? 'Variant source preparation was interrupted.'
              : 'Variant source preparation failed.')
      ),
      variantMessageKey(
        terminal.error?.code ?? '',
        terminal.state === 'canceled'
          ? 'variant.preparationCanceled'
          : terminal.state === 'interrupted'
            ? 'variant.preparationInterrupted'
            : 'variant.preparationFailed'
      )
    );
  }

  const envelope = await managedOperations.getResult(operationId);
  if (
    envelope.kind !== OPERATION_KIND ||
    envelope.operation_id !== operationId ||
    envelope.status !== 'available' ||
    !isVariantSourceResult(envelope.result)
  ) {
    throw new Error('The operation owner returned an invalid variant-source result.');
  }
  return envelope.result;
}

export function isVariantSourceResult(value: unknown): value is VariantSourceResult {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.sourcePath) ||
    !isNonEmptyString(value.queryPath) ||
    !isNonEmptyString(value.indexPath) ||
    (value.format !== 'vcf' && value.format !== 'bcf') ||
    !isNonEmptyString(value.label) ||
    !isSafeNonNegativeInteger(value.sourceSizeBytes) ||
    !isDecimalString(value.sourceMtimeNs) ||
    typeof value.sourceIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sourceIdentity) ||
    typeof value.assemblyRevision !== 'string' ||
    !/^variant-assembly-v1:sha256:[0-9a-f]{64}$/.test(value.assemblyRevision) ||
    !isStringArray(value.matchedReferences, true) ||
    !isStringArray(value.samples, false) ||
    !isVariantFileGeneration(value.sourceGeneration) ||
    !isVariantFileGeneration(value.queryGeneration) ||
    !isVariantFileGeneration(value.indexGeneration)
  ) {
    return false;
  }
  return (
    value.sourceGeneration.canonicalPath === value.sourcePath &&
    value.queryGeneration.canonicalPath === value.queryPath &&
    value.indexGeneration.canonicalPath === value.indexPath &&
    value.sourceGeneration.size === value.sourceSizeBytes &&
    value.sourceGeneration.mtimeNs === value.sourceMtimeNs
  );
}

function isVariantFileGeneration(value: unknown): value is VariantFileGeneration {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.canonicalPath) &&
    isSafeNonNegativeInteger(value.size) &&
    isDecimalString(value.mtimeNs) &&
    isDecimalString(value.ctimeNs) &&
    isOptionalDecimalString(value.device) &&
    isOptionalDecimalString(value.inode)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function isOptionalDecimalString(value: unknown): boolean {
  return value === undefined || value === null || isDecimalString(value);
}

function isStringArray(value: unknown, nonEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.every((item) => isNonEmptyString(item))
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
