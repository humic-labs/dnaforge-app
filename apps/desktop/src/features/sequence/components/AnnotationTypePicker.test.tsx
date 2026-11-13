import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnnotationTypePicker } from './AnnotationTypePicker';

afterEach(cleanup);

const REGISTRY = [
  { trackId: 'gene', label: 'gene', order: 0, visible: true },
  { trackId: 'mRNA', label: 'mRNA', order: 1, visible: true },
  { trackId: 'enhancer', label: 'Enhancer', order: 2, visible: true },
  { trackId: 'lncRNA', label: 'lncRNA', order: 3, visible: true },
  { trackId: 'miRNA', label: 'miRNA', order: 4, visible: true },
  { trackId: 'centromere', label: 'centromere', order: 5, visible: true },
  { trackId: 'biological_region', label: 'biological_region', order: 6, visible: true },
  { trackId: 'novel_type', label: 'novel_type', order: 7, visible: true },
];

async function openPicker() {
  fireEvent.click(screen.getByTestId('annotation-type-picker-summary'));
  await waitFor(() => {
    expect(screen.getByTestId('annotation-type-picker').getAttribute('data-morphed')).toBe('true');
  });
}

describe('AnnotationTypePicker (flyout)', () => {
  it('shows an orienting summary with active badges, not a bare fraction', () => {
    render(
      <AnnotationTypePicker
        registry={REGISTRY}
        visibleTypes={new Set(['gene', 'mRNA'])}
        onToggleVisibleType={vi.fn()}
        onSetVisibleTypes={vi.fn()}
      />
    );
    const summary = screen.getByTestId('annotation-type-picker-summary');
    expect(summary).toHaveTextContent('Annotations');
    expect(screen.getByTestId('annotation-type-picker-count')).toHaveTextContent('2 of 8');
    expect(screen.getByTestId('annotation-type-picker-summary-badges')).toHaveTextContent('gene');
    expect(screen.getByTestId('annotation-type-picker-summary-badges')).toHaveTextContent('mRNA');
    const badge = screen.getByTestId('annotation-type-picker-summary-badges').querySelector('span');
    expect(badge?.className).toMatch(/rounded-full/);
    expect(screen.queryByTestId('annotation-type-picker')).toBeNull();
  });

  it('overflows extra active types as +N', () => {
    render(
      <AnnotationTypePicker
        registry={REGISTRY}
        visibleTypes={new Set(['gene', 'mRNA', 'enhancer', 'lncRNA', 'miRNA'])}
        onToggleVisibleType={vi.fn()}
        onSetVisibleTypes={vi.fn()}
      />
    );
    expect(screen.getByTestId('annotation-type-picker-count')).toHaveTextContent('5 of 8');
    expect(screen.getByTestId('annotation-type-picker-summary-overflow')).toHaveTextContent('+2');
  });

  it('morphs an anchored flyout from the collapsed surface with presets + groups', async () => {
    const onToggle = vi.fn();
    const onSet = vi.fn();
    render(
      <div data-testid="track-gutter-row-lane:reference">
        <AnnotationTypePicker
          registry={REGISTRY}
          visibleTypes={new Set(['gene', 'mRNA'])}
          onToggleVisibleType={onToggle}
          onSetVisibleTypes={onSet}
        />
      </div>
    );
    await openPicker();
    const panel = screen.getByTestId('annotation-type-picker');
    expect(panel.getAttribute('data-flyout')).toBe('true');
    expect(screen.getByTestId('annotation-type-picker-summary-expanded')).toBeTruthy();
    expect(panel.parentElement).toBe(document.body);
    expect(panel.getAttribute('role')).toBe('group');
    expect(screen.queryByTestId('annotation-type-picker-backdrop')).toBeNull();
    expect(screen.getByTestId('annotation-type-presets')).toBeTruthy();
    expect(screen.getByTestId('annotation-type-group-genes')).toBeTruthy();
    expect(screen.getByTestId('annotation-type-group-rna')).toBeTruthy();
    expect(screen.getByTestId('annotation-type-group-regulatory')).toBeTruthy();
    expect(screen.getByTestId('annotation-type-group-structure')).toBeTruthy();
    expect(screen.getByTestId('annotation-type-group-regions')).toBeTruthy();
    expect(screen.getByTestId('annotation-type-group-other')).toBeTruthy();

    fireEvent.click(screen.getByTestId('annotation-type-enhancer'));
    expect(onToggle).toHaveBeenCalledWith('enhancer');

    const enhancer = screen.getByTestId('annotation-type-enhancer');
    expect(enhancer.className).toMatch(/rounded-full/);
    const lnc = screen.getByTestId('annotation-type-lncRNA');
    expect(lnc.getAttribute('aria-pressed')).toBe('false');
    expect(lnc.className).toMatch(/rounded-full/);
    expect(lnc.className).toMatch(/border/);

    const regulatory = screen.getByTestId('annotation-type-group-regulatory');
    const regulatoryLabels = [...regulatory.querySelectorAll('button')].map((b) => b.textContent);
    expect(regulatoryLabels).toEqual(
      [...regulatoryLabels].sort((a, b) =>
        (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base' })
      )
    );

    fireEvent.click(screen.getByTestId('annotation-type-preset-all'));
    const allArg = onSet.mock.calls[0][0] as Set<string>;
    expect(allArg.size).toBe(8);
  });

  it('applies the Genes preset', async () => {
    const onSet = vi.fn();
    render(
      <AnnotationTypePicker
        registry={REGISTRY}
        visibleTypes={new Set(['enhancer'])}
        onToggleVisibleType={vi.fn()}
        onSetVisibleTypes={onSet}
      />
    );
    await openPicker();
    fireEvent.click(screen.getByTestId('annotation-type-preset-genes'));
    expect([...(onSet.mock.calls[0][0] as Set<string>)].sort()).toEqual(['gene', 'mRNA']);
  });

  it('collapses on Escape and on chip toggle', async () => {
    render(
      <AnnotationTypePicker
        registry={REGISTRY}
        visibleTypes={new Set(['gene'])}
        onToggleVisibleType={vi.fn()}
        onSetVisibleTypes={vi.fn()}
      />
    );
    const chip = screen.getByTestId('annotation-type-picker-summary');
    await openPicker();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('annotation-type-picker')).toBeNull();
    });

    await openPicker();
    fireEvent.click(chip);
    await waitFor(() => {
      expect(screen.queryByTestId('annotation-type-picker')).toBeNull();
    });
  });

  it('filters across groups', async () => {
    render(
      <AnnotationTypePicker
        registry={REGISTRY}
        visibleTypes={new Set(['gene'])}
        onToggleVisibleType={vi.fn()}
        onSetVisibleTypes={vi.fn()}
      />
    );
    await openPicker();
    fireEvent.change(screen.getByTestId('annotation-type-filter'), {
      target: { value: 'enh' },
    });
    expect(screen.getByTestId('annotation-type-group-regulatory')).toHaveTextContent('Enhancer');
    expect(screen.queryByTestId('annotation-type-group-genes')).toBeNull();
  });
});
