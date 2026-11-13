import { isExactProviderStableId } from './provider-object-reference';
import { LIMS_OLIGO_USES } from './lims';

export type OligoClassificationChoice =
  | { kind: 'keep_generic' }
  | { kind: 'classify'; use: (typeof LIMS_OLIGO_USES)[number] | null };

export type SequenceClassificationDecision = {
  schema: 'dnaforge.sequence-classification.v1';
  choice: OligoClassificationChoice;
  molecule: 'dna' | 'rna';
  targetSourceId: string;
  reviewedAt: number;
  actor: string;
  evidenceFingerprint: string;
  reviewedFileSha256: string;
};

export function parseSequenceClassificationDecision(
  value: unknown
): SequenceClassificationDecision {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('schema' in value) ||
    value.schema !== 'dnaforge.sequence-classification.v1' ||
    !('choice' in value) ||
    !('molecule' in value) ||
    (value.molecule !== 'dna' && value.molecule !== 'rna') ||
    !('targetSourceId' in value) ||
    !isExactProviderStableId(value.targetSourceId) ||
    !value.targetSourceId.startsWith('seq_') ||
    !('reviewedAt' in value) ||
    typeof value.reviewedAt !== 'number' ||
    !Number.isSafeInteger(value.reviewedAt) ||
    value.reviewedAt < 0 ||
    !('actor' in value) ||
    !boundedText(value.actor, 256) ||
    !('evidenceFingerprint' in value) ||
    typeof value.evidenceFingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.evidenceFingerprint) ||
    !('reviewedFileSha256' in value) ||
    typeof value.reviewedFileSha256 !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.reviewedFileSha256)
  )
    throw new Error('Portable sequence classification decision is invalid.');
  const { choice } = parseApplyOligoClassificationRequest({
    entityId: value.targetSourceId,
    requestId: 'portable-decision',
    reviewToken: value.reviewedFileSha256,
    choice: value.choice,
  });
  return {
    schema: value.schema,
    choice,
    molecule: value.molecule,
    targetSourceId: value.targetSourceId,
    reviewedAt: value.reviewedAt,
    actor: value.actor,
    evidenceFingerprint: value.evidenceFingerprint,
    reviewedFileSha256: value.reviewedFileSha256,
  };
}

export type ApplyOligoClassificationRequest = {
  entityId: string;
  reviewToken: string;
  requestId: string;
  choice: OligoClassificationChoice;
};
export type AppliedOligoClassification = {
  status: 'applied';
  entityId: string;
  requestId: string;
  kind: 'dna_sequence' | 'rna_sequence' | 'oligo' | 'rna_oligo';
  use: (typeof LIMS_OLIGO_USES)[number] | null;
};
export type ApplyOligoClassificationResult =
  | AppliedOligoClassification
  | { status: 'stale'; review: OligoClassificationReview };

export function parseApplyOligoClassificationRequest(
  value: unknown
): ApplyOligoClassificationRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    !('entityId' in value) ||
    !boundedText(value.entityId, 256) ||
    !('requestId' in value) ||
    !boundedText(value.requestId, 200) ||
    !('reviewToken' in value) ||
    typeof value.reviewToken !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.reviewToken) ||
    !('choice' in value) ||
    !value.choice ||
    typeof value.choice !== 'object' ||
    !('kind' in value.choice)
  )
    throw new Error('Classification requires a current review and a request identity.');
  const common = {
    entityId: value.entityId,
    requestId: value.requestId,
    reviewToken: value.reviewToken,
  };
  if (value.choice.kind === 'keep_generic') return { ...common, choice: { kind: 'keep_generic' } };
  if (value.choice.kind === 'classify' && 'use' in value.choice) {
    if (value.choice.use === null) return { ...common, choice: { kind: 'classify', use: null } };
    const selectedUse = value.choice.use;
    const use = LIMS_OLIGO_USES.find((use) => use === selectedUse);
    if (use) return { ...common, choice: { kind: 'classify', use } };
  }
  throw new Error('Classification choice is invalid.');
}

export type OligoClassificationReview =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'review';
      entityId: string;
      entityName: string;
      targetSourceId: string;
      currentKind: 'dna_sequence' | 'rna_sequence';
      reviewToken: string;
      evidence: OligoClassificationEvidence[];
      evidenceLimited: boolean;
      sequence: { length: number; molecule: 'dna' | 'rna'; topology: 'linear' };
      assessment: Exclude<OligoClassificationAssessment, { status: 'unavailable' }>;
    };

type SourceEvidenceLocation = {
  sourceObjectId: string;
  targetSourceId: string;
  sourceEntryPath: string;
  sourceEntrySha256: string;
  occurrence: number;
};

export type OligoClassificationEvidence = SourceEvidenceLocation &
  (
    | { channel: 'provider_display_type'; value: string }
    | { channel: 'authored_role'; value: 'primer' | 'probe' | 'sgRNA'; excerpt: string }
    | { channel: 'authored_role_disputed'; value: 'review_required'; excerpt: string }
  );

export type OligoClassificationEvidencePacket = {
  schema: 'dnaforge.benchling.classification-evidence.v1';
  facts: OligoClassificationEvidence[];
  limited: boolean;
};

