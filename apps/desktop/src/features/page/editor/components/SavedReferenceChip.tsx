import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { EntityReferenceChip } from '../../../../components/entity-reference/EntityReferenceChip';
import { useSavedReferenceChip } from './SavedReferenceChipContent';

export function SavedReferenceChip({ node, extension }: NodeViewProps) {
  const href = typeof node.attrs.referenceUri === 'string' ? node.attrs.referenceUri : '';
  const sourceNotebookPageId =
    (
      extension.options as { referenceNotebookPageId?: () => string | null }
    ).referenceNotebookPageId?.() ?? undefined;
  const { entityType, referenceId, chipProps } = useSavedReferenceChip({
    href,
    label: typeof node.attrs.label === 'string' ? node.attrs.label : '',
    sourceNotebookPageId,
  });
  return (
    <NodeViewWrapper
      as="span"
      className="mention"
      data-type="mention"
      data-entity-type={entityType}
      data-reference-uri={href}
      data-reference-id={referenceId ?? undefined}
      data-testid="mention-node"
    >
      <EntityReferenceChip {...chipProps} />
    </NodeViewWrapper>
  );
}
