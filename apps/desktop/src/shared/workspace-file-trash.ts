import { z } from 'zod';

const root = { workspaceRoot: z.string().min(1), mutationToken: z.string().min(1).optional() };
const entry = { ...root, entryId: z.string().uuid(), expectedRevision: z.string().min(1) };
export const workspaceFileTrashRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...root, kind: z.literal('inspect'), path: z.string().min(1) }).strict(),
  z
    .object({
      ...root,
      kind: z.literal('list'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(50),
    })
    .strict(),
  z
    .object({
      ...root,
      kind: z.literal('trash'),
      path: z.string().min(1),
      expectedRevision: z.string().min(1),
    })
    .strict(),
  z.object({ ...entry, kind: z.literal('restore') }).strict(),
  z.object({ ...entry, kind: z.literal('purge') }).strict(),
]);
export type WorkspaceFileTrashRequest = z.input<typeof workspaceFileTrashRequestSchema>;
export interface FileTrashSource {
  path: string;
  type: 'file' | 'directory';
  size: number;
  contentHash: string | null;
  revision: string;
}
export interface FileTrashEntry {
  id: string;
  originalPath: string;
  type: 'file' | 'directory';
  size: number;
  trashedAt: string;
  revision: string;
  deletionStarted: boolean;
}
export type WorkspaceFileTrashResult =
  | { kind: 'inspect'; source: FileTrashSource }
  | {
      kind: 'list';
      entries: FileTrashEntry[];
      errors: Array<{ entryId: string; error: string }>;
      nextOffset: number | null;
    }
  | { kind: 'trash'; changed: true; entry: FileTrashEntry; warnings: string[] }
  | { kind: 'restore'; changed: true; entryId: string; path: string; warnings: string[] }
  | { kind: 'purge'; changed: true; entryId: string; warnings: string[] }
  | {
      kind: 'failed';
      code: string;
      error: string;
      stateChanged: boolean | 'unknown';
      entryId?: string;
      path?: string;
    };
