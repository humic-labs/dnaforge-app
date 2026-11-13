import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  toUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SETTINGS_CARD_CLASS, SettingsButton } from '../../components/SettingsSubsection';
import { platform } from '../../platform';
import { openQuickLookSource } from '../../lib/open-quick-look-source';
import type { FileAssociationHandlerStatus } from '../../shared/file-association-ipc';
import {
  associationFamilyForPath,
  FILE_ASSOCIATION_FAMILIES,
  type FileAssociationFamily,
  type FileAssociationFamilyId,
} from '../../shared/file-associations';
import { useToastStore } from '../../stores/toast-store';
import {
  queryFileAssociationHandlers,
  requestFileAssociationDefault,
  REVEAL_OPEN_DOCUMENT_EVENT,
} from './handler-status-source';

function handlerSummary(status: FileAssociationHandlerStatus | undefined): UserMessage {
  if (!status) return userMessage('fileAssociations.checking');
  if (status.state === 'default') return userMessage('fileAssociations.default');
  if (status.state === 'other')
    return userMessageWithValues('fileAssociations.other', {
      name: userMessageValue(status.handlerName ?? 'another app'),
    });
  if (status.state === 'none') return userMessage('fileAssociations.none');
  return toUserMessage(status.detail, 'fileAssociations.unavailable');
}

function actionLabel(status: FileAssociationHandlerStatus | undefined): string | null {
  if (!status || status.state === 'default') return null;
  if (status.defaultAction === 'native') return 'Make DNAForge default';
  if (status.defaultAction === 'system-settings') return 'Open Windows Default Apps';
  if (status.defaultAction === 'instructions') return 'How to set default';
  return null;
}

const DEFAULT_APP_STEPS = [
  'In Finder, select a file with the extension you want to change.',
  'Choose File → Get Info.',
  'Under Open with, choose the installed DNAForge app, then Change All.',
] as const;

type PendingAction = { familyId: FileAssociationFamilyId; kind: 'default' | 'preview' };

