import type { ResidueSelection } from './residue-selection-types';

export const SAVED_RESIDUE_SELECTION_SCHEMA = 'waypoint.residue-selection.v1' as const;

const MAX_SAVED_SELECTION_INTERVALS = 100_000;
const MAX_SAVED_SELECTION_RESIDUES = 1_000_000;

export interface SavedSelectionActor {
  kind: 'user' | 'agent' | 'system';
  id?: string;
}

export interface SavedSelectionSourceArtifactPin {
  entityId: string;
  gitCommit?: string;
  path?: string;
}

export interface SavedSelectionTranslationPin {
  featureId?: string;
  strand: 1 | -1;
  geneticCode: number;
  frame: 0 | 1 | 2;
}

export interface SavedSelectionPolymerRevision {
  moleculeId: string;
  moleculeKind: string;
  sequenceDigestSha256: string;
  sourceArtifact?: SavedSelectionSourceArtifactPin;
  translation?: SavedSelectionTranslationPin;
}

export interface SavedSelectionStructureRevision {
  id: string;
  structureId: string;
  providerIdentityKey?: string;
  coordinateDigestSha256: string;
  assemblyId?: string;
  sourceArtifact?: SavedSelectionSourceArtifactPin;
}

export interface SavedSelectionChainInstance {
  chain: string;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
}

export type SavedSelectionScope =
  | { kind: 'polymer' }
  | {
      kind: 'structure-chain-instance';
      structureRevisionId: string;
      chain: SavedSelectionChainInstance;
    };

export interface SavedResidueIdentity {
  polymerIndex: number;
  authSeqId: number;
  labelSeqId?: number;
  labelCompId: string;
  oneLetterCode: string;
}

export interface SavedResidueSelectionMember {
  id: string;
  selection: ResidueSelection;
  scope: SavedSelectionScope;
  polymerRevision: SavedSelectionPolymerRevision;
  residueIdentities?: SavedResidueIdentity[];
}

export interface SavedResidueSelectionRevision {
  id: string;
  parentRevisionId?: string;
  createdAt: string;
  actor: SavedSelectionActor;
  reason?: string;
  members: SavedResidueSelectionMember[];
  structureRevisions: SavedSelectionStructureRevision[];
}

export interface SavedResidueSelectionDocument {
  schema: typeof SAVED_RESIDUE_SELECTION_SCHEMA;
  kind: 'residue-selection';
  id: string;
  name: string;
  color: string;
  currentRevisionId: string;
  revisions: SavedResidueSelectionRevision[];
}

export interface CreateSavedResidueSelectionDocumentInput {
  id: string;
  name: string;
  color: string;
  revisionId: string;
  createdAt: string;
  actor: SavedSelectionActor;
  reason?: string;
  members: SavedResidueSelectionMember[];
  structureRevisions?: SavedSelectionStructureRevision[];
}

export interface AppendSavedResidueSelectionRevisionInput {
  revisionId: string;
  createdAt: string;
  actor: SavedSelectionActor;
  reason?: string;
  name?: string;
  color?: string;
  members: SavedResidueSelectionMember[];
  structureRevisions?: SavedSelectionStructureRevision[];
}

export type SavedResidueSelectionCompatibility =
  | { status: 'compatible' }
  | { status: 'missing-polymer'; memberId: string; moleculeId: string }
  | {
      status: 'stale-polymer';
      memberId: string;
      moleculeId: string;
      expectedDigest: string;
      actualDigest: string;
    }
  | { status: 'missing-structure'; memberId: string; structureRevisionId: string }
  | {
      status: 'structure-remap-required';
      memberId: string;
      structureId: string;
      expectedDigest: string;
      actualDigest: string;
    };

