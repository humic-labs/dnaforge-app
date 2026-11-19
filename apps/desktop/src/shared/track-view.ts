import { parseSequenceDataLayerIndexedTargetId } from './sequence-data-layer-indexed-target';
import { savedSequenceDataLayersSchema } from './saved-sequence-data-layers';
import { QUANTITATIVE_COLOR_PALETTE_IDS } from '@waypoint/genome-data';
import { comparisonProjectionViewStateSchema } from './comparison-source';
import { contactProjectionViewStateSchema } from './contact-source';
import { z } from 'zod';
import { isRemoteSshTarget } from './remote-ssh-target';
import { TRACK_VIEW_FILE_SUFFIX } from './registry-file-types';
import {
  createIndexedBbiTrackId,
  MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS,
  parsePortableGenomeViewReference,
  parseTrackAdmissionRequestV1,
  type AdmittedTrackSource,
  type PortableGenomeViewReference,
} from '@waypoint/genome-data';
import {
  isAlignedReadReferenceGeneration,
  isAlignedReadSourceGeneration,
  type AlignedReadReferenceGenerationV1,
  type AlignedReadSourceGenerationV1,
} from './aligned-read-source-generation';

export const TRACK_VIEW_SCHEMA_V2 = 'dnaforge.track-view.v2';
export const TRACK_VIEW_SCHEMA_V3 = 'dnaforge.track-view.v3';
export const TRACK_VIEW_SCHEMA = TRACK_VIEW_SCHEMA_V3;
export const TRACK_VIEW_SUFFIX = TRACK_VIEW_FILE_SUFFIX;
export const trackViewIdSchema = z.string().regex(/^track-view-[A-Za-z0-9-]{8,100}$/u);
const text = z.string().min(1).max(8192);
const integer = z.number().int().nonnegative().safe();
const positive = integer.positive();
const finite = z.number().finite();
const remoteAlignmentLocator = z
  .object({
    contract: z.literal('remote-alignment-locator.v1'),
    endpointId: text,
    target: text,
    alignmentPath: text,
    indexPath: text,
    signalPath: text.optional(),
    tileServerReceiptPath: text
      .refine(
        (path) => path.startsWith('/') && !path.includes('\0'),
        'Invalid remote tile server receipt path.'
      )
      .optional(),
  })
  .strict();
const remoteSignalLocator = z
  .object({
    contract: z.literal('remote-signal-locator.v1'),
    endpointId: text,
    target: text.refine(isRemoteSshTarget, 'Invalid SSH target.'),
    signalPath: text.refine(
      (path) => path.startsWith('/') && !path.includes('\0'),
      'Invalid SSH signal path.'
    ),
  })
  .strict();
const quantitativeSourceSummary = z
  .object({
    contract: z.literal('dnaforge.quantitative-source-summary.v1'),
    algorithm: z.literal('equal-genomic-bin-means-r7-quantiles-v1'),
    targetSampleCount: positive,
    sampleCount: positive,
    lowerQuantile: finite.min(0).max(1),
    upperQuantile: finite.min(0).max(1),
    robustMin: finite,
    robustMax: finite,
    fullMin: finite,
    fullMax: finite,
    missingData: z.literal('excluded'),
  })
  .strict()
  .refine(
    (summary) =>
      summary.lowerQuantile < summary.upperQuantile &&
      summary.robustMin <= summary.robustMax &&
      summary.fullMin <= summary.fullMax,
    'Invalid quantitative source summary range.'
  );
const quantitativeScaleBase = {
  transform: z.enum(['linear', 'log1p']),
  groupId: text.optional(),
};
const quantitativePresentation = z
  .object({
    version: z.literal(1),
    graph: z.enum(['bar', 'band', 'points']),
    palette: z.enum(QUANTITATIVE_COLOR_PALETTE_IDS).optional(),
    showRange: z.boolean(),
    smoothingSigmaBins: finite.min(0).max(MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS).optional(),
    smoothing: z.enum(['none', 'gaussian-subtle']).optional(),
    scale: z.union([
      z
        .object({
          ...quantitativeScaleBase,
          mode: z.enum(['robust-global', 'full-global', 'visible-window']),
        })
        .strict(),
      z
        .object({
          ...quantitativeScaleBase,
          mode: z.literal('fixed'),
          min: finite,
          max: finite,
        })
        .strict()
        .refine((scale) => scale.min < scale.max, 'Fixed scale minimum must be below maximum.'),
    ]),
  })
  .strict()
  .refine(
    (presentation) =>
      presentation.smoothingSigmaBins === undefined || presentation.smoothing === undefined,
    'Specify a quantitative smoothing sigma or the legacy mode, not both.'
  );
