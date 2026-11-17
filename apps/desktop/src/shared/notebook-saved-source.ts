import type { JSONContent } from '@tiptap/core';
import { z } from 'zod';

const node: z.ZodType<JSONContent> = z.lazy(() =>
  z
    .object({
      type: z.string().min(1),
      text: z.string().optional(),
      attrs: z.record(z.unknown()).optional(),
      marks: z
        .array(z.object({ type: z.string(), attrs: z.record(z.unknown()).optional() }).strict())
        .optional(),
      content: z.array(node).optional(),
    })
    .strict()
);

export const notebookSavedSourceSchema = z
  .object({
    schema: z.literal('dnaforge.notebook-saved-source.v1'),
    projectId: z.string().min(1).max(256),
    workspaceScope: z.string().min(1).max(256),
    pageId: z.string().min(1).max(1000),
    fileObjectUuid: z.string().min(1).max(256),
    title: z.string().min(1).max(500),
    content: node,
  })
  .strict();

export type NotebookSavedSource = z.infer<typeof notebookSavedSourceSchema>;
