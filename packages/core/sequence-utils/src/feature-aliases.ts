import type { Annotation } from './types';

export type FeatureIdentityInput = Pick<Annotation, 'type' | 'name' | 'qualifiers'> &
  Partial<Pick<Annotation, 'label'>>;

export interface FeatureXref {
  readonly db: string;
  readonly id: string;
}

export interface FeatureAliasSet {
  readonly displayName: string;
  readonly geneSymbol?: string;
  readonly locusTag?: string;
  readonly synonyms: readonly string[];
  readonly product?: string;
  readonly xrefs: readonly FeatureXref[];
  readonly exportLabel?: string;
  readonly descriptors: readonly string[];
}

export type AliasMatchKind =
  | 'locusTag'
  | 'geneSymbol'
  | 'synonym'
  | 'xref'
  | 'product'
  | 'exportLabel'
  | 'displayName'
  | 'descriptor';

export interface AliasMatch<T> {
  readonly feature: T;
  readonly matchedOn: AliasMatchKind;
  readonly exact: boolean;
  readonly rank: number;
}

export interface ResolveFeaturesOptions<T> {
  readonly filter?: (feature: T) => boolean;
  readonly aliasesOf?: (feature: T) => FeatureAliasSet;
}

const SYNONYM_KEYS = [
  'gene_synonym',
  'old_locus_tag',
  'standard_name',
  'allele',
  'Alias',
  'Name',
] as const;

const DESCRIPTOR_KEYS = [
  'note',
  'function',
  'EC_number',
  'mobile_element_type',
  'ncRNA_class',
  'regulatory_class',
  'rpt_family',
] as const;

const XREF_LIST_KEYS = ['db_xref'] as const;
const XREF_ACCESSION_KEYS = [
  ['protein_id', 'protein_id'],
  ['transcript_id', 'transcript_id'],
] as const;

const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,14}$/;

const LABEL_TYPE_WORD =
  '(?:CDS|gene|mRNA|ncRNA|tRNA|rRNA|snRNA|snoRNA|tmRNA|misc_RNA|promoter|terminator|repeat_region|rep_origin|LTR)';

const COMPOSITE_LABEL = new RegExp(`^(\\S+)\\s+${LABEL_TYPE_WORD}\\b\\s*(?:\\((.+)\\))?\\s*$`, 'i');

const SEMICOLON_LABEL = /^([^;]+);\s*(.+)$/;

function firstQualifier(
  qualifiers: Record<string, string[]> | undefined,
  key: string
): string | undefined {
  const value = qualifiers?.[key]?.[0]?.trim();
  return value ? value : undefined;
}

function recoverFromLabel(label: string | undefined): {
  geneSymbol?: string;
  product?: string;
} {
  if (!label) return {};
  const trimmed = label.trim();

  const composite = COMPOSITE_LABEL.exec(trimmed);
  if (composite) {
    const symbol = composite[1];
    return {
      geneSymbol: SYMBOL_PATTERN.test(symbol) ? symbol : undefined,
      product: composite[2]?.trim() || undefined,
    };
  }

  const semicolon = SEMICOLON_LABEL.exec(trimmed);
  if (semicolon) {
    const symbol = semicolon[1].trim();
    return {
      geneSymbol: SYMBOL_PATTERN.test(symbol) ? symbol : undefined,
      product: semicolon[2].trim() || undefined,
    };
  }

  return SYMBOL_PATTERN.test(trimmed) ? { geneSymbol: trimmed } : {};
}

function parseXref(raw: string): FeatureXref | null {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { db: raw.slice(0, separator).trim(), id: raw.slice(separator + 1).trim() };
}

