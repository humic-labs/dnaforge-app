import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import { EntityReferenceChip } from '../../../../components/entity-reference/EntityReferenceChip';
import { platform } from '../../../../platform';
import { useToastStore } from '../../../../stores/toast-store';
import { openNotebookResourceReference } from '../../../../services/notebook-resource-navigation';
import {
  projectResourceReferenceSchema,
  type ResolvedProjectResourceReference,
} from '../../../../shared/project-resource-reference';

export function ProjectResourceReferenceChip({ node, extension }: NodeViewProps) {
  const documentId =
    (
      extension.options as { referenceNotebookPageId?: () => string | null }
    ).referenceNotebookPageId?.() ?? null;
  const raw =
    typeof node.attrs.referenceUri === 'string'
      ? node.attrs.referenceUri
      : node.attrs.resourceReference;
  const key = JSON.stringify({ documentId, reference: raw });
  const reference = useMemo(() => {
    if (typeof raw === 'string') return raw;
    const parsed = projectResourceReferenceSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }, [key]);
  const [state, setState] = useState<{
    key: string;
    resource: ResolvedProjectResourceReference | null;
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const resource = state?.key === key ? state.resource : null;
  const loading = Boolean(documentId && reference && state?.key !== key);
  useEffect(() => {
    let current = true;
    const resolver = platform().notebook.resolveResourceReference;
    if (!documentId || !reference || !resolver) {
      setState({ key, resource: null });
      return;
    }
    void resolver({ documentId, reference }).then(
      (value) => {
        if (current) setState({ key, resource: value });
      },
      () => {
        if (current) setState({ key, resource: null });
      }
    );
    return () => {
      current = false;
    };
  }, [documentId, reference, key]);
  const open = useCallback(async () => {
    if (!documentId || !reference || opening) return;
    setOpening(true);
    try {
      await openNotebookResourceReference({ documentId, reference });
    } catch (error) {
      setState({ key, resource: null });
      useToastStore.getState().addToast(toUserMessage(error, 'document.referenceUnavailable'), {
        definition: 'page-reference-open-failed',
      });
    } finally {
      setOpening(false);
    }
  }, [documentId, reference, opening, key]);
  const label =
    typeof node.attrs.label === 'string' && node.attrs.label
      ? node.attrs.label
      : (resource?.label ?? 'Project resource');
  const entityType =
    resource?.entityType ??
    (reference && typeof reference !== 'string' && reference.kind === 'path'
      ? reference.resourceKind
      : 'reference');
  return (
    <NodeViewWrapper
      as="span"
      className="mention"
      data-type="mention"
      data-entity-type="project-resource"
      data-testid="mention-node"
    >
      <EntityReferenceChip
        entityType={entityType}
        iconContext={
          resource?.iconContext ?? { path: resource?.path, isDirectory: entityType === 'directory' }
        }
        label={label}
        detail={resource?.path}
        busy={loading || opening}
        onOpen={resource ? open : undefined}
        unavailable={!loading && !resource}
        testId="mention-chip"
        labelTestId="mention-chip-label"
        detailTestId="mention-chip-detail"
      />
    </NodeViewWrapper>
  );
}
