import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useState } from 'react';

import { EntityReferenceChip } from '../../../../components/entity-reference/EntityReferenceChip';
import type { DBEntityReference } from '../../../../db/entity-references';
import { savedReferencePresentation } from '../../../../components/entity-reference/saved-reference-presentation';
import { savedReferenceIdFromHref } from '../../../../shared/saved-reference-url';
import { resolveMolecularReference } from '../../../../shared/molecular-reference';
import { useToastStore } from '../../../../stores/toast-store';
import { navigateToReference } from '../../../ai/public/navigate-to-reference';
import { molecularDocumentReferenceFromHref } from '../../../../shared/molecular-document-reference';
import { resolveMolecularReferenceRecord } from '../../../molecular-documents/public/references';

export interface SavedReferenceChipContentProps {
  href: string;
  label: string;
  sourceNotebookPageId?: string;
}

export function useSavedReferenceChip({
  href,
  label: requestedLabel,
  sourceNotebookPageId,
}: SavedReferenceChipContentProps) {
  const referenceId = savedReferenceIdFromHref(href);
  const hasDocumentReference = Boolean(molecularDocumentReferenceFromHref(href));
  const [resolved, setResolved] = useState<{
    id: string;
    reference: DBEntityReference | null;
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const reference = resolved?.id === href ? (resolved?.reference ?? null) : null;
  const loading = Boolean((referenceId || hasDocumentReference) && resolved?.id !== href);
  useEffect(() => {
    let current = true;
    if (!referenceId && !hasDocumentReference) {
      setResolved({ id: href, reference: null });
      return;
    }
    void resolveMolecularReferenceRecord(
      href,
      requestedLabel || 'Saved result',
      sourceNotebookPageId
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
  }, [href, referenceId, hasDocumentReference, requestedLabel, sourceNotebookPageId]);
  const open = useCallback(async () => {
    if ((!referenceId && !hasDocumentReference) || opening) return;
    setOpening(true);
    try {
      const current = await resolveMolecularReferenceRecord(
        href,
        requestedLabel || 'Saved result',
        sourceNotebookPageId
      );
      if (!current) {
        setResolved({ id: href, reference: null });
        throw new Error('This saved result is no longer available.');
      }
      await navigateToReference(
        current,
        sourceNotebookPageId ? { sourceNotebookPageId } : undefined
      );
    } catch (error) {
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'failure.could-not-open-saved-result'), {
          definition: 'page-reference-open-failed',
        });
    } finally {
      setOpening(false);
    }
  }, [sourceNotebookPageId, opening, href, referenceId, hasDocumentReference, requestedLabel]);
  const molecular = reference
    ? (() => {
        try {
          return resolveMolecularReference(reference);
        } catch {
          return undefined;
        }
      })()
    : null;
  const presentation = reference
    ? savedReferencePresentation(reference, molecular ?? null)
    : { entityType: 'reference' };
  const label = requestedLabel ? requestedLabel : reference?.display_label || 'Saved result';
  return {
    entityType: presentation.entityType,
    referenceId,
    chipProps: {
      ...presentation,
      iconContext: reference?.iconContext,
      label,
      detail: reference?.locator,
      busy: loading || opening,
      onOpen: reference && molecular !== undefined ? open : undefined,
      unavailable: !loading && (!reference || molecular === undefined),
      testId: 'mention-chip',
      labelTestId: 'mention-chip-label',
      detailTestId: 'mention-chip-detail',
    },
  };
}

export function SavedReferenceChipContent(props: SavedReferenceChipContentProps) {
  const { chipProps } = useSavedReferenceChip(props);
  return <EntityReferenceChip {...chipProps} />;
}
