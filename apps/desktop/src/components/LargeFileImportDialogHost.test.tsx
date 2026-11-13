import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LargeFileImportDialogRequest } from '../shared/large-file-import-dialog';
import { LargeFileImportDialogHost } from './LargeFileImportDialogHost';

let requestListener: ((request: LargeFileImportDialogRequest) => void) | null = null;
let cancelListener: ((requestId: string) => void) | null = null;
const respond = vi.fn();

vi.mock('../platform', () => ({
  platform: () => ({
    largeFileImportDialog: {
      onRequest: (listener: (request: LargeFileImportDialogRequest) => void) => {
        requestListener = listener;
        return () => {
          requestListener = null;
        };
      },
      onCancel: (listener: (requestId: string) => void) => {
        cancelListener = listener;
        return () => {
          cancelListener = null;
        };
      },
      respond,
    },
  }),
}));

function request(
  overrides: Partial<LargeFileImportDialogRequest> = {}
): LargeFileImportDialogRequest {
  return {
    requestId: 'large-files-1',
    files: [{ relPath: 'Export.zip', sizeBytes: 2.6 * 1024 ** 3 }],
    thresholdBytes: 1024 ** 3,
    ...overrides,
  };
}

describe('LargeFileImportDialogHost', () => {
  beforeEach(() => {
    requestListener = null;
    cancelListener = null;
    respond.mockReset();
  });

  afterEach(() => cleanup());

  it('renders the large-file choice in DNAForge UI and returns the copy policy', async () => {
    render(<LargeFileImportDialogHost />);
    act(() => requestListener?.(request()));

    const dialog = screen.getByTestId('large-file-import-dialog');
    expect(dialog).toHaveAttribute('data-large-file-import-ui', 'dnaforge-v1');
    expect(dialog).toHaveClass('bg-bg', 'border-border');
    expect(screen.getByText('Export.zip')).toBeVisible();
    expect(screen.getByText('2.6 GB')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy into DNAForge' })).toHaveFocus()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy into DNAForge' }));
    expect(respond).toHaveBeenCalledWith('large-files-1', {
      requestId: 'large-files-1',
      policy: 'copy',
    });
  });

  it('returns the symlink policy from the keep-in-place action', () => {
    render(<LargeFileImportDialogHost />);
    act(() => requestListener?.(request()));

    fireEvent.click(screen.getByRole('button', { name: 'Keep files in place' }));
    expect(respond).toHaveBeenCalledWith('large-files-1', {
      requestId: 'large-files-1',
      policy: 'symlink',
    });
  });

  it('fails closed from Escape, the backdrop, or a main-process cancellation', () => {
    render(<LargeFileImportDialogHost />);
    act(() => requestListener?.(request()));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(respond).toHaveBeenLastCalledWith('large-files-1', {
      requestId: 'large-files-1',
      policy: 'cancel',
    });

    act(() => requestListener?.(request({ requestId: 'large-files-2' })));
    fireEvent.mouseDown(screen.getByTestId('large-file-import-dialog-backdrop'));
    expect(respond).toHaveBeenLastCalledWith('large-files-2', {
      requestId: 'large-files-2',
      policy: 'cancel',
    });

    act(() => requestListener?.(request({ requestId: 'large-files-3' })));
    act(() => cancelListener?.('large-files-3'));
    expect(screen.queryByTestId('large-file-import-dialog')).not.toBeInTheDocument();
  });

  it('summarizes additional large files without overwhelming the dialog', () => {
    render(<LargeFileImportDialogHost />);
    act(() =>
      requestListener?.(
        request({
          files: Array.from({ length: 7 }, (_, index) => ({
            relPath: `file-${index + 1}.zip`,
            sizeBytes: (index + 2) * 1024 ** 3,
          })),
        })
      )
    );

    expect(screen.getByText('And 2 more files')).toBeVisible();
    expect(screen.queryByText('file-6.zip')).not.toBeInTheDocument();
  });
});
