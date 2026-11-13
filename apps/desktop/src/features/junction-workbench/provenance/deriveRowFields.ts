import type { ColoredCutSite, RestrictionEnzyme } from '@waypoint/sequence-utils';
import { makeMappingPoint, type CoordMappingPointKind } from '../coord-mapping';
import { normalizeSourceBase, positiveModulo } from './coordinates';
import type {
  DerivedSourceRowFields,
  DigestBoundaryProjection,
  ValidatedSourceProvenanceProjection,
} from './types';

const RD_SCAR_ANNOTATION_COLOR = '#f59e0b';

export function deriveSourceRowFields(
  projection: ValidatedSourceProvenanceProjection,
  options: {
    pointKindForBioCol?: (bioCol: number, includedInProduct: boolean) => CoordMappingPointKind;
  } = {}
): DerivedSourceRowFields {
  const pointKindForBioCol =
    options.pointKindForBioCol ?? ((_, included) => (included ? 'valid' : 'unavailable'));
  const sequence = projection.bases.map((base) => base.base).join('');
  const sourceByRowPosition = projection.bases.map((base) => base.sourceBase);
  const points = projection.bases.map((base) => {
    const included = base.owner === 'contributing';
    return makeMappingPoint(
      projection.rowId,
      base.rowPosition,
      base.bioCol,
      base.productPosition,
      base.owner === 'unavailable' ? 'unavailable' : pointKindForBioCol(base.bioCol, included),
      { sourcePosition: base.sourceBase }
    );
  });
  const visibleColumns = projection.bases
    .filter((base) => base.owner !== 'unavailable')
    .map((base) => base.rowPosition as number);
  const contributingColumns = projection.bases
    .filter((base) => base.owner === 'contributing')
    .map((base) => base.rowPosition as number);
  const contributingColumnSet = new Set(contributingColumns);
  const mutedColumns = visibleColumns.filter((column) => !contributingColumnSet.has(column));
  const mutedColumnSet = new Set(mutedColumns);

  return {
    sequence,
    coordinateStart: sourceByRowPosition.find((position) => position !== null) ?? 0,
    points,
    sourceByRowPosition,
    visibleColumns,
    contributingColumns,
    mutedColumns,
    mutedColumnSet,
    cutSites: deriveCutSites(projection),
  };
}

function deriveCutSites(projection: ValidatedSourceProvenanceProjection): ColoredCutSite[] {
  const cutSites: ColoredCutSite[] = [];
  const seen = new Set<string>();

  for (const boundary of projection.digestBoundaries) {
    const cutPositionTop = sourceBoundaryToRowCoordinate(boundary.topCutBoundary, projection);
    const cutPositionBottom = sourceBoundaryToRowCoordinate(boundary.bottomCutBoundary, projection);
    const recognitionStart = sourceBoundaryToRowCoordinate(
      boundary.recognitionInterval.start,
      projection
    );
    const recognitionEnd = sourceBoundaryToRowCoordinate(
      boundary.recognitionInterval.end,
      projection
    );
    if (
      cutPositionTop === null ||
      cutPositionBottom === null ||
      recognitionStart === null ||
      recognitionEnd === null
    ) {
      continue;
    }

    const key = [
      boundary.enzymeName,
      cutPositionTop,
      cutPositionBottom,
      recognitionStart,
      recognitionEnd,
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);

    cutSites.push({
      enzyme: restrictionDigestCutSiteEnzyme(boundary),
      cutPositionTop,
      cutPositionBottom,
      recognitionStart,
      recognitionEnd,
      strand: 'forward',
      color: RD_SCAR_ANNOTATION_COLOR,
    });
  }

  return cutSites.sort((a, b) => a.cutPositionTop - b.cutPositionTop);
}

function sourceBoundaryToRowCoordinate(
  sourceBoundary: number,
  projection: ValidatedSourceProvenanceProjection
): number | null {
  const entries = projection.bases
    .filter((base) => base.sourceBase !== null)
    .map((base) => ({
      sourcePosition: base.sourceBase as number,
      rowPosition: base.rowPosition as number,
    }));
  if (entries.length === 0) return null;

  const exact = entries.find((entry) => entry.sourcePosition === sourceBoundary);
  if (exact) return exact.rowPosition;

  if (projection.circular && projection.sourceLength > 0) {
    const normalizedBoundary = normalizeSourceBase(sourceBoundary, projection.sourceLength);
    const matches = entries.filter(
      (entry) =>
        normalizeSourceBase(entry.sourcePosition, projection.sourceLength) === normalizedBoundary
    );
    if (matches.length > 0) {
      return matches.reduce((best, candidate) =>
        Math.abs(candidate.sourcePosition - sourceBoundary) <
        Math.abs(best.sourcePosition - sourceBoundary)
          ? candidate
          : best
      ).rowPosition;
    }
  }

  const before = entries
    .filter((entry) => entry.sourcePosition < sourceBoundary)
    .sort((a, b) => b.sourcePosition - a.sourcePosition)[0];
  if (before) return before.rowPosition + 1;

  return entries[0]?.rowPosition ?? null;
}

function restrictionDigestCutSiteEnzyme(boundary: DigestBoundaryProjection): RestrictionEnzyme {
  const recognitionLength = Math.max(
    1,
    boundary.recognitionInterval.end - boundary.recognitionInterval.start
  );
  return {
    name: boundary.enzymeName,
    recognition_sequence: 'N'.repeat(recognitionLength),
    recognition_sequence_length: recognitionLength,
    cut_position_top: null,
    cut_position_bottom: null,
    overhang_type:
      boundary.overhang.kind === '5prime'
        ? '5_prime'
        : boundary.overhang.kind === '3prime'
          ? '3_prime'
          : 'blunt',
    overhang_length: boundary.overhang.length,
    enzyme_type: 'Type_II',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  };
}

export { positiveModulo };
