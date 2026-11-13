import { userMessage } from '@waypoint/user-messages';
/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndexedGenomeIsoformDialog } from './IndexedGenomeIsoformDialog';
import type { IndexedTranscriptIsoform } from './indexed-transcript-isoforms';

afterEach(cleanup);

const ISOFORMS: IndexedTranscriptIsoform[] = [
  {
    featureId: 'tx-1',
    geneId: 'gene-1',
    name: 'Isoform 1',
    chrom: 'chr1',
    start0: 100,
    end0: 900,
    strand: '+',
    isSelected: true,
  },
  {
    featureId: 'tx-2',
    geneId: 'gene-1',
    name: 'Isoform 2',
    chrom: 'chr1',
    start0: 140,
    end0: 840,
    strand: '+',
    isSelected: false,
  },
];

describe('IndexedGenomeIsoformDialog', () => {
  it('lets the user choose a sibling and copy that isoform as DNA or RNA', () => {
    const onCopy = vi.fn();
    render(
      <IndexedGenomeIsoformDialog
        state={{ kind: 'ready', isoforms: ISOFORMS, selectedFeatureId: 'tx-1' }}
        onSelect={vi.fn()}
        onCopy={onCopy}
        onCancel={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Isoform 2/ }));
    expect((screen.getByRole('radio', { name: /Isoform 2/ }) as HTMLInputElement).checked).toBe(
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy RNA' }));
    expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'tx-2' }), 'rna');
  });

  it('shows an explicit single-isoform explanation instead of an empty chooser', () => {
    render(
      <IndexedGenomeIsoformDialog
        state={{ kind: 'ready', isoforms: [ISOFORMS[0]!], selectedFeatureId: 'tx-1' }}
        onSelect={() => {}}
        onCopy={() => {}}
        onCancel={() => {}}
      />
    );

    expect(screen.getByText(/No alternative isoforms were found/)).toBeTruthy();
  });

  it('surfaces a bounded-lookup failure and offers no copy action', () => {
    render(
      <IndexedGenomeIsoformDialog
        state={{ kind: 'error', message: userMessage('sequence.isoformIncomplete') }}
        onSelect={() => {}}
        onCopy={() => {}}
        onCancel={() => {}}
      />
    );

    expect(screen.getByRole('alert').textContent).toContain('incomplete');
    expect(screen.queryByRole('button', { name: 'Copy DNA' })).toBeNull();
  });
});
