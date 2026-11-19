import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Tab } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { requestTabClose } from '../../canvas/public/artifact-document-lifecycle';
import { EntityDetails } from '../../entity-details/public/EntityDetails';
import { getEntityDetailsSession } from '../../entity-details/public/session';
import {
  commitReadableContent,
  failReadableContent,
} from '../../../lib/readable-content-telemetry';

export function EntityRecordTab({ tab, panelId }: { tab: Tab; panelId: string }) {
  const updateTab = useCanvasStore((state) => state.updateTab);
  const target = useMemo(() => ({ entityId: tab.entityId, recordFile: true }), [tab.entityId]);
  const session = useMemo(() => getEntityDetailsSession(target), [target]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    if (state.loading) return;
    if (state.definition?.savedRecord?.loaded.artifact.id === tab.entityId)
      commitReadableContent(tab.entityId);
    else if (state.error) failReadableContent(tab.entityId);
  }, [state.loading, state.definition, state.error, tab.entityId]);

  useEffect(() => {
    const artifact = state.definition?.savedRecord?.loaded.artifact;
    if (!artifact || artifact.id !== tab.entityId || artifact.kind === tab.entityKind) return;
    updateTab(panelId, tab.id, { entityKind: artifact.kind });
  }, [state.definition, tab.entityId, tab.entityKind, tab.id, panelId, updateTab]);

  useDocumentLifecycle({
    target: { kind: 'tab', tabId: tab.id },
    tabId: tab.id,
    isDirty: () => session.dirty || session.getSnapshot().completionPending,
    save: async () => {
      if (tab.readOnly) return false;
      if (session.getSnapshot().completionPending) await session.retryCompletion();
      else await session.save();
      const current = session.getSnapshot();
      return (
        !session.dirty &&
        !current.saving &&
        !current.requiresReload &&
        !current.completionPending &&
        !current.mutationBlock
      );
    },
    discard: () => session.discard(),
  });

  return (
    <div
      data-testid="entity-record-tab"
      data-entity-id={tab.entityId}
      data-workspace-id={
        state.definition?.savedRecord?.loaded.preview.entity.workspaceId ?? undefined
      }
      className="h-full min-h-0 min-w-0 overflow-hidden"
    >
      <EntityDetails
        target={target}
        tabId={tab.id}
        readOnly={tab.readOnly}
        onClose={() => {
          void requestTabClose(panelId, tab.id);
        }}
        onSaved={(record) => updateTab(panelId, tab.id, { label: record.name })}
      />
    </div>
  );
}
