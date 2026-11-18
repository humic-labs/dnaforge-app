import { z } from 'zod';
import type { JSONContent } from '@tiptap/core';

const identifier = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !/[\u0000-\u001F\u007F]/u.test(s));
export const workNotebookPlacementSchema = z
  .object({
    documentId: identifier,
    expectedRevision: identifier,
    index: z.number().int().nonnegative(),
    placementId: z.string().uuid(),
  })
  .strict();
export type WorkNotebookPlacement = z.infer<typeof workNotebookPlacementSchema>;
export type WorkPlacementIntent = WorkNotebookPlacement & {
  projectId: string;
  taskId: string;
  operationId: string;
};
export const workTaskReferenceSchema = z
  .object({ projectId: identifier, taskId: identifier, placementId: z.string().uuid() })
  .strict();
export type WorkTaskReference = z.infer<typeof workTaskReferenceSchema>;
const prefix = 'dnaforge-chat://work-task/';

export function workTaskReferenceHref(reference: WorkTaskReference): string {
  const { projectId, taskId, placementId } = workTaskReferenceSchema.parse(reference);
  return prefix + [projectId, taskId, placementId].map(encodeURIComponent).join('/');
}

export function parseWorkTaskReferenceHref(
  href: string | null | undefined
): WorkTaskReference | null {
  if (!href?.startsWith(prefix) || href.length > 8192) return null;
  try {
    const parts = href.slice(prefix.length).split('/');
    if (parts.length !== 3) return null;
    const [projectId, taskId, placementId] = parts.map(decodeURIComponent);
    const result = workTaskReferenceSchema.safeParse({ projectId, taskId, placementId });
    return result.success && workTaskReferenceHref(result.data) === href ? result.data : null;
  } catch {
    return null;
  }
}

export function containsWorkTaskPlacement(content: JSONContent, href: string): boolean {
  return (
    (content.type === 'mention' && content.attrs?.referenceUri === href) ||
    !!content.content?.some((node) => containsWorkTaskPlacement(node, href))
  );
}
