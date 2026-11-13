import { z } from 'zod';

const count = z.number().int().nonnegative();
const coordinateRange = z.object({ start: z.number(), end: z.number() }).strict();
const direction = z.enum(['forward', 'reverse', 'none']);
const format = z.enum(['genbank', 'fasta', 'gff3']);
const resource = { documentId: z.string(), resourceUri: z.string() };
const success = { ok: z.literal(true) };
const geneticCodeBasis = z.enum(['default', 'declared', 'declared-mixed', 'chosen']);
const codonMeaning = z.union([
  z
    .object({
      kind: z.literal('amino-acid'),
      letter: z.enum([
        'A',
        'C',
        'G',
        'T',
        'U',
        'N',
        'D',
        'E',
        'F',
        'H',
        'I',
        'K',
        'L',
        'M',
        'P',
        'Q',
        'R',
        'S',
        'V',
        'W',
        'Y',
        'O',
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('stop') }).strict(),
  z.object({ kind: z.literal('residue'), residue: z.string() }).strict(),
  z.object({ kind: z.literal('unassigned') }).strict(),
]);
const customGeneticCode = z
  .object({
    id: z.string(),
    revision: z.number(),
    name: z.string(),
    codons: z.record(z.string(), codonMeaning),
    startCodons: z.array(z.string()),
    residues: z.array(
      z.object({ abbreviation: z.string(), name: z.string(), ccd: z.string().optional() }).strict()
    ),
  })
  .strict();
const geneticCodeSpec = z.union([z.number(), customGeneticCode]);

export const getSequenceGeneticCodeOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    geneticCode: geneticCodeSpec,
    label: z.string(),
    basis: geneticCodeBasis,
    basisExplanation: z.string(),
    mixed: z.boolean(),
    declaredByFeatures: z.array(
      z.object({ geneticCode: z.number(), label: z.string(), codingFeatures: count }).strict()
    ),
    needsUserChoice: z.boolean(),
    organelle: z.string().optional(),
    publishedGeneticCodes: z.array(z.object({ id: z.number(), name: z.string() }).strict()),
    note: z.string(),
  })
  .strict();
export const setSequenceGeneticCodeOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    geneticCode: z.number().nullable(),
    label: z.string().nullable(),
    resolvedGeneticCode: geneticCodeSpec,
    resolvedLabel: z.string(),
    basis: geneticCodeBasis,
    featuresStillReadingByTheirOwnCode: z.array(z.string()),
    savedToFile: z.boolean(),
  })
  .strict();

const sequenceFeature = z
  .object({ name: z.string(), type: z.string(), start: z.number(), end: z.number(), direction })
  .strict();
const foundFeature = sequenceFeature.extend({
  segments: z.array(coordinateRange).optional(),
  exons: z.array(coordinateRange).optional(),
  cds: z.array(coordinateRange).optional(),
  transcriptId: z.string().optional(),
});
export const findFeaturesOutputSchema = z
  .object({
    coordinateSystem: z.literal('one_based_inclusive'),
    ...success,
    ...resource,
    matchCount: count,
    features: z.array(foundFeature),
    returnedRange: z.object({ offset: count, count }).strict().optional(),
    nextOffset: count.optional(),
  })
  .strict();


export const getSequenceOutputSchema = z.union([
  z.object({ ...success, ...resource, exists: z.literal(false), error: z.string() }).strict(),
  z
    .object({
      ...success,
      ...resource,
      exists: z.literal(true),
      coordinateSystem: z.literal('one_based_inclusive'),
      name: z.string(),
      format,
      circular: z.boolean().optional(),
      length: count,
      sequenceIncluded: z.boolean(),
      sequence: z.string().nullable(),
      sequencePreview: z.string().nullable(),
      featureCount: count,
      features: z.array(sequenceFeature),
      primerCount: count.optional(),
      window: coordinateRange.extend({ length: count, wraps: z.boolean().optional() }).optional(),
    })
    .strict(),
]);

