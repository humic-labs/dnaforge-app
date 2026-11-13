import type { UcscCatalogLeaf } from '@waypoint/genome-data';

export interface UcscCatalogMatch {
  readonly tracks: ReadonlyArray<UcscCatalogLeaf>;
  readonly total: number;
  readonly catalogSize: number;
  readonly terms: ReadonlyArray<string>;
}

function haystack(leaf: UcscCatalogLeaf): string {
  const parts: string[] = [
    leaf.track,
    leaf.shortLabel,
    leaf.longLabel,
    leaf.group ?? '',
    leaf.type ?? '',
    leaf.parentTrack ?? '',
    leaf.parentParentTrack ?? '',
    leaf.experimentAccession ?? '',
    leaf.fileAccession ?? '',
  ];
  for (const attribute of leaf.attributes ?? []) {
    parts.push(attribute.key, attribute.value);
  }
  for (const container of leaf.containerPath ?? []) {
    parts.push(container.shortLabel);
  }
  return parts.join(' ').toLowerCase();
}

function nameText(leaf: UcscCatalogLeaf): string {
  return `${leaf.shortLabel} ${leaf.track}`.toLowerCase();
}

function describedText(leaf: UcscCatalogLeaf): string {
  return `${leaf.shortLabel} ${leaf.track} ${leaf.longLabel}`.toLowerCase();
}

function matchTier(
  leaf: UcscCatalogLeaf,
  terms: ReadonlyArray<string>,
  exactIdentifier: string
): number {
  if (exactIdentifier && leaf.track.toLowerCase() === exactIdentifier) return 0;
  const name = nameText(leaf);
  if (terms.every((term) => name.includes(term))) return 1;
  const described = describedText(leaf);
  if (terms.every((term) => described.includes(term))) return 2;
  return 3;
}

export function ucscCatalogSearchTerms(query: string): ReadonlyArray<string> {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

export function searchUcscCatalogLocally(
  catalog: ReadonlyArray<UcscCatalogLeaf>,
  query: string
): UcscCatalogMatch {
  const terms = ucscCatalogSearchTerms(query);
  const catalogSize = catalog.length;
  if (terms.length === 0) {
    return { tracks: catalog, total: catalogSize, catalogSize, terms };
  }

  const exactIdentifier = query.trim().toLowerCase();
  const matched = catalog.filter((leaf) => {
    const text = haystack(leaf);
    return terms.every((term) => text.includes(term));
  });

  const ranked = matched
    .map((leaf, index) => ({ leaf, index, tier: matchTier(leaf, terms, exactIdentifier) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.leaf);

  return { tracks: ranked, total: ranked.length, catalogSize, terms };
}
