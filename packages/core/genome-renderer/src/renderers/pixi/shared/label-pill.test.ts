// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  PILL_LABEL_TEXT_DARK_THEME,
  pillLabelTextColor,
  pillLabelTextStyle,
  setPillLabelTheme,
} from './label-pill';

describe('pill label TextStyle cache', () => {
  it('bounds arbitrary annotation-color styles with least-recently-used eviction', () => {
    const first = pillLabelTextStyle(0xffffff, 12, 0);
    const second = pillLabelTextStyle(0xffffff, 12, 1);
    for (let color = 2; color < 64; color += 1) {
      pillLabelTextStyle(0xffffff, 12, color);
    }

    expect(pillLabelTextStyle(0xffffff, 12, 0)).toBe(first);
    pillLabelTextStyle(0xffffff, 12, 64);

    const reloadedSecond = pillLabelTextStyle(0xffffff, 12, 1);
    expect(reloadedSecond).not.toBe(second);
    expect(pillLabelTextStyle(0xffffff, 12, 1)).toBe(reloadedSecond);
    expect(pillLabelTextStyle(0xffffff, 12, 0)).toBe(first);
  });
});

describe('pill label text color by theme', () => {
  afterEach(() => setPillLabelTheme('light'));

  it('uses the floating-label off-white on dark fills in dark mode only', () => {
    setPillLabelTheme('light');
    expect(pillLabelTextColor(0x1d4ed8)).toBe(0xffffff);
    expect(pillLabelTextColor(0xfde68a)).toBe(0x888888);

    setPillLabelTheme('dark');
    expect(pillLabelTextColor(0x1d4ed8)).toBe(PILL_LABEL_TEXT_DARK_THEME);
    expect(pillLabelTextColor(0xfde68a)).toBe(0x888888);
    expect(pillLabelTextStyle(0x1d4ed8).fill).not.toBe(
      (setPillLabelTheme('light'), pillLabelTextStyle(0x1d4ed8).fill)
    );
  });
});
