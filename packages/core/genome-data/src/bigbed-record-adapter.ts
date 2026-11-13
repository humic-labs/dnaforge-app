import type { ScientificTrackKind } from './admitted-track-source';
import {
  adaptUcscTrackRecords,
  type AdaptedUcscTrackRecords,
  type RegionalTrackCoordinates,
} from './ucsc-record-adapters';

export type BigBedScientificKind = Extract<
  ScientificTrackKind,
  'transcript' | 'interval' | 'peak' | 'repeat'
>;

export interface RawBigBedFeature {
  readonly start: number;
  readonly end: number;
  readonly score?: number;
  readonly rest?: string;
  readonly uniqueId?: string;
}

export interface BigBedRecordAdapterOptions {
  readonly autoSql?: string;
}

type BigBedAdaptedRecords = Extract<
  AdaptedUcscTrackRecords,
  { scientificKind: BigBedScientificKind }
>;

export function adaptBigBedFeatures(
  scientificKind: BigBedScientificKind,
  features: ReadonlyArray<RawBigBedFeature>,
  coordinates: RegionalTrackCoordinates,
  options: BigBedRecordAdapterOptions = {}
): BigBedAdaptedRecords {
  const fieldNames = parseBigBedAutoSqlFieldNames(options.autoSql);
  const rawRecords = features.map((feature) =>
    rawRecordFromBigBedFeature(scientificKind, feature, fieldNames)
  );
  return adaptUcscTrackRecords(scientificKind, rawRecords, coordinates) as BigBedAdaptedRecords;
}

export function parseBigBedAutoSqlFieldNames(autoSql: string | undefined): string[] {
  if (!autoSql) return [];
  const names: string[] = [];
  const declaration = /^\s*[A-Za-z_]\w*(?:\[[^\]]+\])?\s+([A-Za-z_]\w*)\s*;/gm;
  for (const match of autoSql.matchAll(declaration)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names;
}

function rawRecordFromBigBedFeature(
  scientificKind: BigBedScientificKind,
  feature: RawBigBedFeature,
  fieldNames: ReadonlyArray<string>
): Readonly<Record<string, unknown>> {
  const columns = feature.rest?.split('\t') ?? [];
  const raw: Record<string, unknown> = {
    chromStart: feature.start,
    chromEnd: feature.end,
    ...(feature.uniqueId ? { uniqueId: feature.uniqueId } : {}),
    ...(feature.rest === undefined ? {} : { rawRest: feature.rest }),
  };

  assign(raw, 'name', columns[0]);
  assign(raw, 'score', feature.score ?? columns[1]);
  assign(raw, 'strand', columns[2]);

  if (scientificKind === 'peak') {
    assign(raw, 'signalValue', columns[3]);
    assign(raw, 'pValue', columns[4]);
    assign(raw, 'qValue', columns[5]);
    assign(raw, 'peak', columns[6]);
  } else {
    assign(raw, 'thickStart', columns[3]);
    assign(raw, 'thickEnd', columns[4]);
    assign(raw, 'itemRgb', columns[5]);
    assign(raw, 'blockCount', columns[6]);
    assign(raw, 'blockSizes', columns[7]);
    assign(raw, 'blockStarts', columns[8]);
  }

  for (let index = 3; index < fieldNames.length; index += 1) {
    assign(raw, fieldNames[index], columns[index - 3]);
  }
  return raw;
}

function assign(target: Record<string, unknown>, key: string | undefined, value: unknown): void {
  if (!key || value === undefined || value === '') return;
  target[key] = value;
}
