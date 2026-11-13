import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { userMessage } from '@waypoint/user-messages';
import { StartupSurface } from './StartupSurface';

describe('StartupSurface', () => {
  it('uses hosted-workspace language for the hosted browser runtime', () => {
    render(<StartupSurface stage="platform" runtime="hosted-browser" />);

    expect(screen.getByTestId('startup-surface')).toHaveTextContent(
      'Preparing the hosted workspace'
    );
    expect(screen.getByTestId('startup-surface')).not.toHaveTextContent(
      'Connecting to the desktop'
    );
  });

  it('keeps desktop startup language by default', () => {
    render(<StartupSurface stage="platform" />);

    expect(screen.getByTestId('startup-surface')).toHaveTextContent('Connecting to the desktop');
  });

  it('uses the approved web failure guidance at the platform stage', () => {
    render(
      <StartupSurface
        stage="platform"
        runtime="hosted-browser"
        error={userMessage('startup.hostedPlatformFailed')}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      userMessage('startup.hostedPlatformFailed')
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('connect to the desktop');
  });
});
