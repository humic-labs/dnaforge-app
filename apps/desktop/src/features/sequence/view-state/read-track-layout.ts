import { z } from 'zod';

const id = z.string().min(1);
const row = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('track'), id }),
  z.object({
    kind: z.literal('group'),
    id,
    label: z.string().trim().min(1),
    trackIds: z.array(id).readonly(),
  }),
]);
const preferences = z.object({
  visible: z.boolean().optional(),
  heightPx: z.number().int().min(32).max(2048).optional(),
  version: z.number().int().positive().optional(),
  settings: z.record(z.unknown()).optional(),
});
const layoutSchema = z.object({
  version: z.literal(1),
  reference: z
    .object({ hiddenAnnotationTypes: z.array(z.string()).readonly().optional() })
    .optional(),
  rows: z.array(row).readonly(),
  tracks: z.record(preferences),
});
export type ReadTrackLayout = z.infer<typeof layoutSchema>;
export type ReadTrackRow = z.infer<typeof row>;
export type ReadTrackPreferences = z.infer<typeof preferences>;
export function parseReadTrackLayout(value: unknown): ReadTrackLayout | undefined {
  const parsed = layoutSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