const importProvenance = z
  .object({
    provider: z.string(),
    fetchedVia: z.enum(['filesystem', 'sidecar']),
    sourceUrl: z.string().optional(),
    license: z.string().optional(),
    attribution: z.string().optional(),
    contentSha256: z.string().optional(),
    versionIdentifier: z.string().optional(),
    organism: z.string().optional(),
    definition: z.string().optional(),
    taxonId: z.string().optional(),
  })
  .strict();
export const importSequenceOutputSchema = z
  .object({
    ...success,
    ...resource,
    imported: z.literal(true),
    reused: z.literal(true).optional(),
    source: z
      .object({
        kind: z.enum(['url', 'local_file', 'addgene', 'ncbi']),
        url: z.string().optional(),
        plasmidId: z.string().optional(),
        accession: z.string().optional(),
        database: z.string().optional(),
        provenance: importProvenance.optional(),
      })
      .strict(),
    documents: z.array(z.object({ ...resource, name: z.string() }).strict()),
    name: z.string(),
    format,
    circular: z.boolean().optional(),
    length: count,
    featureCount: count,
    opened: z.boolean(),
    tabId: z.string().nullable(),
    stopRequested: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict();

export const getSequenceChangesOutputSchema = z.union([
  z
    .object({ ...success, ...resource, status: z.literal('untracked'), message: z.string() })
    .strict(),
  z
    .object({
      ...success,
      ...resource,
      sequenceChanges: z
        .object({
          insertions: count,
          deletions: count,
          mutations: count,
          insertedBp: count,
          deletedBp: count,
        })
        .strict(),
      annotationChanges: z.object({ added: count, removed: count, modified: count }).strict(),
      details: z.array(
        z
          .object({
            type: z.enum(['mutation', 'insertion', 'deletion']),
            position: z.number(),
            length: count,
            oldBases: z.string().optional(),
            newBases: z.string().optional(),
          })
          .strict()
      ),
      annotationDetails: z.array(
        z
          .object({
            type: z.enum(['added', 'removed', 'modified']),
            name: z.string(),
            annotationType: z.string(),
            changes: z.array(z.string()).optional(),
          })
          .strict()
      ),
    })
    .strict(),
]);

export const selectionTranslateOutputSchema = z
  .object({
    ...success,
    refId: z.string(),
    protein: z.string(),
    proteinLengthAa: count,
    strand: z.enum(['+', '-']),
    frame: z.literal(0),
    geneticCode: z.string(),
    translTable: z.number().nullable(),
    startsWithMet: z.boolean(),
    hasInternalStop: z.boolean(),
    note: z.string().optional(),
  })
  .strict();
export const selectionReverseComplementOutputSchema = z
  .object({ ...success, refId: z.string(), reverseComplement: z.string(), length: count })
  .strict();
export const selectionRestrictionSitesOutputSchema = z
  .object({
    ...success,
    refId: z.string(),
    coordinateSystem: z.literal('1-indexed-relative-to-selection'),
    notFound: z.array(z.string()),
    results: z.array(
      z
        .object({
          enzyme: z.string(),
          recognitionSequence: z.string(),
          siteCount: count,
          truncated: z.boolean(),
          sites: z.array(
            z
              .object({
                recognitionStart: z.number(),
                strand: z.enum(['forward', 'reverse']),
                cutTop: z.number(),
                cutBottom: z.number(),
                absoluteRecognitionStart: z.number().optional(),
              })
              .strict()
          ),
        })
        .strict()
    ),
  })
  .strict();
export const selectionGcProfileOutputSchema = z
  .object({
    ...success,
    refId: z.string(),
    windowSize: count,
    length: count,
    overallGcPercent: z.number(),
    windows: z.array(coordinateRange.extend({ gcPercent: z.number() })),
    truncated: z.boolean(),
  })
  .strict();
export const selectionFindOrfsOutputSchema = z
  .object({
    ...success,
    refId: z.string(),
    coordinateSystem: z.literal('1-indexed-relative-to-selection'),
    minLen: count,
    orfCount: count,
    orfs: z.array(
      coordinateRange.extend({
        strand: z.enum(['+', '-']),
        frame: z.number(),
        lengthBp: count,
        codonCount: count,
        absoluteStart: z.number().optional(),
      })
    ),
    truncated: z.boolean(),
  })
  .strict();
