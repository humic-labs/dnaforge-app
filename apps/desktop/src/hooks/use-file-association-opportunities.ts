import {
  userMessage,
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { useEffect, useRef } from 'react';
import { getSetting, setSetting } from '../db';
import { platform } from '../platform';
import { associationFamilyForPath, fileAssociationFamily } from '../shared/file-associations';
import { useToastStore } from '../stores/toast-store';
import { subscribeVisibleFileOpen } from '../features/sequence/file-open-telemetry';
import { FileAssociationOpportunityCoordinator } from '../features/file-associations/opportunity-coordinator';

interface UseFileAssociationOpportunitiesOptions {
  readonly now?: () => number;
}

function showDefaultRequestOutcome(
  outcome: Awaited<ReturnType<FileAssociationOpportunityCoordinator['requestDefault']>>
): void {
  const { addToast } = useToastStore.getState();
  if (outcome.confirmedDefault) {
    addToast(userMessage('notice.dnaforge-is-now-the-default-app-for-these-files'), {
      definition:
        'use-file-association-opportunities-dnaforge-is-now-the-default-app-for-these-files',
    });
    return;
  }
  if (outcome.request.outcome === 'opened-settings') {
    addToast(userMessage('notice.choose-dnaforge-in-windows-default-apps-then-return-here'), {
      definition:
        'use-file-association-opportunities-choose-dnaforge-in-windows-default-apps-then-return-here',
    });
    return;
  }
  if (outcome.request.outcome === 'instructions') {
    addToast(
      outcome.request.detail != null
        ? toUserMessage(outcome.request, 'operation.failed')
        : userMessage('notice.change-the-default-app-in-system-settings'),
      {
        definition: 'use-file-association-opportunities-change-the-default-app-in-system-settings',
      }
    );
    return;
  }
  if (outcome.request.outcome === 'requested') {
    addToast(
      userMessage('notice.the-request-completed-but-the-system-did-not-report-dnaforge-as-defaul'),
      {
        definition:
          'use-file-association-opportunities-the-request-completed-but-the-system-did-not-report-dnaforge-as-default',
      }
    );
    return;
  }
  addToast(
    outcome.request.detail != null
      ? toUserMessage(outcome.request, 'operation.failed')
      : userMessage('failure.default-app-controls-are-unavailable'),
    {
      definition: 'use-file-association-opportunities-default-app-controls-are-unavailable',
    }
  );
}

async function persistPromptPreference(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    useToastStore
      .getState()
      .addToast(userMessage('notice.could-not-save-the-default-app-prompt-preference'), {
        definition:
          'use-file-association-opportunities-could-not-save-the-default-app-prompt-preference',
      });
  }
}

export function useFileAssociationOpportunities(
  options: UseFileAssociationOpportunitiesOptions = {}
): void {
  const coordinatorRef = useRef<FileAssociationOpportunityCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new FileAssociationOpportunityCoordinator({
      getSetting,
      setSetting,
      queryHandlers: () => platform().fileAssociations.queryHandlers(),
      requestDefault: (familyId) => platform().fileAssociations.requestDefault(familyId),
      now: options.now,
    });
  }

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;

    return subscribeVisibleFileOpen(({ filePath, associationFamilyId }) => {
      const usedFamily = associationFamilyId
        ? fileAssociationFamily(associationFamilyId)
        : associationFamilyForPath(filePath);
      if (!usedFamily) return;
      void coordinator
        .recordSuccessfulUse(usedFamily.id)
        .then((opportunity) => {
          if (!opportunity) return;
          const family = fileAssociationFamily(opportunity.familyId);
          let actionTaken = false;
          useToastStore.getState().addRichToast({
            definition:
              'use-file-association-opportunities-make-dnaforge-the-default-app-for-example-files',
            message: userMessageWithValues('notice.make-dnaforge-the-default-app-for-value-files', {
              value0: userMessageValue(family.displayName),
            }),
            onDismiss: async () => {
              if (actionTaken) return;
              actionTaken = true;
              await persistPromptPreference(() => coordinator.snooze(family.id));
            },
            actions: [
              {
                label: 'Make DNAForge default',
                onClick: async () => {
                  actionTaken = true;
                  try {
                    const outcome = await coordinator.requestDefault(family.id);
                    showDefaultRequestOutcome(outcome);
                    if (outcome.request.outcome === 'opened-settings') {
                      window.addEventListener(
                        'focus',
                        () => void coordinator.refreshConfirmedDefaults().catch(() => undefined),
                        { once: true }
                      );
                    }
                  } catch (error) {
                    useToastStore
                      .getState()
                      .addToast(toUserMessage(error, 'file.defaultAppFailed'), {
                        definition:
                          'use-file-association-opportunities-could-not-change-the-default-app-example-error',
                      });
                  }
                },
              },
              {
                label: 'Not now',
                onClick: async () => {
                  actionTaken = true;
                  await persistPromptPreference(() => coordinator.snooze(family.id));
                },
              },
              {
                label: "Don't ask again",
                onClick: async () => {
                  actionTaken = true;
                  await persistPromptPreference(() => coordinator.dismissPermanently(family.id));
                },
              },
            ],
          });
        })
        .catch(() => undefined);
    });
  }, []);
}
