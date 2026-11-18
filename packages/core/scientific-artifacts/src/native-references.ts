import {
  defineScientificDocument,
  type PrimerBindingDocument,
  type ScientificIssue,
  type ScientificReader,
  type ScientificSnapshot,
  type StrainDescentDocument,
  type StrainSequenceDocument,
} from '@waypoint/scientific-objects';
import {
  defineBlob,
  parseResourceId,
  parseResourceRevisionId,
  type CanonicalMap,
  type ResourceId,
  type ResourceRevisionId,
} from '@waypoint/workspace-revisions';
import {
  parsePrimerArtifact,
  type PrimerArtifactBindingV1,
} from './shared/primers/primer-artifact';
import { parseEntityArtifact, type EntityArtifactRelationshipV1 } from './shared/entity-artifact';
import { nativeRecord, parseNativeJson } from './native-json';

export interface NativeStrainRelationship {
  readonly resourceId: ResourceId;
  readonly strainId: ResourceId;
  readonly kind: 'strain-descent' | 'strain-sequence';
  readonly targetId: ResourceId;
  readonly targetRevisionId: ResourceRevisionId | null;
  readonly fields: CanonicalMap;
}
export class UnsupportedNativeStrainRepresentationError extends TypeError {
  readonly code = 'UNSUPPORTED_NATIVE_STRAIN_REPRESENTATION';
}
export interface NativeStrainRelationshipOwnership {
  readonly strainId: string;
  readonly targetId: string;
  readonly kind: 'strain-descent' | 'strain-sequence';
}
export function nativeStrainRelationshipOwnership(
  relationship: Pick<EntityArtifactRelationshipV1, 'type' | 'fromEntityId' | 'toEntityId'>
): NativeStrainRelationshipOwnership | null {
  switch (relationship.type) {
    case 'derives_from':
      return {
        strainId: relationship.fromEntityId,
        targetId: relationship.toEntityId,
        kind: 'strain-descent',
      };
    case 'has_genome':
      return {
        strainId: relationship.fromEntityId,
        targetId: relationship.toEntityId,
        kind: 'strain-sequence',
      };
    case 'carried_by':
      return {
        strainId: relationship.toEntityId,
        targetId: relationship.fromEntityId,
        kind: 'strain-sequence',
      };
    default:
      return null;
  }
}
export type NativeStrainRepresentation =
  | { readonly kind: 'native'; readonly claims: readonly NativeStrainRelationship[] }
  | {
      readonly kind: 'legacy';
      readonly reason: {
        readonly code: 'UNSUPPORTED_NATIVE_STRAIN_REPRESENTATION';
        readonly message: string;
      };
    };

export function classifyNativeStrainRepresentation(text: string): NativeStrainRepresentation {
  parseEntityArtifact(text);
  try {
    return { kind: 'native', claims: parseNativeStrainRelationships(text) };
  } catch (error) {
    if (!(error instanceof UnsupportedNativeStrainRepresentationError)) throw error;
    return { kind: 'legacy', reason: { code: error.code, message: error.message } };
  }
}
function resourceId(value: string): ResourceId {
  const parsed = parseResourceId(value);
  if (!parsed.ok)
    throw new UnsupportedNativeStrainRepresentationError(
      'Native strain relationship identity is invalid.'
    );
  return parsed.value;
}

