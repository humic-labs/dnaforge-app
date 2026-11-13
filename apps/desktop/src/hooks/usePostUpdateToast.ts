import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useEffect, useRef } from 'react';
import { platform } from '../platform';
import { useToastStore } from '../stores/toast-store';
import { getReleaseNote } from '../lib/release-notes';
import { APP_BUILD } from '../lib/app-build';
import { installedReleaseVersion } from '../shared/app-build-identity';

export function usePostUpdateToast(
  openReleaseNotes: (version: string, sourceElement?: HTMLElement) => void
): void {
  const currentVersion = installedReleaseVersion(APP_BUILD);
  const addRichToast = useToastStore((s) => s.addRichToast);
  const firedRef = useRef(false);
  const openReleaseNotesRef = useRef(openReleaseNotes);

  openReleaseNotesRef.current = openReleaseNotes;

  useEffect(() => {
    if (!currentVersion || firedRef.current) return;
    firedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const bridge = platform();
        const appData = await bridge.path.appDataDir();
        const filePath = `${appData}/.last-seen-version`;
        const exists = await bridge.fs.exists(filePath);

        if (!exists) {
          await bridge.fs.writeTextFile(filePath, currentVersion);
          return;
        }

        const lastVersion = (await bridge.fs.readTextFile(filePath)).trim();
        if (cancelled) return;
        if (lastVersion === currentVersion) return;

        const note = getReleaseNote(currentVersion);
        if (!note) {
          await bridge.fs.writeTextFile(filePath, currentVersion);
          return;
        }

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

        await bridge.fs.writeTextFile(filePath, currentVersion);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
