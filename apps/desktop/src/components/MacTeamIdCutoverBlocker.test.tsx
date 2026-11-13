import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  MacTeamIdCutoverBlocker,
  shouldShowMacTeamIdCutoverBlocker,
} from './MacTeamIdCutoverBlocker';

describe('macOS Team ID cutover platform gate', () => {
  it('blocks only a flagged macOS renderer', () => {
    expect(
      shouldShowMacTeamIdCutoverBlocker({
        cutoverEnabled: true,
        navigatorPlatform: 'MacIntel',
      })
    ).toBe(true);
    expect(
      shouldShowMacTeamIdCutoverBlocker({
        cutoverEnabled: false,
        navigatorPlatform: 'MacIntel',
      })
    ).toBe(false);
    expect(
      shouldShowMacTeamIdCutoverBlocker({
        cutoverEnabled: true,
        navigatorPlatform: 'Win32',
      })
    ).toBe(false);
    expect(
      shouldShowMacTeamIdCutoverBlocker({
        cutoverEnabled: true,
        navigatorPlatform: 'Linux x86_64',
      })
    ).toBe(false);
  });
});

describe('MacTeamIdCutoverBlocker copy', () => {
  it('states the confirmed account, one action, and local-data preservation', () => {
    render(<MacTeamIdCutoverBlocker />);

    expect(
      screen.getByText(/Apple has approved our official Developer Account/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/local projects will stay on this Mac/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download the new macOS installer' })).toHaveAttribute(
      'href',
      'https://www.dnaforge.com/download?source=mac-team-id-cutover'
    );
    expect(screen.queryByText(/signing identity/i)).not.toBeInTheDocument();
  });
});