export function parseNativeStrainRelationships(text: string): readonly NativeStrainRelationship[] {
  const raw = parseNativeJson(text);
  const strain = parseEntityArtifact(text);
  if (strain.kind !== 'strain') throw new TypeError('Expected a native strain record.');
  const relationships = raw.relationships;
  if (!Array.isArray(relationships))
    throw new UnsupportedNativeStrainRepresentationError(
      'Native strain relationships are malformed.'
    );
  const seen = new Set<ResourceId>();
  return Object.freeze(
    strain.relationships.map((relationship, index) => {
      const payload = nativeRecord(nativeRecord(relationships[index]).payload);
      const type = relationship.type;
      const ownership = nativeStrainRelationshipOwnership(relationship);
      if (!ownership)
        throw new UnsupportedNativeStrainRepresentationError(
          `Native strain relationships require explicit pinned relationship migration: unsupported ${type}`
        );
      if (payload.assertion !== 'planned')
        throw new UnsupportedNativeStrainRepresentationError(
          'Native strain link qualification requires an explicit planned assertion; observed links require accepted physical evidence.'
        );
      if (
        type === 'has_genome' &&
        (payload.confidence === 'WGS_verified' || payload.confidence === 'partially_verified')
      )
        throw new UnsupportedNativeStrainRepresentationError(
          'A planned genome link cannot claim verification without accepted physical evidence.'
        );
      if (ownership.strainId !== strain.id)
        throw new UnsupportedNativeStrainRepresentationError(
          'Native strain relationship does not belong to its record.'
        );
      let targetRevisionId: ResourceRevisionId | null = null;
      if (Object.hasOwn(payload, 'targetRevisionId')) {
        if (typeof payload.targetRevisionId !== 'string')
          throw new UnsupportedNativeStrainRepresentationError(
            'Native strain target revision is invalid.'
          );
        const parsed = parseResourceRevisionId(payload.targetRevisionId);
        if (!parsed.ok)
          throw new UnsupportedNativeStrainRepresentationError(
            'Native strain target revision is invalid.'
          );
        targetRevisionId = parsed.value;
      }
      const id = resourceId(
        `native-strain-link-${defineBlob(new TextEncoder().encode(JSON.stringify([strain.id, type, relationship.fromEntityId, relationship.toEntityId]))).hash.slice('sha256:'.length)}`
      );
      if (seen.has(id))
        throw new UnsupportedNativeStrainRepresentationError(
          'Native strain relationship is declared more than once.'
        );
      seen.add(id);
      return Object.freeze({
        resourceId: id,
        strainId: resourceId(strain.id),
        kind: ownership.kind,
        targetId: resourceId(ownership.targetId),
        targetRevisionId,
        fields: { nativeRelationshipType: type, payload },
      });
    })
  );
}

export function nativeStrainRelationshipMatches(
  claim: NativeStrainRelationship,
  document: StrainSequenceDocument | StrainDescentDocument
): boolean {
  const target = document.kind === 'strain-descent' ? document.parent : document.sequence;
  if (
    claim.kind !== document.kind ||
    claim.strainId !== document.strainId ||
    claim.targetId !== target.resourceId ||
    (claim.targetRevisionId !== null && claim.targetRevisionId !== target.revisionId) ||
    document.assertion !== 'planned' ||
    document.evidence.length !== 0
  )
    return false;
  return (
    defineScientificDocument(document).scientificHash ===
    defineScientificDocument({ ...document, fields: claim.fields }).scientificHash
  );
}

export function validateNativeStrainReferences(input: {
  readonly snapshot: ScientificSnapshot;
  readonly reader: ScientificReader;
}): readonly ScientificIssue[] {
  const representation = input.snapshot.representation;
  if (!representation) throw new TypeError('Expected a native strain representation.');
  const claims = parseNativeStrainRelationships(representation.text);
  const declared = new Set(claims.map((claim) => claim.resourceId));
  const issues: ScientificIssue[] = [];
  for (const claim of claims) {
    const found = input.reader.current(claim.resourceId);
    if (!found)
      issues.push({
        code: 'MISSING_REFERENCE',
        resourceId: input.snapshot.resourceId,
        message: `Native strain link has no accepted relationship: ${claim.resourceId}`,
      });
    else if (
      (found.document.kind !== 'strain-descent' && found.document.kind !== 'strain-sequence') ||
      !nativeStrainRelationshipMatches(claim, found.document)
    )
      issues.push({
        code: 'EVIDENCE_INPUT_MISMATCH',
        resourceId: input.snapshot.resourceId,
        message: `Native strain link does not match its pinned relationship: ${claim.resourceId}`,
      });
  }
  for (const snapshot of input.reader.listCurrent())
    if (
      (snapshot.document.kind === 'strain-descent' ||
        snapshot.document.kind === 'strain-sequence') &&
      snapshot.document.strainId === input.snapshot.resourceId &&
      !declared.has(snapshot.resourceId)
    )
      issues.push({
        code: 'EVIDENCE_INPUT_MISMATCH',
        resourceId: input.snapshot.resourceId,
        message: `Accepted strain relationship is absent from its native projection: ${snapshot.resourceId}`,
      });
  return issues;
}

