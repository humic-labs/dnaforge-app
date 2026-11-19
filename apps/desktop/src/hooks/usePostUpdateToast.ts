import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useEffect, useRef } from 'react';
import { readNoticeVersion, rememberNotice } from '../lib/desktop-notice-history';
import { platform } from '../platform';
import { useToastStore } from '../stores/toast-store';
import { getReleaseNote } from '../lib/release-notes';
import { APP_BUILD } from '../lib/app-build';
import { installedReleaseVersion } from '../shared/app-build-identity';

async function readLegacyVersion(): Promise<string | null> {
  const bridge = platform();
  const path = `${await bridge.path.appDataDir()}/.last-seen-version`;
  return (await bridge.fs.exists(path)) ? (await bridge.fs.readTextFile(path)).trim() : null;
}

export function usePostUpdateToast(
  openReleaseNotes: (version: string, sourceElement?: HTMLElement) => void
): void {
  const currentVersion = installedReleaseVersion(APP_BUILD);
  const addRichToast = useToastStore((s) => s.addRichToast);
  const openReleaseNotesRef = useRef(openReleaseNotes);

  openReleaseNotesRef.current = openReleaseNotes;

  useEffect(() => {
    if (!currentVersion) return;
    let cancelled = false;
    (async () => {
      try {
        const recorded = await readNoticeVersion('post-update');
        if (cancelled || recorded === currentVersion) return;
        const previous = recorded ?? (await readLegacyVersion());
        if (cancelled) return;
        await rememberNotice('post-update', currentVersion);
        if (
          cancelled ||
          !previous ||
          previous === currentVersion ||
          !getReleaseNote(currentVersion)
        )
          return;

        addRichToast({
          definition: 'post-update',
          message: userMessageWithValues('notice.updated-to-vvalue-see-what-changed', {
            value0: userMessageValue(currentVersion),
          }),
          actions: [
            {
              label: "What's new",
              onClick: (sourceElement) =>
                sourceElement
                  ? openReleaseNotesRef.current(currentVersion, sourceElement)
                  : openReleaseNotesRef.current(currentVersion),
            },
          ],
        });
      } catch (error) {
        console.warn(
          '[Post-update notice] Could not check or record the installed release.',
          error
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addRichToast, currentVersion]);
}
