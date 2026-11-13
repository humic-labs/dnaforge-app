import { z } from 'zod';

const revision = z.string().regex(/^project-history-v1:[a-f0-9]{64}$/u);
const paths = z.array(z.string().min(1).max(32768)).min(1).max(10000);
const message = z
  .string()
  .trim()
  .min(1)
  .max(10000)
  .refine((value) => !value.includes('\0'));

export const projectHistoryOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inspect'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
    })
    .strict(),
  z.object({ kind: z.literal('stage'), expectedRevision: revision, paths }).strict(),
  z.object({ kind: z.literal('unstage'), expectedRevision: revision, paths }).strict(),
  z.object({ kind: z.literal('commit'), expectedRevision: revision, paths, message }).strict(),
  z
    .object({
      kind: z.literal('save-all'),
      expectedRevision: revision,
      message: message.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('initialize'), expectedRevision: revision }).strict(),
]);

export const projectHistoryRequestSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(32768),
    operation: projectHistoryOperationSchema,
    mutationToken: z.string().min(1).optional(),
  })
  .strict();

export const projectHistoryAgentRequestSchema = z
  .object({
    project: z.string().min(1).max(32768),
    operation: projectHistoryOperationSchema,
  })
  .strict();

export type ProjectHistoryOperation = z.input<typeof projectHistoryOperationSchema>;
export type ProjectHistoryRequest = z.input<typeof projectHistoryRequestSchema>;
export type ProjectHistoryAgentRequest = z.input<typeof projectHistoryAgentRequestSchema>;
export interface ProjectHistoryEntry {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  staged: boolean;
  unstaged: boolean;
  package: boolean;
}
export interface ProjectHistoryInspection {
  workspaceRoot: string;
  tracked: boolean;
  head: string | null;
  branch: string | null;
  revision: string;
  entries: ProjectHistoryEntry[];
  totalEntries: number;
  nextOffset: number | null;
  protectedStagedPaths: string[];
}
export type ProjectHistoryResult =
  | {
      status: 'ok';
      operation: ProjectHistoryOperation['kind'];
      inspection: ProjectHistoryInspection;
      stateChanged: boolean;
      paths: string[];
      commitOid?: string;
      warnings: string[];
    }
  | {
      status: 'failed';
      operation: ProjectHistoryOperation['kind'];
      code: string;
      error: string;
      stateChanged: boolean | 'unknown';
      paths: string[];
      commitOid?: string;
    };
