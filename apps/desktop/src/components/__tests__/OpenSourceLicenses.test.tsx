import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThirdPartyNoticesPort } from '../../shared/ipc/third-party-notices.contract';

const bridge = vi.hoisted(() => ({
  notices: undefined as Partial<ThirdPartyNoticesPort> | undefined,
}));
vi.mock('../../platform', () => ({ platform: () => ({ thirdPartyNotices: bridge.notices }) }));

const editor = vi.hoisted(() => ({
  view: {
    state: { selection: { main: { to: 0 } } },
    dispatch: vi.fn(),
  },
}));
vi.mock('../CodeEditor', () => ({
  default: function CodeEditorStub({
    value,
    onReady,
  }: {
    value: string;
    onReady?: (view: unknown) => void;
  }) {
    useEffect(() => onReady?.(editor.view), [onReady]);
    return <pre data-testid="code-editor-content">{value}</pre>;
  },
}));

import { AboutSettingsSection } from '../AboutSettingsSection';
import { OpenSourceLicensesSetting, nextMatch } from '../OpenSourceLicenses';

const NOTICES = '# Third-party notices for DNAForge 1.0.0\n\nalpha MIT\nbeta MIT\n';

beforeEach(() => {
  editor.view.state.selection.main.to = 0;
  editor.view.dispatch.mockClear();
  bridge.notices = {
    read: vi.fn(async () => ({ status: 'available' as const, text: NOTICES })),
    openChromiumLicenses: vi.fn(async () => true),
  };
});

async function openDialog() {
  render(<OpenSourceLicensesSetting />);
  fireEvent.click(screen.getByTestId('settings-open-licenses'));
  return screen.findByTestId('open-source-licenses-dialog');
}

describe('open-source licenses view', () => {
  it('appears in About', () => {
    render(<AboutSettingsSection />);
    expect(screen.getByTestId('settings-section-open-source-licenses')).toHaveTextContent(
      'Licenses for the open-source components in DNAForge, and where to get their source code.'
    );
  });

  it('shows the shipped list and finds text from the cursor, wrapping at the end', async () => {
    await openDialog();
    expect(await screen.findByTestId('code-editor-content')).toHaveTextContent(
      'Third-party notices for DNAForge 1.0.0'
    );
    const find = screen.getByTestId('open-source-licenses-find');
    fireEvent.change(find, { target: { value: 'MIT' } });
    fireEvent.submit(find);
    const first = NOTICES.indexOf('MIT');
    expect(editor.view.dispatch).toHaveBeenLastCalledWith({
      selection: { anchor: first, head: first + 3 },
      scrollIntoView: true,
    });
    editor.view.state.selection.main.to = NOTICES.lastIndexOf('MIT') + 3;
    fireEvent.submit(find);
    expect(editor.view.dispatch).toHaveBeenLastCalledWith({
      selection: { anchor: first, head: first + 3 },
      scrollIntoView: true,
    });
    fireEvent.change(find, { target: { value: 'GPL-9' } });
    fireEvent.submit(find);
    expect(screen.getByTestId('open-source-licenses-no-match')).toHaveTextContent('No matches');
  });

  it('opens the Chromium list and says so when the system cannot open it', async () => {
    await openDialog();
    fireEvent.click(await screen.findByTestId('open-source-licenses-chromium'));
    await waitFor(() => expect(bridge.notices!.openChromiumLicenses).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('open-source-licenses-chromium-failed')).toBeNull();
    vi.mocked(bridge.notices!.openChromiumLicenses!).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId('open-source-licenses-chromium'));
    expect(await screen.findByTestId('open-source-licenses-chromium-failed')).toHaveTextContent(
      'The Chromium license list could not be opened.'
    );
  });

  it.each([
    [
      'the file is missing',
      () => ({ read: vi.fn(async () => ({ status: 'unavailable' as const })) }),
    ],
    ['the read fails', () => ({ read: vi.fn(async () => Promise.reject(new Error('denied'))) })],
    ['there is no desktop bridge', () => undefined],
  ])('explains a development build without a list when %s', async (_case, notices) => {
    bridge.notices = notices();
    await openDialog();
    expect(await screen.findByTestId('open-source-licenses-unavailable')).toHaveTextContent(
      'This development build has no license list. Packaged builds include it.'
    );
    expect(screen.queryByTestId('open-source-licenses-find')).toBeNull();
    expect(screen.queryByTestId('open-source-licenses-chromium')).toBeNull();
  });

  it('closes on Escape, the close button and a backdrop click', async () => {
    await openDialog();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByTestId('open-source-licenses-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-open-licenses'));
    fireEvent.click(await screen.findByTestId('open-source-licenses-close'));
    expect(screen.queryByTestId('open-source-licenses-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-open-licenses'));
    fireEvent.click(await screen.findByTestId('open-source-licenses-backdrop'));
    expect(screen.queryByTestId('open-source-licenses-dialog')).toBeNull();
  });

  it('finds the next match after a position and wraps to the first', () => {
    expect(nextMatch('a b a', 'a', 0)).toBe(0);
    expect(nextMatch('a b a', 'a', 1)).toBe(4);
    expect(nextMatch('a b a', 'a', 5)).toBe(0);
    expect(nextMatch('a b a', 'z', 0)).toBe(-1);
    expect(nextMatch('a b a', '', 0)).toBe(-1);
  });
});