const variantFileGeneration = z
  .object({
    canonicalPath: text,
    size: integer,
    mtimeNs: z.string().regex(/^\d+$/u),
    ctimeNs: z.string().regex(/^\d+$/u),
    device: z.string().regex(/^\d+$/u).nullable().optional(),
    inode: z.string().regex(/^\d+$/u).nullable().optional(),
  })
  .strict();
const sourceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: text }).strict(),
  z.object({ kind: z.literal('url'), url: text }).strict(),
]);
const trackAdmissionRequest = z.unknown().transform((value, ctx) => {
  try {
    return parseTrackAdmissionRequestV1(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid track admission request.',
    });
    return z.NEVER;
  }
});
const admittedSource = z
  .object({
    uri: text,
    formatId: text,
    input: sourceInput.optional(),
    index: sourceInput.optional(),
    reference: sourceInput.optional(),
    recommendedTypes: z.array(text).optional(),
    admissionVersion: z.union([z.literal(1), z.literal(2)]),
    request: trackAdmissionRequest.optional(),
    admittedAt: z.string().datetime().optional(),
    fingerprint: text,
    readerKind: z.enum(['ucsc-rest', 'bbi', 'interval-text', 'bam', 'variant']),
    scientificKind: z.enum([
      'transcript',
      'interval',
      'quantitative',
      'peak',
      'repeat',
      'reads',
      'variants',
      'unsupported',
    ]),
    quantitativeColumnSemantics: z.enum(['continuous-signal', 'native-interval']).optional(),
    quantitativeSummary: quantitativeSourceSummary.optional(),
    publishedSignalScale: z
      .object({ minimum: z.number().finite(), maximum: z.number().finite() })
      .strict()
      .optional(),
    assemblyId: text,
    referenceReceipt: z
      .object({
        assemblyId: text,
        referenceSignature: text,
        sourceSignature: text,
        contigMap: z.record(z.string()),
        checkedContigs: integer,
        status: z.literal('compatible'),
        checkedAt: text,
      })
      .strict(),
    provenance: z
      .object({
        provider: text.optional(),
        catalogId: text.optional(),
        hubUrl: text.optional(),
        remoteUrl: text.optional(),
        track: text.optional(),
        sourceKind: text.optional(),
        ucscGenome: text.optional(),
        label: text.optional(),
        parentPath: z.array(text).optional(),
        devScenarioFixture: z.literal(true).optional(),
      })
      .strict(),
    expectedValidators: z
      .object({
        etag: text.optional(),
        lastModified: text.optional(),
        contentLength: integer.optional(),
      })
      .strict()
      .optional(),
    indexExpectedValidators: z
      .object({
        etag: text.optional(),
        lastModified: text.optional(),
        contentLength: integer.optional(),
      })
      .strict()
      .optional(),
    alignedReadGeneration: z
      .custom<AlignedReadSourceGenerationV1>(isAlignedReadSourceGeneration)
      .optional(),
    alignedReadReferenceGeneration: z
      .custom<AlignedReadReferenceGenerationV1>(isAlignedReadReferenceGeneration)
      .optional(),
    alignedReadIndexState: z.enum(['present', 'created']).optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (source.admissionVersion === 1) {
      if (source.request !== undefined || source.admittedAt !== undefined) {
        fail('A legacy admitted source cannot contain v2 admission fields.');
      }
      return;
    }
    if (!source.request || !source.admittedAt) {
      fail('A v2 admitted source requires its request and admission timestamp.');
      return;
    }
    if (source.request.assemblyId !== source.assemblyId) {
      fail('The admission request and admitted source use different assemblies.');
    }
    if (source.request.formatId && source.request.formatId !== source.formatId) {
      fail('The admission request and admitted source use different formats.');
    }
    if (source.request.scientificKind && source.request.scientificKind !== source.scientificKind) {
      fail('The admission request and admitted source use different scientific track kinds.');
    }
  })
  .transform((source): AdmittedTrackSource => source as AdmittedTrackSource);

