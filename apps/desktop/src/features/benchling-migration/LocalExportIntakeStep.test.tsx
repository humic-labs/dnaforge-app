import { withUserMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocalExportIntakeStep } from './LocalExportIntakeStep';

vi.mock('../../platform', () => ({
  platform: () => ({
    workspace: {
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? '',
    },
  }),
}));

function exportFile(path?: string): File {
  const file = new File(['zip-bytes'], 'Export_-_2026-08-05.zip', { type: 'application/zip' });
  if (path !== undefined) Object.defineProperty(file, 'path', { value: path });
  return file;
}

function dropFiles(files: File[]) {
  fireEvent.drop(screen.getByTestId('benchling-migration-export-dropzone'), {
    dataTransfer: { files, types: ['Files'] },
  });
}

describe('LocalExportIntakeStep', () => {
  it('keeps the source screen mounted and blocks another drop while reading', () => {
    const onDropExport = vi.fn();
    const { rerender } = render(
      <LocalExportIntakeStep
        pendingState={null}
        onChooseExport={vi.fn()}
        onDropExport={onDropExport}
      />
    );
    const button = screen.getByTestId('benchling-migration-choose-export');
    const help = screen.getByTestId('benchling-export-video');
    rerender(
      <LocalExportIntakeStep
        pendingState="reading_export"
        onChooseExport={vi.fn()}
        onDropExport={onDropExport}
      />
    );
    expect(screen.getByTestId('benchling-migration-choose-export')).toBe(button);
    expect(screen.getByTestId('benchling-export-video')).toBe(help);
    dropFiles([exportFile('/Users/test/another.zip')]);
    expect(onDropExport).not.toHaveBeenCalled();
  });
  it('offers one primary file control and shows export help by default', () => {
    render(
      <LocalExportIntakeStep pendingState={null} onChooseExport={vi.fn()} onDropExport={vi.fn()} />
    );

    expect(screen.getByText('Drop your Benchling export here')).toBeVisible();
    expect(screen.getByTestId('benchling-migration-choose-export')).toHaveTextContent(
      'Choose file or folder…'
    );
    const video = screen.getByTestId('benchling-export-video');
    const close = screen.getByRole('button', { name: 'Close video' });
    expect(video).toBeVisible();
    expect(video.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts a run from a dropped export', async () => {
    const onDropExport = vi.fn(async () => undefined);
    render(
      <LocalExportIntakeStep
        pendingState={null}
        onChooseExport={vi.fn()}
        onDropExport={onDropExport}
      />
    );

    dropFiles([exportFile('/Users/x/Downloads/Export_-_2026-08-05.zip')]);

    await waitFor(() =>
      expect(onDropExport).toHaveBeenCalledWith('/Users/x/Downloads/Export_-_2026-08-05.zip')
    );
  });

  it('explains a drop whose path cannot be resolved instead of failing silently', async () => {
    const onDropExport = vi.fn(async () => undefined);
    render(
      <LocalExportIntakeStep
        pendingState={null}
        onChooseExport={vi.fn()}
        onDropExport={onDropExport}
      />
    );

    dropFiles([exportFile()]);

    expect(await screen.findByTestId('benchling-migration-drop-error')).toHaveTextContent(
      'Use the button below instead'
    );
    expect(onDropExport).not.toHaveBeenCalled();
  });

  it('surfaces a rejected export rather than leaving the modal looking idle', async () => {
    const onDropExport = vi.fn(async () => {
      throw withUserMessage(
        new Error('Drop a Benchling ZIP or HTML export.'),
        'guidance.drop-a-benchling-zip-or-html-export'
      );
    });
    render(
      <LocalExportIntakeStep
        pendingState={null}
        onChooseExport={vi.fn()}
        onDropExport={onDropExport}
      />
    );

    dropFiles([exportFile('/Users/x/Downloads/notes.zip')]);

    expect(await screen.findByTestId('benchling-migration-drop-error')).toHaveTextContent(
      'Drop a Benchling ZIP or HTML export.'
    );
  });

  it('keeps the drop target highlighted while the pointer crosses its own contents', () => {
    render(
      <LocalExportIntakeStep pendingState={null} onChooseExport={vi.fn()} onDropExport={vi.fn()} />
    );
    const zone = screen.getByTestId('benchling-migration-export-dropzone');

    fireEvent.dragEnter(zone);
    fireEvent.dragEnter(zone);
    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute('data-drag-active', 'true');

    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute('data-drag-active', 'false');
  });

  it('says the native file picker is opening before a file exists', () => {
    render(
      <LocalExportIntakeStep
        pendingState="opening_picker"
        onChooseExport={vi.fn()}
        onDropExport={vi.fn()}
      />
    );

    expect(screen.getByText('Opening file picker…')).toBeVisible();
    expect(screen.queryByText('Reading your export')).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-choose-export')).toBeDisabled();
  });

  it('says the export is being read only after a file is selected or dropped', () => {
    render(
      <LocalExportIntakeStep
        pendingState="reading_export"
        onChooseExport={vi.fn()}
        onDropExport={vi.fn()}
      />
    );

    expect(screen.getByText('Reading your export')).toBeVisible();
    expect(screen.getByTestId('benchling-migration-choose-export')).toBeDisabled();
    expect(screen.getByText('Drop your Benchling export here')).toBeVisible();
  });
});
