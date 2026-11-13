// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AnnotationSummaryStatus } from './AnnotationSummaryStatus';

describe('AnnotationSummaryStatus', () => {
  it('hides when the summary tile is ready', () => {
    const { container } = render(
      <AnnotationSummaryStatus
        state="ready"
        fidelity="summary"
        recordCount={12}
        sourceRecordCount={12}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows updating copy while the summary tile is pending', () => {
    render(
      <AnnotationSummaryStatus
        state="loading"
        fidelity="summary"
        message="Fetching chr1"
        recordCount={0}
        sourceRecordCount={40}
      />
    );
    const banner = screen.getByTestId('indexed-genome-summary-state');
    expect(banner).toHaveAttribute('data-tile-state', 'loading');
    expect(banner).toHaveAttribute('data-fidelity', 'summary');
    expect(banner).toHaveAttribute('data-record-count', '0');
    expect(banner).toHaveAttribute('data-source-record-count', '40');
    expect(banner.textContent).toContain('Updating annotations…');
    expect(banner.textContent).toContain('Fetching chr1');
    expect(banner.textContent).not.toContain('coordinate shell');
  });

  it('shows out-of-date copy when the summary tile is stale', () => {
    render(
      <AnnotationSummaryStatus
        state="stale"
        fidelity="summary"
        recordCount={12}
        sourceRecordCount={12}
      />
    );
    const banner = screen.getByTestId('indexed-genome-summary-state');
    expect(banner).toHaveAttribute('data-tile-state', 'stale');
    expect(banner.textContent).toContain('Annotation summary is out of date.');
    expect(banner.textContent).not.toContain('Updating annotations…');
  });
});
