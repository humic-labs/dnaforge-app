import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InternalCutSiteStepper } from './InternalCutSiteStepper';

describe('InternalCutSiteStepper  #10)', () => {
  it('shows the N of M internal cut sites banner and dispatches steps', () => {
    const onStep = vi.fn();
    render(<InternalCutSiteStepper cutSiteCount={3} activeCutSiteIndex={1} onStep={onStep} />);

    expect(screen.getByTestId('internal-cut-site-stepper-label')).toHaveTextContent(
      '2 of 3 internal cut sites'
    );
    fireEvent.click(screen.getByTestId('internal-cut-site-next'));
    fireEvent.click(screen.getByTestId('internal-cut-site-prev'));
    expect(onStep).toHaveBeenNthCalledWith(1, 'next');
    expect(onStep).toHaveBeenNthCalledWith(2, 'prev');
  });

  it('shows an en-dash for the cursor when no site is active', () => {
    render(<InternalCutSiteStepper cutSiteCount={2} activeCutSiteIndex={null} onStep={vi.fn()} />);
    expect(screen.getByTestId('internal-cut-site-stepper-label')).toHaveTextContent(
      '– of 2 internal cut sites'
    );
  });

  it('singularizes the label for a single site', () => {
    render(<InternalCutSiteStepper cutSiteCount={1} activeCutSiteIndex={0} onStep={vi.fn()} />);
    expect(screen.getByTestId('internal-cut-site-stepper-label')).toHaveTextContent(
      '1 of 1 internal cut site'
    );
  });

  it('renders nothing when there are no internal cut sites', () => {
    const { container } = render(
      <InternalCutSiteStepper cutSiteCount={0} activeCutSiteIndex={null} onStep={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('internal-cut-site-stepper')).not.toBeInTheDocument();
  });
});
