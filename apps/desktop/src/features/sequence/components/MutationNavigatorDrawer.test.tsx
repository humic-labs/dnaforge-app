import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { annotationTypeBadgeStyle } from '@waypoint/genome-renderer/pure';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeVariantSourceState } from '../../../shared/indexed-genome';
import type { MutationAnnotationImpactState } from '../mutation-annotation-impact';
import type { VariantSummary } from '../variant-client';
import { MutationNavigatorDrawer } from './MutationNavigatorDrawer';

const SOURCE: IndexedGenomeVariantSourceState = {
  sourcePath: '/data/HG002.vcf.gz',
  queryPath: '/data/HG002.vcf.gz',
  indexPath: '/data/HG002.vcf.gz.tbi',
  format: 'vcf',
  label: 'HG002.vcf.gz',
  sourceSizeBytes: 123,
  sourceMtimeNs: '456',
  sourceIdentity: 'a'.repeat(64),
  matchedReferences: ['chr1'],
  samples: ['HG002'],
  attachedAt: 1,
};

const VARIANT: VariantSummary = {
  id: 'coding-snv',
  recordId: null,
  chrom: 'chr1',
  start: 924_532,
  end: 924_533,
  position: 924_533,
  ref: 'A',
  alts: ['G'],
  quality: 60,
  filters: ['PASS'],
  variantClass: 'substitution',
  genotypes: { HG002: '0/1' },
};

const IMPACT: MutationAnnotationImpactState = {
  status: 'ready',
  impact: {
    variantId: VARIANT.id,
    overlapsAnnotation: true,
    overlapsCds: true,
    codingEffect: { label: 'CDS substitution', frameEffect: null },
    annotations: [
      { type: 'gene', label: 'SAMD11', start: 923_922, end: 944_574, strand: '+' },
      {
        type: 'mRNA',
        label: 'NM_001385640.1',
        start: 923_922,
        end: 944_574,
        strand: '+',
      },
      {
        type: 'CDS',
        label: 'NP_001372569.1',
        start: 924_431,
        end: 924_948,
        strand: '+',
      },
    ],
    hiddenAnnotationCount: 0,
    truncated: false,
  },
};

describe('MutationNavigatorDrawer', () => {
  it('shows an attached real call source, selects a row, and keeps paging available', () => {
    const onSelectVariant = vi.fn();
    renderDrawer({
      selectedVariantId: null,
      nextCursor: 'next',
      onSelectVariant,
    });

    expect(screen.getByText('HG002.vcf.gz')).toBeVisible();
    expect(screen.getByText('chr1:924,533')).toBeVisible();
    expect(screen.getByText('A → G')).toBeVisible();
    expect(screen.getByText('HG002 0/1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'chr1:924,533 A → G' }));
    expect(onSelectVariant).toHaveBeenCalledWith(VARIANT);
    expect(screen.getByRole('button', { name: 'Load more mutations' })).toBeEnabled();
  });

  it('offers the manual source path without pretending calls already exist', () => {
    const onChooseSource = vi.fn();
    renderDrawer({
      source: null,
      variants: [],
      annotationImpacts: new Map(),
      selectedVariantId: null,
      onChooseSource,
    });

    expect(screen.getByText(/choose a called-variant file/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Choose VCF or BCF…' }));
    expect(onChooseSource).toHaveBeenCalledTimes(1);
  });

  it('keeps a preparation failure visible and recoverable', () => {
    renderDrawer({
      source: null,
      variants: [],
      annotationImpacts: new Map(),
      selectedVariantId: null,
      error: userMessage('variant.assemblyMismatch'),
    });

    expect(screen.getByRole('alert')).toHaveTextContent(userMessage('variant.assemblyMismatch'));
    expect(screen.getByRole('button', { name: 'Choose VCF or BCF…' })).toBeEnabled();
  });

  it('defaults to a wider drawer and expands the selected mutation annotation impact', () => {
    renderDrawer();

    expect(screen.getByTestId('mutation-navigator')).toHaveStyle({ width: '460px' });
    const row = screen.getByRole('button', { name: 'chr1:924,533 A → G' });
    expect(within(row).getByText('CDS substitution')).toBeInTheDocument();
    expect(within(row).getByText('Affected annotations')).toBeInTheDocument();
    expect(within(row).getAllByText('SAMD11')).toHaveLength(2);
    expect(within(row).getAllByText('NM_001385640.1')).toHaveLength(2);
    expect(within(row).getByText('NP_001372569.1')).toBeInTheDocument();
    const cdsStyle = annotationTypeBadgeStyle('CDS', 'light');
    expect(within(row).getByText('CDS')).toHaveStyle({
      background: cdsStyle.background,
      color: cdsStyle.color,
    });
  });

  it('keeps the coding summary compact until the mutation is selected', () => {
    renderDrawer({ selectedVariantId: null });

    const row = screen.getByRole('button', { name: 'chr1:924,533 A → G' });
    expect(within(row).getByText('CDS substitution')).toBeInTheDocument();
    expect(within(row).getByText('SAMD11')).toBeInTheDocument();
    expect(within(row).queryByText('Affected annotations')).not.toBeInTheDocument();
    expect(within(row).queryByText('NP_001372569.1')).not.toBeInTheDocument();
  });

  it('selects the row without making annotation loading a separate user action', () => {
    const onSelectVariant = vi.fn();
    renderDrawer({
      selectedVariantId: null,
      annotationImpacts: new Map([[VARIANT.id, { status: 'loading' }]]),
      onSelectVariant,
    });

    const row = screen.getByRole('button', { name: 'chr1:924,533 A → G' });
    expect(within(row).getByText('Checking reference annotations…')).toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelectVariant).toHaveBeenCalledWith(VARIANT);
  });
});

function renderDrawer(
  overrides: Partial<ComponentProps<typeof MutationNavigatorDrawer>> = {}
): void {
  render(
    <MutationNavigatorDrawer
      open
      source={SOURCE}
      variants={[VARIANT]}
      annotationImpacts={new Map([[VARIANT.id, IMPACT]])}
      selectedVariantId={VARIANT.id}
      nextCursor={null}
      phase="idle"
      error={null}
      trimmed={false}
      themeMode="light"
      onClose={vi.fn()}
      onChooseSource={vi.fn()}
      onLoadMore={vi.fn()}
      onSelectVariant={vi.fn()}
      {...overrides}
    />
  );
}
