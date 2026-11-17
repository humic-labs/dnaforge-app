import { z } from 'zod';
import {
  prepareSequenceDataLayer,
  resolveGenomicMarkup,
  type GenomicMarkupDataset,
  type GenomicMarkupStyle,
  type PrepareSequenceDataLayerResult,
  type SequenceDataLayerAnnotation,
  type SequenceDataLayerMapping,
  type SequenceDataLayerMappingReport,
  type SequenceDataLayerTarget,
} from '@waypoint/genome-data';
import { canonicalJson } from './canonical-json';
import { HEX_COLOR_PATTERN } from './published-schema-patterns';

export const SEQUENCE_DATA_LAYER_SCHEMA = 'dnaforge.sequence-data-layer.v1' as const;
export const SEQUENCE_DATA_LAYERS_CHANGED = 'dnaforge:sequence-data-layers-changed' as const;
export const SEQUENCE_DATA_LAYER_SUFFIX = '.dnalayer.json' as const;
export const SEQUENCE_DATA_LAYER_DIRECTORY = '.dnaforge/sequence-data-layers' as const;
export const MAX_SEQUENCE_DATA_LAYER_CSV_BYTES = 1_048_576;
export const MAX_SEQUENCE_DATA_LAYER_DOCUMENT_BYTES = 16 * 1_048_576;

const text = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const annotationDigest = z
  .string()
  .regex(/^annotation-(?:mapping|document)-v1:sha256:[a-f0-9]{64}$/u);
export const sequenceDataLayerIdSchema = z.string().regex(/^layer-[a-f0-9]{64}$/u);
const hex = z.string().regex(HEX_COLOR_PATTERN);
const finite = z.number().finite();
const scaleSchema = z
  .object({
    kind: z.literal('continuous'),
    domain: z.tuple([finite, finite]),
    colors: z.array(hex).min(2).max(32),
    missingColor: hex,
    transform: z.enum(['linear', 'log10']),
    quantization: z.number().int().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((scale, context) => {
    if (
      scale.domain[0] >= scale.domain[1] ||
      (scale.transform === 'log10' && scale.domain[0] <= 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose an increasing valid color domain.',
      });
    }
  });
const styleSchema = z
  .object({
    geometry: z.enum(['bars', 'band', 'points', 'arcs']),
    colorScale: scaleSchema,
  })
  .strict();
export const sequenceDataLayerPresentationSchema = z
  .object({
    sampleId: text,
    style: styleSchema,
    annotationColors: z.boolean(),
    signalVisible: z.boolean(),
  })
  .strict();
const mappingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('positions'),
      startColumn: text,
      endColumn: text.optional(),
      coordinateSystem: z.enum(['zero-based-half-open', 'one-based-inclusive']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('annotation'),
      identifierColumn: text,
      identifierField: z.enum(['id', 'locus_tag', 'ID']),
    })
    .strict(),
]);
const targetSchema = z
  .object({
    documentId: text,
    sequenceFingerprint: digest,
    annotationFingerprint: annotationDigest.optional(),
    length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const annotationSchema = z
  .object({
    id: text,
    start0: z.number().int().nonnegative(),
    end0: z.number().int().positive(),
    qualifiers: z.record(z.array(z.string())).optional(),
  })
  .strict();
const sourceReferenceSchema = z
  .object({
    project: z.string().min(1).max(4096),
    id: sequenceDataLayerIdSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const sourceSchema = z
  .object({
    kind: z.literal('csv-snapshot'),
    csv: z.string().min(1).max(MAX_SEQUENCE_DATA_LAYER_CSV_BYTES),
    sha256: digest,
    origin: sourceReferenceSchema.optional(),
  })
  .strict();

export const sequenceDataLayerCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      project: z.string().min(1).max(4096),
      requestId: text,
      targetDocumentId: text,
      expectedSequenceFingerprint: digest,
      expectedAnnotationFingerprint: annotationDigest.optional(),
      csv: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('text'),
            text: z.string().min(1).max(MAX_SEQUENCE_DATA_LAYER_CSV_BYTES),
          })
          .strict(),
        z.object({ kind: z.literal('path'), path: z.string().min(1).max(4096) }).strict(),
        z.object({ kind: z.literal('layer'), source: sourceReferenceSchema }).strict(),
      ]),
      mapping: mappingSchema,
      valueColumns: z.array(text).min(1).max(32),
      label: text,
      unit: z.string().trim().min(1).max(128),
      unresolvedPolicy: z.enum(['reject', 'exclude']),
      aggregation: z.enum(['none', 'mean']),
      presentation: sequenceDataLayerPresentationSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('inspect'),
      project: z.string().min(1).max(4096),
      id: sequenceDataLayerIdSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('list'),
      project: z.string().min(1).max(4096),
      targetDocumentId: text.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('target'),
      project: z.string().min(1).max(4096),
      targetDocumentId: text,
    })
    .strict(),
]);

export type SequenceDataLayerCommand = z.infer<typeof sequenceDataLayerCommandSchema>;
export type SequenceDataLayerCreateRequest = Extract<
  SequenceDataLayerCommand,
  { operation: 'create' }
>;
export type SequenceDataLayerPresentation = z.infer<typeof sequenceDataLayerPresentationSchema>;
export interface SequenceDataLayerViewSelection {
  project: string;
  layerId: string | null;
  visibleLayerIds?: readonly string[];
  presentationByLayerId?: Readonly<Record<string, SequenceDataLayerPresentation>>;
}

