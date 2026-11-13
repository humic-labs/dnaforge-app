import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useEffect, useRef } from 'react';
import { resolveSequenceGeneticCode, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { useToastStore } from '../../stores/toast-store';

const asked = new Set<string>();

export function resetGeneticCodePromptsForTest(): void {
  asked.clear();
}

export function useGeneticCodePrompt(
  documentId: string,
  sequence: AnnotatedSequence | null | undefined,
  options: { readonly enabled?: boolean } = {}
): void {
  const enabled = options.enabled ?? true;
  const askedRef = useRef(asked);

  useEffect(() => {
    if (!enabled || !sequence) return;
    if (askedRef.current.has(documentId)) return;

    const resolution = resolveSequenceGeneticCode(sequence);
    if (!resolution.needsUserChoice) return;

    askedRef.current.add(documentId);
    useToastStore.getState().addRichToast({
      definition: 'genetic-code-question',
      message: userMessageWithValues(
        'notice.this-record-s-source-says-value-but-no-feature-declares-a-genetic-code',
        { value0: userMessageValue(resolution.organelle) }
      ),
    });
  }, [documentId, enabled, sequence]);
}
