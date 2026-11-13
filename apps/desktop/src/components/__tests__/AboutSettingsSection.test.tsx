import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AppBuildIdentity } from '../../shared/app-build-identity';
import { AboutSettingsSection } from '../AboutSettingsSection';
import { ReleaseNotesModal } from '../ReleaseNotesModal';
import { VERSION_HISTORY, getReleaseNote } from '../../lib/release-notes';

const { build } = vi.hoisted(() => ({
  build: {
    kind: 'development',
    version: '0.9.8+dev.4.g535acc37d41f',
    sourceReleaseVersion: '0.9.8',
    sourceCommit: '535acc37d41f1794b20563a2f20a9e0d9051f420',
    sourceModified: true,
  } as AppBuildIdentity,
}));
vi.mock('../../lib/app-build', () => ({ APP_BUILD: build }));

beforeEach(() => {
  Object.assign(build, {
    kind: 'development',
    version: '0.9.8+dev.4.g535acc37d41f',
    sourceReleaseVersion: '0.9.8',
    sourceCommit: '535acc37d41f1794b20563a2f20a9e0d9051f420',
    sourceModified: true,
  });
});

describe('About and release notes share artifact identity', () => {
  it.each([
    ['development', 'Development build'],
    ['local', 'Local build'],
    ['test', 'Test build'],
    ['unknown', 'Build information unavailable'],
  ] as const)('never labels a %s build as the old package release', (kind, label) => {
    Object.assign(build, {
      kind,
      ...(kind === 'unknown' ? { version: null, sourceReleaseVersion: null } : {}),
    });
    const onOpen = vi.fn();
    render(<AboutSettingsSection onOpenReleaseNotes={onOpen} />);
    const about = screen.getByTestId('settings-section-about');
    expect(screen.getByTestId('settings-about-build-kind')).toHaveTextContent(label);
    expect(screen.getByTestId('settings-about-version')).toHaveTextContent(
      kind === 'unknown' ? 'Version unavailable' : 'v0.9.8+dev.4.g535acc37d41f'
    );
    expect(about).not.toHaveTextContent('0.9.3');
    expect(about).not.toHaveTextContent('Package version');
    expect(about).not.toHaveTextContent(/Currently running v|released 2026-09-23/);
    fireEvent.click(screen.getByTestId('settings-open-release-notes'));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(screen.getByTestId('settings-open-release-notes'));
  });

  it('labels development provenance as the startup snapshot with local changes', () => {
    render(<AboutSettingsSection />);
    fireEvent.click(screen.getByText('Build details'));
    expect(screen.getByText('Source at startup')).toBeVisible();
    expect(screen.getByTestId('settings-about-source')).toHaveTextContent(
      '535acc37d41f · with local changes'
    );
    expect(screen.getByTestId('settings-about-source')).toHaveAttribute(
      'title',
      build.sourceCommit
    );
  });

  it('keeps a real release version/date even when the registry has newer notes', () => {
    Object.assign(build, {
      kind: 'release',
      sourceModified: false,
      version: '0.9.3',
      sourceReleaseVersion: '0.9.3',
    });
    render(<AboutSettingsSection />);
    expect(screen.getByTestId('settings-about-version')).toHaveTextContent('v0.9.3');
    expect(screen.getByTestId('settings-section-release-notes')).toHaveTextContent(
      'Currently running v0.9.3 (released 2026-09-23)'
    );
    expect(screen.queryByText('Package version')).not.toBeInTheDocument();
    expect(screen.queryByText(/with local changes/)).not.toBeInTheDocument();
  });

  it('does not invent a release date when matching notes are absent', () => {
    Object.assign(build, { kind: 'release', version: '9.9.9' });
    render(<AboutSettingsSection />);
    expect(screen.getByTestId('settings-section-release-notes')).toHaveTextContent(
      'Currently running v9.9.9'
    );
    expect(screen.getByTestId('settings-section-release-notes')).not.toHaveTextContent('released');
  });

  it.each(['development', 'local', 'test', 'unknown'] as const)(
    'browses notes without an installed marker for %s',
    (kind) => {
      Object.assign(build, {
        kind,
        ...(kind === 'unknown' ? { version: null, sourceReleaseVersion: null } : {}),
      });
      render(<ReleaseNotesModal open onClose={vi.fn()} />);
      const picker = screen.getByTestId('release-notes-modal-version-picker');
      expect(picker).toHaveValue(VERSION_HISTORY[0]);
      expect(within(picker).queryByRole('option', { name: /installed/ })).not.toBeInTheDocument();
      fireEvent.change(picker, { target: { value: '0.9.3' } });
      expect(picker).toHaveValue('0.9.3');
      expect(within(picker).queryByRole('option', { name: /installed/ })).not.toBeInTheDocument();
    }
  );

  it('selects the development source release even when newer notes exist', () => {
    Object.assign(build, {
      version: '0.9.7+dev.2.g535acc37d41f',
      sourceReleaseVersion: '0.9.7',
    });
    render(<ReleaseNotesModal open onClose={vi.fn()} />);
    const picker = screen.getByTestId('release-notes-modal-version-picker');
    expect(picker).toHaveValue('0.9.7');
    expect(within(picker).queryByRole('option', { name: /installed/ })).not.toBeInTheDocument();
  });

  it('browses the newest notes when the source release has no recorded notes', () => {
    expect(getReleaseNote('99.0.0')).toBeNull();
    Object.assign(build, { sourceReleaseVersion: '99.0.0' });
    render(<ReleaseNotesModal open onClose={vi.fn()} />);
    const picker = screen.getByTestId('release-notes-modal-version-picker');
    expect(picker).toHaveValue(VERSION_HISTORY[0]);
    expect(within(picker).queryByRole('option', { name: /installed/ })).not.toBeInTheDocument();
  });

  it('selects and marks exactly the installed release, not the newest notes', () => {
    Object.assign(build, { kind: 'release', version: '0.9.3', sourceReleaseVersion: '0.9.3' });
    render(<ReleaseNotesModal open onClose={vi.fn()} />);
    const picker = screen.getByTestId('release-notes-modal-version-picker');
    expect(picker).toHaveValue('0.9.3');
    expect(within(picker).getAllByRole('option', { name: /installed/ })).toHaveLength(1);
    expect(within(picker).getByRole('option', { name: 'v0.9.3 (installed)' })).toBeInTheDocument();
  });
});
