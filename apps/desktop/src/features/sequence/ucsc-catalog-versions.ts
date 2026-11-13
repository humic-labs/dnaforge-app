import type { UcscCatalogLeaf } from '@waypoint/genome-data';

export interface VersionedCatalogRow {
  readonly track: UcscCatalogLeaf;
  readonly context: ReadonlyArray<string>;
  readonly versions: ReadonlyArray<{
    readonly label: string;
    readonly track: UcscCatalogLeaf;
  }>;
}

const VERSION_TOKEN = /\b[vV]\.?\s?(\d+(?:\.\d+)?)\b|\(Ensembl\s+(\d+)\)/;
const VERSION_SUFFIX = /[vV](\d+(?:\.\d+)?)$/;
const MIN_ID_BASE_LENGTH = 4;

function versionOf(text: string): number | null {
  const match = VERSION_TOKEN.exec(text);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  return raw === undefined ? null : Number.parseFloat(raw);
}

function withoutVersion(text: string): string {
  return text
    .replace(/\(Ensembl\s+\d+\)/g, '')
    .replace(/\b[vV]\.?\s?\d+(?:\.\d+)?\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function idBase(leaf: UcscCatalogLeaf): string {
  const stripped = leaf.track.replace(VERSION_SUFFIX, '');
  return stripped.length >= MIN_ID_BASE_LENGTH ? stripped : leaf.track;
}

function versionFromId(leaf: UcscCatalogLeaf): { version: number; label: string } | null {
  const match = VERSION_SUFFIX.exec(leaf.track);
  if (!match?.[1]) return null;
  if (leaf.track.length - match[0].length < MIN_ID_BASE_LENGTH) return null;
  return { version: Number.parseFloat(match[1]), label: match[0].toUpperCase() };
}

function containerLabels(leaf: UcscCatalogLeaf): ReadonlyArray<string> {
  return (leaf.containerPath ?? []).map((container) => container.shortLabel);
}

function familyOf(
  leaf: UcscCatalogLeaf
): { keys: ReadonlyArray<string>; version: number; label: string } | null {
  let version: number | null = null;
  let label = '';
  const labels = containerLabels(leaf);
  for (const source of [leaf.shortLabel, ...labels]) {
    const found = versionOf(source);
    if (found === null) continue;
    version = found;
    label = VERSION_TOKEN.exec(source)?.[0]?.trim() ?? String(found);
    break;
  }
  if (version === null) {
    const fromId = versionFromId(leaf);
    if (!fromId) return null;
    version = fromId.version;
    label = fromId.label;
  }

  const shared = [leaf.sourceKind, leaf.hubUrl ?? '', leaf.scientificKind, leaf.formatId];
  const dataset = withoutVersion(leaf.shortLabel);
  return {
    keys: [
      ['id', ...shared, idBase(leaf), dataset].join('\u0001'),
      ['path', ...shared, dataset, labels.map(withoutVersion).join('\u0000')].join('\u0001'),
    ],
    version,
    label,
  };
}

export function catalogTrackRelease(track: UcscCatalogLeaf): string {
  return familyOf(track)?.label ?? '';
}

export function collapseVersionFamilies(
  tracks: ReadonlyArray<UcscCatalogLeaf>
): ReadonlyArray<VersionedCatalogRow> {
  type Entry = { leaf: UcscCatalogLeaf; version: number; label: string };
  const groups: Array<{ entries: Array<Entry>; mergedInto: number | null }> = [];
  const byKey = new Map<string, number>();

  const rootOf = (index: number): number => {
    let current = index;
    while (groups[current]!.mergedInto !== null) current = groups[current]!.mergedInto!;
    return current;
  };

  for (const leaf of tracks) {
    const family = familyOf(leaf);
    if (!family) {
      groups.push({ entries: [{ leaf, version: 0, label: '' }], mergedInto: null });
      continue;
    }
    const entry: Entry = { leaf, version: family.version, label: family.label };
    const found = [...new Set(family.keys.map((key) => byKey.get(key)))]
      .filter((index): index is number => index !== undefined)
      .map(rootOf);
    const home = [...new Set(found)].sort((a, b) => a - b);

    if (home.length === 0) {
      const index = groups.length;
      groups.push({ entries: [entry], mergedInto: null });
      for (const key of family.keys) byKey.set(key, index);
      continue;
    }
    const target = home[0]!;
    for (const other of home.slice(1)) {
      groups[target]!.entries.push(...groups[other]!.entries);
      groups[other]!.entries = [];
      groups[other]!.mergedInto = target;
    }
    groups[target]!.entries.push(entry);
    for (const key of family.keys) if (!byKey.has(key)) byKey.set(key, target);
  }

  return groups
    .filter((group) => group.mergedInto === null && group.entries.length > 0)
    .map((group) => {
      const ordered = [...group.entries].sort((a, b) => b.version - a.version);
      const newest = ordered[0]!;
      return {
        track: newest.leaf,
        context: containerLabels(newest.leaf)
          .map(withoutVersion)
          .filter((label) => label.length > 0),
        versions: ordered.map((item) => ({ label: item.label, track: item.leaf })),
      };
    });
}
