// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  tableGridAlignButtonClass,
  tableGridFindWidth,
  tableGridFormatControlsDisabled,
  tableGridFormatToggleClass,
  tableGridSwatchColor,
} from './table-grid-format-classes';

describe('tableGridFormatControlsDisabled', () => {
  it('disables format controls without a selection or a format writer', () => {
    expect(tableGridFormatControlsDisabled({ startRow: 0 }, () => undefined)).toBe(false);
    expect(tableGridFormatControlsDisabled(null, () => undefined)).toBe(true);
    expect(tableGridFormatControlsDisabled({ startRow: 0 }, undefined)).toBe(true);
  });
});

describe('tableGridFormatToggleClass', () => {
  it('uses disabled, on, mixed, then idle in that order', () => {
    expect(tableGridFormatToggleClass(true, true)).toContain('opacity-40');
    expect(tableGridFormatToggleClass(false, true)).toContain('bg-accent');
    expect(tableGridFormatToggleClass(false, 'mixed')).toContain('bg-bg-muted');
    expect(tableGridFormatToggleClass(false, false)).toContain('wp-interactive');
  });
});

describe('tableGridAlignButtonClass / color / swatch', () => {
  it('marks the active alignment and falls color swatches back when mixed', () => {
    expect(tableGridAlignButtonClass(false, true)).toContain('bg-accent');
    expect(tableGridAlignButtonClass(true, true)).toContain('opacity-40');
    expect(tableGridSwatchColor('#ef4444', 'currentColor')).toBe('#ef4444');
    expect(tableGridSwatchColor('mixed', 'currentColor')).toBe('mixed');
    expect(tableGridSwatchColor(null, 'transparent')).toBe('transparent');
  });
});

describe('tableGridFindWidth', () => {
  it('expands the find field only while a search is active', () => {
    expect(tableGridFindWidth(true, 240, 48)).toBe(240);
    expect(tableGridFindWidth(false, 240, 48)).toBe(48);
  });
});
