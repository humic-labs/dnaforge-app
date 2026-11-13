import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Button, Notice } from '../../../components/ui';
import { platform } from '../../../platform';
import {
  googleSpreadsheetIdSchema,
  type GoogleSheetsStatus,
  type GoogleSpreadsheet,
  type GoogleWorksheetSnapshot,
} from '../../../shared/google-sheets';

export function googleSpreadsheetIdFromInput(value: string): string {
  const direct = googleSpreadsheetIdSchema.safeParse(value.trim());
  if (direct.success) return direct.data;
  const url = new URL(value);
  const match = /^\/spreadsheets\/d\/([^/]+)(?:\/|$)/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'docs.google.com' ||
    url.username ||
    url.password ||
    !match
  )
    throw new Error('Paste a Google Sheets link or spreadsheet ID.');
  return googleSpreadsheetIdSchema.parse(match[1]);
}
const SELECT =
  'mt-1.5 h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent disabled:opacity-50';
export function GoogleSheetChooser(input: {
  disabled: boolean;
  source?: { spreadsheetId: string; sheetId: number };
  onSelected(value: {
    grantId: string;
    spreadsheet: GoogleSpreadsheet;
    snapshot: GoogleWorksheetSnapshot;
  }): Promise<void>;
}) {
  const [status, setStatus] = useState<GoogleSheetsStatus | null>(null);
  const [grantId, setGrantId] = useState('');
  const [documentInput, setDocumentInput] = useState(input.source?.spreadsheetId ?? '');
  const [spreadsheet, setSpreadsheet] = useState<GoogleSpreadsheet | null>(null);
  const [sheetId, setSheetId] = useState<number | null>(input.source?.sheetId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let request = 0;
    async function refresh() {
      const generation = ++request;
      try {
        const current = await platform().googleSheets.status();
        if (disposed || generation !== request) return;
        setStatus(current);
        setGrantId((previous) =>
          current.accounts.some(
            (entry) => entry.kind === 'connected' && entry.account.id === previous
          )
            ? previous
            : (current.accounts.find((entry) => entry.kind === 'connected')?.account.id ?? '')
        );
      } catch (reason) {
        if (!disposed) setError(toUserMessage(reason, 'operation.failed'));
      }
    }
    void refresh();
    const stop = platform().googleSheets.onChanged(() => {
      setSpreadsheet(null);
      void refresh();
    });
    return () => {
      disposed = true;
      stop();
    };
  }, []);
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(toUserMessage(reason, 'operation.failed'));
    } finally {
      setBusy(false);
    }
  }
  const locked = input.disabled || busy;
  return (
    <section className="space-y-3 border-t border-border pt-4" data-testid="google-sheet-chooser">
      <h3 className="text-sm font-semibold">Connect Google Sheets</h3>
      <p className="text-xs leading-5 text-fg-muted">
        Allow read-only access in your browser, then choose a worksheet. Changes are checked every
        minute while this project is open.
      </p>
      {error ? <Notice tone="error">{toUserMessage(error, 'operation.failed')}</Notice> : null}
      {status && !status.configured ? (
        <Notice tone="neutral">
          Google Sheets connection is unavailable in this desktop build.
        </Notice>
      ) : null}
      {status?.connection.kind === 'error' ? (
        <Notice tone="error">{toUserMessage(status.connection.message, 'account.failed')}</Notice>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-xs font-medium">
          Google account
          <select
            aria-label="Google Sheets account"
            className={SELECT}
            value={grantId}
            disabled={locked}
            onChange={(event) => {
              setGrantId(event.target.value);
              setSpreadsheet(null);
            }}
          >
            <option value="">Choose an account</option>
            {status?.accounts
              .filter((entry) => entry.kind === 'connected')
              .map((entry) => (
                <option key={entry.account.id} value={entry.account.id}>
                  {entry.account.email}
                </option>
              ))}
          </select>
        </label>
        <Button
          disabled={
            locked ||
            !status?.configured ||
            status.connection.kind === 'authorizing' ||
            status.connection.kind === 'saving'
          }
          onClick={() =>
            void perform(async () => {
              await platform().googleSheets.connect();
            })
          }
        >
          Connect Google account
        </Button>
        {status?.connection.kind === 'authorizing' ? (
          <Button
            onClick={() =>
              void perform(async () => {
                if (status.connection.kind === 'authorizing')
                  await platform().googleSheets.cancel(status.connection.requestId);
              })
            }
          >
            Cancel connection
          </Button>
        ) : null}
        {grantId ? (
          <Button
            disabled={locked}
            onClick={() =>
              void perform(async () => {
                await platform().googleSheets.forget(grantId);
                setSpreadsheet(null);
              })
            }
          >
            Forget account on this device
          </Button>
        ) : null}
      </div>
      {status?.accounts.some((entry) => entry.kind === 'reconnect-required') ? (
        <p className="text-xs text-warning">
          A saved Google connection needs consent again. Choose Connect Google account to reconnect.
        </p>
      ) : null}
      {status?.unreadableAccounts ? (
        <Notice tone="error">Some saved Google connections cannot be read on this device.</Notice>
      ) : null}
      <label className="block text-xs font-medium">
        Spreadsheet link or ID
        <input
          aria-label="Google spreadsheet link or ID"
          className={SELECT}
          value={documentInput}
          disabled={locked || !!input.source}
          onChange={(event) => {
            setDocumentInput(event.target.value);
            setSpreadsheet(null);
          }}
        />
      </label>
      <Button
        disabled={locked || !grantId || !documentInput}
        onClick={() =>
          void perform(async () => {
            const result = await platform().googleSheets.spreadsheet({
              grantId,
              spreadsheetId: googleSpreadsheetIdFromInput(documentInput),
            });
            if (input.source && result.id !== input.source.spreadsheetId)
              throw new Error('Choose the spreadsheet recorded for this connection.');
            setSpreadsheet(result);
            setSheetId(input.source?.sheetId ?? result.sheets[0]?.id ?? null);
          })
        }
      >
        Load worksheets
      </Button>
      {spreadsheet ? (
        <>
          <p className="text-xs font-medium">{spreadsheet.title}</p>
          <label className="block text-xs font-medium">
            Worksheet
            <select
              aria-label="Google worksheet"
              className={SELECT}
              value={sheetId ?? ''}
              disabled={locked || !!input.source}
              onChange={(event) =>
                setSheetId(z.coerce.number().int().nonnegative().parse(event.target.value))
              }
            >
              {spreadsheet.sheets.map((sheet) => (
                <option key={sheet.id} value={sheet.id}>
                  {sheet.title}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={locked || sheetId === null}
            onClick={() =>
              void perform(async () => {
                if (sheetId === null) return;
                const snapshot = await platform().googleSheets.worksheet({
                  grantId,
                  spreadsheetId: spreadsheet.id,
                  sheetId,
                });
                await input.onSelected({ grantId, spreadsheet, snapshot });
              })
            }
          >
            {input.source ? 'Authorize this worksheet' : 'Preview this worksheet'}
          </Button>
        </>
      ) : null}
    </section>
  );
}
