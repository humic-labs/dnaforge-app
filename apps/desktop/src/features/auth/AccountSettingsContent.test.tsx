import { userMessage } from '@waypoint/user-messages';
import { expectToastCall } from '../../test/toast-assertions';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import type { DesktopPublicSession } from '../../shared/auth-types';

const h = vi.hoisted(() => ({
  updateProfile: vi.fn(async () => ({ ok: true as const })),
  signOut: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      updateProfile: h.updateProfile,
      signOut: h.signOut,
    }),
}));

vi.mock('../../stores/toast-store', () => ({
  useToastStore: (selector: (s: unknown) => unknown) => selector({ addToast: h.addToast }),
}));

import { AccountSettingsContent } from './AccountSettingsContent';

const session: DesktopPublicSession = {
  accountId: 'account-1',
  desktopSessionId: 'session-1',
  email: 'ada@lab.edu',
  displayName: 'Ada',
  avatarUrl: null,
  channel: 'dev',
  accessTokenExpiresAt: '2030-01-01T00:00:00Z',
};

function jpegFile(name = 'banana.jpg'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/jpeg' });
}

function pickPhoto(file: File = jpegFile()): void {
  const input = screen.getByTestId('account-settings-avatar-file');
  fireEvent.change(input, { target: { files: [file] } });
}

function loadCropImage(): HTMLImageElement {
  const image = screen.getByTestId('avatar-crop-image') as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1000 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 500 });
  fireEvent.load(image);
  return image;
}

