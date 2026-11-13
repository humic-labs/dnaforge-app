import {
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
  userMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  geneticCodeLabel,
  resolveGeneticCode,
  nonStandardResidueLegend,
  STANDARD_GENETIC_CODE_ID,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import { useToastStore } from '../../../stores/toast-store';
import {
  computeSixFrameTranslations,
  FRAME_STRANDS,
  type FrameStrand,
  type FrameTranslation,
} from '../six-frame-translation';

import { deliverTranslationCopy } from '../translation-copy-delivery';
import { translationCopyLengthBucket } from '../../../shared/translation-copy-telemetry';

const COPIED_TOAST_PREVIEW_MAX = 20;

const MAX_TRANSLATION_BP = 50_000;

function copiedToastMessage(aminoAcids: string): UserMessage {
  const preview =
    aminoAcids.length > COPIED_TOAST_PREVIEW_MAX
      ? `${aminoAcids.slice(0, COPIED_TOAST_PREVIEW_MAX)}…`
      : aminoAcids;
  return userMessageWithValues('clipboard.copiedSequence', { sequence: userMessageValue(preview) });
}

interface CopyTranslationDialogProps {
  sequence: string;
  label?: string;

  geneticCode?: GeneticCodeSpec;
  onClose: () => void;
}

const STRAND_HEADINGS: Record<FrameStrand, string> = {
  forward: "Forward strand (5'→3')",
  reverse: "Reverse strand (3'→5')",
};

function AminoAcids({ text }: { text: string }) {
  const segments = text.split(/(\*+)/).filter((segment) => segment.length > 0);
  return (
    <>
      {segments.map((segment, index) =>
        segment.startsWith('*') ? (
          <span key={index} className="text-error font-semibold" data-testid="stop-codon">
            {segment}
          </span>
        ) : (
          <span key={index}>{segment}</span>
        )
      )}
    </>
  );
}

type CopyLifecycle = { kind: 'ready' } | { kind: 'pending' } | { kind: 'closed' };

function FrameRow({
  frame,
  isCopyPending,
  onCopy,
}: {
  frame: FrameTranslation;
  isCopyPending: boolean;
  onCopy: (frame: FrameTranslation) => void;
}) {
  const testId = `${frame.strand}-${frame.frame}`;
  const canCopy = frame.aminoAcids.length > 0;

  return (
    <button
      type="button"
      onClick={() => onCopy(frame)}
      disabled={!canCopy || isCopyPending}
      aria-label={`Copy ${frame.strand} frame ${frame.frame} translation`}
      data-testid={`translation-frame-${testId}`}
      className="group w-full flex items-start gap-3 px-4 py-2 text-left border-t border-border first:border-t-0 hover:bg-bg-muted disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="w-16 shrink-0 pt-0.5 text-xs font-medium text-fg-muted">
        Frame {frame.frame}
        <span
          className="mt-0.5 block text-[10px] font-normal text-fg-subtle"
          data-testid={`translation-frame-length-${testId}`}
        >
          {frame.codonCount} aa
        </span>
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-mono text-xs leading-relaxed text-fg break-all">
          {canCopy ? (
            <AminoAcids text={frame.aminoAcids} />
          ) : (
            <span className="text-fg-subtle italic">no full codon</span>
          )}
        </span>
        {frame.truncatedBases > 0 && (
          <span className="mt-0.5 block text-[10px] text-fg-subtle">
            +{frame.truncatedBases} nt not translated
          </span>
        )}
      </span>
      {canCopy && (
        <span className="shrink-0 pt-0.5 text-xs text-fg-subtle group-hover:text-fg">Copy</span>
      )}
    </button>
  );
}

export function CopyTranslationDialog({
  sequence,
  label,
  geneticCode = STANDARD_GENETIC_CODE_ID,
  onClose,
}: CopyTranslationDialogProps) {
  const tooLarge = sequence.length > MAX_TRANSLATION_BP;
  const frames = useMemo(
    () => (tooLarge ? [] : computeSixFrameTranslations(sequence, geneticCode)),
    [tooLarge, sequence, geneticCode]
  );

  const copyLifecycleRef = useRef<CopyLifecycle>({ kind: 'ready' });
  const [isCopyPending, setIsCopyPending] = useState(false);

  useLayoutEffect(() => {
    copyLifecycleRef.current = { kind: 'ready' };
    return () => {
      copyLifecycleRef.current = { kind: 'closed' };
    };
  }, []);

  const closeDialog = useCallback(() => {
    copyLifecycleRef.current = { kind: 'closed' };
    onClose();
  }, [onClose]);

  const handleCopy = useCallback(
    async (frame: FrameTranslation) => {
      const { aminoAcids } = frame;
      if (copyLifecycleRef.current.kind !== 'ready' || aminoAcids.length === 0) return;
      const attempt = { kind: 'pending' } satisfies CopyLifecycle;
      copyLifecycleRef.current = attempt;
      setIsCopyPending(true);
      try {
        const code = resolveGeneticCode(frame.geneticCode);
        await deliverTranslationCopy({
          strand: frame.strand,
          frame: frame.frame,
          codeCategory:
            code.kind === 'custom'
              ? 'custom'
              : code.id === STANDARD_GENETIC_CODE_ID
                ? 'standard'
                : 'nonstandard',
          lengthBucket: translationCopyLengthBucket(aminoAcids.length),
          write: () => navigator.clipboard.writeText(aminoAcids),
        });
      } catch (err) {
        if (copyLifecycleRef.current !== attempt) return;
        copyLifecycleRef.current = { kind: 'ready' };
        setIsCopyPending(false);
        console.error('Failed to copy translation to clipboard:', err);
        useToastStore.getState().addToast(userMessage('notice.failed-to-copy-translation'), {
          definition: 'copy-translation-dialog-failed-to-copy-translation',
        });
        return;
      }
      if (copyLifecycleRef.current !== attempt) return;
      useToastStore.getState().addToast(copiedToastMessage(aminoAcids), {
        definition: 'copy-translation-dialog-handle-copy',
      });
      closeDialog();
    },
    [closeDialog]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeDialog]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      data-testid="copy-translation-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeDialog();
      }}
    >
      <div
        className="bg-bg border border-border rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-translation-dialog-title"
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 id="copy-translation-dialog-title" className="text-sm font-medium text-fg">
              Copy Translation
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted" data-testid="copy-translation-genetic-code">
              {label ? `${label} · ` : ''}
              {`Genetic code ${geneticCodeLabel(geneticCode)}`}
            </p>
            {}
            {nonStandardResidueLegend(geneticCode) ? (
              <p className="mt-0.5 text-xs text-fg-subtle" data-testid="copy-translation-residues">
                {nonStandardResidueLegend(geneticCode)}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={closeDialog}
            className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded transition-colors"
            data-testid="copy-translation-dialog-close"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto">
          {tooLarge ? (
            <p className="px-4 py-6 text-xs text-fg-muted" data-testid="translation-too-large">
              Selection is too large to translate ({sequence.length.toLocaleString()} bp). Select up
              to {MAX_TRANSLATION_BP.toLocaleString()} bp to view its reading frames.
            </p>
          ) : (
            FRAME_STRANDS.map((strand) => (
              <section key={strand} data-testid={`translation-strand-${strand}`}>
                <div className="px-4 py-1.5 bg-bg-subtle text-[11px] font-semibold uppercase tracking-wide text-fg-muted sticky top-0">
                  {STRAND_HEADINGS[strand]}
                </div>
                {frames
                  .filter((frame) => frame.strand === strand)
                  .map((frame) => (
                    <FrameRow
                      key={`${frame.strand}-${frame.frame}`}
                      frame={frame}
                      isCopyPending={isCopyPending}
                      onCopy={handleCopy}
                    />
                  ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
