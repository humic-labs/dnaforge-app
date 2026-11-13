import {
  assemblyAccession,
  isFeatureKind,
  parseGff3Track,
  sourceId,
  type AnnotationEvidenceClass,
  type AnnotationSourceDefinition,
  type FeatureKind,
  type SourceAvailability,
} from '@waypoint/genome-data/annotation-catalog';

import type { TrackFileText, TrackListing, TrackMeta, TrackRef } from '../../../shared/track-store';

export interface StoreTrackReader {
  readTrackFile(ref: TrackRef): Promise<TrackFileText>;
}

export interface StoreTrackSourceResult {
  readonly definition: AnnotationSourceDefinition | null;
  readonly problem: string | null;
}

function evidenceClass(value: string): AnnotationEvidenceClass | null {
  return value === 'curated' || value === 'measured' || value === 'computed' ? value : null;
}

function drawableKinds(meta: TrackMeta): FeatureKind[] {
  return meta.kinds.filter((kind): kind is FeatureKind => isFeatureKind(kind));
}

export function defineStoreTrackSource(
  listing: TrackListing,
  reader: StoreTrackReader
): StoreTrackSourceResult {
  const { meta } = listing;
  if (!meta) {
    return {
      definition: null,
      problem: `${listing.track}: ${listing.problems.join(' ') || 'no readable version'}`,
    };
  }
  const [firstKind, ...otherKinds] = drawableKinds(meta);
  if (!firstKind) {
    return {
      definition: null,
      problem: `${listing.track}: meta.json declares kinds [${meta.kinds.join(', ')}], none of which the sequence viewer draws`,
    };
  }
  const evidence = evidenceClass(meta.evidence);
  const availability: SourceAvailability = !evidence
    ? {
        status: 'unavailable',
        reason: `meta.json says evidence is "${meta.evidence}"; it must be curated, measured or computed`,
      }
    : listing.problems.length > 0
      ? { status: 'unavailable', reason: listing.problems.join(' ') }
      : { status: 'available' };
  const kinds: [FeatureKind, ...FeatureKind[]] = [firstKind, ...otherKinds];
  const ref: TrackRef = { accession: listing.accession, track: listing.track };

  return {
    problem: null,
    definition: {
      id: sourceId(listing.track),
      label: meta.label,
      kinds,
      assembly: assemblyAccession(meta.assembly.accession),
      evidence: evidence ?? 'measured',
      availability,
      derivedFrom: [],
      provenance: {
        citation: meta.citation ?? null,
        url: meta.url ?? null,
        doi: meta.doi ?? null,
        datasetVersion: meta.datasetVersion ?? null,
        liftedFrom: meta.liftedFrom ?? null,
        license: {
          spdx: meta.license.spdx ?? null,
          attribution: meta.license.attribution,
          evidenceUrl: meta.license.evidenceUrl ?? null,
        },
      },
      load: async (context) => {
        if (availability.status === 'unavailable') {
          throw new Error(`${meta.label} is unavailable: ${availability.reason}`);
        }
        const file = await reader.readTrackFile(ref);
        if (file.meta.file.format !== 'gff3') {
          throw new Error(
            `${meta.label} is a ${file.meta.file.format} file; the sequence viewer reads GFF3 tracks`
          );
        }
        const { records, rejected } = parseGff3Track({
          text: file.text,
          track: listing.track,
          assembly: context.assembly,
          aliases: file.meta.assembly.aliases,
          kinds,
        });
        if (rejected.count > 0) {
          throw new Error(
            `${meta.label}: ${rejected.count} invalid row(s) in ${file.meta.file.name}, e.g. ${rejected.examples.slice(0, 3).join('; ')}`
          );
        }
        return records;
      },
    },
  };
}
