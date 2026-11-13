import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LimsImportDropZone } from './LimsImportDropZone';

describe('LimsImportDropZone', () => {
  it('shows the type-specific copy and returns the file chosen via the browse input', () => {
    const onFile = vi.fn();
    render(
      <LimsImportDropZone label="primers" hint="CSV, TSV, or Excel" accept=".csv" onFile={onFile} />
    );
    expect(screen.getByTestId('lims-import-dropzone')).toHaveTextContent(/primers/i);

    const file = new File(['x'], 'p.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByTestId('lims-import-drop-input'), { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('accepts a drop ANYWHERE in the window, not just on the dashed box', () => {
    const onFile = vi.fn();
    render(<LimsImportDropZone label="strains" hint="CSV" accept=".csv" onFile={onFile} />);
    const file = new File(['x'], 's.csv', { type: 'text/csv' });
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [file] } });
    document.body.dispatchEvent(dropEvent);
    expect(onFile).toHaveBeenCalledWith(file);
  });
});
