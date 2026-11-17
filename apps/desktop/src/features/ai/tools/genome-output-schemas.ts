import { QUANTITATIVE_COLOR_PALETTE_IDS } from '@waypoint/genome-data';
import { z } from 'zod';
import { entityNavigationTargetSchema } from '../../../shared/entity-navigation';
import { molecularDocumentReferenceSchema } from '../../../shared/molecular-document-reference';
const count = z.number().int().nonnegative();
const interval = z.object({ start0: count, end0: count });
export const indexedTrackOutputSchema = z.object({
  trackId: z.string(),
  trackType: z.string(),
  family: z.enum(['quantitative', 'reads', 'annotation']),
  order: z.number(),
  visible: z.boolean(),
  label: z.string(),
  color: z.string(),
  heightPx: z.number(),
  rowHeightPx: z.number().optional(),
  maxRows: count.optional(),
  source: z
    .object({
      uri: z.string().optional(),
      formatId: z.string().optional(),
      fingerprint: z.string().optional(),
      bamPath: z.string().optional(),
      indexPath: z.string().optional(),
      referencePath: z.string().optional(),
    })
    .optional(),
  coverageCutoffDepth: count.optional(),
  quantitative: z
    .object({
      version: z.literal(1),
      graph: z.enum(['bar', 'band', 'points']),
    palette: z.enum(QUANTITATIVE_COLOR_PALETTE_IDS).optional(),
      showRange: z.boolean(),
      smoothingSigmaBins: z.number().optional(),
      smoothing: z.enum(['none', 'gaussian-subtle']).optional(),
      scale: z.object({
        mode: z.enum(['robust-global', 'full-global', 'visible-window', 'fixed']),
        transform: z.enum(['linear', 'log1p']),
        min: z.number().optional(),
        max: z.number().optional(),
        groupId: z.string().optional(),
      }),
      sourceSummary: z
        .object({
          contract: z.literal('dnaforge.quantitative-source-summary.v1'),
          algorithm: z.literal('equal-genomic-bin-means-r7-quantiles-v1'),
          targetSampleCount: count,
          sampleCount: count,
          lowerQuantile: z.number(),
          upperQuantile: z.number(),
          robustMin: z.number(),
          robustMax: z.number(),
          fullMin: z.number(),
          fullMax: z.number(),
          missingData: z.literal('excluded'),
        })
        .optional(),
    })
    .optional(),
  composition: z
    .object({
      kind: z.literal('signal-read-pileup'),
      readsTrackId: z.string(),
      signalTrackId: z.string(),
    })
    .optional(),
});
const currentView = z.object({
  ok: z.literal(true),
  tabId: z.string(),
  sourcePath: z.string(),
  chrom: z.string(),
  assemblyId: z.string().optional(),
  scopeKind: z.enum(['all', 'chromosome', 'locus']),
  start0: count.optional(),
  end0: count.optional(),
  highlight: interval.optional(),
});
export const inspectIndexedCurrentViewOutputSchema = currentView.extend({
  tracks: z.array(indexedTrackOutputSchema),
});
export const setIndexedCurrentViewOutputSchema = currentView;
export const addIndexedBigWigUrlOutputSchema = z.object({
  ok: z.literal(true),
  tabId: z.string(),
  assemblyId: z.string(),
  trackId: z.string(),
  label: z.string(),
  url: z.string(),
  status: z.enum(['added', 'duplicate']),
  laneCount: count,
});
export const configureIndexedTrackOutputSchema = z.object({
  ok: z.literal(true),
  tabId: z.string(),
  track: indexedTrackOutputSchema,
});
export const composeIndexedTrackViewOutputSchema = z.object({
  ok: z.literal(true),
  tabId: z.string(),
  assemblyId: z.string(),
  name: z.string(),
  unsaved: z.literal(true),
  tracks: z.array(indexedTrackOutputSchema),
});
const outcomeIdentity = {
  index: count,
  label: z.string(),
  family: z.enum(['data', 'reads', 'variants']),
};
export const importGenomeSourcesOutputSchema = z.object({
  ok: z.literal(true),
  tabId: z.string(),
  assemblyId: z.string(),
  added: count,
  duplicates: count,
  failed: count,
  laneCount: count,
  outcomes: z.array(
    z.discriminatedUnion('status', [
      z.object({
        ...outcomeIdentity,
        status: z.literal('failed'),
        code: z.string(),
        message: z.string(),
      }),
      z.object({ ...outcomeIdentity, status: z.literal('added'), trackId: z.string() }),
      z.object({ ...outcomeIdentity, status: z.literal('duplicate'), trackId: z.string() }),
    ])
  ),
});
export const createReferenceOutputSchema = z.object({
  ok: z.literal(true),
  referenceId: z.string(),
  entityType: z.literal('molecular-document').optional(),
  documentReference: molecularDocumentReferenceSchema.optional(),
  inlineLink: z.string().optional(),
  reused: z.literal(true).optional(),
  target: entityNavigationTargetSchema.optional(),
  externalUrl: z.string().nullable().optional(),
  shellCommand: z.string().nullable().optional(),
  entityId: z.string().optional(),
  registryEntityId: z.string().optional(),
  primerId: z.string().nullable().optional(),
  workspaceRoot: z.string().nullable().optional(),
  localOnly: z.boolean().optional(),
});
const strand = z.enum(['+', '-']);
const segment = interval.extend({ strand });
const intervalShape = {
  ok: z.literal(true),
  interval: interval.extend({
    chrom: z.string(),
    strand,
    length: count,
    wraps: z.boolean().optional(),
  }),
  provenance: z.object({
    sourceId: z.string(),
    fastaPath: z.string().optional(),
    assemblyId: z.string().optional(),
    sourceFingerprint: z.string().optional(),
    chrom: z.string(),
    start0: count,
    end0: count,
    strand,
    chromosomeLength: count,
    requestedLength: count,
    sequenceFingerprint: z.string().optional(),
    wraps: z.boolean().optional(),
  }),
};
export const inspectReferenceIntervalOutputSchema = z.discriminatedUnion('operation', [
  z.object({ ...intervalShape, operation: z.literal('read'), sequence: z.string() }),
  z.object({ ...intervalShape, operation: z.literal('reverse_complement'), sequence: z.string() }),
  z.object({
    ...intervalShape,
    operation: z.literal('translate'),
    translations: z.array(
      z.object({
        strand,
        frame: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        protein: z.string(),
        codonCount: count,
        incompleteCodon: z.boolean(),
      })
    ),
  }),
  z.object({
    ...intervalShape,
    operation: z.literal('translate_spliced'),
    spliced: z.object({
      protein: z.string(),
      codingLength: count,
      frameOffset: count,
      incompleteCodon: z.boolean(),
      hadTrailingStop: z.boolean(),
      phaseSource: z.enum(['source', 'derived']),
      featureId: z.string().optional(),
      segments: z.array(segment),
    }),
  }),
  z.object({
    ...intervalShape,
    operation: z.literal('search'),
    searchMotif: z.string(),
    searchHits: z.array(
      z.object({ start: count, end: count, strand: z.enum(['forward', 'reverse']) })
    ),
    searchTruncated: z.boolean(),
  }),
  z.object({
    ...intervalShape,
    operation: z.literal('extract'),
    derived: z.object({
      sequence: z.string(),
      topology: z.enum(['linear', 'circular-origin-span']),
      wraps: z.boolean(),
    }),
  }),
]);
