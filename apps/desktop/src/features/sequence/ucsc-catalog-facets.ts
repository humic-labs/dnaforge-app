import type { UcscCatalogLeaf } from '@waypoint/genome-data';

export interface CatalogFacetValue {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface CatalogFacetGroup {
  readonly key: string;
  readonly label: string;
  readonly values: ReadonlyArray<CatalogFacetValue>;
}

export type CatalogFacetSelection = Readonly<Record<string, ReadonlyArray<string>>>;

export const TRACK_KIND_FACET_KEY = 'scientificKind';

const KIND_LABELS: Readonly<Record<string, string>> = {
  transcript: 'Gene models',
  quantitative: 'Signal',
  peak: 'Peaks',
  interval: 'Intervals',
  repeat: 'Repeats',
  reads: 'Reads',
  variants: 'Variants',
};

const MAX_DISTINCT_VALUES = 400;
const MAX_UNIQUENESS = 0.5;
const MIN_CARRIER_FRACTION = 0.002;
const MIN_CARRIERS = 2;
const UNIQUENESS_EVIDENCE_FLOOR = 8;
const MAX_VALUE_LENGTH = 48;
const NEVER_A_QUESTION = new Set(['strand', 'donor']);
const PREFERRED_GROUPS = [
  'organ',
  'tissue',
  'celltype',
  'factor',
  'datatype',
  'biosampletype',
  'category',
  'sequencetech',
  'treatment',
  'assay',
];
const MAX_GROUPS = 12;

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function humanizeValue(value: string): string {
  const stripped = /^type[A-Z0-9]/.test(value) ? value.slice(4) : value;
  return stripped.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function facetPairs(leaf: UcscCatalogLeaf): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [[TRACK_KIND_FACET_KEY, leaf.scientificKind]];
  for (const attribute of leaf.attributes ?? []) {
    if (!attribute.key || !attribute.value) continue;
    pairs.push([attribute.key, attribute.value]);
  }
  return pairs;
}

function matchesSelection(
  leaf: UcscCatalogLeaf,
  selection: CatalogFacetSelection,
  ignoreKey?: string
): boolean {
  const pairs = facetPairs(leaf);
  for (const [key, chosen] of Object.entries(selection)) {
    if (chosen.length === 0 || key === ignoreKey) continue;
    const has = pairs.some(([pairKey, value]) => pairKey === key && chosen.includes(value));
    if (!has) return false;
  }
  return true;
}

export function applyUcscCatalogFacets(
  tracks: ReadonlyArray<UcscCatalogLeaf>,
  selection: CatalogFacetSelection
): ReadonlyArray<UcscCatalogLeaf> {
  const active = Object.values(selection).some((values) => values.length > 0);
  if (!active) return tracks;
  return tracks.filter((leaf) => matchesSelection(leaf, selection));
}

export function computeUcscCatalogFacets(
  tracks: ReadonlyArray<UcscCatalogLeaf>,
  selection: CatalogFacetSelection = {}
): ReadonlyArray<CatalogFacetGroup> {
  const counts = new Map<string, Map<string, number>>();

  const carrierCounts = new Map<string, number>();
  for (const { key, carriers } of collectKeys(tracks)) {
    carrierCounts.set(key, carriers);
    const scoped = tracks.filter((leaf) => matchesSelection(leaf, selection, key));
    const perValue = new Map<string, number>();
    for (const leaf of scoped) {
      for (const [pairKey, value] of facetPairs(leaf)) {
        if (pairKey !== key) continue;
        perValue.set(value, (perValue.get(value) ?? 0) + 1);
      }
    }
    if (perValue.size > 0) counts.set(key, perValue);
  }

  const groups: CatalogFacetGroup[] = [];
  for (const [key, perValue] of counts) {
    const chosen = selection[key] ?? [];
    if (perValue.size < 2 && chosen.length === 0) continue;
    if (perValue.size > MAX_DISTINCT_VALUES) continue;
    const labelFor = key === TRACK_KIND_FACET_KEY ? trackKindLabel : humanizeValue;
    const values = [...perValue.entries()]
      .filter(
        ([value]) => humanizeValue(value).length <= MAX_VALUE_LENGTH || chosen.includes(value)
      )
      .map(([value, count]) => ({ value, label: labelFor(value), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (values.length < 2 && chosen.length === 0) continue;
    groups.push({
      key,
      label: key === TRACK_KIND_FACET_KEY ? 'Track type' : humanizeKey(key),
      values,
    });
  }

  const ranked = groups.sort((a, b) => {
    if (a.key === TRACK_KIND_FACET_KEY) return -1;
    if (b.key === TRACK_KIND_FACET_KEY) return 1;
    const chosenA = (selection[a.key] ?? []).length > 0 ? 1 : 0;
    const chosenB = (selection[b.key] ?? []).length > 0 ? 1 : 0;
    if (chosenA !== chosenB) return chosenB - chosenA;
    const priorityA = PREFERRED_GROUPS.indexOf(a.key.toLowerCase());
    const priorityB = PREFERRED_GROUPS.indexOf(b.key.toLowerCase());
    if (priorityA !== priorityB) {
      if (priorityA < 0) return 1;
      if (priorityB < 0) return -1;
      return priorityA - priorityB;
    }
    const coverA = carrierCounts.get(a.key) ?? 0;
    const coverB = carrierCounts.get(b.key) ?? 0;
    return coverB - coverA || a.label.localeCompare(b.label);
  });
  const byLabel = new Set<string>();
  const unique = ranked.filter((group) => {
    if (byLabel.has(group.label)) return false;
    byLabel.add(group.label);
    return true;
  });
  return unique.slice(0, MAX_GROUPS);
}

function collectKeys(
  tracks: ReadonlyArray<UcscCatalogLeaf>
): ReadonlyArray<{ key: string; carriers: number }> {
  const distinct = new Map<string, Set<string>>();
  const carriers = new Map<string, number>();
  for (const leaf of tracks) {
    const seenKeys = new Set<string>();
    for (const [key, value] of facetPairs(leaf)) {
      let values = distinct.get(key);
      if (!values) {
        values = new Set();
        distinct.set(key, values);
      }
      values.add(value);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        carriers.set(key, (carriers.get(key) ?? 0) + 1);
      }
    }
  }

  const kept: Array<{ key: string; carriers: number }> = [];
  for (const [key, values] of distinct) {
    const held = carriers.get(key) ?? 0;
    if (key === TRACK_KIND_FACET_KEY) {
      kept.push({ key, carriers: held });
      continue;
    }
    if (NEVER_A_QUESTION.has(key.toLowerCase())) continue;
    if (held < Math.max(MIN_CARRIERS, tracks.length * MIN_CARRIER_FRACTION)) continue;
    if (held >= UNIQUENESS_EVIDENCE_FLOOR && values.size / held > MAX_UNIQUENESS) continue;
    kept.push({ key, carriers: held });
  }

  const byNormalized = new Map<string, { key: string; carriers: number }>();
  for (const entry of kept) {
    const normalized = entry.key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const existing = byNormalized.get(normalized);
    if (!existing || entry.carriers > existing.carriers) byNormalized.set(normalized, entry);
  }
  return [...byNormalized.values()];
}

export function toggleCatalogFacet(
  selection: CatalogFacetSelection,
  key: string,
  value: string
): CatalogFacetSelection {
  const current = selection[key] ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  const updated: Record<string, ReadonlyArray<string>> = { ...selection };
  if (next.length === 0) delete updated[key];
  else updated[key] = next;
  return updated;
}

export function countSelectedFacets(selection: CatalogFacetSelection): number {
  return Object.values(selection).reduce((total, values) => total + values.length, 0);
}

export function trackKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? humanizeKey(kind);
}
