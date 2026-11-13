import type { GoogleSheetsPort } from '../shared/ipc/google-sheets.contract';
async function unavailable(): Promise<never> {
  throw new Error('Google Sheets requires the native desktop app.');
}
export const googleSheetsUnavailable: GoogleSheetsPort = {
  status: unavailable,
  connect: unavailable,
  cancel: unavailable,
  forget: unavailable,
  spreadsheet: unavailable,
  worksheet: unavailable,
  onChanged: () => () => {},
};
