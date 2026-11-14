import { documentLifecycle } from '../shared/document-lifecycle';
/** @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TabularFileViewerTab } from './TabularFileViewerTab';

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readTextFile: vi.fn(),
  readTextFileSlice: vi.fn(),
  writeTextFileAtomic: vi.fn(),
  revealItemInDir: vi.fn(),
  openInFocusedPanel: vi.fn(),
  updateTabByEntityId: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      stat: mocks.stat,
      readTextFile: mocks.readTextFile,
      readTextFileSlice: mocks.readTextFileSlice,
      writeTextFileAtomic: mocks.writeTextFileAtomic,
    },
    shell: {
      revealItemInDir: mocks.revealItemInDir,
    },
  }),
}));

vi.mock('../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));

vi.mock('../features/canvas/store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        openInFocusedPanel: mocks.openInFocusedPanel,
        updateTabByEntityId: mocks.updateTabByEntityId,
      }),
    { getState: () => ({ panels: {} }) }
  ),
}));

vi.mock('../features/canvas/oversize-scan', () => ({
  isMissingFileError: (error: unknown) =>
    (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
    ((error as Error)?.message ?? '').includes('ENOENT'),
}));

function mockFile(content: string, sizeBytes = new TextEncoder().encode(content).byteLength) {
  mocks.stat.mockResolvedValue({
    size: sizeBytes,
    isFile: true,
    isDirectory: false,
    mtime: 0,
  });
  mocks.readTextFile.mockResolvedValue(content);
  mocks.readTextFileSlice.mockResolvedValue({
    text: content,
    bytesRead: new TextEncoder().encode(content).byteLength,
  });
  mocks.writeTextFileAtomic.mockResolvedValue(undefined);
}

describe('TabularFileViewerTab', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', webcrypto);
  });

  it('renders a quoted CSV in the shared editable table grid', async () => {
    mockFile('sample,condition,notes\nA1,control,"alpha, beta"\nA2,treated,"line two"\n');

    render(<TabularFileViewerTab filePath="/ws/quoted-samples.csv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('tabular-file-toolbar')).toHaveClass('bg-bg');
    expect(screen.getByTestId('tabular-file-toolbar')).not.toHaveClass('bg-bg-subtle');
    expect(screen.getByTestId('tabular-file-toolbar-primary')).toHaveClass('items-center');
    expect(screen.getByTestId('tabular-file-actions')).toHaveClass('h-6', 'gap-1');
    expect(screen.getByRole('button', { name: /^save$/i })).toHaveClass('h-6', 'rounded-[5px]');
    expect(screen.getByRole('button', { name: /open as text/i })).toHaveClass(
      'h-6',
      'rounded-[5px]'
    );
    expect(screen.getByTestId('table-grid')).toBeInTheDocument();
    const grid = screen.getByTestId('table-grid');
    const lettersRow = screen.getByTestId('table-column-letters-row');
    const labelsRow = screen.getByTestId('table-column-labels-row');
    const body = grid.querySelector('tbody');
    expect(body).not.toBeNull();
    expect(within(lettersRow).getByText('A')).toBeInTheDocument();
    expect(within(lettersRow).getByText('B')).toBeInTheDocument();
    expect(within(labelsRow).getByText('sample')).toBeInTheDocument();
    expect(within(labelsRow).getByText('condition')).toBeInTheDocument();
    expect(within(lettersRow).queryByText('sample')).not.toBeInTheDocument();
    expect(within(body as HTMLElement).queryByText('sample')).not.toBeInTheDocument();
    expect(screen.getByText('alpha, beta')).toBeInTheDocument();
    expect(screen.getByText(/2 data rows/)).toBeInTheDocument();
    expect(screen.queryByText('editable values')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /first row/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('searches the shared table grid without mutating file contents', async () => {
    mockFile('sample,condition,notes\nA1,control,"alpha, beta"\nA2,treated,"line two"\n');

    render(<TabularFileViewerTab filePath="/ws/quoted-samples.csv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    expect(screen.queryByTestId('table-search-input')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('table-grid'), { key: 'f', ctrlKey: true });
    const search = screen.getByTestId('table-search-input');
    fireEvent.change(search, { target: { value: 'treated' } });

    expect(screen.getByText('treated')).toBeInTheDocument();
    expect(screen.queryByText('control')).not.toBeInTheDocument();
    expect(screen.getByTestId('table-search-count')).toHaveTextContent('1/2');
    expect(screen.queryByText('unsaved')).not.toBeInTheDocument();
  });

  it('renders a sliced preview for oversized TSV files instead of forcing raw text fallback', async () => {
    mockFile(
      '#tax_id\tGeneID\tSymbol\n9606\t1\tA1BG\n9606\t2\tA2M\n9606\t3\tA3GALT2\npartial',
      35 * 1024 * 1024
    );

    render(<TabularFileViewerTab filePath="/ws/homo_sapiens.gene_info.tsv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('table-grid')).toBeInTheDocument();
    expect(screen.getByText('#tax_id')).toBeInTheDocument();
    expect(screen.getByText('A1BG')).toBeInTheDocument();
    expect(screen.getByText(/preview rows/i)).toBeInTheDocument();
    expect(screen.getByText(/showing first/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('tabular-file-fallback')).not.toBeInTheDocument();
    expect(mocks.readTextFile).not.toHaveBeenCalled();
    expect(mocks.readTextFileSlice).toHaveBeenCalledWith(
      '/ws/homo_sapiens.gene_info.tsv',
      5 * 1024 * 1024
    );
  });

  it('uses tab delimiters for TSV so commas inside cells stay literal', async () => {
    mockFile('read\tsequence\tnote\nr1\tACGT\tcomma, inside\nr2\tTGCA\tok\n');

    render(<TabularFileViewerTab filePath="/ws/reads.tsv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('table-grid')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('comma, inside')).toBeInTheDocument();
    expect(screen.queryByText('comma')).not.toBeInTheDocument();
  });

  it('saves edited CSV cell values back to the source file without rich formatting', async () => {
    mockFile('sample,condition,notes\nA1,control,"alpha, beta"\nA2,treated,"line two"\n');

    render(<TabularFileViewerTab filePath="/ws/quoted-samples.csv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText('control'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'edited' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('unsaved')).toBeInTheDocument();
    });
    expect(documentLifecycle.dirty({ kind: 'file', filePath: '/ws/quoted-samples.csv' })).toBe(
      true
    );

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/ws/quoted-samples.csv',
          content: 'sample,condition,notes\nA1,edited,"alpha, beta"\nA2,treated,line two\n',
        })
      );
    });
    expect(screen.queryByText('unsaved')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(documentLifecycle.dirty({ kind: 'file', filePath: '/ws/quoted-samples.csv' })).toBe(
        false
      );
    });
  });

  it('records the original write failure and retains the unsaved cells', async () => {
    const filePath = '/ws/save-denied.csv';
    mockFile('sample,condition\nA1,control\n');
    const failure = new Error('EACCES: table write denied');
    mocks.writeTextFileAtomic.mockRejectedValueOnce(failure);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<TabularFileViewerTab filePath={filePath} />);
      await screen.findByTestId('tabular-file-viewer');
      fireEvent.doubleClick(screen.getByText('control'));
      const input = await screen.findByRole('textbox');
      fireEvent.change(input, { target: { value: 'edited' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await screen.findByText('unsaved');
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          '[TabularFileViewerTab] Save failed:',
          { filePath },
          failure
        )
      );
      expect(screen.getByText('edited')).toBeInTheDocument();
      expect(documentLifecycle.dirty({ kind: 'file', filePath })).toBe(true);
    } finally {
      report.mockRestore();
    }
  });

  it('preserves a newer cell edit and dirty state when an earlier save completes', async () => {
    mockFile('sample,condition\nA1,control\n');
    let completeWrite!: () => void;
    mocks.writeTextFileAtomic.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeWrite = resolve;
        })
    );
    render(<TabularFileViewerTab filePath="/ws/save-race.csv" />);
    await screen.findByTestId('tabular-file-viewer');
    fireEvent.doubleClick(screen.getByText('control'));
    let input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'first edit' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mocks.writeTextFileAtomic).toHaveBeenCalled());
    fireEvent.doubleClick(screen.getByText('first edit'));
    input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'newer human edit' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => completeWrite());
    expect(screen.getByText('newer human edit')).toBeInTheDocument();
    expect(screen.getByText('unsaved')).toBeInTheDocument();
    expect(documentLifecycle.dirty({ kind: 'file', filePath: '/ws/save-race.csv' })).toBe(true);
  });

  it('responds to a file save target so dirty table tabs can save before close', async () => {
    mockFile('sample,condition,notes\nA1,control,"alpha, beta"\nA2,treated,"line two"\n');

    render(<TabularFileViewerTab filePath="/ws/quoted-samples.csv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText('control'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'edited' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('unsaved')).toBeInTheDocument());

    await act(async () => {
      expect(
        await documentLifecycle.save({ kind: 'file', filePath: '/ws/quoted-samples.csv' })
      ).toBe(true);
    });

    await waitFor(() => {
      expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/ws/quoted-samples.csv',
          content: 'sample,condition,notes\nA1,edited,"alpha, beta"\nA2,treated,line two\n',
        })
      );
    });
    await waitFor(() => {
      expect(documentLifecycle.dirty({ kind: 'file', filePath: '/ws/quoted-samples.csv' })).toBe(
        false
      );
    });
  });

  it('saves edited first-row label values back to the source file as plain CSV data', async () => {
    mockFile('sample,condition,notes\nA1,control,"alpha, beta"\nA2,treated,"line two"\n');

    render(<TabularFileViewerTab filePath="/ws/quoted-samples.csv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByTestId('table-column-label-0'));
    const labelInput = await screen.findByTestId('table-column-label-input-0');
    fireEvent.change(labelInput, { target: { value: 'sample_id' } });
    fireEvent.keyDown(labelInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('unsaved')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/ws/quoted-samples.csv',
          content: 'sample_id,condition,notes\nA1,control,"alpha, beta"\nA2,treated,line two\n',
        })
      );
    });
  });

  it('can hide and re-show the first row as a column label row without changing file bytes', async () => {
    mockFile('sample,condition,notes\nA1,control,"alpha, beta"\nA2,treated,"line two"\n');

    render(<TabularFileViewerTab filePath="/ws/quoted-samples.csv" />);

    expect(await screen.findByTestId('tabular-file-viewer')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: /first row/i });
    const grid = screen.getByTestId('table-grid');
    const body = grid.querySelector('tbody') as HTMLElement;

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(
      within(screen.getByTestId('table-column-letters-row')).getByText('A')
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('table-column-labels-row')).getByText('sample')
    ).toBeInTheDocument();
    expect(within(body).queryByText('sample')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(
      within(screen.getByTestId('table-column-letters-row')).getByText('A')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('table-column-labels-row')).not.toBeInTheDocument();
    expect(within(body).getByText('sample')).toBeInTheDocument();
    expect(screen.getByText(/3 rows/)).toBeInTheDocument();
    expect(screen.queryByText('unsaved')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(
      within(screen.getByTestId('table-column-letters-row')).getByText('A')
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('table-column-labels-row')).getByText('sample')
    ).toBeInTheDocument();
    expect(within(body).queryByText('sample')).not.toBeInTheDocument();
    expect(screen.getByText(/2 data rows/)).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('control'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'edited' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(mocks.writeTextFileAtomic).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/ws/quoted-samples.csv',
          content: 'sample,condition,notes\nA1,edited,"alpha, beta"\nA2,treated,line two\n',
        })
      );
    });
  });

  it('shows a raw-text fallback action when parsing fails', async () => {
    mockFile('sample,notes\nA1,"unterminated\nA2,ok\n');

    render(<TabularFileViewerTab filePath="/ws/bad.csv" />);

    expect(await screen.findByTestId('tabular-file-fallback')).toBeInTheDocument();
    expect(screen.getByText(/could not be parsed as a CSV table/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open as text/i }));

    await waitFor(() => {
      expect(mocks.openInFocusedPanel).toHaveBeenCalledWith('text', '/ws/bad.csv', 'bad.csv');
    });
  });

  it('returns a read-time ENOENT to the canvas missing-file state', async () => {
    mocks.stat.mockResolvedValue({ size: 64, isFile: true, isDirectory: false, mtime: 0 });
    mocks.readTextFile.mockRejectedValue(
      new Error("Error invoking remote method 'fs:readTextFile': ENOENT: no such file")
    );

    render(<TabularFileViewerTab filePath="/ws/disappeared-after-stat.csv" />);

    await waitFor(() => {
      expect(mocks.updateTabByEntityId).toHaveBeenCalledWith('/ws/disappeared-after-stat.csv', {
        loadStatus: 'missing',
        fileSizeBytes: undefined,
      });
    });
    expect(screen.queryByText('Failed to open table')).not.toBeInTheDocument();
    expect(screen.queryByText(/ENOENT|no such file/i)).not.toBeInTheDocument();
  });
});