function FamilyRow({
  family,
  status,
  pendingAction,
  refreshing,
  onRequest,
  onPreview,
}: {
  readonly family: FileAssociationFamily;
  readonly status: FileAssociationHandlerStatus | undefined;
  readonly pendingAction: PendingAction | null;
  readonly refreshing: boolean;
  readonly onRequest: (familyId: FileAssociationFamilyId) => void;
  readonly onPreview: (familyId: FileAssociationFamilyId) => void;
}) {
  const label = actionLabel(status);
  const activeAction = pendingAction?.familyId === family.id ? pendingAction.kind : null;

  return (
    <article data-testid={`file-handler-${family.id}`} className={SETTINGS_CARD_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{family.displayName}</h3>
          <p className="mt-1 text-xs text-fg-muted">
            {family.extensions.map((extension) => `.${extension}`).join(', ')}
            {family.parser === 'snapgene' ? ' · Imports as GenBank' : ''}
          </p>
          <p
            className="mt-3 text-sm text-fg"
            role="status"
            data-testid={`file-handler-status-${family.id}`}
            title={status?.handlerPath ?? undefined}
          >
            {handlerSummary(status)}
          </p>
          {!family.promptReady ? (
            <p className="mt-2 max-w-2xl text-xs leading-5 text-fg-muted">
              DNAForge won’t prompt to become the default while format compatibility is under
              review.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {label && status?.defaultAction !== 'instructions' ? (
            <SettingsButton
              disabled={pendingAction !== null || refreshing}
              onClick={() => onRequest(family.id)}
            >
              {activeAction === 'default' ? 'Checking…' : label}
            </SettingsButton>
          ) : null}
          <SettingsButton
            disabled={pendingAction !== null}
            onClick={() => onPreview(family.id)}
            data-testid={`file-handler-preview-${family.id}`}
          >
            {activeAction === 'preview' ? 'Opening…' : 'Preview a file'}
          </SettingsButton>
        </div>
      </div>
    </article>
  );
}

export function FileHandlingSettings() {
  const [statuses, setStatuses] = useState<readonly FileAssociationHandlerStatus[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const queryVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++queryVersion.current;
    setRefreshing(true);
    try {
      const latest = await queryFileAssociationHandlers();
      if (version === queryVersion.current) setStatuses(latest);
      return version === queryVersion.current ? latest : null;
    } catch (error) {
      const detail = toUserMessage(error, 'fileAssociations.unavailable');
      const unavailable = FILE_ASSOCIATION_FAMILIES.map((family) => ({
        familyId: family.id,
        state: 'unavailable' as const,
        handlerName: null,
        handlerPath: null,
        defaultAction: 'none' as const,
        detail,
      }));
      if (version === queryVersion.current) setStatuses(unavailable);
      return version === queryVersion.current ? unavailable : null;
    } finally {
      if (version === queryVersion.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshOnFocus = () => void refresh();
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      queryVersion.current += 1;
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [refresh]);

  const statusesByFamily = useMemo(
    () => new Map(statuses.map((status) => [status.familyId, status] as const)),
    [statuses]
  );
  const showDefaultAppSteps = statuses.some(
    (status) => status.defaultAction === 'instructions' && status.state !== 'default'
  );

  const requestDefault = useCallback(
    async (familyId: FileAssociationFamilyId) => {
      const family = FILE_ASSOCIATION_FAMILIES.find((candidate) => candidate.id === familyId);
      if (!family) return;
      setPendingAction({ familyId, kind: 'default' });
      try {
        const result = await requestFileAssociationDefault(familyId);
        if (result.outcome === 'opened-settings') {
          useToastStore
            .getState()
            .addToast(
              userMessage('notice.choose-dnaforge-in-windows-default-apps-then-return-here'),
              {
                definition:
                  'file-handling-settings-choose-dnaforge-in-windows-default-apps-then-return-here',
              }
            );
          return;
        }
        if (result.outcome === 'instructions') {
          useToastStore
            .getState()
            .addToast(toUserMessage(result, 'failure.change-the-default-app-in-finder-get-info'), {
              definition: 'file-handling-settings-change-the-default-app-in-finder-get-info',
            });
          return;
        }
        if (result.outcome === 'unavailable') {
          useToastStore
            .getState()
            .addToast(toUserMessage(result, 'failure.default-app-controls-are-unavailable'), {
              definition: 'file-handling-settings-default-app-controls-are-unavailable',
            });
          return;
        }

        const latest = await refresh();
        if (!latest) return;
        const confirmed = latest.some(
          (status) => status.familyId === familyId && status.state === 'default'
        );
        useToastStore.getState().addToast(
          confirmed
            ? userMessageWithValues('notice.dnaforge-is-now-the-default-app-for-value-files', {
                value0: userMessageValue(family.displayName),
              })
            : userMessage('notice.the-system-did-not-report-dnaforge-as-the-default-app'),
          {
            definition:
              'file-handling-settings-the-system-did-not-report-dnaforge-as-the-default-app',
            variant: confirmed ? 'success' : 'warning',
          }
        );
      } catch (error) {
        useToastStore.getState().addToast(toUserMessage(error, 'file.defaultAppFailed'), {
          definition: 'file-handling-settings-could-not-change-the-default-app-example-error',
        });
      } finally {
        setPendingAction(null);
      }
    },
    [refresh]
  );

  const previewFile = useCallback(async (familyId: FileAssociationFamilyId) => {
    const family = FILE_ASSOCIATION_FAMILIES.find((candidate) => candidate.id === familyId);
    if (!family) return;
    setPendingAction({ familyId, kind: 'preview' });
    try {
      const picked = await platform().dialog.open({
        title: `Preview a ${family.displayName} file`,
        filters: [{ name: family.displayName, extensions: [...family.extensions] }],
      });
      const sourcePath = Array.isArray(picked) ? picked[0] : picked;
      if (typeof sourcePath !== 'string') return;
      const matched = associationFamilyForPath(sourcePath);
      if (matched?.id !== family.id) {
        const extensions = family.extensions.map((ext) => `.${ext}`).join(', ');
        useToastStore.getState().addToast(
          userMessageWithValues('notice.choose-a-value-file-value', {
            value0: userMessageValue(family.displayName),
            value1: userMessageValue(extensions),
          }),
          {
            definition: 'file-handling-settings-choose-a-example-file-example',
          }
        );
        return;
      }
      const tabId = await openQuickLookSource({
        sourcePath,
        familyId: family.id,
        sourceSurface: 'menu',
      });
      if (tabId) window.dispatchEvent(new Event(REVEAL_OPEN_DOCUMENT_EVENT));
    } catch (error) {
      useToastStore.getState().addToast(toUserMessage(error, 'file.previewFailed'), {
        definition: 'file-handling-settings-could-not-preview-the-file-example-error',
      });
    } finally {
      setPendingAction(null);
    }
  }, []);

  return (
    <div className="space-y-3" data-testid="file-handling-settings">
      <p className="mb-5 max-w-2xl text-sm leading-5 text-fg-muted">
        Preview files without changing the originals. Use Import to Edit to copy them into a
        project.
      </p>
      {FILE_ASSOCIATION_FAMILIES.map((family) => (
        <FamilyRow
          key={family.id}
          family={family}
          status={statusesByFamily.get(family.id)}
          pendingAction={pendingAction}
          refreshing={refreshing}
          onRequest={(id) => void requestDefault(id)}
          onPreview={(id) => void previewFile(id)}
        />
      ))}
      {showDefaultAppSteps ? (
        <details className={SETTINGS_CARD_CLASS} data-testid="file-handler-howto">
          <summary className="cursor-pointer text-sm font-medium text-fg focus-visible:outline-accent">
            Change the default app in Finder
          </summary>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            This development window cannot register itself as the default app.
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs leading-5 text-fg-muted">
            {DEFAULT_APP_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
      ) : null}
      <SettingsButton
        onClick={() => void refresh()}
        data-testid="file-handler-refresh"
        disabled={refreshing || pendingAction !== null}
      >
        {refreshing ? 'Checking defaults…' : 'Refresh default-app status'}
      </SettingsButton>
    </div>
  );
}