export function parseOligoClassificationEvidence(
  value: unknown
): OligoClassificationEvidencePacket | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('schema' in value) ||
    value.schema !== 'dnaforge.benchling.classification-evidence.v1' ||
    !('limited' in value) ||
    typeof value.limited !== 'boolean' ||
    !('facts' in value) ||
    !Array.isArray(value.facts) ||
    value.facts.length > 256
  )
    return null;
  const facts: OligoClassificationEvidence[] = [];
  for (const item of value.facts) {
    const fact: unknown = item;
    if (
      !fact ||
      typeof fact !== 'object' ||
      Array.isArray(fact) ||
      !('sourceObjectId' in fact) ||
      !boundedText(fact.sourceObjectId, 256) ||
      !('targetSourceId' in fact) ||
      !isExactProviderStableId(fact.targetSourceId) ||
      !fact.targetSourceId.startsWith('seq_') ||
      !('sourceEntryPath' in fact) ||
      !boundedText(fact.sourceEntryPath, 4096) ||
      !('sourceEntrySha256' in fact) ||
      typeof fact.sourceEntrySha256 !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(fact.sourceEntrySha256) ||
      !('occurrence' in fact) ||
      typeof fact.occurrence !== 'number' ||
      !Number.isSafeInteger(fact.occurrence) ||
      fact.occurrence < 0 ||
      fact.occurrence >= 4096 ||
      !('channel' in fact) ||
      !('value' in fact)
    )
      return null;
    const location: SourceEvidenceLocation = {
      sourceObjectId: fact.sourceObjectId,
      targetSourceId: fact.targetSourceId,
      sourceEntryPath: fact.sourceEntryPath,
      sourceEntrySha256: fact.sourceEntrySha256,
      occurrence: fact.occurrence,
    };
    if (fact.channel === 'provider_display_type' && boundedText(fact.value, 64)) {
      facts.push({ ...location, channel: fact.channel, value: fact.value });
    } else if (
      fact.channel === 'authored_role' &&
      (fact.value === 'primer' || fact.value === 'probe' || fact.value === 'sgRNA') &&
      'excerpt' in fact &&
      boundedText(fact.excerpt, 512)
    ) {
      facts.push({ ...location, channel: fact.channel, value: fact.value, excerpt: fact.excerpt });
    } else if (
      fact.channel === 'authored_role_disputed' &&
      fact.value === 'review_required' &&
      'excerpt' in fact &&
      boundedText(fact.excerpt, 512)
    ) {
      facts.push({ ...location, channel: fact.channel, value: fact.value, excerpt: fact.excerpt });
    } else return null;
  }
  return { schema: value.schema, limited: value.limited, facts };
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
  );
}

export type OligoClassificationAssessment =
  | { status: 'unavailable'; reason: 'missing_sequence' | 'circular_sequence' }
  | {
      status: 'needs_review';
      reason:
        | 'insufficient_evidence'
        | 'conflicting_roles'
        | 'mixed_targets'
        | 'conflicting_types'
        | 'incomplete_evidence'
        | 'disputed_role';
    }
  | { status: 'suggested'; kind: 'oligo' | 'rna_oligo'; use: 'primer' | 'probe' | 'sgRNA' };

export function assessOligoClassification(input: {
  sequence: {
    molecule: 'dna' | 'rna';
    available: boolean;
    length: number;
    topology: 'linear' | 'circular';
  };
  evidence: readonly OligoClassificationEvidence[];
  targetSourceId: string;
  evidenceLimited: boolean;
}): OligoClassificationAssessment {
  const { sequence, evidence } = input;
  if (!sequence.available || !Number.isSafeInteger(sequence.length) || sequence.length <= 0)
    return { status: 'unavailable', reason: 'missing_sequence' };
  if (sequence.topology === 'circular')
    return { status: 'unavailable', reason: 'circular_sequence' };
  if (evidence.some((fact) => fact.targetSourceId !== input.targetSourceId))
    return { status: 'needs_review', reason: 'mixed_targets' };
  if (input.evidenceLimited) return { status: 'needs_review', reason: 'incomplete_evidence' };
  if (evidence.some((fact) => fact.channel === 'authored_role_disputed'))
    return { status: 'needs_review', reason: 'disputed_role' };
  const types = evidence.flatMap((fact) =>
    fact.channel === 'provider_display_type' ? [fact.value.toLowerCase()] : []
  );
  if (types.some((value) => !['oligo', 'sequence', 'linear'].includes(value)))
    return { status: 'needs_review', reason: 'conflicting_types' };
  const roles = new Set(
    evidence.flatMap((fact) => (fact.channel === 'authored_role' ? [fact.value] : []))
  );
  if (roles.size > 1) return { status: 'needs_review', reason: 'conflicting_roles' };
  const role = [...roles][0];
  if (!role || !types.includes('oligo'))
    return { status: 'needs_review', reason: 'insufficient_evidence' };
  return {
    status: 'suggested',
    kind: sequence.molecule === 'rna' ? 'rna_oligo' : 'oligo',
    use: role,
  };
}