const primerBindingSchema = z
  .object({
    id: text,
    primerId: text,
    primerName: text,
    primerBases: z.string().min(1).max(10_000),
    chrom: text,
    start0: integer,
    end0: positive,
    strand: z.enum(['+', '-']),
    source: z.enum(['created', 'attached']),
  })
  .strict();

const userAnnotationSchema = z
  .object({
    id: text,
    chrom: text,
    annotation: z
      .object({
        name: z.string().max(8192),
        type: text,
        start: positive,
        end: positive,
        direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
        color: z.string().max(64).optional(),
        label: z.string().max(8192).optional(),
        qualifiers: z.record(z.string(), z.array(z.string().max(65_536))).optional(),
        segments: z.array(z.object({ start: positive, end: positive }).strict()).optional(),
      })
      .strict(),
  })
  .strict();

const documentSchema = z
  .object({
    schema: z.enum([TRACK_VIEW_SCHEMA_V2, TRACK_VIEW_SCHEMA_V3]),
    kind: z.literal('track-view'),
    id: trackViewIdSchema,
    name: z.string().trim().min(1).max(200),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    creationRequest: z
      .object({ id: text, inputHash: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict()
      .optional(),
    portableReference: z
      .unknown()
      .transform((value, ctx): PortableGenomeViewReference => {
        try {
          return parsePortableGenomeViewReference(value);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              error instanceof Error ? error.message : 'Invalid portable reference identity.',
          });
          return z.NEVER;
        }
      })
      .optional(),
    reference: z
      .object({
        assemblyId: text,
        name: text,
        chromosomes: z
          .array(z.object({ chrom: text, length: positive }).strict())
          .min(1)
          .max(100_000),
        sourceFingerprint: z
          .string()
          .regex(/^[a-f0-9]{24}$/u)
          .nullable(),
        inventoryFingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        bundleFingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        sequenceIdentity: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        annotationIdentity: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
      })
      .strict(),
    viewport: z.object({ start0: integer, end0: positive }).strict(),
    contactProjection: contactProjectionViewStateSchema.optional(),
    sequenceDataLayers: savedSequenceDataLayersSchema.optional(),
    comparisonProjection: comparisonProjectionViewStateSchema.optional(),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all') }).strict(),
      z.object({ kind: z.literal('chromosome'), chrom: text }).strict(),
      z.object({ kind: z.literal('locus'), chrom: text, start: integer, end: positive }).strict(),
    ]),
    annotation: z
      .object({
        policy: z
          .object({
            isoformMode: z.enum(['canonical', 'expanded']),
            laneLimit: positive.nullable(),
          })
          .strict(),
        orderedTrackIds: z.array(text).max(256),
        visibilityByTrackId: z.record(z.boolean()),
      })
      .strict(),
    dataTracks: z
      .array(
        z
          .object({
            trackId: text,
            trackType: text,
            label: text,
            order: integer.optional(),
            color: integer.max(0xffffff),
            trackPx: positive,
            laneHeightPx: positive,
            maxLanes: positive,
            visible: z.boolean(),
            quantitativePresentation: quantitativePresentation.optional(),
            source: admittedSource,
            remoteSignal: remoteSignalLocator.optional(),
          })
          .strict()
      )
      .max(256),
    bamTracks: z
      .array(
        z
          .object({
            trackId: text,
            label: text,
            order: integer.optional(),
            visible: z.boolean(),
            color: integer.max(0xffffff).optional(),
            trackPx: positive.optional(),
            laneHeightPx: positive.optional(),
            maxLanes: positive.optional(),
            coverageCutoffDepth: z.number().finite().nonnegative(),
            source: z
              .object({
                bamPath: text,
                indexPath: text,
                referencePath: text.optional(),
                generation: z
                  .custom<AlignedReadSourceGenerationV1>(isAlignedReadSourceGeneration)
                  .optional(),
                remote: remoteAlignmentLocator.optional(),
              })
              .strict(),
            admittedSource: admittedSource.optional(),
          })
          .strict()
      )
      .max(256),
    signalReadPileupViews: z
      .array(
        z
          .object({
            contract: z.literal('dnaforge.signal-read-pileup-view.v1'),
            trackId: text,
            readsTrackId: text,
            signalTrackId: text,
            label: z.string().trim().min(1).max(200),
            order: integer.optional(),
            visible: z.boolean(),
            color: integer.max(0xffffff),
            trackPx: positive.max(2_048),
            laneHeightPx: positive.max(128),
            maxLanes: positive.max(1_000),
            overflowBandHeightPx: positive.max(2_048),
            coverageCutoffDepth: positive.max(1_000_000_000),
            loadingAnimation: z.literal('diagonal-scan'),
          })
          .strict()
      )
      .max(256)
      .optional(),
    variantSource: z
      .object({
        sourcePath: text,
        queryPath: text,
        indexPath: text,
        format: z.enum(['vcf', 'bcf']),
        label: text,
        sourceSizeBytes: integer,
        sourceMtimeNs: z.string().regex(/^\d+$/u).optional(),
        sourceIdentity: text,
        sourceGeneration: variantFileGeneration.optional(),
        queryGeneration: variantFileGeneration.optional(),
        indexGeneration: variantFileGeneration.optional(),
        assemblyRevision: z
          .string()
          .regex(/^variant-assembly-v1:sha256:[0-9a-f]{64}$/u)
          .optional(),
        admittedSource: admittedSource.optional(),
        matchedReferences: z.array(text),
        samples: z.array(text),
        attachedAt: integer,
      })
      .strict()
      .optional(),
    primerBindings: z.array(primerBindingSchema).max(100_000).optional(),
    userAnnotations: z.array(userAnnotationSchema).max(100_000).optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const portableReference = doc.portableReference;
    if (portableReference) {
      if (portableReference.assemblyId !== doc.reference.assemblyId) {
        fail('The portable and managed reference identities use different assemblies.');
      }
      if (portableReference.kind === 'hosted-reference') {
        if (
          portableReference.bundleFingerprint !== doc.reference.bundleFingerprint ||
          portableReference.sourceFingerprint !== doc.reference.sourceFingerprint ||
          portableReference.inventoryFingerprint !== doc.reference.inventoryFingerprint ||
          (doc.reference.sequenceIdentity &&
            portableReference.sequenceIdentity !== doc.reference.sequenceIdentity) ||
          (doc.reference.annotationIdentity &&
            portableReference.annotationIdentity !== doc.reference.annotationIdentity)
        ) {
          fail('The portable and managed hosted reference fingerprints conflict.');
        }
      }
    }
    if (
      (doc.reference.sequenceIdentity === undefined) !==
      (doc.reference.annotationIdentity === undefined)
    ) {
      fail('A reference requires both sequence and annotation identities.');
    }
    if (
      doc.schema === TRACK_VIEW_SCHEMA_V2 &&
      ((doc.primerBindings?.length ?? 0) > 0 || (doc.userAnnotations?.length ?? 0) > 0)
    ) {
      fail('Primer bindings and user annotations require a v3 Track view.');
    }
    const chromosomeLengths = new Map(
      doc.reference.chromosomes.map((chromosome) => [chromosome.chrom, chromosome.length])
    );
    if (doc.sequenceDataLayers) {
      try {
        const target = parseSequenceDataLayerIndexedTargetId(
          doc.sequenceDataLayers.targetDocumentId
        );
        if (
          !target ||
          target.referenceId !== doc.reference.assemblyId ||
          !chromosomeLengths.has(target.chrom) ||
          (doc.reference.sequenceIdentity !== undefined &&
            (target.sequenceIdentity !== doc.reference.sequenceIdentity ||
              target.annotationIdentity !== doc.reference.annotationIdentity))
        )
          fail('The saved data layers do not match this reference version.');
      } catch {
        fail('The saved data layers need an exact indexed reference target.');
      }
    }
    if (doc.contactProjection && doc.comparisonProjection)
      fail('A saved view can use only one native coordinate projection at a time.');
    if (doc.comparisonProjection) {
      const axis = doc.comparisonProjection.source.targetReference;
      if (chromosomeLengths.get(axis.chrom) !== axis.length)
        fail('The comparison target does not match the saved reference accession and length.');
    }
    if (doc.contactProjection) {
      const axis = doc.contactProjection.source.xReference;
      if (chromosomeLengths.get(axis.chrom) !== axis.length)
        fail('The contact X axis does not match the saved reference accession and length.');
    }
    for (const binding of doc.primerBindings ?? []) {
      const length = chromosomeLengths.get(binding.chrom);
      if (length === undefined || binding.start0 >= binding.end0 || binding.end0 > length) {
        fail(`Primer binding ${binding.primerName} is outside its reference chromosome.`);
      }
    }
    for (const entry of doc.userAnnotations ?? []) {
      const length = chromosomeLengths.get(entry.chrom);
      if (
        length === undefined ||
        entry.annotation.start > entry.annotation.end ||
        entry.annotation.end > length
      ) {
        fail(`Annotation ${entry.annotation.name} is outside its reference chromosome.`);
      }
    }
    const total = doc.reference.chromosomes.reduce((sum, chromosome) => sum + chromosome.length, 0);
    if (
      doc.viewport.start0 >= doc.viewport.end0 ||
      doc.viewport.end0 > total ||
      !Number.isSafeInteger(total)
    ) {
      fail('Track view location is outside its reference.');
    }
    const chromosomes = new Map(
      doc.reference.chromosomes.map((chromosome) => [chromosome.chrom, chromosome.length])
    );
    if (chromosomes.size !== doc.reference.chromosomes.length)
      fail('Duplicate reference chromosomes.');
    if (doc.scope.kind !== 'all') {
      const length = chromosomes.get(doc.scope.chrom);
      if (
        !length ||
        (doc.scope.kind === 'locus' && (doc.scope.start >= doc.scope.end || doc.scope.end > length))
      )
        fail('Invalid reference scope.');
    }
    const ids = [...doc.dataTracks, ...doc.bamTracks, ...(doc.signalReadPileupViews ?? [])].map(
      (track) => track.trackId
    );
    if (new Set(ids).size !== ids.length) fail('Duplicate saved track identities.');
    const bamById = new Map(doc.bamTracks.map((track) => [track.trackId, track] as const));
    const bamIds = new Set(bamById.keys());
    const quantitativeIds = new Set(
      doc.dataTracks
        .filter(
          (track) =>
            track.source.formatId === 'bigwig' && track.source.scientificKind === 'quantitative'
        )
        .map((track) => track.trackId)
    );
    const signalReadSourcePairs = new Set<string>();
    for (const view of doc.signalReadPileupViews ?? []) {
      const sourcePair = `${view.readsTrackId}\u0000${view.signalTrackId}`;
      if (signalReadSourcePairs.has(sourcePair)) {
        fail('Duplicate signal-to-reads source pair.');
      }
      signalReadSourcePairs.add(sourcePair);
      if (!bamIds.has(view.readsTrackId)) {
        fail(`Signal-to-reads view ${view.label} names a missing read track.`);
      }
      const readsTrack = bamById.get(view.readsTrackId);
      const remote = readsTrack?.source.remote;
      const expectedRemoteSignalTrackId = remote?.signalPath
        ? createIndexedBbiTrackId({
            assemblyId: doc.reference.assemblyId,
            source: {
              kind: 'url',
              url: `ssh://${remote.target}${remote.signalPath}`,
            },
          })
        : null;
      if (
        !quantitativeIds.has(view.signalTrackId) &&
        view.signalTrackId !== expectedRemoteSignalTrackId
      ) {
        fail(`Signal-to-reads view ${view.label} names a missing quantitative signal track.`);
      }
    }
    for (const track of doc.dataTracks) {
      if (track.remoteSignal) {
        const uri = `ssh://${track.remoteSignal.target}${track.remoteSignal.signalPath}`;
        if (
          track.source.admissionVersion !== 1 ||
          track.source.readerKind !== 'bbi' ||
          track.source.formatId !== 'bigwig' ||
          track.source.scientificKind !== 'quantitative' ||
          track.source.uri !== uri ||
          track.source.input?.kind !== 'url' ||
          track.source.input.url !== uri ||
          track.source.fingerprint !== ['remote-signal', uri].join('\0') ||
          track.source.index ||
          track.source.reference ||
          track.source.alignedReadGeneration ||
          track.source.alignedReadReferenceGeneration ||
          track.source.provenance.remoteUrl
        ) {
          fail(`Track ${track.label} has an invalid durable SSH signal source.`);
        }
      } else if (track.source.uri.startsWith('ssh://')) {
        fail(`Track ${track.label} is missing its durable SSH signal locator.`);
      }
      if (
        track.source.assemblyId !== doc.reference.assemblyId ||
        track.source.referenceReceipt.assemblyId !== doc.reference.assemblyId
      ) {
        fail(`Track ${track.label} belongs to a different reference.`);
      }
      if (track.quantitativePresentation && track.source.scientificKind !== 'quantitative') {
        fail(`Track ${track.label} has quantitative settings but is not quantitative.`);
      }
      if (
        track.quantitativePresentation?.scale.transform === 'log1p' &&
        track.source.quantitativeSummary &&
        track.source.quantitativeSummary.fullMin < 0
      ) {
        fail(`Track ${track.label} contains negative values and cannot use log scaling.`);
      }
    }
    const variantSource = doc.variantSource;
    if (variantSource) {
      const admittedReceipt = variantSource.admittedSource;
      const localReceipt =
        admittedReceipt !== undefined &&
        (admittedReceipt.request?.source.kind === 'local-file' ||
          admittedReceipt.input?.kind === 'path');
      const remoteReceipt = localReceipt ? undefined : admittedReceipt;
      if (admittedReceipt && localReceipt) {
        if (
          admittedReceipt.readerKind !== 'variant' ||
          admittedReceipt.scientificKind !== 'variants' ||
          admittedReceipt.assemblyId !== doc.reference.assemblyId ||
          admittedReceipt.formatId !== variantSource.format ||
          admittedReceipt.input?.kind !== 'path' ||
          admittedReceipt.input.path !== variantSource.sourcePath ||
          admittedReceipt.index !== undefined ||
          admittedReceipt.expectedValidators?.contentLength !== variantSource.sourceSizeBytes
        ) {
          fail('A saved local variant receipt does not match its source or reference.');
        }
      }
      const receiptValues = [
        variantSource.sourceGeneration,
        variantSource.queryGeneration,
        variantSource.indexGeneration,
        variantSource.assemblyRevision,
      ];
      const receiptCount = receiptValues.filter((value) => value !== undefined).length;
      if (remoteReceipt) {
        const htsgetReceipt = remoteReceipt.request?.source.kind === 'htsget';
        const commonReceiptMismatch =
          remoteReceipt.readerKind !== 'variant' ||
          remoteReceipt.scientificKind !== 'variants' ||
          remoteReceipt.assemblyId !== doc.reference.assemblyId ||
          remoteReceipt.formatId !== variantSource.format;
        if (commonReceiptMismatch) {
          fail('A saved network variant receipt does not match its source or reference.');
        } else if (htsgetReceipt) {
          const identity = variantSource.sourceIdentity;
          const durableSourcePath = `htsget-source://${identity}/source.${variantSource.format}`;
          if (
            remoteReceipt.request?.source.kind !== 'htsget' ||
            remoteReceipt.request.source.dataClass !== 'variants' ||
            remoteReceipt.request.source.format?.toLowerCase() !== variantSource.format ||
            remoteReceipt.uri !== `htsget:${identity}` ||
            remoteReceipt.input !== undefined ||
            remoteReceipt.index !== undefined ||
            variantSource.sourcePath !== durableSourcePath ||
            variantSource.queryPath !== durableSourcePath ||
            variantSource.indexPath !== `htsget-source://${identity}/regional-index` ||
            variantSource.sourceSizeBytes !== 0
          ) {
            fail('A saved htsget variant receipt does not match its endpoint-backed source.');
          }
        } else if (
          remoteReceipt.input?.kind !== 'url' ||
          remoteReceipt.input.url !== variantSource.sourcePath ||
          remoteReceipt.index?.kind !== 'url' ||
          remoteReceipt.index.url !== variantSource.indexPath ||
          remoteReceipt.expectedValidators?.contentLength !== variantSource.sourceSizeBytes
        ) {
          fail('A saved remote variant receipt does not match its source or reference.');
        }
        if (
          (!htsgetReceipt && variantSource.queryPath !== variantSource.sourcePath) ||
          variantSource.sourceMtimeNs !== undefined ||
          receiptCount !== 1
        ) {
          fail('A saved remote variant source cannot contain local file receipts.');
        }
      } else if (variantSource.sourceMtimeNs === undefined) {
        fail('A saved local variant source requires its modification-time receipt.');
      }
      if (receiptCount !== 0 && receiptCount !== receiptValues.length) {
        if (!remoteReceipt || receiptCount !== 1 || variantSource.assemblyRevision === undefined) {
          fail('A saved variant source must contain every file and assembly receipt.');
        }
      }
      if (
        !remoteReceipt &&
        receiptCount === receiptValues.length &&
        (variantSource.sourceGeneration?.canonicalPath !== variantSource.sourcePath ||
          variantSource.queryGeneration?.canonicalPath !== variantSource.queryPath ||
          variantSource.indexGeneration?.canonicalPath !== variantSource.indexPath ||
          variantSource.sourceGeneration?.size !== variantSource.sourceSizeBytes ||
          variantSource.sourceGeneration?.mtimeNs !== variantSource.sourceMtimeNs)
      ) {
        fail('A saved variant source receipt does not match its paths or source identity.');
      }
    }
  });

