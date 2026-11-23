import {
  namedEntityTypePresentation,
  resolveNamedEntityType,
} from '@waypoint/scientific-artifacts/shared/entity-types';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { memo, useCallback, useMemo } from 'react';

import { EntityReferenceChip } from '../../../../components/entity-reference/EntityReferenceChip';
import { readMentionReference } from '../../../../shared/notebook-reference';
import { parseWorkTaskReferenceHref } from '../../../../shared/work-task-reference';
import { WorkTaskReferenceChip } from './WorkTaskReferenceChip';
import { SavedReferenceChip } from './SavedReferenceChip';
import { ProjectResourceReferenceChip } from './ProjectResourceReferenceChip';
import { isProjectResourceReferenceHref } from '../../../../shared/project-resource-reference';

export interface MentionChipIntent {
  entityType: string;
  entityId: string | null;
  label: string;
  path: string | null;
  contentHash: string | null;

  owningRoot: string | null;

  objectUuid: string | null;
  projectId: string | null;
}

export type MentionChipAction = 'open' | 'reveal';

function intentFrom(attrs: Record<string, unknown>, owningRoot: string | null): MentionChipIntent {
  return {
    owningRoot,
    entityType: typeof attrs.entityType === 'string' ? attrs.entityType : 'page',
    entityId: typeof attrs.entityId === 'string' ? attrs.entityId : null,
    label: typeof attrs.label === 'string' ? attrs.label : '',
    path: typeof attrs.path === 'string' ? attrs.path : null,
    contentHash: typeof attrs.contentHash === 'string' ? attrs.contentHash : null,
    objectUuid: typeof attrs.objectUuid === 'string' ? attrs.objectUuid : null,
    projectId: typeof attrs.projectId === 'string' ? attrs.projectId : null,
  };
}

function dispatch(intent: MentionChipIntent, action: MentionChipAction): void {
  window.dispatchEvent(new CustomEvent('waypoint:open-entity', { detail: { ...intent, action } }));
}

function WorkspaceMentionChip({ node, extension }: NodeViewProps) {
  const owningRoot =
    (
      extension?.options as { referenceWorkspaceRoot?: (() => string | null) | null } | undefined
    )?.referenceWorkspaceRoot?.() ?? null;
  const intent = useMemo(
    () => intentFrom(node.attrs as Record<string, unknown>, owningRoot),
    [node.attrs, owningRoot]
  );
  const canOpen = Boolean(
    intent.entityId || intent.path || intent.objectUuid || intent.contentHash
  );

  const shape = useMemo(
    () => readMentionReference(node.attrs as Record<string, unknown>),
    [node.attrs]
  );
  const portablePath =
    shape.kind === 'record' ? shape.ref.path : shape.kind === 'legacy-path' ? shape.path : null;

  const localOnly = !portablePath && Boolean(intent.entityId);
  const registryKind = typeof node.attrs.registryKind === 'string' ? node.attrs.registryKind : null;
  const fallbackType = namedEntityTypePresentation(
    resolveNamedEntityType({ type: intent.entityType, registryKind })
  );

  const open = useCallback(() => {
    if (canOpen) {
      const liveOwningRoot =
        (
          extension?.options as
            | { referenceWorkspaceRoot?: (() => string | null) | null }
            | undefined
        )?.referenceWorkspaceRoot?.() ?? intent.owningRoot;
      dispatch({ ...intent, owningRoot: liveOwningRoot }, 'open');
    }
  }, [canOpen, extension, intent]);

  const reveal = useCallback(() => {
    const liveOwningRoot =
      (
        extension?.options as { referenceWorkspaceRoot?: (() => string | null) | null } | undefined
      )?.referenceWorkspaceRoot?.() ?? intent.owningRoot;
    dispatch({ ...intent, owningRoot: liveOwningRoot }, 'reveal');
  }, [extension, intent]);

  return (
    <NodeViewWrapper
      as="span"
      className="mention"
      data-type="mention"
      data-entity-type={intent.entityType}
      data-entity-id={intent.entityId ?? undefined}
      data-path={intent.path ?? undefined}
      data-content-hash={intent.contentHash ?? undefined}
      data-object-uuid={intent.objectUuid ?? undefined}
      data-registry-kind={registryKind ?? undefined}
      data-project-id={intent.projectId ?? undefined}
      data-testid="mention-node"
    >
      <EntityReferenceChip
        entityType={intent.entityType}
        kindLabel={fallbackType.kindLabel}
        iconKind={fallbackType.iconKind}
        typeLookup={
          intent.entityId ? { entityId: intent.entityId, projectId: intent.projectId } : undefined
        }
        iconContext={{
          kind: registryKind ?? intent.entityType,
          path: portablePath ?? intent.path ?? undefined,
        }}
        label={intent.label}
        detail={portablePath}
        onOpen={canOpen ? open : undefined}
        onReveal={portablePath ? reveal : undefined}
        unavailable={!canOpen}
        localOnly={localOnly}
        testId="mention-chip"
        labelTestId="mention-chip-label"
        detailTestId="mention-chip-detail"
      />
    </NodeViewWrapper>
  );
}

function MentionChipInner(props: NodeViewProps) {
  const task = parseWorkTaskReferenceHref(props.node.attrs.referenceUri);
  if (task) return <WorkTaskReferenceChip {...props} reference={task} />;
  if (
    props.node.attrs.entityType === 'project-resource' ||
    (typeof props.node.attrs.referenceUri === 'string' &&
      isProjectResourceReferenceHref(props.node.attrs.referenceUri))
  )
    return <ProjectResourceReferenceChip {...props} />;
  return typeof props.node.attrs.referenceUri === 'string' ? (
    <SavedReferenceChip {...props} />
  ) : (
    <WorkspaceMentionChip {...props} />
  );
}

export const MentionChip = memo(MentionChipInner, (prev, next) => {
  const a = prev.node.attrs as Record<string, unknown>;
  const b = next.node.attrs as Record<string, unknown>;
  return (
    a.entityType === b.entityType &&
    a.path === b.path &&
    a.entityId === b.entityId &&
    a.label === b.label &&
    a.contentHash === b.contentHash &&
    a.objectUuid === b.objectUuid &&
    a.referenceUri === b.referenceUri &&
    a.registryKind === b.registryKind &&
    a.projectId === b.projectId &&
    a.resourceReference === b.resourceReference
  );
});
