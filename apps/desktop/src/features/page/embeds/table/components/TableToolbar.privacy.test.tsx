import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { installAnalyticsFirehose } from '../../../../../lib/analytics-firehose';
import { TableToolbar } from './TableToolbar';

describe('replacement draft authored-ingress dependency gate', () => {
  it('excludes the actual replacement descendants, aggregate parent and keyboard before private reads', () => {
    render(
      <TableToolbar
        rows={2}
        cols={2}
        onAddRow={vi.fn()}
        onRemoveRow={vi.fn()}
        onAddColumn={vi.fn()}
        onRemoveColumn={vi.fn()}
        onExportCSV={vi.fn()}
        onCopyToClipboard={async () => {}}
        onReplaceTable={() => true}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replace table…' }));
    const draft = screen.getByRole('textbox', { name: 'Replacement table data' });
    fireEvent.change(draft, { target: { value: 'NONFUNCTIONAL_REPLACEMENT_DRAFT_SENTINEL' } });
    const form = screen.getByRole('form', { name: 'Replace table' });
    const parent = form.parentElement!;
    const child = document.createElement('span');
    child.textContent = 'NONFUNCTIONAL_REPLACEMENT_CHILD_SENTINEL';
    form.appendChild(child);
    const publicControl = document.createElement('button');
    publicControl.textContent = 'Open';
    publicControl.dataset.testid = 'f28-public-control';
    document.body.appendChild(publicControl);
    const capture = vi.fn();
    const privateRead = vi.fn(() => 'NONFUNCTIONAL_REPLACEMENT_PRIVATE_SENTINEL');
    const restorations: Array<() => void> = [];
    let clock = 5_000;
    const uninstall = installAnalyticsFirehose({
      capture,
      now: () => {
        clock += 1_000;
        return clock;
      },
    });
    const types = ['click', 'focusin', 'wheel', 'keydown'];
    const stopAfterIngress = (event: Event) => event.stopImmediatePropagation();
    for (const type of types) window.addEventListener(type, stopAfterIngress, { capture: true });
    try {
      fireEvent.click(publicControl);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(
        'interaction_observed',
        expect.objectContaining({ target_test_id: 'f28-public-control' })
      );
      capture.mockClear();
      for (const target of [draft, form, parent, child]) {
        for (const property of ['textContent', 'ariaLabel']) {
          const descriptor = Object.getOwnPropertyDescriptor(target, property);
          Object.defineProperty(target, property, { configurable: true, get: privateRead });
          restorations.push(() => {
            if (descriptor) Object.defineProperty(target, property, descriptor);
            else Reflect.deleteProperty(target, property);
          });
        }
        for (const type of types) {
          const event =
            type === 'keydown'
              ? new KeyboardEvent(type, {
                  bubbles: true,
                  composed: true,
                  key: 'NONFUNCTIONAL_PRIVATE_KEY',
                })
              : new Event(type, { bubbles: true, composed: true });
          if (type === 'keydown') Object.defineProperty(event, 'key', { get: privateRead });
          fireEvent(target, event);
        }
      }
      expect(privateRead).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      uninstall();
      for (const type of types)
        window.removeEventListener(type, stopAfterIngress, { capture: true });
      for (const restore of restorations.reverse()) restore();
      child.remove();
      publicControl.remove();
    }
  });
});
