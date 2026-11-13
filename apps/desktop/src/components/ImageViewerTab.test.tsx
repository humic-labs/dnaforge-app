// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ImageViewerTab } from './ImageViewerTab';

afterEach(() => {
  cleanup();
});

const readFileBoundedMock = vi.fn();

vi.mock('../platform', () => ({
  platform: vi.fn(() => ({
    fs: {
      readFileBounded: readFileBoundedMock,
      readTextFile: vi.fn().mockResolvedValue(''),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
      readDir: vi.fn().mockResolvedValue([]),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 0, isFile: true, isDirectory: false, mtime: 0 }),
      exists: vi.fn().mockResolvedValue(false),
      rename: vi.fn().mockResolvedValue(undefined),
    },
  })),
  initPlatform: vi.fn().mockResolvedValue(undefined),
}));

describe('ImageViewerTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileBoundedMock.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-image');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loading path (DNA — Blob URL, not file://)', () => {
    it('reads the file bytes over IPC and renders a same-origin blob URL', async () => {
      render(<ImageViewerTab filePath="/path/to/figure.png" />);

      await waitFor(() => {
        const img = screen.getByRole('img') as HTMLImageElement;
        expect(img.getAttribute('src')).toBe('blob:mock-image');
      });
      expect(readFileBoundedMock).toHaveBeenCalledWith('/path/to/figure.png', 256 * 1024 * 1024);
      expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it('surfaces a read error instead of a broken image', async () => {
      readFileBoundedMock.mockRejectedValueOnce(new Error('EACCES'));
      render(<ImageViewerTab filePath="/path/to/locked.png" />);
      await waitFor(() => {
        expect(screen.getByText('Failed to load image')).toBeInTheDocument();
      });
    });

    it('revokes the blob URL on path change and on unmount (no object-URL leak)', async () => {
      let n = 0;
      (URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation(
        () => `blob:mock-${++n}`
      );

      const { rerender, unmount } = render(<ImageViewerTab filePath="/a.png" />);
      await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mock-1'));

      rerender(<ImageViewerTab filePath="/b.png" />);
      await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mock-2'));
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');

      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
    });
  });

  describe('browser mode (mock image)', () => {
    it('shows filename in header', async () => {
      render(<ImageViewerTab filePath="/path/to/photo.jpg" />);

      await waitFor(
        () => {
          expect(screen.getByText('photo.jpg')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it('renders image element', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          const img = screen.getByRole('img');
          expect(img).toBeInTheDocument();
          expect(img).toHaveAttribute('alt', 'image.png');
        },
        { timeout: 2000 }
      );
    });
  });

  describe('zoom controls', () => {
    it('has Fit button', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByText('Fit')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it('has percentage zoom buttons', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByText('25%')).toBeInTheDocument();
          expect(screen.getByText('50%')).toBeInTheDocument();
          expect(screen.getByText('100%')).toBeInTheDocument();
          expect(screen.getByText('200%')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it('has zoom in/out buttons', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByTitle('Zoom in')).toBeInTheDocument();
          expect(screen.getByTitle('Zoom out')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it('Fit is active by default', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          const fitButton = screen.getByText('Fit');
          expect(fitButton).toHaveClass('bg-accent/10');
        },
        { timeout: 2000 }
      );
    });

    it('changes active zoom when clicking different level', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByText('100%')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      const hundredPercentButton = screen.getByText('100%');
      fireEvent.click(hundredPercentButton);

      expect(hundredPercentButton).toHaveClass('bg-accent/10');

      const fitButton = screen.getByText('Fit');
      expect(fitButton).not.toHaveClass('bg-accent/10');
    });
  });

  describe('copy path functionality', () => {
    it('has copy path button', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByText('Copy Path')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it('copies path to clipboard when clicked', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      render(<ImageViewerTab filePath="/path/to/myimage.png" />);

      await waitFor(
        () => {
          expect(screen.getByText('Copy Path')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      fireEvent.click(screen.getByText('Copy Path'));

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith('/path/to/myimage.png');
      });
    });
  });

  describe('footer hint', () => {
    it('shows hint for fit mode', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByText(/Double-click for 100%/)).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it('shows hint for zoomed mode', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByText('100%')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      fireEvent.click(screen.getByText('100%'));

      expect(screen.getByText(/Drag to pan/)).toBeInTheDocument();
    });
  });

  describe('double click behavior', () => {
    it('toggles between fit and 100% on double click', async () => {
      render(<ImageViewerTab filePath="/path/to/image.png" />);

      await waitFor(
        () => {
          expect(screen.getByRole('img')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      const container = screen.getByRole('img').parentElement;
      expect(container).not.toBeNull();

      expect(screen.getByText('Fit')).toHaveClass('bg-accent/10');

      fireEvent.doubleClick(container!);

      expect(screen.getByText('100%')).toHaveClass('bg-accent/10');
      expect(screen.getByText('Fit')).not.toHaveClass('bg-accent/10');

      fireEvent.doubleClick(container!);

      expect(screen.getByText('Fit')).toHaveClass('bg-accent/10');
    });
  });
});
