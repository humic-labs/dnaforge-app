import { z } from 'zod';
import { isSafeWorkspaceRelativePath } from './path-boundary';

const entityId = z.string().min(1).max(2048);
const destination = z
  .string()
  .max(32768)
  .refine(
    (p) =>
      isSafeWorkspaceRelativePath(p) &&
      !p.includes('\\') &&
      !p
        .split('/')
        .some((s) => ['.git', '.forge', '.dnaforge', '.waypoint'].includes(s.toLowerCase()))
  );
export const savedFileSourceOperation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('versions'),
      entityId,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  z
    .object({ kind: z.literal('restore'), entityId, revisionId: z.string().uuid(), destination })
    .strict(),
]);
export const savedFileSourceRequest = z
  .object({
    workspaceRoot: z.string().min(1).max(32768).nullable(),
    operation: savedFileSourceOperation,
  })
  .strict();
export const savedFileSourceAgentRequest = z
  .object({ project: z.string().min(1).max(32768), operation: savedFileSourceOperation })
  .strict();
export type SavedFileSourceRequest = z.input<typeof savedFileSourceRequest>;
export type SavedFileSourceVersion = {
  id: string;
  createdAt: number;
  sha256: string;
  members: number;
  sizeBytes: number;
};
export type SavedFileSourceResult =
  | { versions: SavedFileSourceVersion[]; nextOffset: number | null; unavailableSources?: number }
  | { restored: { id: string; relativePath: string } };
