// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FeatureDetailsInspector } from './FeatureDetailsInspector';
import type { FeatureDetailsState } from './useIndexedFeatureDetails';

const annotation = {
  id: 'feat-1',
  name: 'BRCA1',
  type: 'mRNA',
  chrom: 'chr17',
  start: 100,
  end: 200,
};

describe('FeatureDetailsInspector', () => {
  it('takes no layout or visual space while idle', () => {
    render(<FeatureDetailsInspector state={{ kind: 'idle' }} />);
    expect(screen.queryByTestId('indexed-genome-feature-inspector')).toBeNull();
    expect(screen.queryByText('Select an annotation')).toBeNull();
  });

  it('shows loading copy for the selected annotation', () => {
    render(
      <FeatureDetailsInspector state={{ kind: 'loading', annotation } as FeatureDetailsState} />
    );
    const inspector = screen.getByTestId('indexed-genome-feature-inspector');
    expect(inspector).toHaveAttribute('data-state', 'loading');
    expect(inspector).toHaveClass('ml-auto', 'min-w-48', 'shrink-0', 'justify-end');
    expect(inspector).not.toHaveClass(
      'absolute',
      'pointer-events-none',
      'rounded-md',
      'border',
      'shadow-sm'
    );
    expect(inspector).not.toHaveClass('h-9');
    expect(inspector.textContent).toContain('BRCA1');
    expect(inspector.textContent).toContain('Loading details');
  });

  it('shows related-record and window counts when ready', () => {
    render(
      <FeatureDetailsInspector
        state={
          {
            kind: 'ready',
            annotation,
            details: {
              feature: {
                id: 'feat-1',
                type: 'mRNA',
                start: 100,
                end: 200,
                attributes: { ID: ['NM_007294'] },
              },
              featureId: 'feat-1',
              relatedFeatures: [{}, {}],
              window: { start: 43044294, end: 43125483 },
              truncated: true,
            },
          } as FeatureDetailsState
        }
      />
    );
    const inspector = screen.getByTestId('indexed-genome-feature-inspector');
    expect(inspector.textContent).toContain('NM_007294');
    expect(inspector.textContent).toContain('2 related records');
    expect(inspector.textContent).toContain('43,044,294');
    expect(inspector.textContent).toContain('43,125,483');
    expect(inspector.textContent).toContain('Details limited');
  });

  it('omits the source id when it matches the displayed label', () => {
    render(
      <FeatureDetailsInspector
        state={
          {
            kind: 'ready',
            annotation,
            details: {
              feature: {
                id: 'feat-1',
                type: 'mRNA',
                start: 100,
                end: 200,
                attributes: { ID: ['BRCA1'] },
              },
              featureId: 'BRCA1',
              relatedFeatures: [],
              window: { start: 1, end: 2 },
              truncated: false,
            },
          } as FeatureDetailsState
        }
      />
    );
    const inspector = screen.getByTestId('indexed-genome-feature-inspector');
    expect(inspector.textContent).toContain('BRCA1');
    expect(inspector.textContent?.split('BRCA1').length).toBe(2);
  });
});
