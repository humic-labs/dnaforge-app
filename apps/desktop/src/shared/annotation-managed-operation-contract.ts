import type {
  AnnotationFeature,
  AnnotationResult,
  OperationSubject,
} from '@waypoint/api-client/models';
import type {
  ManagedDocumentInspection,
  ManagedDocumentOperationTarget,
} from '@waypoint/domain-services';
import { hasAnnotationResultShape } from './annotation-result';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface TrustedManagedAnnotationAuthority {
  schema: 'dnaforge.managed-annotation-authority.v1';
  operation: {
    id: string;
    kind: string;
    state: string;
    result_status: string;
    version: number;
    subject: OperationSubject;
  };
  resultSha256: string;
  result: AnnotationResult;
}

export interface ManagedAnnotationCandidate {
  id: string;
  index: number;
  sourceFeature: AnnotationFeature;
  feature: AnnotationFeature;
  substitutionOverlap: boolean;
}

export type ManagedAnnotationInspection = ManagedDocumentInspection<ManagedAnnotationCandidate> & {
  readonly coordinates: 'exact' | 'mapped';
  readonly transitionCount: number;
};

export class ManagedAnnotationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedAnnotationAuthorityError';
  }
}

export function assertManagedAnnotationAuthority(
  input: ManagedDocumentOperationTarget,
  authority: unknown
): asserts authority is TrustedManagedAnnotationAuthority {
  const payload = objectRecord(authority);
  const operation = objectRecord(payload?.operation);
  const subject = objectRecord(operation?.subject);
  if (
    payload?.schema !== 'dnaforge.managed-annotation-authority.v1' ||
    !operation ||
    !subject ||
    operation.id !== input.operationId ||
    operation.kind !== 'annotation' ||
    operation.state !== 'succeeded' ||
    operation.result_status !== 'available' ||
    typeof operation.version !== 'number' ||
    !Number.isSafeInteger(operation.version) ||
    operation.version < 1 ||
    subject.subject_id !== input.targetDocumentId ||
    typeof subject.subject_id !== 'string' ||
    subject.subject_id.startsWith('external-input:') ||
    typeof subject.scope_id !== 'string' ||
    !subject.scope_id ||
    typeof subject.input_revision !== 'string' ||
    !subject.input_revision ||
    typeof payload.resultSha256 !== 'string' ||
    !SHA256_PATTERN.test(payload.resultSha256) ||
    !hasAnnotationResultShape(payload.result) ||
    payload.result.error
  ) {
    throw new ManagedAnnotationAuthorityError(
      'The sidecar did not supply a valid current managed annotation authority.'
    );
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
