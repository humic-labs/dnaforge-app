import type { AdmittedTrackSource, TrackSourceProvenance } from './admitted-track-source';
import type { FormatInput } from './format-handler';

export type IndexedBbiTrackInput = Extract<FormatInput, { kind: 'path' | 'url' }>;

export interface IndexedBbiTrackProvenance extends TrackSourceProvenance {
  readonly provider: 'local-file' | 'direct-url' | 's3' | 'gcs';
  readonly sourceKind: 'local-file' | 'remote-url' | 's3' | 'gcs';
  readonly label: string;
  readonly devScenarioFixture?: true;
}

export interface IndexedBbiTrackSource extends Omit<
  AdmittedTrackSource,
  'formatId' | 'input' | 'provenance' | 'readerKind'
> {
  readonly formatId: 'bigwig' | 'bigbed';
  readonly input: IndexedBbiTrackInput;
  readonly readerKind: 'bbi';
  readonly provenance: IndexedBbiTrackProvenance;
}

export function isIndexedBbiTrackSource(
  source: AdmittedTrackSource
): source is IndexedBbiTrackSource {
  if (
    source.readerKind !== 'bbi' ||
    (source.formatId !== 'bigwig' && source.formatId !== 'bigbed') ||
    (source.input?.kind !== 'path' && source.input?.kind !== 'url')
  ) {
    return false;
  }
  const sourceKind = 'sourceKind' in source.provenance ? source.provenance.sourceKind : undefined;
  const label = 'label' in source.provenance ? source.provenance.label : undefined;
  const devScenarioFixture =
    'devScenarioFixture' in source.provenance ? source.provenance.devScenarioFixture : undefined;
  if (devScenarioFixture !== undefined && devScenarioFixture !== true) return false;
  if (source.input.kind === 'path') {
    return (
      typeof source.input.path === 'string' &&
      source.input.path.trim().length > 0 &&
      source.provenance.provider === 'local-file' &&
      sourceKind === 'local-file' &&
      typeof label === 'string' &&
      label.trim().length > 0
    );
  }
  return (
    typeof source.input.url === 'string' &&
    source.input.url.trim().length > 0 &&
    ((source.provenance.provider === 'direct-url' && sourceKind === 'remote-url') ||
      (source.provenance.provider === 's3' && sourceKind === 's3') ||
      (source.provenance.provider === 'gcs' && sourceKind === 'gcs')) &&
    typeof label === 'string' &&
    label.trim().length > 0
  );
}

export function createIndexedBbiTrackId(input: {
  readonly assemblyId: string;
  readonly source: IndexedBbiTrackInput;
}): string {
  const locator = input.source.kind === 'path' ? input.source.path : input.source.url;
  const filename = sourceFilename(locator) || 'indexed-data';
  const readable = filename
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `data:${readable || 'indexed-data'}-${fnv1a32(
    `${input.assemblyId}\u0000${input.source.kind}\u0000${locator}`
  )}`;
}

export function indexedBbiTrackLabel(source: IndexedBbiTrackInput): string {
  const locator = source.kind === 'path' ? source.path : source.url;
  return sourceFilename(locator) || (source.kind === 'path' ? 'Local BigWig' : 'Linked BigWig');
}

function sourceFilename(locator: string): string {
  const withoutQuery = locator.split(/[?#]/, 1)[0] ?? '';
  const segments = withoutQuery.split(/[\\/]/).filter(Boolean);
  return decodeURIComponentSafe(segments[segments.length - 1] ?? '');
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
