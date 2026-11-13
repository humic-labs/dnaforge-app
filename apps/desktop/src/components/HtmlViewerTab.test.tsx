import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({ fs: { readTextFile: mocks.readTextFile } }),
}));

vi.mock('../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (p: string) => p,
}));

import { HtmlViewerTab } from './HtmlViewerTab';

const SAMPLE_HTML = '<html><body><h1>QC Report</h1><p>passed</p></body></html>';

describe('HtmlViewerTab ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readTextFile.mockResolvedValue(SAMPLE_HTML);
  });

  it('renders the HTML in a fully-sandboxed iframe by default (no scripts)', async () => {
    render(<HtmlViewerTab filePath="/ws/report.html" />);
    const iframe = await screen.findByTestId('html-viewer-iframe');
    expect(iframe).toHaveAttribute('srcdoc', SAMPLE_HTML);
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('enabling scripts adds ONLY allow-scripts — never allow-same-origin', async () => {
    render(<HtmlViewerTab filePath="/ws/report.html" />);
    await screen.findByTestId('html-viewer-iframe');

    fireEvent.click(screen.getByTestId('html-viewer-enable-scripts'));

    const iframe = await screen.findByTestId('html-viewer-iframe');
    const sandbox = iframe.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('source mode shows the raw HTML as escaped text (no iframe)', async () => {
    render(<HtmlViewerTab filePath="/ws/report.html" />);
    await screen.findByTestId('html-viewer-iframe');

    fireEvent.click(screen.getByTestId('html-viewer-mode-source'));

    const source = await screen.findByTestId('html-viewer-source');
    expect(source.textContent).toContain('<h1>QC Report</h1>');
    expect(screen.queryByTestId('html-viewer-iframe')).toBeNull();
  });

  it('shows the loading placeholder while the read is in flight, then clears it', async () => {
    let resolveRead!: (html: string) => void;
    mocks.readTextFile.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        })
    );

    render(<HtmlViewerTab filePath="/ws/report.html" />);
    expect(screen.getByText('Loading HTML…')).toBeInTheDocument();
    expect(screen.queryByTestId('html-viewer-iframe')).toBeNull();

    resolveRead(SAMPLE_HTML);

    const iframe = await screen.findByTestId('html-viewer-iframe');
    expect(iframe).toHaveAttribute('srcdoc', SAMPLE_HTML);
    expect(screen.queryByText('Loading HTML…')).toBeNull();
  });

  it('copies the file path to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<HtmlViewerTab filePath="/ws/report.html" />);
    await screen.findByTestId('html-viewer-iframe');

    fireEvent.click(screen.getByText('Copy Path'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/ws/report.html'));
  });

  it('surfaces a read error instead of mounting an iframe', async () => {
    mocks.readTextFile.mockRejectedValue(new Error('EACCES: permission denied'));
    render(<HtmlViewerTab filePath="/ws/locked.html" />);
    expect(await screen.findByText('Failed to open HTML')).toBeInTheDocument();
    expect(screen.queryByTestId('html-viewer-iframe')).toBeNull();
  });

  it('re-reads and resets scripts-off when the file path changes', async () => {
    const { rerender } = render(<HtmlViewerTab filePath="/ws/a.html" />);
    await screen.findByTestId('html-viewer-iframe');
    fireEvent.click(screen.getByTestId('html-viewer-enable-scripts'));
    expect(screen.getByTestId('html-viewer-iframe').getAttribute('sandbox')).toBe('allow-scripts');

    mocks.readTextFile.mockResolvedValue('<p>second file</p>');
    rerender(<HtmlViewerTab filePath="/ws/b.html" />);

    await waitFor(() =>
      expect(screen.getByTestId('html-viewer-iframe')).toHaveAttribute(
        'srcdoc',
        '<p>second file</p>'
      )
    );
    expect(screen.getByTestId('html-viewer-iframe').getAttribute('sandbox')).toBe('');
    expect(mocks.readTextFile).toHaveBeenCalledTimes(2);
  });
});
