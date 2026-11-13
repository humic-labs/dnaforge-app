import type { Annotation } from '@waypoint/sequence-utils';

export type BiomoleculeRef = TranslatedCdsProteinRef | DirectProteinRef | ProteinMsaRowRef;

export interface BiomoleculeAlias {
  kind: 'gene' | 'locus-tag' | 'product' | 'label' | 'name' | 'accession' | 'legacy-id';
  value: string;
}

export interface TranslatedCdsProteinRef {
  kind: 'translated-cds';
  canonicalProteinIdentityKey: string;
  sourceEntityId: string;
  featureKey: string;
  cdsBounds: { start0: number; end0: number; strand: 1 | -1 };
  aliases: BiomoleculeAlias[];
}

export interface DirectProteinRef {
  kind: 'protein-sequence';
  canonicalProteinIdentityKey: string;
  source:
    | { kind: 'file'; entityId: string }
    | { kind: 'provider'; provider: 'uniprot' | 'rcsb' | 'alphafold'; accession: string }
    | { kind: 'mcp'; requestId: string };
  aliases: BiomoleculeAlias[];
}

export interface ProteinMsaRowRef {
  kind: 'protein-msa-row';
  canonicalProteinIdentityKey: string;
  alignmentId: string;
  rowId: string;
  rowDigest?: string;
  aliases: BiomoleculeAlias[];
}

export interface BuildTranslatedCdsProteinRefArgs {
  referenceId: string;
  cds: Annotation;
}

export interface BuildTranslatedCdsProteinRefFromPartsArgs {
  referenceId: string;
  featureKey: string;
  start0: number;
  end0: number;
  strand: 1 | -1;
  aliases?: ReadonlyArray<BiomoleculeAlias>;
}

export function buildTranslatedCdsProteinRef({
  referenceId,
  cds,
}: BuildTranslatedCdsProteinRefArgs): TranslatedCdsProteinRef {
  const featureKey = translatedCdsFeatureKey(cds);
  return buildTranslatedCdsProteinRefFromParts({
    referenceId,
    featureKey,
    start0: cds.start - 1,
    end0: cds.end - 1,
    strand: cds.direction === -1 ? -1 : 1,
    aliases: translatedCdsAliases(cds),
  });
}

export function buildTranslatedCdsProteinRefFromParts({
  referenceId,
  featureKey,
  start0,
  end0,
  strand,
  aliases = [],
}: BuildTranslatedCdsProteinRefFromPartsArgs): TranslatedCdsProteinRef {
  const start1 = start0 + 1;
  const end1 = end0 + 1;
  const normalizedFeatureKey = featureKey.trim();
  return {
    kind: 'translated-cds',
    canonicalProteinIdentityKey: [
      'translated-cds',
      referenceId.trim(),
      normalizedFeatureKey,
      `${start1}-${end1}`,
      strand,
    ].join(':'),
    sourceEntityId: referenceId,
    featureKey: normalizedFeatureKey,
    cdsBounds: { start0, end0, strand },
    aliases: dedupeAliases([{ kind: 'legacy-id', value: normalizedFeatureKey }, ...aliases]),
  };
}

export function translatedCdsMoleculeId(referenceId: string, cds: Annotation): string {
  return serializeBiomoleculeRef(buildTranslatedCdsProteinRef({ referenceId, cds }));
}

export function translatedCdsMoleculeIdFromParts(
  args: BuildTranslatedCdsProteinRefFromPartsArgs
): string {
  return serializeBiomoleculeRef(buildTranslatedCdsProteinRefFromParts(args));
}

export interface BuildDirectProteinRefArgs {
  entityId: string;
  sequenceHash: string;
  aliases?: ReadonlyArray<BiomoleculeAlias>;
}

export function buildDirectProteinRef({
  entityId,
  sequenceHash,
  aliases = [],
}: BuildDirectProteinRefArgs): DirectProteinRef {
  const normalizedEntityId = entityId.trim();
  const normalizedHash = sequenceHash.trim();
  return {
    kind: 'protein-sequence',
    canonicalProteinIdentityKey: [
      'protein-sequence',
      'file',
      normalizedEntityId,
      normalizedHash,
    ].join(':'),
    source: { kind: 'file', entityId: normalizedEntityId },
    aliases: dedupeAliases(aliases),
  };
}

export function standaloneProteinMoleculeIdFromEntity(
  entityId: string,
  sequenceHash: string
): string {
  return serializeBiomoleculeRef(buildDirectProteinRef({ entityId, sequenceHash }));
}

export function translatedCdsFeatureKey(cds: Annotation): string {
  return (
    firstQualifier(cds, 'locus_tag') ??
    firstQualifier(cds, 'gene') ??
    firstQualifier(cds, 'product') ??
    cds.name ??
    `CDS:${cds.start}-${cds.end}:${cds.direction ?? 1}`
  );
}

export function serializeBiomoleculeRef(ref: BiomoleculeRef): string {
  return ref.canonicalProteinIdentityKey;
}

function translatedCdsAliases(cds: Annotation): BiomoleculeAlias[] {
  return [
    ...qualifierAliases(cds, 'locus_tag', 'locus-tag'),
    ...qualifierAliases(cds, 'gene', 'gene'),
    ...qualifierAliases(cds, 'product', 'product'),
    ...(cds.label ? [{ kind: 'label' as const, value: cds.label }] : []),
    ...(cds.name ? [{ kind: 'name' as const, value: cds.name }] : []),
  ];
}

function qualifierAliases(
  cds: Annotation,
  qualifier: string,
  kind: BiomoleculeAlias['kind']
): BiomoleculeAlias[] {
  return (cds.qualifiers?.[qualifier] ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({ kind, value }));
}

function firstQualifier(cds: Annotation, key: string): string | undefined {
  return cds.qualifiers?.[key]?.map((item) => item.trim()).find((item) => item.length > 0);
}

function dedupeAliases(aliases: ReadonlyArray<BiomoleculeAlias>): BiomoleculeAlias[] {
  const seen = new Set<string>();
  const result: BiomoleculeAlias[] = [];
  for (const alias of aliases) {
    const value = alias.value.trim();
    if (!value) continue;
    const key = `${alias.kind}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: alias.kind, value });
  }
  return result;
}
