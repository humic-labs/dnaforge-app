// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleSheetsReader, GoogleSheetsReadError } from './api';

let server: Server;
let origin: string;
let title: string;
let responseSheetId: number;
let status: number;
let cells: unknown[];
const calls: Array<{ method: string | undefined; authorization: string | undefined; url: URL }> =
  [];
const spreadsheetId = 'permanent-spreadsheet-id';
const sheetId = 17;
const cell = (value: string | number | boolean, display = String(value)) => ({
  formattedValue: display,
  effectiveValue:
    typeof value === 'string'
      ? { stringValue: value }
      : typeof value === 'number'
        ? { numberValue: value }
        : { boolValue: value },
});

beforeEach(async () => {
  title = "Lab's master";
  responseSheetId = sheetId;
  status = 200;
  cells = [
    { values: [cell('Stable ID'), cell('Name'), cell('Sequence')] },
    { values: [cell(1, '001'), cell('Forward A'), cell('GTAAAACGACGGCCAGT')] },
  ];
  calls.length = 0;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    calls.push({ method: request.method, authorization: request.headers.authorization, url });
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = status;
    if (status === 302) response.setHeader('Location', '/unexpected-redirect');
    if (status !== 200) {
      response.end(JSON.stringify({ error: 'never include this body in errors' }));
      return;
    }
    response.end(
      JSON.stringify(
        url.searchParams.has('ranges')
          ? {
              spreadsheetId,
              sheets: [
                { properties: { sheetId: responseSheetId, title }, data: [{ rowData: cells }] },
              ],
            }
          : {
              spreadsheetId,
              properties: { title: 'Lab workbook' },
              sheets: [{ properties: { sheetId, title } }],
            }
      )
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reader(beforeRequest?: (url: URL) => void) {
  return createGoogleSheetsReader({
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe('https://sheets.googleapis.com');
      beforeRequest?.(url);
      return fetch(new URL(url.pathname + url.search, origin), init);
    },
  });
}
const input = { spreadsheetId, sheetId, accessToken: 'synthetic-access-token' };

describe('Google worksheet reader over actual HTTP', () => {
  it('refuses redirects instead of moving an authenticated sheet request to another resource', async () => {
    status = 302;
    await expect(
      reader().spreadsheet({ spreadsheetId, accessToken: 'synthetic-access' })
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).not.toBe('/unexpected-redirect');
  });
  it('uses readonly GETs and binds cells to numeric worksheet identity while preserving formatted IDs', async () => {
    const result = await reader().worksheet(input);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(calls.every((call) => call.authorization === 'Bearer synthetic-access-token')).toBe(
      true
    );
    expect(calls[1].url.searchParams.get('ranges')).toBe("'Lab''s master'");
    expect(calls[1].url.searchParams.get('fields')).toContain('sheetId');
    expect(result.rows[1][0]).toEqual({ kind: 'value', value: 1, display: '001' });
    expect(result.rows[1][2]).toEqual({
      kind: 'value',
      value: 'GTAAAACGACGGCCAGT',
      display: 'GTAAAACGACGGCCAGT',
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-access-token');
  });
  it('keeps revision identity across tab rename and changes it for actual cell edits', async () => {
    const api = reader();
    const first = await api.worksheet(input);
    title = 'Renamed worksheet';
    const renamed = await api.worksheet(input);
    expect(renamed.sheetTitle).toBe(title);
    expect(renamed.revision).toBe(first.revision);
    cells = [
      { values: [cell('Stable ID'), cell('Name')] },
      { values: [cell(1, '001'), cell('Changed')] },
    ];
    expect((await api.worksheet(input)).revision).not.toBe(first.revision);
  });
  it('rejects a title race or a replaced numeric worksheet instead of reading the wrong tab', async () => {
    await expect(
      reader((url) => {
        if (url.searchParams.has('ranges')) title = 'Renamed during read';
      }).worksheet(input)
    ).rejects.toThrow('changed during this read');
    responseSheetId = 23;
    await expect(reader().worksheet(input)).rejects.toThrow('changed during this read');
  });
  it('retains formula errors as explicit errors instead of turning them into empty cells', async () => {
    cells = [
      { values: [{ formattedValue: '#REF!', effectiveValue: { errorValue: { type: 'REF' } } }] },
    ];
    expect((await reader().worksheet(input)).rows).toEqual([[{ kind: 'error', display: '#REF!' }]]);
  });
  it.each([401, 403, 404, 429, 503])(
    'preserves HTTP %s as a read failure without exposing response bodies',
    async (code) => {
      status = code;
      const error = await reader()
        .worksheet(input)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(GoogleSheetsReadError);
      if (!(error instanceof GoogleSheetsReadError)) throw new Error('Missing read error');
      expect(error.status).toBe(code);
      expect(error.message).not.toContain('never include');
    }
  );
  it('rejects malformed source IDs before any network read', async () => {
    await expect(reader().worksheet({ ...input, spreadsheetId: '../foreign' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
