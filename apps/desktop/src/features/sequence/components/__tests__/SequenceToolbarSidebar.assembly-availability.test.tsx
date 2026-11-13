// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SequenceToolbarSidebar } from '../SequenceToolbarSidebar';
import { DEFAULT_VIEWER_CONFIG } from '../../types';

afterEach(cleanup);
const defaults = { config: DEFAULT_VIEWER_CONFIG, onConfigChange: vi.fn() };

describe('associated Assembly control availability', () => {
  it('omits an unavailable closed Assembly control without an empty Details section', () => {
    render(
      <SequenceToolbarSidebar {...defaults} onOpenAssembly={vi.fn()} isAssemblyAvailable={false} />
    );
    expect(screen.queryByTestId('toolbar-assembly')).toBeNull();
    expect(screen.queryByTestId('sequence-toolbar-details-section')).toBeNull();
    expect(screen.getByTestId('toolbar-structure')).toBeDisabled();
  });

  it('retains Metadata when the associated Assembly is unavailable', () => {
    const onOpenMetadata = vi.fn();
    render(
      <SequenceToolbarSidebar
        {...defaults}
        onOpenMetadata={onOpenMetadata}
        onOpenAssembly={vi.fn()}
      />
    );
    expect(screen.queryByTestId('toolbar-assembly')).toBeNull();
    fireEvent.click(screen.getByTestId('toolbar-metadata'));
    expect(onOpenMetadata).toHaveBeenCalledTimes(1);
  });

  it('retains the enabled available Assembly action', () => {
    const onOpenAssembly = vi.fn();
    render(
      <SequenceToolbarSidebar {...defaults} onOpenAssembly={onOpenAssembly} isAssemblyAvailable />
    );
    expect(screen.getByTestId('toolbar-assembly')).toBeEnabled();
    fireEvent.click(screen.getByTestId('toolbar-assembly'));
    expect(onOpenAssembly).toHaveBeenCalledTimes(1);
  });

  it('keeps an open Assembly closable after availability is lost', () => {
    function Harness({ available }: { available: boolean }) {
      const [open, setOpen] = useState(true);
      return (
        <SequenceToolbarSidebar
          {...defaults}
          onOpenAssembly={() => setOpen(false)}
          isAssemblyOpen={open}
          isAssemblyAvailable={available}
        />
      );
    }
    const view = render(<Harness available />);
    view.rerender(<Harness available={false} />);
    const button = screen.getByTestId('toolbar-assembly');
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('data-active', 'true');
    fireEvent.click(button);
    expect(screen.queryByTestId('toolbar-assembly')).toBeNull();
  });

  it('does not invent an action when no Assembly callback exists', () => {
    render(<SequenceToolbarSidebar {...defaults} isAssemblyAvailable isAssemblyOpen />);
    expect(screen.queryByTestId('toolbar-assembly')).toBeNull();
  });
});
