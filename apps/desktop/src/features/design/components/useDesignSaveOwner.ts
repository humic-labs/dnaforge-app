import { reportSaveFailure } from '../../../lib/report-save-failure';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef } from 'react';
import { useCommandScope } from '../../../commands/useCommandScope';
import { COMMAND_SCOPES } from '../../../commands/types';
import { useToastStore } from '../../../stores/toast-store';
import { useCanvasStore } from '../../canvas/public/store';
import type { Tab } from '../../canvas/public/types';
import {
  isEphemeralArtifactDraft,
  saveTargetForTab,
} from '../../canvas/public/artifact-document-lifecycle';
import {
  discardDesignArtifactChanges,
  drainDesignArtifactMirrors,
} from '../design-artifact-mirror';
import {
  captureDesignRecovery,
  designContentIdentity,
  useDesignRecoveryStore,
} from '../design-recovery';
import { useDesignStore } from '../store';
import { ensureDesignArtifact } from '../materialize-design-artifact';

export function useDesignSaveOwner({
  designId,
  tab,
  panelId,
}: {
  designId: string;
  tab?: Tab;
  panelId?: string;
}): ReturnType<typeof useCommandScope>['eventHandlers'] {
  const ownedTab = tab?.type === 'design' && tab.entityId === designId ? tab : null;
  const focused = useCanvasStore((state) => {
    if (!ownedTab || !panelId || state.focusedPanelId !== panelId) return false;
    const panel = state.panels[panelId];
    return panel?.activeTabId === ownedTab.id;
  });
  const inFlight = useRef<{ designId: string; promise: Promise<void> } | null>(null);

  const scope = useCommandScope(COMMAND_SCOPES.tabSequence, {
    enabled: focused,
    claimOnMount: focused,
  });
  const flush = useCallback(async () => {
    if (inFlight.current?.designId === designId) return inFlight.current.promise;
    const save = async () => {
      const current = useDesignStore.getState().designs[designId];
      const recovery = useDesignRecoveryStore.getState().records[designId];
      if (!current || recovery?.retired) throw new Error('The assembly is unavailable.');
      captureDesignRecovery(current, recovery?.design);
      await drainDesignArtifactMirrors([designId]);
      const latest = useDesignStore.getState().designs[designId];
      const saved = useDesignRecoveryStore.getState().records[designId];
      if (
        !latest ||
        !saved ||
        saved.retired ||
        saved.pending ||
        saved.revision !== designContentIdentity(latest)
      ) {
        throw new Error('The assembly changed while saving. Save again before leaving.');
      }
    };
    const run = { designId, promise: save() };
    inFlight.current = run;
    try {
      await run.promise;
    } finally {
      if (inFlight.current === run) inFlight.current = null;
    }
  }, [designId]);

  const design = useDesignStore((state) => state.designs[designId]);
  useDesignRecoveryStore((state) => state.records[designId]);
  const commitDraftDesign = useDesignStore((state) => state.commitDraftDesign);
  const updateTab = useCanvasStore((state) => state.updateTab);
  const draftContext =
    tab?.artifactDocument?.kind === 'assembly' && tab.artifactDocument.persistence === 'draft'
      ? tab.artifactDocument
      : null;
  const draftBaselineRef = useRef<{ designId: string; version: number; name: string } | null>(null);

  useEffect(() => {
    if (!draftContext || !tab || !panelId || !design) {
      draftBaselineRef.current = null;
      return;
    }
    const baseline = draftBaselineRef.current;
    if (!baseline || baseline.designId !== designId) {
      draftBaselineRef.current = {
        designId,
        version: design.version,
        name: design.name,
      };
      return;
    }
    if (baseline.version !== design.version || baseline.name !== design.name) {
      updateTab(panelId, tab.id, { label: design.name });
    }
  }, [design, designId, draftContext, panelId, tab, updateTab]);

  useDocumentLifecycle(
    draftContext && tab && panelId
      ? {
          target: { kind: 'tab', tabId: tab.id },
          tabId: tab.id,
          readRevision: () =>
            designContentIdentity(useDesignStore.getState().designs[designId] ?? null),
          isDirty: () => {
            const current = useDesignStore.getState().designs[designId];
            const baseline = draftBaselineRef.current;
            return Boolean(
              current &&
              baseline &&
              (current.version !== baseline.version || current.name !== baseline.name)
            );
          },
          save: async () => {
            try {
              const state = useDesignStore.getState();
              const current = state.designs[designId];
              if (!current) throw new Error('Assembly design is unavailable.');
              const runId = current.mocloFactory?.runId;
              const siblingDrafts = Object.keys(state.draftDesignIds ?? {}).flatMap((id) => {
                const candidate = state.designs[id];
                return candidate &&
                  id !== designId &&
                  runId &&
                  candidate.mocloFactory?.runId === runId
                  ? [candidate]
                  : [];
              });
              const drafts = [current, ...siblingDrafts];
              const captured = drafts.map((draft) => designContentIdentity(draft));
              let activeArtifactPath = '';
              for (const draft of drafts) {
                const artifactPath = await ensureDesignArtifact({
                  design: draft,
                  workspaceRoot: draftContext.workspaceRoot,
                  source: 'interactive-draft',
                  context: {
                    targetPath: draftContext.destinationPath,
                    targetKind: 'folder',
                    parentPath: draftContext.destinationPath,
                    workspaceRoot: draftContext.workspaceRoot,
                  },
                });
                if (draft.id === designId) activeArtifactPath = artifactPath;
              }
              const latest = useDesignStore.getState();
              const activeTab = useCanvasStore
                .getState()
                .panels[panelId]?.tabs.find((item) => item.id === tab.id);
              if (
                activeTab?.entityId !== designId ||
                !drafts.every(
                  (draft, index) =>
                    latest.draftDesignIds?.[draft.id] &&
                    designContentIdentity(latest.designs[draft.id] ?? null) === captured[index]
                )
              )
                return false;
              for (const draft of drafts) commitDraftDesign(draft.id);
              updateTab(panelId, tab.id, { artifactDocument: undefined });
              window.dispatchEvent(
                new CustomEvent('waypoint:workspace-files-changed', {
                  detail: {
                    workspaceRoot: draftContext.workspaceRoot,
                    revealPath: activeArtifactPath,
                  },
                })
              );
              return { publishedRevision: captured[0] };
            } catch (error) {
              console.warn('[DesignTab] Failed to save draft assembly:', error);
              return false;
            }
          },
          discard: () => {
            const state = useDesignStore.getState();
            const active = state.designs[designId];
            const runId = active?.mocloFactory?.runId;
            const ids = Object.keys(state.draftDesignIds ?? {}).filter((id) => {
              if (id === designId) return true;
              return Boolean(runId && state.designs[id]?.mocloFactory?.runId === runId);
            });
            for (const id of ids) state.deleteDesign(id);
          },
        }
      : ownedTab && !isEphemeralArtifactDraft(ownedTab)
        ? {
            target: saveTargetForTab(ownedTab),
            discard: () => discardDesignArtifactChanges(designId),
            tabId: ownedTab.id,
            readRevision: () =>
              designContentIdentity(useDesignStore.getState().designs[designId] ?? null),
            isDirty: () => {
              const current = useDesignStore.getState().designs[designId];
              const recovery = useDesignRecoveryStore.getState().records[designId];
              return Boolean(
                current &&
                recovery &&
                (recovery.pending || recovery.revision !== designContentIdentity(current))
              );
            },
            save: async () => {
              const ownsTarget = () => {
                const current = panelId
                  ? useCanvasStore
                      .getState()
                      .panels[panelId]?.tabs.find((candidate) => candidate.id === ownedTab.id)
                  : null;
                return current?.type === 'design' && current.entityId === designId;
              };
              if (!ownsTarget()) return false;
              try {
                await flush();
                return ownsTarget();
              } catch (error) {
                reportSaveFailure(
                  '[DesignTab] Save failed:',
                  { designId, tabId: ownedTab.id },
                  error
                );
                useToastStore
                  .getState()
                  .addToast(
                    userMessage('notice.could-not-save-the-assembly-keep-it-open-and-try-again'),
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
  return scope.eventHandlers;
}
