import { z } from 'zod';

export const googleSpreadsheetIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const googleWorksheetIdSchema = z.number().int().nonnegative().safe();
export const googleSheetsAccountSchema = z
  .object({
    id: z.string().uuid(),
    subject: z.string().min(1),
    email: z.string().email(),
  })
  .strict();
export type GoogleSheetsAccount = z.infer<typeof googleSheetsAccountSchema>;

export const googleSpreadsheetSchema = z
  .object({
    id: googleSpreadsheetIdSchema,
    title: z.string(),
    sheets: z.array(z.object({ id: googleWorksheetIdSchema, title: z.string() }).strict()),
  })
  .strict();
export type GoogleSpreadsheet = z.infer<typeof googleSpreadsheetSchema>;

export const googleSheetCellSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('value'),
      value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
      display: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('error'), display: z.string() }).strict(),
]);
export type GoogleSheetCell = z.infer<typeof googleSheetCellSchema>;

export const googleWorksheetSnapshotSchema = z
  .object({
    spreadsheetId: googleSpreadsheetIdSchema,
    sheetId: googleWorksheetIdSchema,
    sheetTitle: z.string(),
    rows: z.array(z.array(googleSheetCellSchema)),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type GoogleWorksheetSnapshot = z.infer<typeof googleWorksheetSnapshotSchema>;

export type GoogleSheetsConnectState =
  | { kind: 'idle' }
  | { kind: 'authorizing'; requestId: string }
  | { kind: 'saving'; requestId: string }
  | { kind: 'connected'; account: GoogleSheetsAccount }
  | { kind: 'error'; message: string };

export type GoogleSheetsStatus = {
  configured: boolean;
  ownerKey: string;
  accounts: Array<{ account: GoogleSheetsAccount; kind: 'connected' | 'reconnect-required' }>;
  unreadableAccounts: number;
  connection: GoogleSheetsConnectState;
};