export interface SavedResidueSelectionCompatibilityContext {
  polymers: ReadonlyArray<{ moleculeId: string; sequenceDigestSha256: string }>;
  structures?: ReadonlyArray<{
    structureId: string;
    coordinateDigestSha256: string;
    providerIdentityKey?: string;
  }>;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createSavedResidueSelectionDocument(
  input: CreateSavedResidueSelectionDocumentInput
): SavedResidueSelectionDocument {
  const document: SavedResidueSelectionDocument = {
    schema: SAVED_RESIDUE_SELECTION_SCHEMA,
    kind: 'residue-selection',
    id: input.id,
    name: input.name,
    color: input.color.toLowerCase(),
    currentRevisionId: input.revisionId,
    revisions: [
      {
        id: input.revisionId,
        createdAt: input.createdAt,
        actor: input.actor,
        ...(input.reason ? { reason: input.reason } : {}),
        members: input.members,
        structureRevisions: input.structureRevisions ?? [],
      },
    ],
  };
  assertSavedResidueSelectionDocument(document);
  return jsonClone(document);
}

export function appendSavedResidueSelectionRevision(
  document: SavedResidueSelectionDocument,
  input: AppendSavedResidueSelectionRevisionInput
): SavedResidueSelectionDocument {
  assertSavedResidueSelectionDocument(document);
  if (document.revisions.some((revision) => revision.id === input.revisionId)) {
    throw new Error(`Saved selection revision already exists: ${input.revisionId}`);
  }
  const current = document.revisions.find((revision) => revision.id === document.currentRevisionId);
  if (!current) {
    throw new Error(`Current saved selection revision is missing: ${document.currentRevisionId}`);
  }

  const next: SavedResidueSelectionDocument = {
    ...jsonClone(document),
    name: input.name ?? document.name,
    color: (input.color ?? document.color).toLowerCase(),
    currentRevisionId: input.revisionId,
    revisions: [
      ...jsonClone(document.revisions),
      {
        id: input.revisionId,
        parentRevisionId: current.id,
        createdAt: input.createdAt,
        actor: input.actor,
        ...(input.reason ? { reason: input.reason } : {}),
        members: jsonClone(input.members),
        structureRevisions: jsonClone(input.structureRevisions ?? current.structureRevisions),
      },
    ],
  };
  assertSavedResidueSelectionDocument(next);
  return next;
}

export function serializeSavedResidueSelectionDocument(
  document: SavedResidueSelectionDocument
): string {
  assertSavedResidueSelectionDocument(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseSavedResidueSelectionDocument(content: string): SavedResidueSelectionDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Invalid saved residue selection JSON');
  }
  assertSavedResidueSelectionDocument(value);
  return jsonClone(value);
}

export function classifySavedResidueSelectionCompatibility(
  revision: SavedResidueSelectionRevision,
  context: SavedResidueSelectionCompatibilityContext
): SavedResidueSelectionCompatibility {
  for (const member of revision.members) {
    const polymer = context.polymers.find(
      (candidate) => candidate.moleculeId === member.polymerRevision.moleculeId
    );
    if (!polymer) {
      return {
        status: 'missing-polymer',
        memberId: member.id,
        moleculeId: member.polymerRevision.moleculeId,
      };
    }
    if (polymer.sequenceDigestSha256 !== member.polymerRevision.sequenceDigestSha256) {
      return {
        status: 'stale-polymer',
        memberId: member.id,
        moleculeId: member.polymerRevision.moleculeId,
        expectedDigest: member.polymerRevision.sequenceDigestSha256,
        actualDigest: polymer.sequenceDigestSha256,
      };
    }

    if (member.scope.kind !== 'structure-chain-instance') continue;
    const scope = member.scope;
    const pinned = revision.structureRevisions.find(
      (candidate) => candidate.id === scope.structureRevisionId
    );
    if (!pinned) {
      return {
        status: 'missing-structure',
        memberId: member.id,
        structureRevisionId: scope.structureRevisionId,
      };
    }
    const available = context.structures?.find(
      (candidate) =>
        candidate.structureId === pinned.structureId ||
        (!!pinned.providerIdentityKey &&
          candidate.providerIdentityKey === pinned.providerIdentityKey)
    );
    if (!available) {
      return {
        status: 'missing-structure',
        memberId: member.id,
        structureRevisionId: member.scope.structureRevisionId,
      };
    }
    if (available.coordinateDigestSha256 !== pinned.coordinateDigestSha256) {
      return {
        status: 'structure-remap-required',
        memberId: member.id,
        structureId: pinned.structureId,
        expectedDigest: pinned.coordinateDigestSha256,
        actualDigest: available.coordinateDigestSha256,
      };
    }
  }
  return { status: 'compatible' };
}

function assertSavedResidueSelectionDocument(
  value: unknown
): asserts value is SavedResidueSelectionDocument {
  const document = record(value, 'Saved selection document');
  requiredString(document.schema, 'schema');
  if (document.schema !== SAVED_RESIDUE_SELECTION_SCHEMA) {
    throw new Error(`Unsupported saved selection schema: ${String(document.schema)}`);
  }
  if (document.kind !== 'residue-selection') {
    throw new Error('Saved selection kind must be residue-selection');
  }
  requiredString(document.id, 'id');
  requiredString(document.name, 'name');
  validColor(document.color, 'color');
  requiredString(document.currentRevisionId, 'currentRevisionId');
  const revisions = array(document.revisions, 'revisions');
  if (revisions.length === 0) throw new Error('Saved selection must contain a revision');
  const revisionIds = new Set<string>();
  for (const valueRevision of revisions) {
    const revision = record(valueRevision, 'revision');
    const revisionId = requiredString(revision.id, 'revision.id');
    if (revisionIds.has(revisionId))
      throw new Error(`Duplicate saved selection revision: ${revisionId}`);
    revisionIds.add(revisionId);
    optionalString(revision.parentRevisionId, 'revision.parentRevisionId');
    requiredString(revision.createdAt, 'revision.createdAt');
    const actor = record(revision.actor, 'revision.actor');
    if (!['user', 'agent', 'system'].includes(String(actor.kind))) {
      throw new Error('revision.actor.kind is invalid');
    }
    optionalString(actor.id, 'revision.actor.id');
    optionalString(revision.reason, 'revision.reason');
    const structureRevisions = array(revision.structureRevisions, 'revision.structureRevisions');
    const structureRevisionIds = new Set<string>();
    for (const valueStructure of structureRevisions) {
      const structure = record(valueStructure, 'structure revision');
      const id = requiredString(structure.id, 'structureRevision.id');
      if (structureRevisionIds.has(id)) throw new Error(`Duplicate structure revision: ${id}`);
      structureRevisionIds.add(id);
      requiredString(structure.structureId, 'structureRevision.structureId');
      requiredString(structure.coordinateDigestSha256, 'structureRevision.coordinateDigestSha256');
      optionalString(structure.providerIdentityKey, 'structureRevision.providerIdentityKey');
      optionalString(structure.assemblyId, 'structureRevision.assemblyId');
      validateSourceArtifact(structure.sourceArtifact);
    }
    const members = array(revision.members, 'revision.members');
    if (members.length === 0) throw new Error('Saved selection revision must contain a member');
    const memberIds = new Set<string>();
    for (const valueMember of members) {
      const member = record(valueMember, 'selection member');
      const memberId = requiredString(member.id, 'member.id');
      if (memberIds.has(memberId)) throw new Error(`Duplicate selection member: ${memberId}`);
      memberIds.add(memberId);
      const validatedSelection = validateResidueSelection(member.selection);
      if (member.residueIdentities !== undefined) {
        const identities = array(member.residueIdentities, 'member.residueIdentities');
        if (identities.length !== validatedSelection.residueCount) {
          throw new Error('member residue identities must cover every selected polymer residue');
        }
        const actualPolymerIndices = new Set<number>();
        for (const valueIdentity of identities) {
          const identity = record(valueIdentity, 'member residue identity');
          const polymerIndex = nonNegativeInteger(
            identity.polymerIndex,
            'member residue identity polymerIndex'
          );
          if (actualPolymerIndices.has(polymerIndex)) {
            throw new Error(`Duplicate member residue identity: ${polymerIndex}`);
          }
          actualPolymerIndices.add(polymerIndex);
          if (!selectionContainsPolymerIndex(validatedSelection.intervals, polymerIndex)) {
            throw new Error('member residue identities must cover every selected polymer residue');
          }
          if (!Number.isInteger(identity.authSeqId)) {
            throw new Error('member residue identity authSeqId must be an integer');
          }
          if (identity.labelSeqId !== undefined && !Number.isInteger(identity.labelSeqId)) {
            throw new Error('member residue identity labelSeqId must be an integer');
          }
          requiredString(identity.labelCompId, 'member residue identity labelCompId');
          const oneLetterCode = requiredString(
            identity.oneLetterCode,
            'member residue identity oneLetterCode'
          );
          if (Array.from(oneLetterCode).length !== 1) {
            throw new Error('member residue identity oneLetterCode must contain one character');
          }
        }
      }
      const scope = record(member.scope, 'member.scope');
      if (scope.kind === 'structure-chain-instance') {
        const structureRevisionId = requiredString(
          scope.structureRevisionId,
          'member.scope.structureRevisionId'
        );
        if (!structureRevisionIds.has(structureRevisionId)) {
          throw new Error(`Member references missing structure revision: ${structureRevisionId}`);
        }
        const chain = record(scope.chain, 'member.scope.chain');
        requiredString(chain.chain, 'member.scope.chain.chain');
        optionalString(chain.baseChain, 'member.scope.chain.baseChain');
        optionalString(chain.labelAsymId, 'member.scope.chain.labelAsymId');
        optionalString(chain.authAsymId, 'member.scope.chain.authAsymId');
        optionalString(chain.entityId, 'member.scope.chain.entityId');
        optionalString(chain.operator, 'member.scope.chain.operator');
      } else if (scope.kind !== 'polymer') {
        throw new Error('member.scope.kind is invalid');
      }
      const polymer = record(member.polymerRevision, 'member.polymerRevision');
      requiredString(polymer.moleculeId, 'member.polymerRevision.moleculeId');
      requiredString(polymer.moleculeKind, 'member.polymerRevision.moleculeKind');
      requiredString(polymer.sequenceDigestSha256, 'member.polymerRevision.sequenceDigestSha256');
      validateSourceArtifact(polymer.sourceArtifact);
      if (polymer.translation !== undefined) {
        const translation = record(polymer.translation, 'member.polymerRevision.translation');
        optionalString(translation.featureId, 'translation.featureId');
        if (translation.strand !== 1 && translation.strand !== -1) {
          throw new Error('translation.strand must be 1 or -1');
        }
        if (!Number.isInteger(translation.geneticCode) || Number(translation.geneticCode) <= 0) {
          throw new Error('translation.geneticCode must be a positive integer');
        }
        if (![0, 1, 2].includes(Number(translation.frame))) {
          throw new Error('translation.frame must be 0, 1, or 2');
        }
      }
    }
  }
  if (!revisionIds.has(String(document.currentRevisionId))) {
    throw new Error(
      `Current saved selection revision is missing: ${String(document.currentRevisionId)}`
    );
  }
}

interface ValidatedSelectionIntervals {
  intervals: Array<{ start: number; end: number }>;
  residueCount: number;
}

function validateResidueSelection(value: unknown): ValidatedSelectionIntervals {
  const selection = record(value, 'member.selection');
  const target = record(selection.target, 'member.selection.target');
  requiredString(target.moleculeId, 'selection.target.moleculeId');
  requiredString(target.moleculeKind, 'selection.target.moleculeKind');
  if (target.coordinateSystem !== 'residue') {
    throw new Error('selection.target.coordinateSystem must be residue');
  }
  const intervals = array(target.intervals, 'selection.target.intervals');
  if (intervals.length === 0) throw new Error('Selection must contain an interval');
  if (intervals.length > MAX_SAVED_SELECTION_INTERVALS) {
    throw new Error(
      `Saved selection cannot contain more than ${MAX_SAVED_SELECTION_INTERVALS} intervals`
    );
  }
  let previousEnd = -1;
  let residueCount = 0;
  const validatedIntervals: Array<{ start: number; end: number }> = [];
  for (const valueInterval of intervals) {
    const interval = record(valueInterval, 'selection interval');
    const start = nonNegativeInteger(interval.start, 'selection interval start');
    const end = nonNegativeInteger(interval.end, 'selection interval end');
    if (end < start) throw new Error('Selection interval end precedes start');
    if (start <= previousEnd) throw new Error('Selection intervals must be sorted and disjoint');
    const intervalResidueCount = end - start + 1;
    if (
      !Number.isSafeInteger(intervalResidueCount) ||
      intervalResidueCount > MAX_SAVED_SELECTION_RESIDUES - residueCount
    ) {
      throw new Error(
        `Saved selection cannot contain more than ${MAX_SAVED_SELECTION_RESIDUES} selected residues`
      );
    }
    residueCount += intervalResidueCount;
    validatedIntervals.push({ start, end });
    previousEnd = end;
  }
  return { intervals: validatedIntervals, residueCount };
}

function selectionContainsPolymerIndex(
  intervals: ReadonlyArray<{ start: number; end: number }>,
  polymerIndex: number
): boolean {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const interval = intervals[middle];
    if (polymerIndex < interval.start) {
      high = middle - 1;
    } else if (polymerIndex > interval.end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function validateSourceArtifact(value: unknown): void {
  if (value === undefined) return;
  const source = record(value, 'sourceArtifact');
  requiredString(source.entityId, 'sourceArtifact.entityId');
  optionalString(source.gitCommit, 'sourceArtifact.gitCommit');
  optionalString(source.path, 'sourceArtifact.path');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) requiredString(value, label);
}

function validColor(value: unknown, label: string): void {
  const color = requiredString(value, label);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`${label} must be a six-digit hex color`);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}