describe('AccountSettingsContent photo crop', () => {
  const drawImage = vi.fn();

  it('cancels unsaved profile text without sending an account update', () => {
    render(<AccountSettingsContent session={session} />);
    const name = screen.getByTestId('account-settings-display-name');
    expect(screen.getByTestId('account-settings-save')).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Changed name' } });
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(name).toHaveValue('Ada');
    expect(h.updateProfile).not.toHaveBeenCalled();
  });

  it('retains a failed profile draft and lets Cancel restore the saved name and photo', async () => {
    h.updateProfile.mockResolvedValueOnce({
      ok: false,
      message: 'Profile service unavailable.',
    } as never);
    render(
      <AccountSettingsContent session={{ ...session, avatarUrl: 'data:image/jpeg;base64,aaaa' }} />
    );
    const name = screen.getByRole('textbox', { name: 'Display name' });
    fireEvent.change(name, { target: { value: 'Unsaved name' } });
    fireEvent.click(screen.getByTestId('account-settings-avatar-clear'));
    fireEvent.click(screen.getByTestId('account-settings-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.could-not-save-profile')
    );
    expect(name).toHaveValue('Unsaved name');
    expect(screen.getByTestId('account-settings-avatar').querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(name).toHaveValue('Ada');
    expect(screen.getByTestId('account-settings-avatar').querySelector('img')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,aaaa'
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.updateProfile).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.updateProfile.mockResolvedValue({ ok: true });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:cropped',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    drawImage.mockReset();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage })) as never;
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob([new Uint8Array(32)], { type: 'image/jpeg' }));
    }) as never;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens the circle crop from Change photo and keeps the file input clickable', () => {
    render(<AccountSettingsContent session={session} />);
    const input = screen.getByTestId('account-settings-avatar-file');
    expect(input.className).toContain('sr-only');
    expect(input.className.split(/\s+/)).not.toContain('hidden');
    const click = vi.spyOn(input as HTMLInputElement, 'click');
    fireEvent.click(screen.getByTestId('account-settings-avatar-pick'));
    expect(click).toHaveBeenCalledOnce();

    pickPhoto();
    expect(screen.getByTestId('avatar-crop-dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' }).textContent).toBe('×');
    expect(screen.getByTestId('avatar-crop-change')).toHaveTextContent('Change photo');
    expect(screen.getByTestId('avatar-crop-accept')).toHaveTextContent('Accept');
    expect(screen.getByTestId('avatar-crop-zoom')).toBeTruthy();
  });

  it('rejects a file that is not a photo and leaves the modal closed', () => {
    render(<AccountSettingsContent session={session} />);
    pickPhoto(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(screen.queryByTestId('avatar-crop-dialog')).toBeNull();
    expectToastCall(h.addToast, 'Photo must be PNG, JPEG, or WebP.', 'error');
    expect(h.updateProfile).not.toHaveBeenCalled();
  });

  it('drags to recenter, zooms, and accepts a cropped jpeg onto the account', async () => {
    render(<AccountSettingsContent session={session} />);
    pickPhoto();
    const image = loadCropImage();
    expect(image.style.left).toBe('-144px');
    expect(image.style.top).toBe('0px');

    const stage = screen.getByTestId('avatar-crop-stage');
    const point = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) => {
      act(() => {
        stage.dispatchEvent(
          new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })
        );
      });
    };
    point('pointerdown', 10, 10);
    point('pointermove', 40, 20);
    point('pointerup', 40, 20);
    expect(image.style.left).toBe('-114px');
    expect(image.style.top).toBe('0px');

    fireEvent.change(screen.getByTestId('avatar-crop-zoom'), { target: { value: '2' } });
    expect((screen.getByTestId('avatar-crop-zoom') as HTMLInputElement).value).toBe('2');
    expect(image.style.left).toBe('-402px');
    expect(image.style.top).toBe('-144px');

    fireEvent.click(screen.getByTestId('avatar-crop-accept'));
    await waitFor(() => expect(h.updateProfile).toHaveBeenCalledOnce());
    const payload = h.updateProfile.mock.calls[0][0] as {
      avatarBase64: string;
      avatarContentType: string;
      displayName?: string;
    };
    expect(payload.avatarContentType).toBe('image/jpeg');
    expect(payload.avatarBase64.length).toBeGreaterThan(0);
    expect(payload.displayName).toBeUndefined();
    const drawn = drawImage.mock.calls[0];
    expect(drawn[0]).toBe(image);
    expect(drawn[1]).toBeCloseTo(348.95833333333337);
    expect(drawn[2]).toBeCloseTo(125);
    expect(drawn[3]).toBeCloseTo(250);
    expect(drawn[4]).toBeCloseTo(250);
    expect(drawn.slice(5)).toEqual([0, 0, 512, 512]);
    await waitFor(() => expect(screen.queryByTestId('avatar-crop-dialog')).toBeNull());
    expectToastCall(h.addToast, 'Photo updated.', 'success');
    expect(
      screen.getByTestId('account-settings-avatar').querySelector('img')?.getAttribute('src')
    ).toBe('blob:cropped');
  });

  it('keeps a cropped preview for canceled or failed removal and releases it after successful removal', async () => {
    render(<AccountSettingsContent session={session} />);
    pickPhoto();
    loadCropImage();
    fireEvent.click(screen.getByTestId('avatar-crop-accept'));
    await waitFor(() => expect(screen.queryByTestId('avatar-crop-dialog')).toBeNull());
    const avatar = screen.getByTestId('account-settings-avatar');
    expect(avatar.querySelector('img')).toHaveAttribute('src', 'blob:cropped');

    fireEvent.click(screen.getByTestId('account-settings-avatar-clear'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(avatar.querySelector('img')).toHaveAttribute('src', 'blob:cropped');

    h.updateProfile.mockResolvedValueOnce({ ok: false, message: 'Removal failed.' } as never);
    fireEvent.click(screen.getByTestId('account-settings-avatar-clear'));
    fireEvent.click(screen.getByTestId('account-settings-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.could-not-save-profile')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(avatar.querySelector('img')).toHaveAttribute('src', 'blob:cropped');

    fireEvent.click(screen.getByTestId('account-settings-avatar-clear'));
    fireEvent.click(screen.getByTestId('account-settings-save'));
    await waitFor(() => expectToastCall(h.addToast, 'Profile saved.', 'success'));
    expect(screen.getByText('All changes saved')).toBeVisible();
    expect(avatar.querySelector('img')).toBeNull();
    expect(screen.getByTestId('account-settings-avatar-clear')).toBeDisabled();
    fireEvent.change(screen.getByTestId('account-settings-display-name'), {
      target: { value: 'Unsaved name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(avatar.querySelector('img')).toBeNull();
    expect(h.updateProfile).toHaveBeenLastCalledWith({ displayName: 'Ada', clearAvatar: true });
  });

  it('closes from the X button without saving', () => {
    render(<AccountSettingsContent session={session} />);
    pickPhoto();
    loadCropImage();
    fireEvent.click(screen.getByTestId('avatar-crop-close'));
    expect(screen.queryByTestId('avatar-crop-dialog')).toBeNull();
    expect(h.updateProfile).not.toHaveBeenCalled();
  });

  it('asks for another file from the modal Change photo button', () => {
    render(<AccountSettingsContent session={session} />);
    pickPhoto();
    const input = screen.getByTestId('account-settings-avatar-file') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('avatar-crop-change'));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByTestId('avatar-crop-dialog')).toBeTruthy();
  });

  it('keeps the modal open when the account save fails', async () => {
    h.updateProfile.mockResolvedValue({ ok: false, message: 'Could not store avatar' });
    render(<AccountSettingsContent session={session} />);
    pickPhoto();
    loadCropImage();
    fireEvent.click(screen.getByTestId('avatar-crop-accept'));
    await waitFor(() => expectToastCall(h.addToast, userMessage('operation.failed'), 'error'));
    expect(screen.getByTestId('avatar-crop-dialog')).toBeTruthy();
  });

  it('keeps an unsaved display name when the saved photo url arrives', () => {
    const { rerender } = render(<AccountSettingsContent session={session} />);
    fireEvent.change(screen.getByTestId('account-settings-display-name'), {
      target: { value: 'Edited' },
    });
    rerender(
      <AccountSettingsContent
        session={{ ...session, avatarUrl: 'https://cdn.example/avatar.jpg' }}
      />
    );
    expect(screen.getByTestId('account-settings-display-name')).toHaveValue('Edited');
    expect(screen.getByTestId('account-settings-avatar').querySelector('img')).toBeNull();
    rerender(
      <AccountSettingsContent session={{ ...session, avatarUrl: 'data:image/jpeg;base64,aaaa' }} />
    );
    expect(screen.getByTestId('account-settings-display-name')).toHaveValue('Edited');
    expect(
      screen.getByTestId('account-settings-avatar').querySelector('img')?.getAttribute('src')
    ).toBe('data:image/jpeg;base64,aaaa');
  });

  it('saves a display name, and a removal, without uploading a new photo', async () => {
    render(
      <AccountSettingsContent session={{ ...session, avatarUrl: 'https://cdn.example/old.jpg' }} />
    );
    fireEvent.change(screen.getByTestId('account-settings-display-name'), {
      target: { value: 'Ada Lovelace' },
    });
    fireEvent.click(screen.getByTestId('account-settings-avatar-clear'));
    fireEvent.click(screen.getByTestId('account-settings-save'));
    await waitFor(() => expect(h.updateProfile).toHaveBeenCalledOnce());
    expect(h.updateProfile).toHaveBeenCalledWith({
      displayName: 'Ada Lovelace',
      clearAvatar: true,
    });
  });
});

describe('AccountSettingsContent settings layout', () => {
  it('uses the shared visible section heading', () => {
    render(<AccountSettingsContent session={session} />);

    const section = screen.getByTestId('settings-section-account');
    expect(section).toHaveAccessibleName('Profile');
    expect(section).not.toHaveClass('grid');
    expect(within(section).getByRole('heading', { name: 'Profile' })).toBeVisible();
    expect(
      screen.queryByText('How you appear to other people in this account.')
    ).not.toBeInTheDocument();
  });
});
