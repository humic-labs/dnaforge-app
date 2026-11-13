import { createHash } from 'node:crypto';
import type { SourceObject, SourceRelationship } from '../../shared/benchling-migration';
import {
  isExactProviderStableId,
  providerObjectClassForStableId,
  type ProviderObjectClass,
} from '../../shared/provider-object-reference';
import { benchlingRelationshipDisplayNames } from '../../shared/benchling-relationship-names';
import { isBenchlingMissingSourceValue } from './benchling-source-value';

type StrainRelationshipSemantics = Readonly<{
  relationType: string;
  targetClasses: readonly ProviderObjectClass[];
}>;

const RELATIONSHIP_FIELDS = new Map<string, StrainRelationshipSemantics>([
  ['Ancestor strain', { relationType: 'derives_from', targetClasses: ['registry_entity'] }],
  ['Host Strain', { relationType: 'derives_from', targetClasses: ['registry_entity'] }],
  ['Ancestor DNA (strain)', { relationType: 'derives_from', targetClasses: ['sequence'] }],
  ['Plasmid', { relationType: 'associated_with', targetClasses: ['sequence'] }],
  [
    'Plasmids, lysogens, episomes',
    { relationType: 'associated_with', targetClasses: ['sequence'] },
  ],
  ['episomal construct(s)', { relationType: 'associated_with', targetClasses: ['sequence'] }],
  ['episomal sequence(s)', { relationType: 'associated_with', targetClasses: ['sequence'] }],
  ['genomic sequence', { relationType: 'associated_with', targetClasses: ['sequence'] }],
  ['Sequence link(s)', { relationType: 'associated_with', targetClasses: ['sequence'] }],
  ['plasmids', { relationType: 'associated_with', targetClasses: ['sequence'] }],
]);

export function attachStrainRelationships(sourceObjects: readonly SourceObject[]): SourceObject[] {
  return sourceObjects.map((sourceObject) => {
    const fields = strainFields(sourceObject);
    if (!fields) return sourceObject;
    const generated = fields.flatMap((field) => {
      const semantics = RELATIONSHIP_FIELDS.get(field.label);
      if (!semantics || isBenchlingMissingSourceValue(field.value)) return [];
      return relationshipsForField(sourceObjects, sourceObject, field, semantics);
    });
    if (generated.length === 0) return sourceObject;
    const existingIds = new Set(sourceObject.relationships.map(({ id }) => id));
    return {
      ...sourceObject,
      relationships: [
        ...sourceObject.relationships,
        ...generated.filter(({ id }) => !existingIds.has(id)),
      ],
    };
  });
}

function relationshipsForField(
  sourceObjects: readonly SourceObject[],
  sourceObject: SourceObject,
  field: { label: string; value: string; position: number },
  semantics: StrainRelationshipSemantics
): SourceRelationship[] {
  const explicitIds = exactProviderIds(field.value).filter((stableId) =>
    semantics.targetClasses.includes(providerObjectClassForStableId(stableId) ?? 'other')
  );
  if (explicitIds.length > 0) {
    return explicitIds.map((stableId, targetIndex) =>
      sourceRelationship(sourceObject, field, semantics, {
        targetIndex,
        targetSourceId: stableId,
        evidence: [
          { kind: 'stable_id', value: stableId, sourcePath: sourceObject.sourcePath },
          { kind: 'source_type', value: semantics.targetClasses.join('|') },
        ],
      })
    );
  }

  const parts = benchlingRelationshipDisplayNames(field.value);
  const fullNameIsOneObject = sourceObjects.some(
    (candidate) =>
      candidate.id !== sourceObject.id &&
      normalizeName(candidate.name) === normalizeName(field.value)
  );
  const names = !fullNameIsOneObject && parts.length >= 2 ? parts : [field.value];
  return names.map((name, targetIndex) =>
    sourceRelationship(sourceObject, field, semantics, {
      targetIndex,
      evidence: [
        { kind: 'name', value: name, sourcePath: sourceObject.sourcePath },
        { kind: 'source_type', value: semantics.targetClasses.join('|') },
      ],
    })
  );
}

function sourceRelationship(
  sourceObject: SourceObject,
  field: { label: string; value: string; position: number },
  semantics: StrainRelationshipSemantics,
  target: {
    targetIndex: number;
    targetSourceId?: string;
    evidence: SourceRelationship['evidence'];
  }
): SourceRelationship {
  const digest = createHash('sha256')
    .update(
      [sourceObject.stableId, field.position, field.label, field.value, target.targetIndex].join(
        '\0'
      ),
      'utf8'
    )
    .digest('hex')
    .slice(0, 24);
  return {
    id: `strain-relationship-${digest}`,
    sourceObjectId: sourceObject.id,
    ...(target.targetSourceId ? { targetSourceId: target.targetSourceId } : {}),
    relationType: semantics.relationType,
    direction: 'outbound',
    evidence: target.evidence,
  };
}

