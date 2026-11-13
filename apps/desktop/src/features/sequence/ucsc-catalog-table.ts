import type { UcscCatalogLeaf } from '@waypoint/genome-data';
import { trackKindLabel } from './ucsc-catalog-facets';
import { catalogTrackRelease, type VersionedCatalogRow } from './ucsc-catalog-versions';

export interface CatalogTableColumn {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly defaultVisible: boolean;
  readonly value: (track: UcscCatalogLeaf) => string;
}

export type CatalogColumnFilters = Readonly<Record<string, string>>;
export interface CatalogTableSort {
  readonly columnId: string;
  readonly direction: 'asc' | 'desc';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const BARE_ACCESSION = /^[A-Za-z]{2,6}[0-9][0-9A-Z]{3,}$/;
const INTERNAL_ATTRIBUTES = new Set(['name', 'view']);

export function trackHeadline(track: UcscCatalogLeaf): string {
  if (BARE_ACCESSION.test(track.shortLabel) && track.longLabel) return track.longLabel;
  return track.shortLabel || track.longLabel || track.track;
}

export function trackSourceLabel(track: UcscCatalogLeaf): string {
  if (track.sourceKind === 'ucsc-hub') return 'Track hub';
  if (track.bigDataUrl) {
    try {
      if (new URL(track.bigDataUrl).hostname === 'encode-public.s3.amazonaws.com') return 'ENCODE';
    } catch {}
  }
  return 'UCSC';
}

export function trackFormatLabel(format: UcscCatalogLeaf['formatId']): string {
  return {
    bigwig: 'BigWig',
    bigbed: 'BigBed',
    'ucsc-native': 'UCSC table',
    bam: 'BAM',
    vcf: 'VCF',
  }[format];
}

function attributeLabel(key: string): string {
  const text = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export function collectCatalogTableColumns(
  tracks: ReadonlyArray<UcscCatalogLeaf>
): ReadonlyArray<CatalogTableColumn> {
  const columns: CatalogTableColumn[] = [
    { id: 'track', label: 'Track', width: 220, defaultVisible: true, value: trackHeadline },
    { id: 'trackId', label: 'ID', width: 148, defaultVisible: true, value: (t) => t.track },
    {
      id: 'description',
      label: 'Description',
      width: 280,
      defaultVisible: false,
      value: (t) => t.longLabel,
    },
    {
      id: 'scientificKind',
      label: 'Track type',
      width: 120,
      defaultVisible: true,
      value: (t) => trackKindLabel(t.scientificKind),
    },
    {
      id: 'collection',
      label: 'Collection',
      width: 180,
      defaultVisible: true,
      value: (t) => (t.containerPath ?? []).map((c) => c.shortLabel).join(' › ') || t.group || '',
    },
    {
      id: 'formatId',
      label: 'Format',
      width: 90,
      defaultVisible: true,
      value: (t) => trackFormatLabel(t.formatId),
    },
    {
      id: 'release',
      label: 'Release',
      width: 110,
      defaultVisible: tracks.some((t) => catalogTrackRelease(t) !== ''),
      value: catalogTrackRelease,
    },
    { id: 'source', label: 'Source', width: 90, defaultVisible: true, value: trackSourceLabel },
    { id: 'group', label: 'Group', width: 150, defaultVisible: false, value: (t) => t.group ?? '' },
    {
      id: 'experimentAccession',
      label: 'Experiment accession',
      width: 165,
      defaultVisible: false,
      value: (t) => t.experimentAccession ?? '',
    },
    {
      id: 'fileAccession',
      label: 'File accession',
      width: 140,
      defaultVisible: false,
      value: (t) => t.fileAccession ?? '',
    },
  ];
  const coverage = new Map<string, number>();
  for (const track of tracks) {
    const keys = new Set(
      (track.attributes ?? [])
        .map((a) => a.key)
        .filter((key) => key && !INTERNAL_ATTRIBUTES.has(key.toLowerCase()))
    );
    for (const key of keys) coverage.set(key, (coverage.get(key) ?? 0) + 1);
  }
  const ranked = [...coverage].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
  const defaults = new Set(
    ranked
      .filter(([key]) => key.toLowerCase() !== 'strand')
      .slice(0, 2)
      .map(([key]) => key)
  );
  for (const [key] of ranked) {
    columns.push({
      id: `attribute:${key}`,
      label: attributeLabel(key),
      width: 150,
      defaultVisible: defaults.has(key),
      value: (track) =>
        [
          ...new Set(
            (track.attributes ?? []).filter((a) => a.key === key && a.value).map((a) => a.value)
          ),
        ].join(' · '),
    });
  }
  const labels = new Map<string, string[]>();
  for (const column of columns) {
    labels.set(column.label, [...(labels.get(column.label) ?? []), column.id]);
  }
  return columns.map((column) => {
    const collisions = labels.get(column.label) ?? [];
    if (collisions.length < 2) return column;
    const metadataKey = column.id.startsWith('attribute:')
      ? column.id.slice('attribute:'.length)
      : null;
    const suffix =
      metadataKey === null
        ? 'provider'
        : collisions.length === 2 && collisions.some((id) => !id.startsWith('attribute:'))
          ? 'metadata'
          : metadataKey;
    return { ...column, label: `${column.label} (${suffix})` };
  });
}

export function filterCatalogTableTracks(
  tracks: ReadonlyArray<UcscCatalogLeaf>,
  columns: ReadonlyArray<CatalogTableColumn>,
  filters: CatalogColumnFilters
): ReadonlyArray<UcscCatalogLeaf> {
  const active = Object.entries(filters).flatMap(([id, filter]) => {
    const column = columns.find((c) => c.id === id);
    const terms = filter.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return column && terms.length ? [{ column, terms }] : [];
  });
  if (!active.length) return tracks;
  return tracks.filter((track) =>
    active.every(({ column, terms }) => {
      const value = (
        column.id === 'track' ? `${column.value(track)} ${track.track}` : column.value(track)
      ).toLocaleLowerCase();
      return terms.every((term) => value.includes(term));
    })
  );
}

export function sortCatalogTableRows(
  rows: ReadonlyArray<VersionedCatalogRow>,
  columns: ReadonlyArray<CatalogTableColumn>,
  sort: CatalogTableSort | null,
  chosenVersions: Readonly<Record<string, string>> = {}
): ReadonlyArray<VersionedCatalogRow> {
  const column = sort && columns.find((c) => c.id === sort.columnId);
  if (!column || !sort) return rows;
  const selected = (row: VersionedCatalogRow) =>
    row.versions.find((v) => v.track.catalogId === chosenVersions[row.track.catalogId])?.track ??
    row.track;
  return [...rows].sort((a, b) => {
    const left = column.value(selected(a)),
      right = column.value(selected(b));
    if (!left && right) return 1;
    if (left && !right) return -1;
    return (
      collator.compare(left, right) * (sort.direction === 'asc' ? 1 : -1) ||
      collator.compare(a.track.catalogId, b.track.catalogId)
    );
  });
}