export function featureAliases(feature: FeatureIdentityInput): FeatureAliasSet {
  const q = feature.qualifiers;

  const exportLabel = firstQualifier(q, 'label') ?? feature.label?.trim() ?? undefined;
  const displayName =
    feature.name?.trim() ||
    exportLabel ||
    firstQualifier(q, 'gene') ||
    firstQualifier(q, 'product') ||
    firstQualifier(q, 'note') ||
    feature.type;

  const recovered = recoverFromLabel(exportLabel ?? feature.name);

  const synonyms: string[] = [];
  for (const key of SYNONYM_KEYS) {
    for (const value of q?.[key] ?? []) {
      const trimmed = value.trim();
      if (trimmed) synonyms.push(trimmed);
    }
  }

  const xrefs: FeatureXref[] = [];
  for (const key of XREF_LIST_KEYS) {
    for (const value of q?.[key] ?? []) {
      const parsed = parseXref(value.trim());
      if (parsed) xrefs.push(parsed);
    }
  }
  for (const [key, db] of XREF_ACCESSION_KEYS) {
    const value = firstQualifier(q, key);
    if (value) xrefs.push({ db, id: value });
  }

  return {
    displayName,
    geneSymbol: firstQualifier(q, 'gene') ?? recovered.geneSymbol,
    locusTag: firstQualifier(q, 'locus_tag'),
    synonyms,
    product: firstQualifier(q, 'product') ?? recovered.product,
    xrefs,
    exportLabel,
    descriptors: DESCRIPTOR_KEYS.flatMap((key) =>
      (q?.[key] ?? []).map((value) => value.trim()).filter(Boolean)
    ),
  };
}

const KIND_RANK: Record<AliasMatchKind, number> = {
  locusTag: 0,
  geneSymbol: 1,
  synonym: 2,
  xref: 3,
  product: 4,
  exportLabel: 5,
  displayName: 6,
  descriptor: 7,
};

const EXACT_BONUS = 100;

interface Candidate {
  readonly kind: AliasMatchKind;
  readonly values: readonly (string | undefined)[];
}

function candidatesFor(aliases: FeatureAliasSet): Candidate[] {
  return [
    { kind: 'locusTag', values: [aliases.locusTag] },
    { kind: 'geneSymbol', values: [aliases.geneSymbol] },
    { kind: 'synonym', values: aliases.synonyms },
    {
      kind: 'xref',
      values: aliases.xrefs.flatMap((x) => [`${x.db}:${x.id}`, x.id]),
    },
    { kind: 'product', values: [aliases.product] },
    { kind: 'exportLabel', values: [aliases.exportLabel] },
    { kind: 'displayName', values: [aliases.displayName] },
    { kind: 'descriptor', values: aliases.descriptors },
  ];
}

export function resolveFeaturesByName<T>(
  features: readonly T[],
  query: string,
  options: ResolveFeaturesOptions<T> & { aliasesOf: (feature: T) => FeatureAliasSet }
): AliasMatch<T>[];
export function resolveFeaturesByName<T extends FeatureIdentityInput>(
  features: readonly T[],
  query: string,
  options?: ResolveFeaturesOptions<T>
): AliasMatch<T>[];
export function resolveFeaturesByName<T>(
  features: readonly T[],
  query: string,
  options: ResolveFeaturesOptions<T> = {}
): AliasMatch<T>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const readAliases =
    options.aliasesOf ?? ((feature: T) => featureAliases(feature as FeatureIdentityInput));
  const matches: AliasMatch<T>[] = [];

  for (const feature of features) {
    if (options.filter && !options.filter(feature)) continue;

    let best: AliasMatch<T> | null = null;
    for (const candidate of candidatesFor(readAliases(feature))) {
      for (const raw of candidate.values) {
        if (!raw) continue;
        const value = raw.toLowerCase();
        const exact = value === needle;
        if (!exact && !value.includes(needle)) continue;

        const rank = KIND_RANK[candidate.kind] + (exact ? 0 : EXACT_BONUS);
        if (!best || rank < best.rank) {
          best = { feature, matchedOn: candidate.kind, exact, rank };
        }
      }
    }
    if (best) matches.push(best);
  }

  return matches.sort((a, b) => a.rank - b.rank);
}
