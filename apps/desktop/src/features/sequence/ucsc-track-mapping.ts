import {
  adaptUcscTrackRecords,
  type AnnotationRecord,
  type RegionalTrackCoordinates,
  type ScientificTrackKind,
  type AdaptedUcscTrackRecords,
} from '@waypoint/genome-data';

export function ucscRecordsToAnnotations(
  rawRecords: ReadonlyArray<Record<string, unknown>>,
  input: RegionalTrackCoordinates
): AnnotationRecord[] {
  const adapted = adaptUcscTrackRecords('interval', rawRecords, input);
  return adapted.records;
}

export function adaptUcscRecords(
  scientificKind: ScientificTrackKind,
  rawRecords: ReadonlyArray<Record<string, unknown>>,
  input: RegionalTrackCoordinates
): AdaptedUcscTrackRecords {
  return adaptUcscTrackRecords(scientificKind, rawRecords, input);
}
