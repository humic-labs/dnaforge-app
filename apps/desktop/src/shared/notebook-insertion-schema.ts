import { z } from 'zod';
import { tableDimensionsSchema } from './notebook-model/table/configuration';
export const notebookEntityTypeSchema = z.enum(['sequence', 'page', 'primer']);
export const notebookInsertionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('entity'),
      type: notebookEntityTypeSchema,
      entityId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      path: z.string().min(1),
      expectedRevision: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('table'), ...tableDimensionsSchema.shape }).strict(),
]);
