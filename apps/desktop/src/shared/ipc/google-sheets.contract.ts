import type {
  GoogleSheetsStatus,
  GoogleSpreadsheet,
  GoogleWorksheetSnapshot,
} from '../google-sheets';
import { defineGroup, event, invoke, type ClientOf } from './contract';

export const googleSheetsContract = defineGroup('googleSheets', {
  status: invoke<[], GoogleSheetsStatus>(),
  connect: invoke<[], string>(),
  cancel: invoke<[requestId: string], boolean>(),
  forget: invoke<[grantId: string], void>(),
  spreadsheet: invoke<[request: { grantId: string; spreadsheetId: string }], GoogleSpreadsheet>(),
  worksheet: invoke<
    [request: { grantId: string; spreadsheetId: string; sheetId: number }],
    GoogleWorksheetSnapshot
  >(),
  onChanged: event<[]>(),
});
export type GoogleSheetsPort = ClientOf<typeof googleSheetsContract>;
