import { MenuNativeSelect } from '@waypoint/ui-components';
import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/ui';
import {
  backtranslate,
  BACKTRANSLATE_HOST_LABELS,
  SUPPORTED_BACKTRANSLATE_HOSTS,
  type SupportedBacktranslateHost,
} from '@waypoint/sequence-utils';
import { useToastStore } from '../../../stores/toast-store';
import { safeFocus } from '../../../shared/utils/safeFocus';

export interface BacktranslateResultDialogProps {
  sequence: string | null;
  onClose: () => void;
}

export function BacktranslateResultDialog({ sequence, onClose }: BacktranslateResultDialogProps) {
  const presentationOverlay = usePresentationOverlay('modal');

  const [host, setHost] = useState<SupportedBacktranslateHost>(SUPPORTED_BACKTRANSLATE_HOSTS[0]);
  const hostSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (sequence) safeFocus(hostSelectRef.current);
  }, [sequence]);

  const result = useMemo(() => {
    if (!sequence) return null;
    try {
      return { status: 'ok' as const, dna: backtranslate(sequence, host) };
    } catch (error) {
      return {
        status: 'error' as const,
        message: toUserMessage(error, 'failure.backtranslation-failed'),
      };
    }
  }, [sequence, host]);

  if (!sequence) return null;

  const handleCopy = async () => {
    if (result?.status !== 'ok') return;
    await navigator.clipboard.writeText(result.dna);
    useToastStore
      .getState()
      .addToast(userMessage('notice.copied-backtranslated-dna-to-clipboard'), {
        definition: 'backtranslate-result-dialog-copied-backtranslated-dna-to-clipboard',
      });
  };

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      data-testid="backtranslate-result-backdrop"
      onMouseDown={onClose}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="backtranslate-result-title"
          data-testid="backtranslate-result-dialog"
          className="mx-4 w-full max-w-lg rounded-lg border border-border bg-bg-subtle p-4 shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <h3 id="backtranslate-result-title" className="text-sm font-semibold text-fg">
            Backtranslate
          </h3>

          <label
            className="mt-3 block text-xs font-medium text-fg-muted"
            htmlFor="backtranslate-host"
          >
            Host
          </label>
          <span className="block min-w-0 w-full mt-1">
            <MenuNativeSelect
              density="form"
              ref={hostSelectRef}
              id="backtranslate-host"
              data-testid="backtranslate-host-select"
              value={host}
              onChange={(e) => setHost(e.target.value as SupportedBacktranslateHost)}
            >
              {SUPPORTED_BACKTRANSLATE_HOSTS.map((h) => (
                <option key={h} value={h}>
                  {BACKTRANSLATE_HOST_LABELS[h]}
                </option>
              ))}
            </MenuNativeSelect>
          </span>

          <div className="mt-3 text-xs font-medium text-fg-muted">
            {result?.status === 'ok' ? `Codon-optimized DNA (${result.dna.length} bp)` : 'Result'}
          </div>
          <div
            data-testid="backtranslate-result-body"
            className="mt-1 max-h-40 overflow-y-auto rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs leading-5 text-fg break-all"
          >
            {result?.status === 'ok' ? (
              result.dna
            ) : (
              <span data-testid="backtranslate-result-error" className="text-error">
                {toUserMessage(result?.message, 'failure.backtranslation-failed')}
              </span>
            )}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" data-testid="backtranslate-result-close" onClick={onClose}>
              Close
            </Button>
            <Button
              type="button"
              data-testid="backtranslate-result-copy"
              onClick={handleCopy}
              disabled={result?.status !== 'ok'}
              variant="primary"
            >
              Copy
            </Button>
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