export type StrainRelationshipIndexes = Readonly<{
  byStableId: ReadonlyMap<string, readonly SourceObject[]>;
  byNormalizedName: ReadonlyMap<string, readonly SourceObject[]>;
}>;

export function buildStrainRelationshipIndexes(
  sourceObjects: readonly SourceObject[]
): StrainRelationshipIndexes {
  const byStableId = new Map<string, SourceObject[]>();
  const byNormalizedName = new Map<string, SourceObject[]>();
  for (const sourceObject of sourceObjects) {
    const stableMatches = byStableId.get(sourceObject.stableId) ?? [];
    stableMatches.push(sourceObject);
    byStableId.set(sourceObject.stableId, stableMatches);
    const name = normalizeName(sourceObject.name);
    if (!name) continue;
    const matches = byNormalizedName.get(name) ?? [];
    matches.push(sourceObject);
    byNormalizedName.set(name, matches);
  }
  return {
    byStableId: sortedIndex(byStableId),
    byNormalizedName: sortedIndex(byNormalizedName),
  };
}

export function strainRelationshipNameCandidates(
  relationship: SourceRelationship,
  indexes: StrainRelationshipIndexes
): readonly SourceObject[] | null {
  if (!relationship.id.startsWith('strain-relationship-')) return null;
  if (relationship.evidence.some(({ kind }) => kind === 'stable_id')) return null;
  const names = [
    ...new Set(
      relationship.evidence
        .filter(({ kind }) => kind === 'name')
        .map(({ value }) => normalizeName(value))
        .filter(Boolean)
    ),
  ];
  if (names.length !== 1) return [];
  return (indexes.byNormalizedName.get(names[0] ?? '') ?? []).filter(
    (candidate) =>
      candidate.id !== relationship.sourceObjectId &&
      strainRelationshipCandidateCompatibility(relationship, candidate) === true
  );
}

export function strainRelationshipCandidateCompatibility(
  relationship: SourceRelationship,
  candidate: SourceObject
): boolean | null {
  if (!relationship.id.startsWith('strain-relationship-')) return null;
  const targetClasses = relationshipTargetClasses(relationship);
  if (targetClasses.size === 0) return false;
  const providerClass = providerObjectClassForStableId(candidate.stableId);
  if (!providerClass || !targetClasses.has(providerClass)) return false;
  return sourceTypeMatchesProviderClass(candidate.sourceType, providerClass);
}

function relationshipTargetClasses(
  relationship: SourceRelationship
): ReadonlySet<ProviderObjectClass> {
  return new Set(
    relationship.evidence
      .filter(({ kind }) => kind === 'source_type')
      .flatMap(({ value }) => value.split('|'))
      .filter((value): value is ProviderObjectClass =>
        ['notebook', 'sequence', 'protein', 'protocol', 'registry_entity', 'other'].includes(value)
      )
  );
}

function sourceTypeMatchesProviderClass(
  sourceType: string,
  providerClass: ProviderObjectClass
): boolean {
  const normalizedSourceType = normalizeType(sourceType);
  switch (providerClass) {
    case 'registry_entity':
      return normalizedSourceType === 'strain';
    case 'sequence':
      return normalizedSourceType === 'dna_sequence' || normalizedSourceType === 'rna_sequence';
    case 'protein':
      return normalizedSourceType === 'protein';
    case 'notebook':
      return normalizedSourceType === 'notebook' || normalizedSourceType === 'notebook_entry';
    case 'protocol':
      return normalizedSourceType === 'protocol';
    case 'other':
      return false;
  }
}

function sortedIndex(index: Map<string, SourceObject[]>): Map<string, readonly SourceObject[]> {
  return new Map(
    [...index].map(([key, candidates]) => [
      key,
      candidates.sort(
        (left, right) =>
          left.stableId.localeCompare(right.stableId) || left.id.localeCompare(right.id)
      ),
    ])
  );
}

function strainFields(
  sourceObject: SourceObject
): Array<{ label: string; value: string; position: number }> | null {
  if (normalizeType(sourceObject.sourceType) !== 'strain' || !isRecord(sourceObject.content)) {
    return null;
  }
  if (
    sourceObject.content.kind !== 'benchling_strain' ||
    !Array.isArray(sourceObject.content.fields)
  ) {
    return null;
  }
  const fields = [];
  for (const value of sourceObject.content.fields) {
    if (!isRecord(value)) return null;
    if (
      typeof value.label !== 'string' ||
      typeof value.value !== 'string' ||
      !Number.isSafeInteger(value.position) ||
      (value.position as number) < 0
    ) {
      return null;
    }
    fields.push({ label: value.label, value: value.value, position: value.position as number });
  }
  return fields;
}

function exactProviderIds(value: string): string[] {
  const found = value.match(/[a-z][a-z0-9]{1,15}_[A-Za-z0-9]{6,}/gu) ?? [];
  return [...new Set(found.filter(isExactProviderStableId))].sort();
}

function normalizeName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function normalizeType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
