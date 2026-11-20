import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

afterEach(cleanup);
it('requires an explicit spreadsheet source choice and shows only that source form', async () => {
  render(<SheetSyncManagerButton />);
  await open();
  expect(screen.queryByLabelText('Google spreadsheet link or ID')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Choose Google Sheet' }));
  expect(await screen.findByLabelText('Google spreadsheet link or ID')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Choose Excel workbook' }));
  await screen.findByText('2 records ready');
  expect(screen.queryByLabelText('Google spreadsheet link or ID')).toBeNull();
});
it('previews actual source samples and mapped scientific values before connecting', async () => {
  render(<SheetSyncManagerButton />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Choose Excel workbook' }));
  await screen.findByText('2 records ready');
  expect(screen.getByRole('columnheader', { name: 'Source sample' })).toBeVisible();
  const table = screen.getByRole('columnheader', { name: 'Sequence', exact: true }).closest('table')!;
  expect(within(table).getAllByRole('cell', { name: 'GTAAAACGACGGCCAGT' })).toHaveLength(2);
  expect(mocks.create).not.toHaveBeenCalled();
});
it('discards a late Excel read after the user chooses Google Sheets', async () => {
  let finish!: (value: Uint8Array) => void;
  mocks.readFile.mockReturnValueOnce(new Promise<Uint8Array>((resolve) => { finish = resolve; }));
  render(<SheetSyncManagerButton />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Choose Excel workbook' }));
  await waitFor(() => expect(mocks.readFile).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Choose Google Sheet' }));
  await act(async () => finish(workbook()));
  expect(screen.getByLabelText('Google spreadsheet link or ID')).toBeVisible();
  expect(screen.queryByText('2 records ready')).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});
