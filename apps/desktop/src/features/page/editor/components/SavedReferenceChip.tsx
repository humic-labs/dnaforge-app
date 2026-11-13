import { toUserMessage } from '@waypoint/user-messages';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useCallback, useEffect, useState } from 'react';

import { EntityReferenceChip } from '../../../../components/entity-reference/EntityReferenceChip';
import type { DBEntityReference } from '../../../../db/entity-references';
import { savedReferenceIdFromHref } from '../../../../shared/saved-reference-url';
import { resolveMolecularReference } from '../../../../shared/molecular-reference';
import { useToastStore } from '../../../../stores/toast-store';
import { navigateToReference } from '../../../ai/public/navigate-to-reference';
import { molecularDocumentReferenceFromHref } from '../../../../shared/molecular-document-reference';
import { resolveMolecularReferenceRecord } from '../../../molecular-documents/public/references';

export function SavedReferenceChip({ node, extension }: NodeViewProps) {
  const href = typeof node.attrs.referenceUri === 'string' ? node.attrs.referenceUri : '';
  const referenceId = savedReferenceIdFromHref(href);
  const documentReference = molecularDocumentReferenceFromHref(href);
  const [resolved, setResolved] = useState<{
    id: string;
    reference: DBEntityReference | null;
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const reference = resolved?.id === href ? (resolved?.reference ?? null) : null;
  const loading = Boolean((referenceId || documentReference) && resolved?.id !== href);
  useEffect(() => {
    let current = true;
    if (!referenceId && !documentReference) {
      setResolved({ id: href, reference: null });
      return;
    }
    const pageId = (
      extension.options as { referenceNotebookPageId?: () => string | null }
    ).referenceNotebookPageId?.();
    void resolveMolecularReferenceRecord(
      href,
      node.attrs.label || 'Saved result',
      pageId ?? undefined
    ).then(
      (value) => {
        if (current) setResolved({ id: href, reference: value });
      },
      () => {
        if (current) setResolved({ id: href, reference: null });
      }
    );
    return () => {
      current = false;
    };
  }, [href, referenceId, node.attrs.label, extension]);
  const open = useCallback(async () => {
    if ((!referenceId && !documentReference) || opening) return;
    setOpening(true);
    try {
      const pageId = (
        extension.options as { referenceNotebookPageId?: () => string | null }
      ).referenceNotebookPageId?.();
      const current = await resolveMolecularReferenceRecord(
        href,
        node.attrs.label || 'Saved result',
        pageId ?? undefined
      );
      if (!current) {
        setResolved({ id: href, reference: null });
        throw new Error('This saved result is no longer available.');
      }
      await navigateToReference(current, pageId ? { sourceNotebookPageId: pageId } : undefined);
    } catch (error) {
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'failure.could-not-open-saved-result'), {
          definition: 'page-reference-open-failed',
        });
    } finally {
      setOpening(false);
    }
  }, [extension, opening, href, referenceId, node.attrs.label]);
  const molecular = reference
    ? (() => {
        try {
          return resolveMolecularReference(reference);
        } catch {
          return undefined;
        }
      })()
    : null;
  const entityType =
    molecular?.kind === 'document' ||
    molecular?.kind === 'visualization' ||
    molecular?.kind === 'view' ||
    (molecular?.kind === 'selection' && molecular.target)
      ? 'molecular-document'
      : (reference?.entity_type ?? 'reference');
  const label =
    typeof node.attrs.label === 'string' && node.attrs.label
      ? node.attrs.label
      : reference?.display_label || 'Saved result';
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
      <EntityReferenceChip
        entityType={entityType}
        label={label}
        busy={loading || opening}
        onOpen={reference && molecular !== undefined ? open : undefined}
        unavailable={!loading && (!reference || molecular === undefined)}
        testId="mention-chip"
        labelTestId="mention-chip-label"
        detailTestId="mention-chip-detail"
      />
    </NodeViewWrapper>
  );
}
