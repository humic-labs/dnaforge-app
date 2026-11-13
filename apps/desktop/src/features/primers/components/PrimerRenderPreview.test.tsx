import { describe, it, expect, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { PrimerRenderPreview } from './PrimerRenderPreview';

describe('PrimerRenderPreview', () => {
  it('keeps observing width after Strict Mode remounts its effects', () => {
    const observed = new Set<Element>();
    class TrackedResizeObserver {
      private target?: Element;
      observe(target: Element) {
        this.target = target;
        observed.add(target);
      }
      disconnect() {
        if (this.target) observed.delete(this.target);
      }
    }
    vi.stubGlobal('ResizeObserver', TrackedResizeObserver);
    try {
      const { unmount } = render(
        <StrictMode>
          <PrimerRenderPreview display={null} />
        </StrictMode>
      );
      expect(observed.has(screen.getByTestId('primer-render-preview'))).toBe(true);
      unmount();
      expect(observed.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('shows a placeholder when there is no draft primer', () => {
    render(<PrimerRenderPreview display={null} />);
    expect(screen.getByTestId('primer-render-preview')).toBeInTheDocument();
    expect(screen.getByText(/enter a primer sequence/i)).toBeInTheDocument();
  });

  it('is read-only — it renders no editable input', () => {
    render(<PrimerRenderPreview display={null} />);
    const preview = screen.getByTestId('primer-render-preview');
    expect(preview.querySelector('input')).toBeNull();
    expect(preview.querySelector('textarea')).toBeNull();
  });
});
