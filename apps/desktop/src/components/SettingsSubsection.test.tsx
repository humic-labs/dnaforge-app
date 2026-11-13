import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SettingsRow,
  SettingsSection,
  SettingsToggle,
  SettingsSegmentedControl,
  SettingsSelect,
} from './SettingsSubsection';

describe('Shared settings presentation', () => {
  it('keeps keyboard selection when a menu appears under a stationary pointer', () => {
    const change = vi.fn();
    render(
      <SettingsSelect
        ariaLabel="Settings section"
        value="appearance"
        options={[
          { value: 'profile', label: 'Profile' },
          { value: 'privacy', label: 'Privacy' },
          { value: 'migrations', label: 'Migrations' },
          { value: 'appearance', label: 'Appearance' },
        ]}
        onValueChange={change}
      />
    );
    const picker = screen.getByRole('combobox', { name: 'Settings section' });
    fireEvent.keyDown(picker, { key: ' ' });
    fireEvent.keyDown(picker, { key: 'Home' });
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Migrations' }));
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(change).toHaveBeenCalledWith('privacy');

    fireEvent.keyDown(picker, { key: ' ' });
    fireEvent.mouseMove(screen.getByRole('option', { name: 'Migrations' }));
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(change).toHaveBeenLastCalledWith('migrations');
  });

  it('gives every section a visible heading and associates a row label with its field', () => {
    render(
      <SettingsSection title="General" description="Organization preferences">
        <SettingsRow label="Name" htmlFor="organization-name">
          <input id="organization-name" defaultValue="Test lab" />
        </SettingsRow>
      </SettingsSection>
    );
    expect(screen.getByRole('heading', { name: 'General' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'General' })).toContainElement(
      screen.getByLabelText('Name')
    );
  });

  it('explains a disabled preference without calling a permission restriction coming soon', () => {
    render(
      <SettingsToggle
        label="Sharing"
        checked
        disabled
        disabledReason={userMessage('settings.managedByOrganization')}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('switch', { name: 'Sharing' })).toBeDisabled();
    expect(screen.getByText('Managed by your organization')).toBeVisible();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('exposes the selected theme and still calls the owning preference handler', () => {
    const change = vi.fn();
    render(
      <SettingsSegmentedControl
        value="dark"
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        onChange={change}
      />
    );
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(change).toHaveBeenCalledWith('light');
  });
});
