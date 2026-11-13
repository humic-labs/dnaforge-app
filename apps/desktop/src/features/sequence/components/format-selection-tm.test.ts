// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { formatSelectionTm } from './format-selection-tm';
import type { LocalTmReadout } from '../../design/algorithms/local-tm';

describe('formatSelectionTm', () => {
  it('shows a single temperature for an unambiguous selection', () => {
    const result = formatSelectionTm({ kind: 'value', tm: 58.4 }, null);
    expect(result.text).toBe('58°C');
  });

  it('shows a RANGE for a degenerate selection, never one number', () => {
    const readout: LocalTmReadout = {
      kind: 'range',
      minTm: 57.8,
      maxTm: 62.3,
      meanTm: 60.1,
      combinations: 32,
    };
    const result = formatSelectionTm(readout, null);
    expect(result.text).toBe('58–62°C');
    expect(result.text).not.toBe('60°C');
  });

  it('explains the range on hover, naming how many sequences it is', () => {
    const readout: LocalTmReadout = {
      kind: 'range',
      minTm: 57.8,
      maxTm: 62.3,
      meanTm: 60.1,
      combinations: 32,
    };
    const { title } = formatSelectionTm(readout, null);
    expect(title).toContain('32');
    expect(title).toContain('degenerate');
    expect(title).toContain('57.8');
    expect(title).toContain('62.3');
  });

  it('collapses a range that rounds to one degree, without printing 60–60', () => {
    const readout: LocalTmReadout = {
      kind: 'range',
      minTm: 59.9,
      maxTm: 60.1,
      meanTm: 60.0,
      combinations: 4,
    };
    expect(formatSelectionTm(readout, null).text).toBe('~60°C');
  });

  it('renders a visible placeholder WITH a reason when indeterminate', () => {
    const readout: LocalTmReadout = {
      kind: 'indeterminate',
      reason: 'too-degenerate',
      detail: 'This selection has too many degenerate positions.',
    };
    const result = formatSelectionTm(readout, null);
    expect(result.text).toBe('—');
    expect(result.title).toBe('This selection has too many degenerate positions.');
  });

  it('renders nothing at all when there is no selection', () => {
    expect(formatSelectionTm(null, null).text).toBeNull();
    expect(formatSelectionTm(undefined, undefined).text).toBeNull();
  });

  it('falls back to the plain number for callers not passing a readout', () => {
    expect(formatSelectionTm(null, 61.6).text).toBe('62°C');
  });
});
