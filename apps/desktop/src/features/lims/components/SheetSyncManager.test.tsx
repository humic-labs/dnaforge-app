import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { SheetSyncConnection } from '../sheet-sync-connection';
import type { SheetSyncView } from '../sheet-sync-projects';
import { SheetSyncManagerButton } from './SheetSyncManager';
const mocks = vi.hoisted(() => ({
  dialog: vi.fn(),
  readFile: vi.fn(),
  create: vi.fn(),
  createGoogle: vi.fn(),
  googleMetadata: vi.fn(),
  googleWorksheet: vi.fn(),
  refresh: vi.fn(),
  pull: vi.fn(),
  load: vi.fn(),
  enabled: vi.fn(),
  authorize: vi.fn(),
  authorization: vi.fn(),
  retain: vi.fn(),
  release: vi.fn(),
  folders: [{ path: '/project', name: 'Lab', pinned: false }],
  views: new Array<SheetSyncView>(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    dialog: { open: mocks.dialog },
    fs: { readFile: mocks.readFile },
    googleSheets: {
      status: async () => ({
        configured: true,
        ownerKey: 'owner',
        accounts: [
          {
            account: {
              id: 'dedfe665-c77c-465a-a561-fe0d65cbcd5b',
              subject: 'synthetic',
              email: 'lab@example.test',
            },
            kind: 'connected',
          },
        ],
        unreadableAccounts: 0,
        connection: { kind: 'idle' },
      }),
      onChanged: () => () => {},
      spreadsheet: mocks.googleMetadata,
      worksheet: mocks.googleWorksheet,
    },
  }),
}));
vi.mock('../../../utils/environment', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: { folders: typeof mocks.folders }) => unknown) =>
    selector({ folders: mocks.folders }),
}));
vi.mock('../../../db', () => ({ ensureSequenceIdentity: vi.fn(async () => 1) }));
vi.mock('../operations', () => ({
  queryLimsEntities: vi.fn(async () => []),
  applyLimsImportBatch: vi.fn(),
}));
vi.mock('../sheet-sync-connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sheet-sync-connection')>()),
  loadSheetSyncConnection: mocks.load,
}));
vi.mock('../sheet-sync-runtime', () => ({
  createExcelSheetSyncConnection: mocks.create,
  createGoogleSheetSyncConnection: mocks.createGoogle,
  setSheetSyncEnabled: mocks.enabled,
}));
vi.mock('../sheet-sync-projects', () => ({
  useSheetSyncViews: () => mocks.views,
  retainSheetSyncProject: mocks.retain,
  refreshSheetSyncProject: mocks.refresh,
  requestSheetSyncPull: mocks.pull,
}));
vi.mock('../sheet-sync-local-state', () => ({
  authorizeLocalSheetSync: mocks.authorize,
  localSheetSyncAuthorization: mocks.authorization,
}));
function workbook(duplicate = false) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['Stable ID', 'Name', 'Sequence'],
      ['001', 'Forward A', 'GTAAAACGACGGCCAGT'],
      [duplicate ? '001' : '002', 'Forward B', 'GTAAAACGACGGCCAGT'],
    ]),
    'Primers'
  );
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
}
const connection: SheetSyncConnection = {
  schema: 'dnaforge.sheet-sync',
  schemaVersion: 1,
  id: 'd788e456-ebdf-4672-818c-d5e6a1ff99b4',
  importSetId: 'import-set',
  source: {
    path: '/master.xlsx',
    sheetName: 'Primers',
    keyColumn: 'Stable ID',
    forcedKind: 'oligo',
    columnMappings: [],
  },
  destinationRelativePath: '',
  revision: `sha256:${'a'.repeat(64)}`,
  enabled: true,
  pending: null,
  finalization: null,
  checkpoints: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.views = [];
  mocks.dialog.mockResolvedValue('/master.xlsx');
  mocks.readFile.mockResolvedValue(workbook());
  mocks.create.mockResolvedValue({ connection });
  mocks.createGoogle.mockResolvedValue({ connection });
  mocks.load.mockResolvedValue({ connection });
  mocks.retain.mockReturnValue(mocks.release);
  mocks.authorization.mockResolvedValue('required');
});
async function open() {
  fireEvent.click(screen.getByTestId('sheet-sync-open'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Choose Excel workbook' })).not.toBeDisabled()
  );
}
describe('Excel sync connection controls', () => {
  it('previews an actual workbook and connects distinct durable rows through the product action', async () => {
    render(<SheetSyncManagerButton />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Choose Excel workbook' }));
    await screen.findByText('2 records ready');
    expect(screen.getByLabelText('Spreadsheet unique ID column')).toHaveValue('Stable ID');
    expect(screen.getByLabelText('Map Name')).toHaveValue('entity.name');
    expect(screen.getByText('Forward A')).toBeInTheDocument();
    expect(screen.getByText('Forward B')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sheet-sync-connect'));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/project',
        source: expect.objectContaining({
          path: '/master.xlsx',
          sheetName: 'Primers',
          keyColumn: 'Stable ID',
        }),
      })
    );
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledWith('/project', connection.id));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.release).toHaveBeenCalled();
    expect(screen.getByTestId('sheet-sync-open')).toHaveFocus();
  });
  it('blocks duplicate IDs before enabling a connection', async () => {
    mocks.readFile.mockResolvedValue(workbook(true));
    render(<SheetSyncManagerButton />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Choose Excel workbook' }));
    await screen.findByText(/Spreadsheet row key is duplicated/);
    expect(screen.getByTestId('sheet-sync-connect')).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('requires a local workbook choice before authorizing a portable connection', async () => {
    mocks.views = [
      {
        kind: 'authorization-required',
        workspaceRoot: '/project',
        connectionId: connection.id,
        provider: 'local-excel',
        sourcePath: '/master.xlsx',
        sheetName: 'Primers',
      },
    ];
    render(<SheetSyncManagerButton />);
    await open();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose workbook' }));
    await waitFor(() =>
      expect(mocks.authorize).toHaveBeenCalledWith('/project', connection, '/master.xlsx')
    );
    expect(mocks.enabled).toHaveBeenCalledWith('/project', connection.id, true);
  });
});

describe('Google Sheets mapping connection controls', () => {
  it('uses native selected sheet data in the shared mapping preview and connects only stable provider identity', async () => {
    const cell = (display: string) => ({ kind: 'value', display, value: display });
    mocks.googleMetadata.mockResolvedValue({
      id: 'source-id',
      title: 'Master',
      sheets: [{ id: 17, title: 'Primers' }],
    });
    mocks.googleWorksheet.mockResolvedValue({
      spreadsheetId: 'source-id',
      sheetId: 17,
      sheetTitle: 'Primers',
      revision: `sha256:${'a'.repeat(64)}`,
      rows: [
        ['Stable ID', 'Name', 'Sequence'].map(cell),
        ['001', 'Native sheet primer', 'GTAAAACGACGGCCAGT'].map(cell),
      ],
    });
    render(<SheetSyncManagerButton />);
    await open();
    await screen.findByRole('option', { name: 'lab@example.test' });
    fireEvent.change(screen.getByLabelText('Google spreadsheet link or ID'), {
      target: { value: 'https://docs.google.com/spreadsheets/d/source-id/edit#gid=17' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load worksheets' }));
    await screen.findByRole('option', { name: 'Primers' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview this worksheet' }));
    await screen.findByText('1 records ready');
    expect(screen.getByLabelText('Spreadsheet unique ID column')).toHaveValue('Stable ID');
    expect(screen.getByText('Native sheet primer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sheet-sync-connect'));
    await waitFor(() => expect(mocks.createGoogle).toHaveBeenCalledOnce());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.dialog).not.toHaveBeenCalled();
    const request = mocks.createGoogle.mock.calls[0][0];
    expect(request.source).toMatchObject({
      provider: 'google-sheets',
      spreadsheetId: 'source-id',
      sheetId: 17,
      keyColumn: 'Stable ID',
    });
    expect(request.grantId).toBe('dedfe665-c77c-465a-a561-fe0d65cbcd5b');
    expect(request.source).not.toHaveProperty('grantId');
  });
});
