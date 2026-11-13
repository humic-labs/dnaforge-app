import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { AnnotationsDrawerContent } from './annotations-drawer';

const base = {
  filePath: '/t.gb',
  annotations: [],
  circular: true,
  sequenceLength: 3000,
  onAnnotationClick: vi.fn(),
  onAnnotationSave: vi.fn(),
  onAnnotationDelete: vi.fn(),
  onRunPlannotate: vi.fn(),
  plannotateStatus: 'idle' as const,
  sequenceVersion: 0,
};

const plannotateContent = () => screen.queryByRole('button', { name: /run plannotate/i });

describe('AnnotationsDrawerContent — tab ownership (single source of truth)', () => {
  it('is fully CONTROLLED: a tab click requests via onTabChange but does not self-switch', () => {
    const onTabChange = vi.fn();
    render(
      <AnnotationsDrawerContent {...base} activeTab="annotations" onTabChange={onTabChange} />
    );
    fireEvent.click(screen.getByRole('tab', { name: /plannotate/i }));
    expect(onTabChange).toHaveBeenCalledWith('plannotate');
    expect(plannotateContent()).toBeNull();
  });

  it('renders exactly the tab given by activeTab', () => {
    const { rerender } = render(
      <AnnotationsDrawerContent {...base} activeTab="annotations" onTabChange={vi.fn()} />
    );
    expect(plannotateContent()).toBeNull();
    rerender(<AnnotationsDrawerContent {...base} activeTab="plannotate" onTabChange={vi.fn()} />);
    expect(plannotateContent()).toBeInTheDocument();
  });

  it('with the parent owning the state, a click switches the tab AND survives a drawer remount', () => {
    function Owner({ remountKey }: { remountKey: number }) {
      const [tab, setTab] = useState<'annotations' | 'plannotate'>('annotations');
      return (
        <div>
          <span data-testid="owner-tab">{tab}</span>
          <AnnotationsDrawerContent
            key={remountKey}
            {...base}
            activeTab={tab}
            onTabChange={setTab}
          />
        </div>
      );
    }

    const { rerender } = render(<Owner remountKey={0} />);
    fireEvent.click(screen.getByRole('tab', { name: /plannotate/i }));
    expect(screen.getByTestId('owner-tab').textContent).toBe('plannotate');
    expect(plannotateContent()).toBeInTheDocument();

    rerender(<Owner remountKey={1} />);
    expect(screen.getByTestId('owner-tab').textContent).toBe('plannotate');
    expect(plannotateContent()).toBeInTheDocument();
  });
});
