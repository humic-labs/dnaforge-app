import { primerTmSettingsSchema } from '../../primer-tm-settings';
import { z } from 'zod';
import { excelSourceSchema, googleSourceSchema } from './persistence';
import type { LimsImportPlan } from '../../lims';
import type { SheetSyncConnectionEntry, StoredSheetSyncConnection } from './persistence';
import type { SheetSyncPullSummary } from './runtime';

const id = z.string().uuid();
const requestId = z.string().min(1).max(200);
export const sheetSyncCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('prepare'),
      source: z.union([excelSourceSchema, googleSourceSchema]),
      destinationRelativePath: z.string(),
      grantId: id.optional(),
      primerTmSettings: primerTmSettingsSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('connect'), preparedId: id, requestId }).strict(),
  z.object({ kind: z.literal('recover-connect'), requestId }).strict(),
  z.object({ kind: z.literal('list') }).strict(),
  z.object({ kind: z.literal('inspect'), id }).strict(),
  z.object({ kind: z.literal('inspect-connect'), requestId }).strict(),
  z
    .object({ kind: z.literal('pull'), id, primerTmSettings: primerTmSettingsSchema.optional() })
    .strict(),
  z.object({ kind: z.literal('set-enabled'), id, enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('authorization'), id }).strict(),
  z.object({ kind: z.literal('authorize-excel'), id, selectedPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('authorize-google'), id, grantId: id }).strict(),
]);
export type SheetSyncCommand = z.infer<typeof sheetSyncCommandSchema>;
export interface SheetSyncRequest {
  workspaceRoot: string;
  command: SheetSyncCommand;
}
export type SheetSyncPrepared = {
  kind: 'prepared';
  preparedId: string;
  sourceRevision: string;
  schemaRevisionId: string;
  plan: LimsImportPlan;
};
export type SheetSyncConnectOutcome = {
  kind: 'connected' | 'partial';
  requestId: string;
  connectionId: string;
  stored: StoredSheetSyncConnection | null;
  message?: string;
};
export type SheetSyncResult =
  | SheetSyncPrepared
  | SheetSyncConnectOutcome
  | { kind: 'connections'; entries: SheetSyncConnectionEntry[] }
  | { kind: 'connection'; stored: StoredSheetSyncConnection }
  | { kind: 'pulled'; summary: SheetSyncPullSummary | null }
  | { kind: 'authorization'; state: 'authorized' | 'paused' | 'required' }
  | { kind: 'changed' };
export function sheetSyncCommandIsReadOnly(command: SheetSyncCommand): boolean {
  return ['list', 'inspect', 'inspect-connect', 'authorization', 'prepare'].includes(command.kind);
}
