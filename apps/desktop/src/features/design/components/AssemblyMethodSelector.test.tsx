import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_CUT_SITE_STYLE, internalCutSiteBadgeDomStyle } from '@waypoint/sequence-utils';
import type { DesignRegion } from '../types';
import { AssemblyMethodSelector } from './AssemblyMethodSelector';

function pcrRegion(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

describe('AssemblyMethodSelector enzyme picker', () => {
  it('labels each enzyme option with internal cut sites before the enzyme is selected', () => {
    render(
      <AssemblyMethodSelector
        method="goldengate"
        enzyme="BsaI"
        regions={[pcrRegion('p1', 'AAAAGGTCTCAAAA'), pcrRegion('p2', 'TTTGAAGACTTT')]}
        onChange={vi.fn()}
      />
    );

    const trigger = screen.getByTestId('assembly-enzyme-select');
    expect(trigger).toHaveTextContent('BsaI');
    expect(trigger).not.toHaveTextContent('internal cut');
    const closedBadge = screen.getByTestId('assembly-enzyme-select-warn');
    expect(closedBadge).toHaveTextContent(INTERNAL_CUT_SITE_STYLE.badgeChar);
    const expected = internalCutSiteBadgeDomStyle();
    expect(closedBadge.querySelector('[data-testid="internal-cut-site-badge"]')).toHaveStyle({
      backgroundColor: expected.backgroundColor,
      color: expected.color,
      border: expected.border,
      width: `${expected.width}px`,
      height: `${expected.height}px`,
    });

    fireEvent.click(trigger);
    expect(screen.getByTestId('assembly-enzyme-select-menu')).toHaveAttribute(
      'data-placement',
      'below'
    );
    const bsaOption = screen.getByTestId('assembly-enzyme-option-BsaI');
    expect(bsaOption).toHaveTextContent('BsaI');
    expect(bsaOption).toHaveTextContent('1 internal cut');
    expect(bsaOption.querySelector('[data-testid="internal-cut-site-badge"]')).toHaveTextContent(
      INTERNAL_CUT_SITE_STYLE.badgeChar
    );
    expect(screen.getByTestId('assembly-enzyme-option-BbsI')).toHaveTextContent('1 internal cut');
    expect(screen.getByTestId('assembly-enzyme-option-BsmBI')).toHaveTextContent('BsmBI');
    expect(screen.getByTestId('assembly-enzyme-option-BsmBI')).not.toHaveTextContent(
      'internal cut'
    );
    expect(screen.getByTestId('assembly-enzyme-option-BsaI')).toHaveAttribute(
      'data-internal-site-count',
      '1'
    );
    expect(screen.getByTestId('assembly-enzyme-option-BsmBI')).toHaveAttribute(
      'data-internal-site-count',
      '0'
    );
  });

  it('keeps the selected enzyme independent of the preview labels', () => {
    const onChange = vi.fn();
    render(
      <AssemblyMethodSelector
        method="goldengate"
        enzyme="BsaI"
        regions={[pcrRegion('p1', 'AAAAGGTCTCAAAA')]}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByTestId('assembly-enzyme-select'));
    fireEvent.click(screen.getByTestId('assembly-enzyme-option-BbsI'));
    expect(onChange).toHaveBeenCalledWith('goldengate', 'BbsI');
  });
});
