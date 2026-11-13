import type {
  AdmittedTrackSource,
  ScientificTrackKind,
  TrackSourceProvenance,
} from './admitted-track-source';
import type { AnnotationRecord } from './records';

export type UcscTrackSourceKind = 'ucsc-native' | 'ucsc-hub' | 'remote-url';
export type UcscTrackFormatId = 'ucsc-native' | 'bigbed' | 'bigwig' | 'bam' | 'vcf';

export interface UcscCatalogContainer {
  readonly track: string;
  readonly shortLabel: string;
  readonly longLabel?: string;
  readonly kind: 'composite' | 'super' | 'view' | 'container';
}

export interface UcscCatalogAttribute {
  readonly key: string;
  readonly value: string;
  readonly origin: 'subgroup' | 'metadata';
}

export interface UcscCatalogSignalScale {
  readonly auto: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly alwaysZero: boolean;
}

export interface UcscCatalogLeaf {
  readonly sourceKind: Exclude<UcscTrackSourceKind, 'remote-url'>;
  readonly catalogId: string;
  readonly track: string;
  readonly shortLabel: string;
  readonly longLabel: string;
  readonly scientificKind: ScientificTrackKind;
  readonly formatId: UcscTrackFormatId;
  readonly assembly: {
    readonly ucscGenome: string;
    readonly aliases: ReadonlyArray<string>;
  };
  readonly parentTrack?: string;
  readonly parentParentTrack?: string;
  readonly catalogColor?: string;
  readonly experimentAccession?: string;
  readonly fileAccession?: string;
  readonly hubUrl?: string;
  readonly bigDataUrl?: string;
  readonly bigDataIndex?: string;
  readonly type?: string;
  readonly group?: string;
  readonly containerPath?: ReadonlyArray<UcscCatalogContainer>;
  readonly attributes?: ReadonlyArray<UcscCatalogAttribute>;
  readonly signalScale?: UcscCatalogSignalScale;
}

export interface UcscTrackProvenance extends TrackSourceProvenance {
  readonly provider: 'ucsc';
  readonly sourceKind: UcscTrackSourceKind;
  readonly catalogId: string;
  readonly ucscGenome: string;
  readonly track: string;
  readonly hubUrl?: string;
  readonly remoteUrl?: string;
  readonly label: string;
}

export interface UcscTrackSource extends Omit<AdmittedTrackSource, 'formatId' | 'provenance'> {
  readonly formatId: UcscTrackFormatId;
  readonly provenance: UcscTrackProvenance;
}

export function isUcscTrackSource(source: AdmittedTrackSource): source is UcscTrackSource {
  return source.provenance.provider === 'ucsc';
}

export type UcscTrackTileResult =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly message: string; readonly retryable: boolean }
  | {
      readonly state: 'ready';
      readonly records: ReadonlyArray<AnnotationRecord>;
      readonly complete: boolean;
      readonly itemsReturned: number;
      readonly maxItemsOutput: number;
    };

export function createUcscTrackFingerprint(input: {
  readonly sourceKind: UcscTrackSourceKind;
  readonly ucscGenome: string;
  readonly track: string;
  readonly hubUrl?: string;
}): string {
  return [input.sourceKind, input.ucscGenome, input.track, input.hubUrl ?? ''].join('\u0000');
}

export function createUcscTrackId(input: {
  readonly sourceKind: UcscTrackSourceKind;
  readonly ucscGenome: string;
  readonly track: string;
  readonly hubUrl?: string;
  readonly remoteUrl?: string;
}): string {
  const readable = `${input.ucscGenome}-${input.track}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (input.sourceKind === 'ucsc-native') return `ucsc:${readable}`;
  const sourceUrl = input.hubUrl ?? input.remoteUrl ?? '';
  return `ucsc:${readable}-${fnv1a32(`${input.sourceKind}\u0000${sourceUrl}`)}`;
}

export function isCompleteUcscTile(
  result: UcscTrackTileResult
): result is Extract<UcscTrackTileResult, { state: 'ready' }> {
  return result.state === 'ready' && result.complete;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
