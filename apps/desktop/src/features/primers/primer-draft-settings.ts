import { z } from 'zod';

const primerDraftSettings = z.object({
  schemaId: z.string().optional(),
  fields: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  directory: z.string().optional(),
});

export type PrimerDraftSettings = z.infer<typeof primerDraftSettings>;

export function restorePrimerDraftSettings(serialized?: string): PrimerDraftSettings {
  if (!serialized) return {};
  try {
    return primerDraftSettings.parse(JSON.parse(serialized));
  } catch {
    return {};
  }
}

export const publishedPrimerDraft = z.object({
  path: z.string().min(1),
  revision: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  accepted: z
    .object({
      kind: z.literal('accepted-object'),
      contentSha256: z.string(),
      resourceId: z.string(),
      resourceRevisionId: z.string(),
      workspaceVersionId: z.string(),
      sequenceEditParentEventId: z.string().nullable(),
    })
    .optional(),
});
