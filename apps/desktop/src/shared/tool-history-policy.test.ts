// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  isHistoryReactivatableTool,
  toolHistoryPolicy,
  validateToolHistoryPolicy,
} from './tool-history-policy';

describe('tool history policy', () => {
  it('registers only safe presentation restorations and defaults every other tool to inspect-only', () => {
    expect(toolHistoryPolicy('open_tab')).toEqual({
      mode: 'reactivate',
      handler: 'open-tab',
      label: 'Show',
    });
    expect(toolHistoryPolicy('highlight_range')).toEqual({
      mode: 'reactivate',
      handler: 'highlight-range',
      label: 'Show',
    });
    expect(toolHistoryPolicy('finalize_design_assembly')).toEqual({ mode: 'inspect-only' });
    expect(isHistoryReactivatableTool('close_tab')).toBe(false);
  });

  it('matches known manifest tools and handlers', () => {
    expect(validateToolHistoryPolicy()).toEqual([]);
  });
});
