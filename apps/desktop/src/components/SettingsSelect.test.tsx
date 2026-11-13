import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsSelect } from './SettingsSubsection';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    bottom: 140,
    left: 80,
    right: 280,
    width: 200,
    height: 40,
    x: 80,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect);
});

describe('SettingsSelect', () => {
  it('opens immediately below its trigger and uses the shared non-native menu', () => {
    render(
      <SettingsSelect
        ariaLabel="Approval policy"
        value="auto"
        onValueChange={() => {}}
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'always', label: 'Always ask' },
        ]}
        testId="approval-policy"
      />
    );

    expect(document.querySelector('select')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Approval policy' }));
    const menu = screen.getByRole('listbox', { name: 'Approval policy' });
    expect(menu).toBeVisible();
    expect(menu.style.top).toBe('144px');
    expect(menu.style.bottom).toBe('');
  });

  it('supports keyboard selection without opening a system picker', () => {
    const onValueChange = vi.fn();
    render(
      <SettingsSelect
        ariaLabel="Approval policy"
        value="auto"
        onValueChange={onValueChange}
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'destructive-only', label: 'Destructive only' },
          { value: 'always', label: 'Always ask' },
        ]}
      />
    );

    const trigger = screen.getByRole('combobox', { name: 'Approval policy' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('destructive-only');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
