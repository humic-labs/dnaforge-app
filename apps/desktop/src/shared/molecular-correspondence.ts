import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const translatedCdsCorrespondenceSchema = z
  .object({
    kind: z.literal('translated-cds'),
    version: z.literal(1),
    reference: z
      .object({
        documentId: z.string().min(1).max(2000),
        sequenceSha256: digest,
        length: z.number().int().positive(),
        circular: z.boolean(),
      })
      .strict(),
    featureKey: z.string().min(1).max(2000),
    residueMoleculeId: z.string().min(1).max(2000),
    context: z
      .object({
        json: z.string().min(1).max(500_000),
        sha256: digest,
      })
      .strict(),
    molecule: z
      .object({
        kind: z.literal('protein'),
        sequence: z.string().min(1).max(1_000_000),
        identitySha256: digest,
      })
      .strict(),
  })
  .strict();
export type TranslatedCdsCorrespondence = z.infer<typeof translatedCdsCorrespondenceSchema>;
