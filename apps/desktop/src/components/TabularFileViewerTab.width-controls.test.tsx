import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabularFileViewerTab } from './TabularFileViewerTab';

const ports = vi.hoisted(() => ({
  stat: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  open: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: { stat: ports.stat, readTextFile: ports.read, writeTextFileAtomic: ports.write },
    shell: {},
  }),
}));
vi.mock('../hooks/resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));
vi.mock('../features/canvas/store', () => {
  const state = {
    panels: {},
    openInFocusedPanel: ports.open,
    updateTabByEntityId: ports.update,
  };
  return {
    useCanvasStore: Object.assign((selector: (state: unknown) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        font: '',
        measureText: (text: string) => ({ width: text.length * 8 }),
      }) as CanvasRenderingContext2D
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('file-backed table column width controls', () => {
  it.each([
    ['csv', ','],
    ['tsv', '\t'],
  ])(
    'exposes, drags and auto-fits %s column widths without writing file contents',
    async (extension, delimiter) => {
      const text = `Name${delimiter}Sequence\nprimer-1${delimiter}ACGTACGTACGTACGTACGTACGTACGTACGT\n`;
      ports.stat.mockResolvedValue({ size: text.length, isFile: true });
      ports.read.mockResolvedValue(text);
      render(<TabularFileViewerTab filePath={`/workspace/primers.${extension}`} />);
      await screen.findByTestId('tabular-file-viewer');
      const header = screen.getByTestId('table-column-header-B');
      const handle = header.querySelector('[data-column-resize-handle]');
      expect(handle).not.toBeNull();
      expect(handle).toBeVisible();
      fireEvent.pointerDown(handle!, { clientX: 80 });
      fireEvent.pointerMove(document, { clientX: 160 });
      fireEvent.pointerUp(document);
      expect(document.querySelectorAll('colgroup col')[2]).toHaveStyle({ width: '160px' });
      fireEvent.doubleClick(handle!);
      expect(
        parseInt((document.querySelectorAll('colgroup col')[2] as HTMLElement).style.width)
      ).toBeGreaterThan(160);
      expect(screen.getByText('ACGTACGTACGTACGTACGTACGTACGTACGT')).toBeVisible();
      expect(ports.write).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('switch', { name: /first row/i }));
      expect(
        screen.getByTestId('table-column-header-B').querySelector('[data-column-resize-handle]')
      ).toBeVisible();
      expect(ports.write).not.toHaveBeenCalled();
    }
  );

  it('does not offer file mutations for a read-only table', async () => {
    ports.stat.mockResolvedValue({ size: 22, isFile: true });
    ports.read.mockResolvedValue('Name,Sequence\nP1,ACGT\n');
    render(<TabularFileViewerTab filePath="/workspace/read-only.csv" readOnly />);
    await screen.findByTestId('tabular-file-viewer');
    expect(document.querySelector('[data-column-resize-handle]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
  });
});
