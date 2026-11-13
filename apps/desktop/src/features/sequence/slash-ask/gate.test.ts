import { describe, it, expect } from 'vitest';
import { canOpenSlashAsk, isTextEntryElement, type SlashAskGateEnv } from './gate';

function base(overrides: Partial<SlashAskGateEnv> = {}): SlashAskGateEnv {
  return {
    isEditMode: false,
    activeElement: null,
    hasOpenDialog: false,
    ...overrides,
  };
}

function el(tag: string, contentEditable = false): Element {
  const node = document.createElement(tag);
  if (contentEditable) {
    Object.defineProperty(node, 'isContentEditable', { value: true, configurable: true });
  }
  return node;
}

describe('canOpenSlashAsk — the `/` app-state gate  regression guard)', () => {
  it('opens when nothing is being typed and no dialog is open (focus location irrelevant)', () => {
    expect(canOpenSlashAsk(base())).toBe(true);
  });

  it('does NOT open in base-edit mode (`/` is a literal base-typing keystroke)', () => {
    expect(canOpenSlashAsk(base({ isEditMode: true }))).toBe(false);
  });

  it('does NOT open when an INPUT is focused', () => {
    expect(canOpenSlashAsk(base({ activeElement: el('input') }))).toBe(false);
  });

  it('does NOT open when a TEXTAREA is focused', () => {
    expect(canOpenSlashAsk(base({ activeElement: el('textarea') }))).toBe(false);
  });

  it('does NOT open when a contenteditable is focused', () => {
    expect(canOpenSlashAsk(base({ activeElement: el('div', true) }))).toBe(false);
  });

  it('does NOT open when a modal dialog is open', () => {
    expect(canOpenSlashAsk(base({ hasOpenDialog: true }))).toBe(false);
  });

  it('a focused non-text element (the canvas div) does not block', () => {
    expect(canOpenSlashAsk(base({ activeElement: el('div') }))).toBe(true);
  });
});

describe('isTextEntryElement', () => {
  it.each(['input', 'textarea', 'select'])('%s is a text-entry element', (tag) => {
    expect(isTextEntryElement(el(tag))).toBe(true);
  });
  it('contenteditable is a text-entry element', () => {
    expect(isTextEntryElement(el('div', true))).toBe(true);
  });
  it('a plain div is not', () => {
    expect(isTextEntryElement(el('div'))).toBe(false);
  });
  it('null is not', () => {
    expect(isTextEntryElement(null)).toBe(false);
  });
});
