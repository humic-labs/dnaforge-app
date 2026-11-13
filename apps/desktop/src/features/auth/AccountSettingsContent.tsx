import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { settingsRowProps } from '../../components/settings-catalog';
import { useEffect, useRef, useState } from 'react';
import {
  SettingsButton,
  SettingsFormActions,
  SettingsInput,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from '../../components/SettingsSubsection';
import type { DesktopPublicSession } from '../../shared/auth-types';
import { useAuthStore } from '../../stores/auth-store';
import { useToastStore } from '../../stores/toast-store';
import { rendererAvatarSrc } from '../../shared/renderer-avatar';
import { AvatarCropDialog, type AvatarCropResult } from './AvatarCropDialog';
import { avatarFileError } from './avatar-crop';

function ProfileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}

export function AccountSettingsContent({ session }: { session: DesktopPublicSession }) {
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const signOut = useAuthStore((s) => s.signOut);
  const addToast = useToastStore((s) => s.addToast);
  const [displayName, setDisplayName] = useState(session.displayName ?? '');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(
    rendererAvatarSrc(session.avatarUrl)
  );
  const [clearAvatar, setClearAvatar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cropUrlRef = useRef<string | null>(null);
  const localPreviewRef = useRef<string | null>(null);

  useEffect(() => {
    setDisplayName(session.displayName ?? '');
  }, [session.displayName]);

  useEffect(() => {
    const saved = rendererAvatarSrc(session.avatarUrl);
    if (saved && localPreviewRef.current && saved !== localPreviewRef.current) {
      URL.revokeObjectURL(localPreviewRef.current);
      localPreviewRef.current = null;
    }
    setAvatarPreview(saved ?? localPreviewRef.current);
    setClearAvatar(false);
  }, [session.avatarUrl]);

  useEffect(() => {
    return () => {
      if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current);
      if (localPreviewRef.current) URL.revokeObjectURL(localPreviewRef.current);
    };
  }, []);

  function replaceCropUrl(next: string | null): void {
    if (cropUrlRef.current && cropUrlRef.current !== next) {
      URL.revokeObjectURL(cropUrlRef.current);
    }
    cropUrlRef.current = next;
    setCropUrl(next);
  }

  function openPhotoPicker(): void {
    const input = fileRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  }

  function onPickAvatar(file: File | undefined): void {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    const error = avatarFileError(file);
    if (error) {
      addToast(toUserMessage(error, 'account.failed'), { definition: 'profile-photo-invalid' });
      return;
    }
    replaceCropUrl(URL.createObjectURL(file));
  }

  async function onAcceptCrop(result: AvatarCropResult): Promise<void> {
    try {
      setBusy(true);
      const saved = await updateProfile({
        avatarBase64: result.base64,
        avatarContentType: result.contentType,
      });
      if (!saved.ok) {
        URL.revokeObjectURL(result.previewUrl);
        addToast(
          saved.message != null
            ? toUserMessage(saved, 'operation.failed')
            : userMessage('notice.could-not-save-photo'),
          {
            definition: 'account-settings-content-could-not-save-photo',
          }
        );
        return;
      }
      if (localPreviewRef.current) URL.revokeObjectURL(localPreviewRef.current);
      localPreviewRef.current = result.previewUrl;
      setAvatarPreview(result.previewUrl);
      setClearAvatar(false);
      addToast(userMessage('notice.photo-updated'), {
        definition: 'account-settings-content-photo-updated',
      });
      replaceCropUrl(null);
    } finally {
      setBusy(false);
    }
  }

  async function onSave(): Promise<void> {
    try {
      setBusy(true);
      setSaveError(null);
      const result = await updateProfile({
        displayName: displayName.trim() || null,
        ...(clearAvatar ? { clearAvatar: true } : {}),
      });
      if (!result.ok) {
        setSaveError(toUserMessage(result, 'failure.could-not-save-profile'));
        addToast(toUserMessage(result, 'failure.could-not-save-profile'), {
          definition: 'account-settings-content-could-not-save-profile',
        });
        return;
      }
      if (clearAvatar) {
        if (localPreviewRef.current) {
          URL.revokeObjectURL(localPreviewRef.current);
          localPreviewRef.current = null;
        }
        setAvatarPreview(null);
        setClearAvatar(false);
      }
      addToast(userMessage('notice.profile-saved'), {
        definition: 'account-settings-content-profile-saved',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Profile" testId="settings-section-account" flushTop>
      <SettingsRow {...settingsRowProps('profile-photo')}>
        <div className="flex items-center gap-3">
          <div
            data-testid="account-settings-avatar"
            className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-muted text-fg-muted"
          >
            {avatarPreview ? (
              <img src={avatarPreview} alt="" className="h-full w-full object-cover" />
            ) : (
              <ProfileIcon className="h-7 w-7" />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <SettingsButton
              type="button"
              data-testid="account-settings-avatar-pick"
              onClick={openPhotoPicker}
              disabled={busy}
            >
              Change photo
            </SettingsButton>
            <SettingsButton
              type="button"
              data-testid="account-settings-avatar-clear"
              onClick={() => {
                setClearAvatar(true);
                setAvatarPreview(null);
              }}
              disabled={busy || (!avatarPreview && !session.avatarUrl)}
            >
              Remove
            </SettingsButton>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              data-testid="account-settings-avatar-file"
              className="sr-only"
              onChange={(event) => onPickAvatar(event.target.files?.[0])}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-fg-muted">PNG, JPEG, or WebP up to 8 MB.</p>
      </SettingsRow>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void onSave();
        }}
      >
        <SettingsRow {...settingsRowProps('profile-name')} htmlFor="account-settings-display-name">
          <SettingsInput
            id="account-settings-display-name"
            data-testid="account-settings-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={120}
            disabled={busy}
          />
        </SettingsRow>
        <SettingsRow
          {...settingsRowProps('profile-email')}
          htmlFor="account-settings-email"
          description="This is the address you sign in with."
        >
          <SettingsInput
            id="account-settings-email"
            data-testid="account-settings-email"
            value={session.email ?? ''}
            readOnly
          />
        </SettingsRow>
        {saveError ? (
          <SettingsNotice tone="error">{toUserMessage(saveError, 'account.failed')}</SettingsNotice>
        ) : null}
        <SettingsFormActions
          dirty={displayName !== (session.displayName ?? '') || clearAvatar}
          busy={busy}
          saveTestId="account-settings-save"
          onCancel={() => {
            setDisplayName(session.displayName ?? '');
            setClearAvatar(false);
            setAvatarPreview(rendererAvatarSrc(session.avatarUrl) ?? localPreviewRef.current);
            setSaveError(null);
          }}
        />
      </form>
      <SettingsButton
        type="button"
        data-testid="account-settings-sign-out"
        disabled={busy}
        onClick={() => void signOut()}
      >
        Sign out
      </SettingsButton>
      {cropUrl ? (
        <AvatarCropDialog
          imageUrl={cropUrl}
          busy={busy}
          onClose={() => replaceCropUrl(null)}
          onChangePhoto={openPhotoPicker}
          onAccept={onAcceptCrop}
          onError={(message) => addToast(toUserMessage(message), { definition: 'profile-error' })}
        />
      ) : null}
    </SettingsSection>
  );
}