export interface SequenceDataLayerTargetSnapshot extends SequenceDataLayerTarget {
  readonly annotations?: readonly SequenceDataLayerAnnotation[];
}
export interface SequenceDataLayerDocument {
  readonly schema: typeof SEQUENCE_DATA_LAYER_SCHEMA;
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly createdAt: string;
  readonly target: SequenceDataLayerTarget;
  readonly annotations: readonly SequenceDataLayerAnnotation[];
  readonly source: z.infer<typeof sourceSchema>;
  readonly mapping: SequenceDataLayerMapping;
  readonly valueColumns: readonly string[];
  readonly unresolvedPolicy: 'reject' | 'exclude';
  readonly aggregation: 'none' | 'mean';
  readonly dataset: GenomicMarkupDataset;
  readonly report: SequenceDataLayerMappingReport;
  readonly annotationAggregation: 'none' | 'mean';
  readonly presentation: SequenceDataLayerPresentation;
  readonly creationRequest: {
    readonly id: string;
    readonly inputHash: string;
    readonly requestedPresentation: SequenceDataLayerPresentation | null;
  };
}
export type SequenceDataLayerAvailability =
  | { readonly status: 'current' }
  | { readonly status: 'stale'; readonly reason: 'sequence-changed' | 'annotations-changed' }
  | { readonly status: 'unavailable'; readonly reason: string };
export interface PublishedSequenceDataLayer {
  readonly status: 'published';
  readonly project?: string;
  readonly document: SequenceDataLayerDocument;
  readonly path: string;
  readonly revision: string;
  readonly availability: SequenceDataLayerAvailability;
  readonly alreadyPublished: boolean;
  readonly warning?: string;
}
export interface SequenceDataLayerNeedsInput {
  readonly status: 'needs-input';
  readonly target: SequenceDataLayerTarget;
  readonly prepared: PrepareSequenceDataLayerResult;
}
export interface SequenceDataLayerFailure {
  readonly status: 'failed';
  readonly disposition: 'not-published' | 'publication-uncertain';
  readonly message: string;
  readonly requestId?: string;
  readonly id?: string;
}
export type SequenceDataLayerCommandResult =
  | PublishedSequenceDataLayer
  | SequenceDataLayerNeedsInput
  | SequenceDataLayerFailure
  | {
      readonly status: 'listed';
      readonly layers: readonly PublishedSequenceDataLayer[];
      readonly errors: readonly { id: string; message: string }[];
    }
  | {
      readonly status: 'target';
      readonly target: SequenceDataLayerTarget;
      readonly annotationIdentifiers: readonly {
        field: 'id' | 'locus_tag' | 'ID';
        count: number;
        distinct: number;
      }[];
    };

const documentSchema = z
  .object({
    schema: z.literal(SEQUENCE_DATA_LAYER_SCHEMA),
    id: sequenceDataLayerIdSchema,
    label: text,
    unit: z.string().trim().min(1).max(128),
    createdAt: z.string().datetime(),
    target: targetSchema,
    annotations: z.array(annotationSchema).max(100_000),
    source: sourceSchema,
    mapping: mappingSchema,
    valueColumns: z.array(text).min(1).max(32),
    unresolvedPolicy: z.enum(['reject', 'exclude']),
    aggregation: z.enum(['none', 'mean']),
    dataset: z.unknown(),
    report: z.unknown(),
    annotationAggregation: z.enum(['none', 'mean']),
    presentation: sequenceDataLayerPresentationSchema,
    creationRequest: z
      .object({
        id: text,
        inputHash: digest,
        requestedPresentation: sequenceDataLayerPresentationSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export function validateSequenceDataLayerDocument(input: unknown): SequenceDataLayerDocument {
  const document = documentSchema.parse(input);
  if (
    new TextEncoder().encode(document.source.csv).byteLength > MAX_SEQUENCE_DATA_LAYER_CSV_BYTES
  ) {
    throw new Error('The retained CSV exceeds the bounded layer import size.');
  }
  const prepared = prepareSequenceDataLayer({
    datasetId: document.id,
    label: document.label,
    unit: document.unit,
    csv: document.source.csv,
    target: document.target,
    mapping: document.mapping,
    valueColumns: document.valueColumns,
    annotations: document.annotations,
    unresolvedPolicy: document.unresolvedPolicy,
    aggregation: document.aggregation,
  });
  if (
    !prepared.publishable ||
    canonicalJson(prepared.dataset) !== canonicalJson(document.dataset) ||
    canonicalJson(prepared.report) !== canonicalJson(document.report) ||
    prepared.annotationAggregation !== document.annotationAggregation
  ) {
    throw new Error('The layer data does not match its retained dataset and mapping.');
  }
  resolveGenomicMarkup({
    dataset: prepared.dataset,
    sampleId: document.presentation.sampleId,
    window: {
      reference: prepared.dataset.reference,
      start: 0,
      end: prepared.dataset.reference.length,
    },
    style: document.presentation.style as GenomicMarkupStyle,
    ...(prepared.annotationAggregation === 'mean'
      ? { annotationAggregation: 'mean' as const }
      : {}),
  });
  return { ...document, dataset: prepared.dataset, report: prepared.report };
}

export function parseSequenceDataLayerDocument(content: string): SequenceDataLayerDocument {
  return validateSequenceDataLayerDocument(JSON.parse(content));
}

export function serializeSequenceDataLayerDocument(document: SequenceDataLayerDocument): string {
  return canonicalJson(validateSequenceDataLayerDocument(document)) + '\n';
}

export function sequenceDataLayerInputIdentity(
  input: Pick<
    SequenceDataLayerDocument,
    'label' | 'unit' | 'target' | 'mapping' | 'valueColumns' | 'unresolvedPolicy' | 'aggregation'
  > & {
    readonly sourceSha256: string;
    readonly sourceOrigin?: z.infer<typeof sourceReferenceSchema>;
    readonly requestedPresentation: SequenceDataLayerPresentation | null;
  }
): string {
  return canonicalJson(input);
}
