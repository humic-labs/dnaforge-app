import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  googleSpreadsheetIdSchema,
  googleWorksheetIdSchema,
  type GoogleSheetCell,
  type GoogleSpreadsheet,
  type GoogleWorksheetSnapshot,
} from '../../shared/google-sheets';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SYNC_ROWS = 50001;
const MAX_SYNC_CELLS = 1000000;
const sheetPropertiesSchema = z.object({ sheetId: googleWorksheetIdSchema, title: z.string() });
const metadataSchema = z.object({
  spreadsheetId: googleSpreadsheetIdSchema,
  properties: z.object({ title: z.string() }),
  sheets: z.array(z.object({ properties: sheetPropertiesSchema })).default([]),
});
const cellSchema = z.object({
  formattedValue: z.string().optional(),
  effectiveValue: z
    .object({
      stringValue: z.string().optional(),
      numberValue: z.number().finite().optional(),
      boolValue: z.boolean().optional(),
      errorValue: z.object({ type: z.string() }).optional(),
    })
    .refine((value) => Object.values(value).filter((entry) => entry !== undefined).length <= 1)
    .optional(),
});
const gridSchema = z.object({
  startRow: z.number().int().nonnegative().max(MAX_SYNC_ROWS).default(0),
  startColumn: z.number().int().nonnegative().max(MAX_SYNC_CELLS).default(0),
  rowData: z
    .array(z.object({ values: z.array(cellSchema).max(MAX_SYNC_CELLS).default([]) }))
    .max(MAX_SYNC_ROWS)
    .default([]),
});
const cellsSchema = z.object({
  spreadsheetId: googleSpreadsheetIdSchema,
  sheets: z
    .array(
      z.object({
        properties: sheetPropertiesSchema,
        data: z.array(gridSchema).default([]),
      })
    )
    .default([]),
});

export class GoogleSheetsReadError extends Error {
  constructor(
    public readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = 'GoogleSheetsReadError';
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new GoogleSheetsReadError(
      response.status,
      `Google Sheets read failed (HTTP ${response.status}).`
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleSheetsReadError(null, 'Google Sheets returned no data.');
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES)
        throw new GoogleSheetsReadError(
          null,
          'This worksheet exceeds the supported sync response size.'
        );
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleSheetsReadError(null, 'Google Sheets returned unreadable data.');
  }
}

function sheetUrl(spreadsheetId: string, fields: string, range?: string): URL {
  const id = googleSpreadsheetIdSchema.parse(spreadsheetId);
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`);
  url.searchParams.set('fields', fields);
  if (range !== undefined) url.searchParams.set('ranges', `'${range.replace(/'/g, "''")}'`);
  return url;
}

export function createGoogleSheetsReader(input: { fetch: typeof fetch }) {
  async function read(url: URL, accessToken: string, signal?: AbortSignal) {
    if (!accessToken.trim())
      throw new GoogleSheetsReadError(401, 'Connect a Google account first.');
    return readResponseJson(
      await input.fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      })
    );
  }

  async function spreadsheet(input: {
    spreadsheetId: string;
    accessToken: string;
    signal?: AbortSignal;
  }): Promise<GoogleSpreadsheet> {
    const raw = metadataSchema.safeParse(
      await read(
        sheetUrl(
          input.spreadsheetId,
          'spreadsheetId,properties(title),sheets(properties(sheetId,title))'
        ),
        input.accessToken,
        input.signal
      )
    );
    if (!raw.success || raw.data.spreadsheetId !== input.spreadsheetId)
      throw new GoogleSheetsReadError(null, 'Google returned a different or invalid spreadsheet.');
    const ids = raw.data.sheets.map((sheet) => sheet.properties.sheetId);
    if (new Set(ids).size !== ids.length)
      throw new GoogleSheetsReadError(null, 'Google returned ambiguous worksheet identities.');
    return {
      id: raw.data.spreadsheetId,
      title: raw.data.properties.title,
      sheets: raw.data.sheets.map((sheet) => ({
        id: sheet.properties.sheetId,
        title: sheet.properties.title,
      })),
    };
  }

  async function worksheet(input: {
    spreadsheetId: string;
    sheetId: number;
    accessToken: string;
    signal?: AbortSignal;
  }): Promise<GoogleWorksheetSnapshot> {
    const sheetId = googleWorksheetIdSchema.parse(input.sheetId);
    const metadata = await spreadsheet(input);
    const selected = metadata.sheets.find((sheet) => sheet.id === sheetId);
    if (!selected)
      throw new GoogleSheetsReadError(404, 'The connected worksheet no longer exists.');
    const raw = cellsSchema.safeParse(
      await read(
        sheetUrl(
          input.spreadsheetId,
          'spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(formattedValue,effectiveValue))))',
          selected.title
        ),
        input.accessToken,
        input.signal
      )
    );
    if (!raw.success || raw.data.spreadsheetId !== input.spreadsheetId)
      throw new GoogleSheetsReadError(null, 'Google returned invalid worksheet data.');
    const matches = raw.data.sheets.filter((sheet) => sheet.properties.sheetId === sheetId);
    const sheet = matches[0];
    if (
      matches.length !== 1 ||
      !sheet ||
      sheet.properties.title !== selected.title ||
      raw.data.sheets.some(
        (other) =>
          other.properties.sheetId !== sheetId && other.data.some((grid) => grid.rowData.length > 0)
      )
    )
      throw new GoogleSheetsReadError(
        null,
        'The worksheet changed during this read. Retry to verify its identity.'
      );
    if (sheet.data.length > 1)
      throw new GoogleSheetsReadError(null, 'Google returned ambiguous worksheet ranges.');
    const rows: GoogleSheetCell[][] = [];
    const grid = sheet.data[0];
    if (grid) {
      if (
        grid.startRow + grid.rowData.length > MAX_SYNC_ROWS ||
        grid.rowData.reduce((count, row) => count + grid.startColumn + row.values.length, 0) >
          MAX_SYNC_CELLS
      )
        throw new GoogleSheetsReadError(
          null,
          'This worksheet exceeds the supported sync data size.'
        );
      for (let rowIndex = 0; rowIndex < grid.startRow; rowIndex++) rows.push([]);
      for (const rawRow of grid.rowData) {
        const row: GoogleSheetCell[] = [];
        for (let column = 0; column < grid.startColumn; column++)
          row.push({ kind: 'value', value: null, display: '' });
        for (const cell of rawRow.values) {
          const effective = cell.effectiveValue;
          row.push(
            effective?.errorValue
              ? { kind: 'error', display: cell.formattedValue ?? effective.errorValue.type }
              : {
                  kind: 'value',
                  value:
                    effective?.stringValue ??
                    effective?.numberValue ??
                    effective?.boolValue ??
                    cell.formattedValue ??
                    null,
                  display: cell.formattedValue ?? '',
                }
          );
        }
        rows.push(row);
      }
    }
    return {
      spreadsheetId: input.spreadsheetId,
      sheetId,
      sheetTitle: sheet.properties.title,
      rows,
      revision: `sha256:${createHash('sha256')
        .update(JSON.stringify({ spreadsheetId: input.spreadsheetId, sheetId, rows }))
        .digest('hex')}`,
    };
  }
  return { spreadsheet, worksheet };
}
