import { z } from 'zod';
import { molecularCatalogObservationSchema } from './molecular-catalog';
import { residueMeasurementSchema } from './residue-measurement';
import { molecularDataViewSchema } from './molecular-data';

export const MOLECULAR_VIEW_MAX_COORDINATE_BYTES = 8_000_000;
export const molecularPredictionSchema = z
  .object({
    provider: z.string().min(1).max(64),
    toolId: z.string().min(1).max(128),
    remoteId: z.string().min(1).max(256),
    jobRecordId: z.string().min(1).max(200),
    proteinSequenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    coordinateSha256: z.string().regex(/^[0-9a-f]{64}$/),
    metrics: z
      .record(z.string().max(200), z.unknown())
      .refine(
        (value) => JSON.stringify(value).length <= 20_000,
        'Prediction metrics exceed the snapshot limit.'
      ),
  })
  .strict();
export type MolecularPrediction = z.infer<typeof molecularPredictionSchema>;
export const molecularAlleleSchema = z
  .object({
    basis: z.literal('single-allele'),
    documentId: z.string().min(1).max(2000),
    position: z.number().int().positive(),
    referenceBase: z.string().max(24000),
    alternateBase: z.string().max(24000),
    referenceProteinSha256: z.string().regex(/^[0-9a-f]{64}$/),
    proteinSequenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    referenceLength: z.number().int().positive().max(24000),
    proteinLength: z.number().int().positive().max(24000),
    alternateToReference: z.array(z.number().int().nonnegative().nullable()).max(24000),
  })
  .strict()
  .refine(
    (value) =>
      value.alternateToReference.length === value.proteinLength &&
      value.alternateToReference.every((index) => index === null || index < value.referenceLength),
    'The allele residue correspondence does not match its proteins.'
  );
export type MolecularAllele = z.infer<typeof molecularAlleleSchema>;
export const molecularCoordinatesSchema = z
  .object({
    format: z.enum(['pdb', 'cif', 'bcif']),
    text: z.string().min(1).max(MOLECULAR_VIEW_MAX_COORDINATE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const comparisonSourceSchema = z
  .object({
    referenceId: z.string().min(1).max(2000),
    title: z.string().min(1).max(200),
    sequence: z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]{1,24000}$/),
    chainId: z.string().min(1).max(200),
    coordinates: molecularCoordinatesSchema,
    source: z.string().max(30).optional(),
    sourceId: z.string().max(2000).optional(),
    providerIdentityKey: z.string().max(300).optional(),
    prediction: molecularPredictionSchema.optional(),
  })
  .strict();
export const molecularComparisonSchema = z
  .object({
    reference: comparisonSourceSchema,
    alternate: comparisonSourceSchema,
    allele: molecularAlleleSchema,
    coordinateSha256: z.string().regex(/^[0-9a-f]{64}$/),
    alignment: z
      .object({
        pairs: z
          .array(
            z
              .object({
                reference: z.number().int().nonnegative(),
                alternate: z.number().int().nonnegative(),
              })
              .strict()
          )
          .min(3)
          .max(24000),
        transform: z.array(z.number().finite()).length(16),
        rmsd: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type MolecularComparison = z.infer<typeof molecularComparisonSchema>;

export const molecularViewEvidenceSchema = z
  .object({
    title: z.string().min(1).max(200),
    url: z
      .string()
      .url()
      .max(2000)
      .regex(/^https?:\/\//, 'Evidence must use a public web URL.')
      .describe(
        'Actual public HTTP(S) evidence URL. Local workspace files and private app schemes are not web URLs; describe those sources in the caption and use evidence: [] when there are no public URLs.'
      ),
  })
  .strict();

export const molecularViewSchema = z
  .object({
    kind: z.literal('molecular-view'),
    version: z.literal(1),
    title: z.string().min(1).max(200),
    caption: z.string().max(2000),
    scene: z.string().min(1).max(500_000),
    initialSnapshotIndex: z.number().int().nonnegative().optional(),
    cameraSnapshot: z.string().max(10_000).optional(),
    coordinates: molecularCoordinatesSchema,
    source: z
      .object({
        source: z.string().max(30).optional(),
        sourceId: z.string().max(2000).optional(),
        providerIdentityKey: z.string().max(300).optional(),
        coordinateModel: z
          .object({
            blockIndex: z.number().int().nonnegative(),
            modelIndex: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        catalogObservation: molecularCatalogObservationSchema.optional(),
        prediction: molecularPredictionSchema.optional(),
        allele: molecularAlleleSchema.optional(),
        comparison: molecularComparisonSchema.optional(),
      })
      .strict(),
    evidence: z.array(molecularViewEvidenceSchema).max(20),
    preview: z
      .string()
      .max(2_000_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
    createdAt: z.number().int().nonnegative(),
    measurements: z.array(residueMeasurementSchema).max(20).optional(),
    activeMeasurementId: z.string().min(1).max(200).optional(),
    molecularData: molecularDataViewSchema.optional(),
  })
  .strict();
export type MolecularView = z.infer<typeof molecularViewSchema>;
