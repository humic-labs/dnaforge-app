import { reportSaveFailure } from '../../../lib/report-save-failure';
import { useSequenceStore } from '../../sequence/public/store';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef } from 'react';
import type { Tab } from '../../canvas/public/types';
import {
  captureDesignRecovery,
  designContentIdentity,
  useDesignRecoveryStore,
} from '../design-recovery';
import {
  drainDesignArtifactMirrors,
  hasPendingDesignArtifactMirror,
} from '../design-artifact-mirror';
import { useDesignStore } from '../store';
import type { SequenceDesign } from '../types';
import { useToastStore } from '../../../stores/toast-store';
import { registerWorkspaceEditorBlocker } from '../../../services/workspace-editor-mutation-state';

export function useEmbeddedAssemblyWorkingCopyOwner({
  designId,
  tab,
  panelId,
  onExitToSequence,
}: {
  designId: string;
  tab?: Tab;
  panelId?: string;
  onExitToSequence?: () => void;
}): { exitToSequence: (() => void) | undefined } {
  const embedded = Boolean(
    tab?.type === 'sequence' && tab.assemblyEditDesignId === designId && panelId
  );
  const design = useDesignStore((state) => state.designs[designId]);
  const recovery = useDesignRecoveryStore((state) => state.records[designId]);
  const originalRef = useRef<{ id: string; design: SequenceDesign } | null>(null);
  const exitingRef = useRef(false);
  const savingRef = useRef(false);
  const managedDocument =
    tab?.sequenceDocument?.kind === 'managed-sequence' ? tab.sequenceDocument : null;

  useEffect(() => {
    if (!embedded || !design) {
      originalRef.current = null;
      return;
    }
    if (originalRef.current?.id !== designId) originalRef.current = { id: designId, design };
  }, [design, designId, embedded]);

  const identity = design ? designContentIdentity(design) : null;
  const unsaved = Boolean(
    embedded &&
    design &&
    (recovery?.pending ||
      (recovery
        ? recovery.revision !== identity
        : originalRef.current?.id === designId &&
          designContentIdentity(originalRef.current.design) !== identity))
  );

  useEffect(() => {
    if (!embedded || !managedDocument) return;
    return registerWorkspaceEditorBlocker(() => {
      const current = useDesignStore.getState().designs[designId];
      const saved = useDesignRecoveryStore.getState().records[designId];
      const changed = Boolean(
        current &&
        (saved
          ? saved.revision !== designContentIdentity(current)
          : originalRef.current?.id === designId &&
            designContentIdentity(originalRef.current.design) !== designContentIdentity(current))
      );
      return {
        entityId: managedDocument.packageId,
        path: managedDocument.packageRoot,
        state: savingRef.current
          ? ('saving' as const)
          : changed || hasPendingDesignArtifactMirror([designId])
            ? ('dirty' as const)
            : ('clean' as const),
      };
    });
  }, [designId, embedded, managedDocument]);

  const saveWorkingCopy = useCallback(async (): Promise<void> => {
    savingRef.current = true;
    try {
      const current = useDesignStore.getState().designs[designId];
      if (!current) throw new Error('The assembly working copy is unavailable.');
      const currentIdentity = designContentIdentity(current);
      const record = useDesignRecoveryStore.getState().records[designId];
      if (record?.revision !== currentIdentity) {
        captureDesignRecovery(current, record?.design ?? originalRef.current?.design);
      }
      await drainDesignArtifactMirrors([designId]);
      const latest = useDesignStore.getState().designs[designId];
      const saved = useDesignRecoveryStore.getState().records[designId];
      if (
        !latest ||
        (saved && (saved.pending || saved.revision !== designContentIdentity(latest)))
      ) {
        throw new Error('The assembly changed while it was saving. Save again before leaving.');
      }
    } finally {
      savingRef.current = false;
    }
  }, [designId]);

  useDocumentLifecycle(
    embedded && tab
      ? {
          target: { kind: 'sequence-document', documentId: tab.entityId },
          discard: () => {
            useSequenceStore.getState().discardEdits(tab.entityId);
          },
          tabId: tab.id,
          isDirty: () => unsaved,
          save: async () => {
            try {
              await saveWorkingCopy();
              return true;
            } catch (error) {
              reportSaveFailure(
                '[EmbeddedAssembly] Save failed:',
                { designId, tabId: tab.id },
                error
              );
              useToastStore
                .getState()
                .addToast(
                  toUserMessage(error, 'failure.could-not-save-the-assembly-working-copy'),
                  {
                    definition: 'assembly-working-copy-save-failed',
                  }
                );
              return false;
            }
          },
        }
      : null
  );

  const exitToSequence = useCallback(() => {
    if (!onExitToSequence) return;
    if (!embedded) {
      onExitToSequence();
      return;
    }
    if (exitingRef.current) return;
    exitingRef.current = true;
    void saveWorkingCopy()
      .then(onExitToSequence)
      .catch((error: unknown) => {
        console.warn('[DesignTab] Could not preserve assembly copy before switching views:', error);
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-save-the-assembly-working-copy'), {
            definition: 'assembly-working-copy-save-failed',
          });
      })
      .finally(() => {
        exitingRef.current = false;
      });
  }, [embedded, onExitToSequence, saveWorkingCopy]);

  return { exitToSequence: onExitToSequence ? exitToSequence : undefined };
}
