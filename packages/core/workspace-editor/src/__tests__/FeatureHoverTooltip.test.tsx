// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureHoverTooltip } from '../FeatureHoverTooltip';

describe('FeatureHoverTooltip', () => {
  it('renders the title + detail lines, portaled to document.body', () => {
    const { baseElement } = render(
      <FeatureHoverTooltip
        testId="tip"
        title="yagG gene"
        lines={['gene • 1414..2796 bp', '→ Forward']}
        clientX={100}
        clientY={100}
      />
    );
    const tip = screen.getByTestId('tip');
    expect(tip.closest('body')).toBe(baseElement);
    expect(tip.textContent).toContain('yagG gene');
    expect(tip.textContent).toContain('gene • 1414..2796 bp');
    expect(tip.textContent).toContain('→ Forward');
  });

  it('is theme-aware (matches the WebGL tooltip), not a hardcoded black box', () => {
    render(<FeatureHoverTooltip testId="tip" title="P" lines={[]} clientX={10} clientY={10} />);
    const tip = screen.getByTestId('tip');
    expect(tip.style.backgroundColor).toBe('hsl(var(--color-bg-subtle))');
    expect(tip.style.color).toBe('hsl(var(--color-fg))');
    expect(tip.style.position).toBe('fixed');
    expect(tip.style.left).toBe('22px');
    expect(tip.style.top).toBe('22px');
  });

  it('allows the additional region line when flipping above the bottom of the viewport', () => {
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 200, 90));
    const clientY = window.innerHeight - 90;
    try {
      render(
        <FeatureHoverTooltip
          testId="tip"
          title="insN"
          lines={['CDS • 690 bp →', 'Exon 1', 'M • Methionine']}
          clientX={100}
          clientY={clientY}
        />
      );
      const tip = screen.getByTestId('tip');
      expect(tip.textContent).toContain('Exon 1');
      expect(Number.parseFloat(tip.style.top)).toBeLessThan(clientY);
    } finally {
      bounds.mockRestore();
    }
  });

  it('keeps a taller modification tooltip inside the viewport using its measured height', () => {
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 200, 180));
    try {
      render(
        <FeatureHoverTooltip
          testId="tip"
          title="Modified primer"
          lines={['5′ phosphorylation /5Phos/', 'Internal Biotin-dT /iBiodT/']}
          clientX={100}
          clientY={window.innerHeight - 20}
        />
      );
      expect(screen.getByTestId('tip').style.top).toBe(`${window.innerHeight - 20 - 12 - 180}px`);
    } finally {
      bounds.mockRestore();
    }
  });
});
