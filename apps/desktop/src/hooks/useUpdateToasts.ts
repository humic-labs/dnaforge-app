import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useEffect, useRef } from 'react';
import { platform } from '../platform';
import { useToastStore } from '../stores/toast-store';
import { resolveToastDefinition } from '../stores/toast-definitions';
import type { UpdateEventPayload, UpdateInstallResult } from '../shared/update-ipc';

export function useUpdateToasts(): void {
  const addRichToast = useToastStore((s) => s.addRichToast);
  const clearToastGroup = useToastStore((s) => s.clearToastGroup);
  const updateToastProgress = useToastStore((s) => s.updateToastProgress);
  const installingVersionRef = useRef<string | null>(null);

  useEffect(() => {
    const bridge = platform();
    const clearErrorToast = () => clearToastGroup('update-error');
    let downloadToast: { id: string; version: string } | null = null;
    const clearDownloadToast = () => {
      downloadToast = null;
      clearToastGroup('update-downloading');
    };
    const unsubNoUpdate = bridge.on('update:no-update', (payload) => {
      clearDownloadToast();
      const { version, isDevMode } = payload as { version: string; isDevMode?: boolean };
      addRichToast({
        definition: 'update-current',
        variant: isDevMode ? 'dev' : 'default',
        message: isDevMode
          ? userMessageWithValues(
              'notice.dev-build-vvalue-update-checks-are-disabled-in-development',
              { value0: userMessageValue(version) }
            )
          : userMessageWithValues('notice.dnaforge-is-up-to-date-vvalue', {
              value0: userMessageValue(version),
            }),
      });
    });

    const unsubAvailable = bridge.on('update:available', (payload) => {
      clearErrorToast();
      const { version, isManual } = payload as UpdateEventPayload<'update:available'>;
      if (downloadToast && downloadToast.version !== version) clearDownloadToast();
      if (!isManual) return;
      if (
        downloadToast &&
        useToastStore
          .getState()
          .toasts.some((toast) => toast.id === downloadToast?.id && toast.phase !== 'exiting')
      )
        return;
      downloadToast = {
        version,
        id: addRichToast({
          definition: 'update-downloading',
          progress: { value: 0, label: userMessage('update.downloadProgress') },
        }),
      };
    });
    const unsubProgress = bridge.on('update:progress', (payload) => {
      if (downloadToast)
        updateToastProgress(
          downloadToast.id,
          (payload as UpdateEventPayload<'update:progress'>).percent
        );
    });
    const showDownloadedToast = (version: string, restartRequired = false): void => {
      addRichToast({
        definition: 'update-ready',
        key: restartRequired ? `${version}:restart-required` : version,
        message: userMessageWithValues('notice.update-vvalue-ready-restart-to-apply', {
          value0: userMessageValue(version),
        }),
        actions: [
          {
            label: 'Restart now',
            onClick: async () => {
              clearToastGroup('update-ready');
              installingVersionRef.current = version;
              let result: UpdateInstallResult;
              try {
                result = await platform().update.install(version);
              } catch {
                result = {
                  status: 'failed',
                  message: 'The update request could not be delivered.',
                };
              }
              switch (result.status) {
                case 'started':
                  return;
                case 'failed':
                  installingVersionRef.current = null;
                  if (result.readyVersion === undefined)
                    showDownloadedToast(version, restartRequired);
                  else if (result.readyVersion !== null) showDownloadedToast(result.readyVersion);
                  return;
                case 'cancelled':
                  installingVersionRef.current = null;
                  showDownloadedToast(version, restartRequired);
                  return;
                default: {
                  const exhaustive: never = result;
                  return exhaustive;
                }
              }
            },
          },
        ],
      });
    };
    const unsubDownloaded = bridge.on('update:downloaded', (payload) => {
      clearDownloadToast();
      if (installingVersionRef.current) return;
      const { version, restartRequired } = payload as UpdateEventPayload<'update:downloaded'>;
      showDownloadedToast(version, restartRequired);
    });
    const unsubError = bridge.on('update:error', (payload) => {
      clearDownloadToast();
      const { stage, reason, operation } = payload as UpdateEventPayload<'update:error'>;
      if (stage === 'install') {
        const retryVersion = installingVersionRef.current;
        installingVersionRef.current = null;
        clearToastGroup('update-ready');
        if (retryVersion) {
          showDownloadedToast(retryVersion);
          return;
        }
        addRichToast({ definition: 'update-install-failed' });
        return;
      }
      const variant =
        stage === 'check'
          ? (reason ?? 'unknown')
          : operation === 'native-preparation'
            ? 'preparation'
            : 'download';
      const definition = resolveToastDefinition({ definition: 'update-error', variant });
      addRichToast({
        definition: 'update-error',
        variant,
        actions: definition.actionLabels.length
          ? definition.actionLabels.map((label) => ({
              label,
              onClick: () => {
                void platform().update.retry();
              },
            }))
          : undefined,
      });
    });
    return () => {
      unsubNoUpdate();
      unsubAvailable();
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, [addRichToast, clearToastGroup, updateToastProgress]);
}
