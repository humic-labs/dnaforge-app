import { useEffect, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { EntityReferenceChip } from '../../../../components/entity-reference/EntityReferenceChip';
import { platform } from '../../../../platform';
import type { WorkTaskReference } from '../../../../shared/work-task-reference';
import type { WorkTaskRecord } from '../../../../shared/work-tasks-ipc';
import { observeWorkTasks, openWorkTask, useWorkAccount } from '../../../work/public/work';
import { getNativeNotebookDocumentClient } from '../../notebook-document-client';

export function WorkTaskReferenceChip({
  node,
  extension,
  reference,
}: NodeViewProps & { reference: WorkTaskReference }) {
  const options = extension.options as {
    referenceNotebookPageId?: () => string | null;
    referenceWorkspaceRoot?: () => string | null;
  };
  const pageId = options.referenceNotebookPageId?.();
  const root =
    options.referenceWorkspaceRoot?.() ||
    (pageId ? getNativeNotebookDocumentClient(pageId).snapshot?.workspaceRoot : null);
  const account = useWorkAccount();
  const scope = JSON.stringify([account, root, reference.projectId, reference.taskId]);
  const [read, setRead] = useState<{ scope: string; task: WorkTaskRecord | null } | null>(null);
  useEffect(() => {
    let current = true;
    let generation = 0;
    async function refresh() {
      const request = ++generation;
      try {
        const task = root
          ? await platform().workTasks.read({ workspaceRoot: root, taskId: reference.taskId })
          : null;
        if (current && request === generation)
          setRead({ scope, task: task?.project.id === reference.projectId ? task : null });
      } catch {
        if (current && request === generation) setRead({ scope, task: null });
      }
    }
    void refresh();
    const off = observeWorkTasks(refresh);
    return () => {
      current = false;
      off();
    };
  }, [scope, root, reference.projectId, reference.taskId]);
  const task = read?.scope === scope ? read.task : null;
  const loading = read?.scope !== scope;
  return (
    <NodeViewWrapper
      as="span"
      className="mention"
      data-type="mention"
      data-entity-type="work-task"
      data-reference-uri={node.attrs.referenceUri}
      data-testid="mention-node"
    >
      <EntityReferenceChip
        entityType="work-task"
        kindLabel="Task"
        label={task?.document.name ?? (loading ? 'Loading task…' : 'Task unavailable')}
        busy={loading}
        unavailable={!loading && !task}
        onOpen={
          task
            ? () => {
                openWorkTask({ workspaceRoot: task.project.root, taskId: task.id });
              }
            : undefined
        }
        detail={
          task
            ? { todo: 'To do', 'in-progress': 'In progress', done: 'Done', canceled: 'Canceled' }[
                task.document.status
              ]
            : undefined
        }
        testId="work-task-reference"
        labelTestId="mention-chip-label"
        detailTestId="mention-chip-detail"
      />
    </NodeViewWrapper>
  );
}
