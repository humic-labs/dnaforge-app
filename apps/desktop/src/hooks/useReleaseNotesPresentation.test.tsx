// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBuildIdentity } from '../shared/app-build-identity';
import type { ReleaseNotesSource } from '../shared/release-notes-telemetry';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import { safeFocus } from '../shared/utils/safeFocus';
import { ReleaseNotesModal } from '../components/ReleaseNotesModal';
import { VERSION_HISTORY } from '../lib/release-notes';
import { useReleaseNotesPresentation } from './useReleaseNotesPresentation';

const mocks = vi.hoisted(() => ({
  build: {
    kind: 'release',
    version: '0.9.3',
    sourceReleaseVersion: '0.9.3',
    sourceCommit: null,
    sourceModified: false,
  } as AppBuildIdentity,
  track: vi.fn(),
  ready: true,
  account: 'private-account-a',
  session: '10000000-0000-4000-8000-000000000001',
  episode: '10000000-0000-4000-8000-000000000002',
}));
vi.mock('../lib/app-build', () => ({ APP_BUILD: mocks.build }));
vi.mock('../lib/analytics', () => ({
  trackRendererEvent: (...args: unknown[]) => mocks.track(...args),
  isAnalyticsCaptureReady: () => mocks.ready,
  getAnalyticsIdentifiedAccountId: () => mocks.account,
}));
vi.mock('../lib/telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: mocks.session,
    episodeCorrelationId: mocks.episode,
  }),
}));
let events: Array<{ event: string; properties: Record<string, unknown> }>;
let nextId: number;
beforeEach(() => {
  mocks.ready = true;
  mocks.account = 'private-account-a';
  mocks.session = '10000000-0000-4000-8000-000000000001';
  mocks.episode = '10000000-0000-4000-8000-000000000002';
  Object.assign(mocks.build, {
    kind: 'release',
    version: '0.9.3',
    sourceReleaseVersion: '0.9.3',
    sourceCommit: null,
    sourceModified: false,
  });
  nextId = 0;
  events = [];
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `550e8400-e29b-41d4-a716-${String(++nextId).padStart(12, '0')}` as ReturnType<
        typeof crypto.randomUUID
      >
  );
  mocks.track.mockReset().mockImplementation((event, properties) => {
    events.push({ event, properties: sanitizeClosedBetaProperties(properties) });
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

function Harness({
  source = 'settings',
  initialVersion,
  removeTrigger = false,
  triggerState,
}: {
  source?: ReleaseNotesSource;
  initialVersion?: string;
  removeTrigger?: boolean;
  triggerState?: 'hidden' | 'disabled';
}) {
  const notes = useReleaseNotesPresentation();
  return (
    <>
      <button data-testid="settings-button">Fallback Settings</button>
      {!removeTrigger && (
        <button
          hidden={triggerState === 'hidden'}
          disabled={triggerState === 'disabled'}
          onClick={(event) => notes.open(source, initialVersion, event.currentTarget)}
        >
          Open notes
        </button>
      )}
      <ReleaseNotesModal {...notes.modalProps} />
    </>
  );
}
function open() {
  const trigger = screen.getByRole('button', { name: 'Open notes' });
  safeFocus(trigger);
  fireEvent.click(trigger);
  return trigger;
}
function cancel() {
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
}
function properties(phase: string) {
  return events
    .filter((item) => item.properties.notes_phase === phase)
    .map((item) => item.properties);
}

describe('accepted release-note presentation owner', () => {
  it.each(['settings', 'home', 'post_update_toast'] as const)(
    'accepts %s once across duplicate activation and StrictMode effect replay',
    (source) => {
      const { rerender } = render(
        <StrictMode>
          <Harness source={source} />
        </StrictMode>
      );
      const trigger = open();
      act(() => {
        fireEvent.click(trigger);
        fireEvent.click(trigger);
      });
      rerender(
        <StrictMode>
          <Harness source={source} />
        </StrictMode>
      );
      expect(properties('presented')).toHaveLength(1);
      expect(properties('presented')[0]).toMatchObject({
        notes_source: source,
        notes_requested_version: '0.9.3',
        notes_displayed_version: '0.9.3',
        notes_result: 'available',
        notes_capability: 'information_only',
      });
      expect(screen.getByTestId('release-notes-heading')).toBe(document.activeElement);
      cancel();
      expect(properties('closed')).toHaveLength(1);
      expect(properties('closed')[0]).toMatchObject({
        presentation_id: properties('presented')[0].presentation_id,
        notes_close_reason: 'escape',
      });
      expect(document.activeElement).toBe(trigger);
    }
  );

  it('returns to the actual mouse control even when it was not the active element', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open notes' });
    safeFocus(screen.getByTestId('settings-button'));
    fireEvent.click(trigger);
    cancel();
    expect(document.activeElement).toBe(trigger);
  });

  it('records committed native-picker values while preserving the original request', () => {
    render(<Harness />);
    open();
    const picker = screen.getByTestId('release-notes-modal-version-picker');
    fireEvent.click(picker);
    expect(properties('version_changed')).toHaveLength(0);
    fireEvent.change(picker, { target: { value: '0.7.6' } });
    fireEvent.change(picker, { target: { value: '0.7.6' } });
    expect(picker).toHaveValue('0.7.6');
    expect(properties('version_changed')).toHaveLength(1);
    expect(properties('version_changed')[0]).toMatchObject({
      notes_requested_version: '0.9.3',
      notes_displayed_version: '0.7.6',
      notes_result: 'available',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(properties('closed')[0]).toMatchObject({
      notes_displayed_version: '0.7.6',
      notes_close_reason: 'close',
    });
  });

  it('accepts a fresh presentation and default selection after close/reopen', () => {
    render(<Harness />);
    open();
    fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
      target: { value: '0.7.6' },
    });
    cancel();
    open();
    expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('0.9.3');
    expect(properties('presented')).toHaveLength(2);
    expect(properties('presented')[0].presentation_id).not.toBe(
      properties('presented')[1].presentation_id
    );
  });

  it('reports a missing requested/displayed note without inventing a public identity', () => {
    render(<Harness initialVersion="9.9.9" />);
    open();
    expect(screen.getByText('No notes recorded for v9.9.9.')).toBeVisible();
    expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('9.9.9');
    expect(properties('presented')[0]).toMatchObject({
      notes_requested_kind: 'explicit',
      notes_requested_version: 'missing',
      notes_displayed_version: 'missing',
      notes_result: 'missing',
    });
    fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
      target: { value: '0.7.6' },
    });
    expect(properties('version_changed')[0]).toMatchObject({
      notes_requested_version: 'missing',
      notes_displayed_version: '0.7.6',
      notes_result: 'available',
    });
  });

  it.each([
    ['private', 'PRIVATE_NOTE_SENTINEL'],
    ['url', 'https://invalid.example/PRIVATE_NOTE_SENTINEL'],
    ['path', '/synthetic/PRIVATE_NOTE_SENTINEL'],
    ['prototype', 'toString'],
    ['constructor', 'constructor'],
    ['long', 'x'.repeat(10000)],
  ])('rejects %s requested strings before retaining a presentation', (_label, initialVersion) => {
    render(<Harness initialVersion={initialVersion} />);
    open();
    expect(properties('presented')[0]).toMatchObject({
      notes_requested_version: 'unknown',
      notes_displayed_version: 'unknown',
      notes_result: 'missing',
    });
    expect(JSON.stringify(events)).not.toContain(initialVersion);
    expect(screen.getByTestId('release-notes-modal')).not.toHaveTextContent(initialVersion);
    cancel();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['development', 'local', 'test', 'unknown'] as const)(
    'keeps %s source notes separate from installed release identity',
    (kind) => {
      Object.assign(mocks.build, {
        kind,
        version: kind === 'unknown' ? null : '0.9.3+test.1.gaaaaaaaaaaaa',
      });
      render(<Harness />);
      open();
      expect(properties('presented')[0]).toMatchObject({
        notes_artifact_kind: kind,
        notes_installed_version: 'unknown',
        notes_source_version: '0.9.3',
        notes_displayed_version: '0.9.3',
      });
      expect(screen.queryByRole('option', { name: /installed/ })).not.toBeInTheDocument();
    }
  );

  it('retains separately validated installed/source releases without notes while displaying the registry fallback', () => {
    Object.assign(mocks.build, {
      kind: 'release',
      version: '9.9.9',
      sourceReleaseVersion: '8.8.8',
    });
    expect(VERSION_HISTORY).not.toContain('9.9.9');
    expect(VERSION_HISTORY).not.toContain('8.8.8');
    render(<Harness />);
    open();
    expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue(
      VERSION_HISTORY[0]
    );
    expect(screen.queryByRole('option', { name: /installed/ })).not.toBeInTheDocument();
    expect(properties('presented')[0]).toMatchObject({
      notes_artifact_kind: 'release',
      notes_installed_version: '9.9.9',
      notes_source_version: '8.8.8',
      notes_requested_kind: 'latest_registry',
      notes_requested_version: VERSION_HISTORY[0],
      notes_displayed_version: VERSION_HISTORY[0],
      notes_result: 'available',
    });
    fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
      target: { value: '0.7.6' },
    });
    expect(properties('version_changed')[0]).toMatchObject({
      notes_installed_version: '9.9.9',
      notes_source_version: '8.8.8',
      notes_displayed_version: '0.7.6',
    });
  });

  it('retains a sealed prerelease identity absent from notes without accepting it as a caller note identity', () => {
    Object.assign(mocks.build, {
      kind: 'release',
      version: '9.9.9-beta.2',
      sourceReleaseVersion: '9.9.9-beta.2',
    });
    render(<Harness initialVersion="9.9.9-beta.2" />);
    open();
    expect(properties('presented')[0]).toMatchObject({
      notes_installed_version: '9.9.9-beta.2',
      notes_source_version: '9.9.9-beta.2',
      notes_requested_version: 'unknown',
      notes_displayed_version: 'unknown',
      notes_result: 'missing',
    });
    fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
      target: { value: '0.7.6' },
    });
    expect(properties('version_changed')[0]).toMatchObject({
      notes_installed_version: '9.9.9-beta.2',
      notes_source_version: '9.9.9-beta.2',
      notes_displayed_version: '0.7.6',
      notes_result: 'available',
    });
  });

  it('retains a validated source release without notes without making a development build installed', () => {
    Object.assign(mocks.build, {
      kind: 'development',
      version: '8.8.8+dev.1.gaaaaaaaaaaaa',
      sourceReleaseVersion: '8.8.8',
    });
    render(<Harness />);
    open();
    expect(properties('presented')[0]).toMatchObject({
      notes_artifact_kind: 'development',
      notes_installed_version: 'unknown',
      notes_source_version: '8.8.8',
      notes_requested_kind: 'latest_registry',
      notes_displayed_version: VERSION_HISTORY[0],
      notes_result: 'available',
    });
  });

  it('never emits private or invalid sealed build fields as release identities', () => {
    Object.assign(mocks.build, {
      kind: 'release',
      version: '9.9.9+PRIVATE_BUILD_SENTINEL',
      sourceReleaseVersion: 'PRIVATE_SOURCE_SENTINEL',
    });
    render(<Harness />);
    open();
    expect(properties('presented')[0]).toMatchObject({
      notes_installed_version: 'unknown',
      notes_source_version: 'unknown',
      notes_displayed_version: VERSION_HISTORY[0],
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_BUILD_SENTINEL');
    expect(JSON.stringify(events)).not.toContain('PRIVATE_SOURCE_SENTINEL');
  });

  it('falls back to the public registry when source identity is unknown without reporting a private source', () => {
    Object.assign(mocks.build, {
      kind: 'unknown',
      version: null,
      sourceReleaseVersion: 'PRIVATE_SOURCE_SENTINEL',
    });
    render(<Harness />);
    open();
    expect(properties('presented')[0]).toMatchObject({
      notes_requested_kind: 'latest_registry',
      notes_displayed_version: VERSION_HISTORY[0],
      notes_source_version: 'unknown',
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_SOURCE_SENTINEL');
  });

  it.each(['consent_refused', 'schema_throw', 'sink_throw'] as const)(
    'preserves notes, committed selection, close and focus on %s',
    (failure) => {
      mocks.track.mockImplementation(() => {
        if (failure !== 'consent_refused') throw new Error('Synthetic optional telemetry refusal');
        return false;
      });
      render(<Harness />);
      const trigger = open();
      fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
        target: { value: '0.7.6' },
      });
      expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('0.7.6');
      cancel();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    }
  );

  it('opens and closes normally if random telemetry identity is unavailable', () => {
    vi.mocked(crypto.randomUUID).mockImplementation(() => {
      throw new Error('Synthetic unavailable random ID');
    });
    render(<Harness />);
    const trigger = open();
    expect(screen.getByRole('dialog')).toBeVisible();
    cancel();
    expect(mocks.track).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it.each(['removed', 'hidden', 'disabled'] as const)(
    'returns to the explicit Settings fallback for a %s initiating toast control',
    (state) => {
      const { rerender } = render(<Harness source="post_update_toast" />);
      open();
      rerender(
        <Harness
          source="post_update_toast"
          removeTrigger={state === 'removed'}
          triggerState={state === 'removed' ? undefined : state}
        />
      );
      cancel();
      expect(document.activeElement).toBe(screen.getByTestId('settings-button'));
      expect(properties('closed')[0]).toMatchObject({
        notes_source: 'post_update_toast',
        notes_close_reason: 'escape',
      });
    }
  );

  it('does not accept a new open before the prior close actually commits, and refuses an obsolete display callback', () => {
    const { result } = renderHook(() => useReleaseNotesPresentation());
    act(() => result.current.open('settings'));
    const obsolete = result.current.modalProps.onDisplayed;
    act(() => obsolete('0.9.3'));
    act(() => {
      result.current.modalProps.onClose('close');
      result.current.open('home');
    });
    expect(result.current.modalProps.open).toBe(false);
    act(() => result.current.open('home'));
    act(() => obsolete('0.7.6'));
    expect(properties('presented')).toHaveLength(1);
    act(() => result.current.modalProps.onDisplayed('0.9.3'));
    expect(properties('presented')).toHaveLength(2);
    expect(properties('presented')[1].notes_source).toBe('home');
  });
  it('keeps notes, picker and focus usable without rebinding consent-off presentation after opt-in', () => {
    mocks.ready = false;
    render(<Harness />);
    const trigger = open();
    expect(properties('presented')).toEqual([]);
    mocks.ready = true;
    fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
      target: { value: '0.7.6' },
    });
    expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('0.7.6');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    expect(events).toEqual([]);
  });
  it.each(['account', 'session', 'episode'] as const)(
    'does not rebind deferred version/close after original %s changes',
    (field) => {
      render(<Harness />);
      const trigger = open();
      expect(properties('presented')).toHaveLength(1);
      mocks[field] = 'private-replacement';
      fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
        target: { value: '0.7.6' },
      });
      expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('0.7.6');
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(properties('version_changed')).toEqual([]);
      expect(properties('closed')).toEqual([]);
      expect(document.activeElement).toBe(trigger);
      expect(JSON.stringify(events)).not.toMatch(/private-account-a|private-replacement/u);
    }
  );
  it('keeps first displayed receipt bound to open admission across deferred React presentation', () => {
    const { result } = renderHook(() => useReleaseNotesPresentation());
    act(() => result.current.open('settings'));
    mocks.episode = 'retired-before-commit';
    act(() => result.current.modalProps.onDisplayed('0.9.3'));
    expect(events).toEqual([]);
    expect(result.current.modalProps.open).toBe(true);
    act(() => result.current.modalProps.onClose('close'));
    expect(result.current.modalProps.open).toBe(false);
    expect(events).toEqual([]);
  });
});
