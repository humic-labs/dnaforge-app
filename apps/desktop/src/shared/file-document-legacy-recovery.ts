import { z } from 'zod';

export const legacyFileDraftSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      path: z.string().min(1),
      baseline: z.string().min(1),
      payload: z.string().max(2 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal('table'),
      path: z.string().min(1),
      baseline: z.string().min(1),
      payload: z
        .object({
          tableData: z.record(z.unknown()),
          firstRowAsHeader: z.boolean(),
          headerRowValues: z.array(z.string()),
        })
        .strict(),
    })
    .strict(),
]);
export type LegacyFileDraft = z.infer<typeof legacyFileDraftSchema>;

export function legacyFileDraftFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export interface LegacyFileDraftRetention {
  retained: true;
  documentId: string;
  recoveryId: string;
}
