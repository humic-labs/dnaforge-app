import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { readLiteralDocument } from '../features/document-opening/literal-document-open-check';
import { stageLiteralOpenSnapshot } from '../features/document-opening/literal-open-snapshot';
import { TabularFileViewerTab } from './TabularFileViewerTab';
import type { FileDocumentSnapshot } from '../shared/file-document';
import { parseTabularPreview } from '../shared/tabular-file';

const ports = vi.hoisted(() => ({ inspect: vi.fn(), commit: vi.fn(), readFile: vi.fn() }));
vi.mock('../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      stat: vi.fn().mockResolvedValue({ size: 21 }),
      readFile: ports.readFile,
      readTextFile: vi.fn(
        async (path: string) => `sample,value\n${path.includes('old') ? 'OLD' : 'CURRENT'},7\n`
      ),
      subscribeFileDocuments: vi.fn(),
      fileDocument: ports.inspect,
    },
  }),
}));
vi.mock('../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));
vi.mock('../lib/readable-content-telemetry', async (original) => ({
  ...(await original<typeof import('../lib/readable-content-telemetry')>()),
  commitReadableContent: ports.commit,
}));

function snapshot(path: string): FileDocumentSnapshot {
  return {
    documentId: path,
    path,
    revision: '1',
    ready: false,
    dirty: false,
    content: null,
    persistedContent: null,
    diskContent: null,
  } as FileDocumentSnapshot;
}

function stageAdmittedTable(path: string) {
  const text = 'sample,value\nADMITTED,7\n';
  const parsed = parseTabularPreview(text, { delimiter: ',', maxRows: 1000 });
  if (!parsed.ok) throw new Error(parsed.error);
  stageLiteralOpenSnapshot(path, {
    kind: 'table',
    format: 'delimited',
    delimiter: ',',
    preview: { parsed, text, size: text.length, bytesRead: text.length, slicedPreview: false },
  });
}

it('retires native document inspection before a replacement table can publish', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  let finishOld!: (snapshot: FileDocumentSnapshot) => void;
  ports.inspect.mockImplementation(({ target }) =>
    target.path.includes('old')
      ? new Promise<FileDocumentSnapshot>((resolve) => {
          finishOld = resolve;
        })
      : Promise.resolve(snapshot(target.path))
  );
  const { rerender } = render(<TabularFileViewerTab filePath="/workspace/old-ownership.csv" />);
  await waitFor(() => expect(ports.inspect).toHaveBeenCalledTimes(1));
  rerender(<TabularFileViewerTab filePath="/workspace/current-ownership.csv" />);
  expect(await screen.findByText('CURRENT')).toBeVisible();
  await act(async () => {
    finishOld(snapshot('/workspace/old-ownership.csv'));
  });
  expect(screen.getByText('CURRENT')).toBeVisible();
  expect(screen.queryByText('OLD')).toBeNull();
  expect(ports.commit).not.toHaveBeenCalledWith('/workspace/old-ownership.csv');
});

it.each([false, true])(
  'preserves admitted table contents or an existing native draft (dirty %s)',
  async (dirty) => {
    const path = dirty ? '/workspace/draft-snapshot.csv' : '/workspace/replaced-snapshot.csv';
    const sample = dirty ? 'DRAFT' : 'REPLACEMENT';
    const diskContent = 'sample,value\nREPLACEMENT,9\n';
    stageAdmittedTable(path);
    ports.inspect.mockResolvedValue({
      ...snapshot(path),
      type: 'csv',
      dirty,
      diskContent,
      persistedContent: diskContent,
      content: `sample,value\n${sample},9\n`,
      firstRowAsHeader: true,
      headerRowValues: ['sample', 'value'],
      tableData: {
        rows: 1,
        cols: 2,
        cells: [
          [
            { type: 'text', value: sample },
            { type: 'text', value: '9' },
          ],
        ],
      },
    });

    render(<TabularFileViewerTab filePath={path} />);

    expect(await screen.findByText(dirty ? 'DRAFT' : 'ADMITTED')).toBeVisible();
    expect(screen.queryByText('REPLACEMENT')).toBeNull();
    if (dirty) {
      expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    } else {
      expect(screen.getByText('preview only')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    }
  }
);

it('opens the admitted preview when the native editor loses access to that path', async () => {
  const path = '/workspace/missing-admitted.csv';
  stageAdmittedTable(path);
  ports.inspect.mockRejectedValueOnce(Object.assign(new Error('Missing file'), { code: 'ENOENT' }));

  render(<TabularFileViewerTab filePath={path} />);

  expect(await screen.findByText('ADMITTED')).toBeVisible();
  expect(screen.getByText('preview only')).toBeVisible();
});

it('opens the verified workbook preview without rereading the path', async () => {
  const path = '/workspace/admitted.xlsx';
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['sample', 'value'],
      ['VERIFIED WORKBOOK', 5],
    ]),
    'Samples'
  );
  ports.readFile
    .mockResolvedValueOnce(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }))
    .mockRejectedValue(new Error('Path replaced'));
  stageLiteralOpenSnapshot(path, await readLiteralDocument('table', path));

  render(<TabularFileViewerTab filePath={path} />);

  expect(await screen.findByText('VERIFIED WORKBOOK')).toBeVisible();
  expect(ports.readFile).toHaveBeenCalledTimes(1);
});
