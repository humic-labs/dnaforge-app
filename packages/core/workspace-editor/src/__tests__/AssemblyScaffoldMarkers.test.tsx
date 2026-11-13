/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssemblyScaffoldHitTargets } from '../AssemblyScaffoldHitTargets';
import { DEFAULT_EDITOR_CONFIG, type LinePositions } from '../types';

describe('AssemblyScaffoldHitTargets', () => {
  it('uses the actual sequence-row geometry without painting another marker', () => {
    const onSelect = vi.fn();
    render(
      <AssemblyScaffoldHitTargets
        rulerSegments={[
          {
            start: 0,
            end: 24,
            color: '#64748b',
            regionId: 'empty-promoter',
            scaffold: {
              slotId: 'promoter',
              slotIndex: 0,
              label: 'Promoter',
              incomingOverhang: 'GGAG',
              outgoingOverhang: 'TACT',
            },
          },
        ]}
        linePositions={[
          {
            line: { startPos: 0, endPos: 24, sequence: '.'.repeat(24) },
            sequenceY: 100,
            complementY: 120,
          } as LinePositions,
        ]}
        sequenceLength={24}
        config={{ ...DEFAULT_EDITOR_CONFIG, charsPerLine: 70 }}
        selectedRegionId="empty-promoter"
        onSelect={onSelect}
      />
    );

    const scaffold = screen.getByRole('button', { name: 'Choose Promoter · GGAG → TACT' });
    expect(scaffold.textContent).toBe('');
    expect(scaffold.style.top).toBe('100px');
    expect(scaffold.style.width).toBe(`${24 * DEFAULT_EDITOR_CONFIG.charWidth}px`);
    expect(scaffold.getAttribute('aria-pressed')).toBe('true');
    expect(scaffold.style.background).toBe('transparent');
    expect(scaffold.style.border).toBe('0px');

    fireEvent.click(scaffold);
    expect(onSelect).toHaveBeenCalledWith('empty-promoter');
  });
});