function sameHash(value: string, hash: string): boolean {
  return value === hash || value === hash.slice('sha256:'.length);
}

export function nativePlacementTargetMatches(
  binding: PrimerArtifactBindingV1,
  target: ScientificSnapshot | null
): target is ScientificSnapshot {
  if (
    !target ||
    target.resourceId !== binding.target.documentId ||
    target.document.kind !== 'sequence'
  )
    return false;
  const sequence = target.document;
  const bytes = target.representation?.text ?? defineScientificDocument(sequence).text;
  return (
    sequence.bases.length === binding.target.length &&
    sequence.topology === binding.target.topology &&
    sameHash(binding.target.fileContentHash, defineBlob(new TextEncoder().encode(bytes)).hash) &&
    sameHash(
      binding.target.normalizedSequenceHash,
      defineBlob(new TextEncoder().encode(sequence.bases.toUpperCase())).hash
    )
  );
}

export function nativePlacementCoordinatesMatch(
  binding: PrimerArtifactBindingV1,
  document: PrimerBindingDocument
): boolean {
  return (
    document.target.resourceId === binding.target.documentId &&
    document.coordinates.start === binding.coordinates.start &&
    document.coordinates.end === binding.coordinates.end &&
    document.coordinates.strand === binding.coordinates.strand
  );
}

export function validateNativePrimerReferences(input: {
  readonly snapshot: ScientificSnapshot;
  readonly reader: ScientificReader;
}): readonly ScientificIssue[] {
  const representation = input.snapshot.representation;
  if (!representation) throw new TypeError('Expected a native primer representation.');
  const primer = parsePrimerArtifact(representation.text);
  const issues: ScientificIssue[] = [];
  const report = (code: ScientificIssue['code'], message: string) =>
    issues.push({ code, resourceId: input.snapshot.resourceId, message });
  const declared = new Set<string>();
  for (const binding of primer.bindings) {
    declared.add(binding.id);
    const identity = parseResourceId(binding.id);
    const found = identity.ok ? input.reader.current(identity.value) : null;
    if (!found) {
      report('MISSING_REFERENCE', `Native primer placement has no accepted binding: ${binding.id}`);
      continue;
    }
    const document = found.document;
    if (document.kind !== 'primer-binding') {
      report(
        'WRONG_REFERENCE_KIND',
        `Native primer placement identity belongs to another kind: ${binding.id}`
      );
      continue;
    }
    if (
      document.primerId !== input.snapshot.resourceId ||
      !nativePlacementCoordinatesMatch(binding, document) ||
      !nativePlacementTargetMatches(binding, input.reader.revision(document.target))
    )
      report(
        'EVIDENCE_INPUT_MISMATCH',
        `Native primer placement does not match its pinned snapshot: ${binding.id}`
      );
  }
  for (const snapshot of input.reader.listCurrent())
    if (
      snapshot.document.kind === 'primer-binding' &&
      snapshot.document.primerId === input.snapshot.resourceId &&
      !declared.has(snapshot.resourceId)
    )
      report(
        'EVIDENCE_INPUT_MISMATCH',
        `Accepted binding is absent from its native primer projection: ${snapshot.resourceId}`
      );
  return issues;
}
