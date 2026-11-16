import { z } from 'zod';
import {
  tableDocumentKey,
  tableDocumentReferenceSchema,
  type TableDocumentReference,
} from './table-document-reference';
import type { TableSnapshot } from './table-package';

const path = z.string().min(1).max(4096);
const revision = z.string().min(1).max(4096);
const destinationSchema = z.object({ workspaceRoot: path, packageRoot: path }).strict();
const title = z.string().max(1000);

export const tableDocumentCommandSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('open'), location: destinationSchema }).strict(),
    z.object({ kind: z.literal('list-promotions'), workspaceRoot: path }).strict(),
    z
      .object({
        kind: z.literal('create'),
        requestId: z.string().uuid(),
        destination: destinationSchema,
        title,
        rows: z.number().int().min(1).max(10000),
        columns: z.number().int().min(1).max(1000),
      })
      .strict(),
    z
      .object({
        kind: z.literal('resolve'),
        reference: tableDocumentReferenceSchema,
        context: z.object({ workspaceRoot: path }).strict().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('pin'),
        requestId: z.string().uuid(),
        reference: tableDocumentReferenceSchema,
        expectedRevision: revision,
      })
      .strict(),
    z
      .object({
        kind: z.literal('copy'),
        requestId: z.string().uuid(),
        source: tableDocumentReferenceSchema,
        expectedRevision: revision.optional(),
        destination: destinationSchema,
        title: title.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('promote'),
        requestId: z.string().uuid(),
        source: tableDocumentReferenceSchema,
        expectedRevision: revision,
        destination: destinationSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('recover-promotion'),
        requestId: z.string().uuid(),
        workspaceRoot: path,
        promotionId: z.string().uuid(),
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (command.kind === 'create' && command.rows * command.columns > 1000000)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The table exceeds one million cells.',
      });
    const reference =
      'reference' in command ? command.reference : 'source' in command ? command.source : undefined;
    if (reference) {
      try {
        tableDocumentKey(reference);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

export type TablePackageDestination = z.infer<typeof destinationSchema>;
export type TableDocumentCommand = z.infer<typeof tableDocumentCommandSchema>;

export interface ResolvedTableDocument {
  reference: TableDocumentReference;
  tableId: string;
  projectId?: string;
  owner:
    | { kind: 'notebook'; documentId: string; blockId: string }
    | { kind: 'file'; documentId: string; path: string; workspaceRoot: string }
    | { kind: 'saved-version'; snapshotSha256: string; snapshot: TableSnapshot };
  readOnly: boolean;
}

export interface TablePromotionRecovery {
  promotionId: string;
  tableId: string;
  sourceReference: TableDocumentReference;
  sourcePath: string;
  destinationPath: string;
  title: string;
  state: 'pending' | 'blocked';
  reason?: string;
}

export type TableDocumentCommandResult =
  | { kind: 'promotions'; promotions: TablePromotionRecovery[] }
  | { kind: 'resolved'; table: ResolvedTableDocument }
  | { kind: 'created'; table: ResolvedTableDocument }
  | { kind: 'pinned'; reference: TableDocumentReference }
  | { kind: 'promoted'; table: ResolvedTableDocument; promotionId: string }
  | { kind: 'promotion-pending'; promotionId: string; phase: string; reason: string };

export type TableDocumentResult = TableDocumentCommandResult;
