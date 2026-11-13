import { userMessage } from '@waypoint/user-messages';
import { useCallback, type ClipboardEvent } from 'react';
import type { DBEntityReference } from '../../db/entity-references';
import type { RichSequenceFragment } from '../sequence-clipboard/public/rich-sequence-clipboard';
import { useRichSequenceClipboardStore } from '../sequence-clipboard/public/store';
import { useToastStore } from '../../stores/toast-store';
import { createAskAiSelectionReference } from './ask-ai-about-selection';
import { copiedSequenceForChatPaste } from './copied-sequence-paste';

export { copiedSequenceForChatPaste } from './copied-sequence-paste';

export async function createCopiedSequenceReference(
  fragment: RichSequenceFragment
): Promise<DBEntityReference | null> {
  const coordinates = fragment.sourceCoordinates;
  if (!coordinates) return null;
  return createAskAiSelectionReference({
    entityType: 'sequence_region',
    displayLabel: `${fragment.sourceName} ${coordinates.start}–${coordinates.end}`,
    locator: fragment.sourceId,
    workspaceRootPath: fragment.sourceWorkspaceRoot ?? null,
    deepLinkParams: {
      start: coordinates.start,
      end: coordinates.end,
      ...(coordinates.wraps ? { wraps: true } : {}),
    },
  });
}

export function useComposerSequencePaste(onReference: (reference: DBEntityReference) => void) {
  return useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const fragment = copiedSequenceForChatPaste(
        text,
        useRichSequenceClipboardStore.getState().copiedRegion
      );
      if (!fragment) return;
      event.preventDefault();
      void createCopiedSequenceReference(fragment)
        .then((reference) => {
          if (reference) onReference(reference);
        })
        .catch((error) => {
          console.error('Failed to attach copied sequence', error);
          useToastStore
            .getState()
            .addToast(userMessage('notice.could-not-attach-the-copied-sequence'), {
              definition: 'paste-copied-sequence-could-not-attach-the-copied-sequence',
            });
        });
    },
    [onReference]
  );
}
