import { describe, expect, it } from 'vitest';
import { UI_FIELD_CLASS, UI_READONLY_FIELD_CLASS, UI_TEXTAREA_CLASS } from './styles';

describe('field focus visibility', () => {
  it.each([
    ['editable field', UI_FIELD_CLASS],
    ['multi-line field', UI_TEXTAREA_CLASS],
    ['read-only field', UI_READONLY_FIELD_CLASS],
  ])('a %s that hides the browser outline shows a focus border instead', (_label, classes) => {
    expect(classes).toContain('focus:outline-none');
    expect(classes).toMatch(/\bfocus:border-accent\b/);
  });
});