export type TrackViewDocument = z.infer<typeof documentSchema>;
export interface SavedTrackView {
  reconciliation?: 'merged' | 'saved-copy';
  warning?: string;
  document: TrackViewDocument;
  revision: string;
  path: string;
  workspaceRoot?: string;
}
export interface TrackViewList {
  views: SavedTrackView[];
  errors: Array<{ name: string; message: string }>;
}
export interface SaveTrackViewRequest {
  baseDocument?: TrackViewDocument;
  document: unknown;
  expectedRevision: string | null;
  destination?: { workspaceRoot: string; path: string };
}
export interface TrackViewsBridge {
  locations(): Promise<{ defaultDirectory: string; homeDirectory: string }>;
  list(): Promise<TrackViewList>;
  read(id: string): Promise<SavedTrackView>;
  save(request: SaveTrackViewRequest): Promise<SavedTrackView>;
}

export function validateTrackViewDocument(value: unknown): TrackViewDocument {
  if (
    value &&
    typeof value === 'object' &&
    'schema' in value &&
    (value.schema === 'dnaforge.track-view.v1' || value.schema === TRACK_VIEW_SCHEMA_V2)
  ) {
    if (value.schema === TRACK_VIEW_SCHEMA_V2) documentSchema.parse(value);
    return documentSchema.parse({ ...value, schema: TRACK_VIEW_SCHEMA });
  }
  return documentSchema.parse(value);
}

export function parseTrackViewDocument(bytes: string): TrackViewDocument {
  if (new TextEncoder().encode(bytes).length > 4 * 1024 * 1024)
    throw new Error('Track view file is too large.');
  return validateTrackViewDocument(JSON.parse(bytes));
}

export function serializeTrackViewDocument(value: unknown): string {
  const bytes = `${JSON.stringify(validateTrackViewDocument(value), null, 2)}\n`;
  if (new TextEncoder().encode(bytes).length > 4 * 1024 * 1024)
    throw new Error('Track view file is too large.');
  return bytes;
}
