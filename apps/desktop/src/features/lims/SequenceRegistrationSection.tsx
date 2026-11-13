import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../presentation/PresentationSurface';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { useToastStore } from '../../stores/toast-store';
import {
  registerOpenSequenceFile,
  type RegisterableOpenSequenceKind,
} from './register-open-sequence';
import { getOpenSequenceRegistrationKindOptions } from './registration-kind-compatibility';
import { useLimsRegistrationBadge } from './registration-badge';

interface SequenceRegistrationSectionProps {
  documentId: string;
  sourcePath: string;
  topology: 'circular' | 'linear';
  length: number;
  readOnly?: boolean;
}

export function SequenceRegistrationSection({
  documentId,
  sourcePath,
  topology,
  length,
  readOnly = false,
}: SequenceRegistrationSectionProps) {
  const presentationOverlay = usePresentationOverlay('keyboard');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const { status, error } = useLimsRegistrationBadge(documentId, sourcePath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const canRegister = !readOnly && Boolean(documentId && sourcePath) && status === 'not_registered';
  const options = getOpenSequenceRegistrationKindOptions({
    sourceType: 'file_dna_sequence',
    topology,
    length,
  });

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    presentationEvents.add(window, 'keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      presentationEvents.remove(window, 'keydown', onKeyDown);
    };
  }, [pickerOpen, presentationEvents]);

  useEffect(() => {
    if (!canRegister) setPickerOpen(false);
  }, [canRegister]);

  const register = async (kind: RegisterableOpenSequenceKind) => {
    if (!canRegister || registering) return;
    setRegistering(true);
    setPickerOpen(false);
    try {
      const result = await registerOpenSequenceFile({ documentId, sourcePath, kind });
      useToastStore
        .getState()
        .addToast(
          result.alreadyRegistered
            ? userMessage('notice.sequence-already-registered')
            : userMessage('notice.registered-open-sequence'),
          { definition: 'registration-badge-registered-open-sequence' }
        );
    } catch (cause) {
      useToastStore.getState().addToast(toUserMessage(cause, 'sequence.registrationFailed'), {
        definition: 'registration-badge-could-not-register-sequence-example-error',
      });
    } finally {
      setRegistering(false);
    }
  };

  return (
    <section
      className="mt-4 border-t border-border pt-3"
      data-testid="sequence-metadata-registration"
    >
      <h3 className="text-xs font-semibold text-fg">Registration</h3>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="text-fg-muted">Status</span>
        <span data-testid="sequence-registration-status" className="capitalize text-fg">
          {status === 'not_registered'
            ? 'Not registered'
            : status === 'loading'
              ? 'Checking'
              : status}
        </span>
      </div>
      {error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {toUserMessage(error, 'sequence.registrationFailed')}
        </p>
      )}
      {canRegister && (
        <div ref={pickerRef} className="relative mt-3">
          <button
            type="button"
            data-testid="sequence-metadata-register"
            aria-expanded={pickerOpen}
            aria-haspopup="menu"
            disabled={registering}
            onClick={() => setPickerOpen((open) => !open)}
            className="h-7 rounded border border-border px-2.5 text-xs text-fg hover:bg-bg-muted disabled:opacity-60"
          >
            {registering ? 'Registering…' : 'Register'}
          </button>
          {pickerOpen && (
            <PresentationScopeContext.Provider value={presentationOverlay.scope}>
              <div
                role="menu"
                data-testid="lims-registration-kind-picker"
                className="absolute left-0 top-8 z-50 w-44 rounded border border-border bg-bg p-1 shadow-lg"
                ref={presentationOverlay.bindRef(undefined, '0')}
              >
                {options.map((option) => (
                  <button
                    key={option.kind}
                    type="button"
                    role="menuitem"
                    data-testid={`lims-registration-kind-${option.kind}`}
                    title={option.title}
                    disabled={option.disabled}
                    onClick={() => void register(option.kind)}
                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] text-fg hover:bg-bg-muted focus:bg-bg-muted focus:outline-none disabled:cursor-not-allowed disabled:text-fg-subtle"
                  >
                    <span>{option.label}</span>
                    {option.disabled && <span title={option.disabledReason}>Unavailable</span>}
                  </button>
                ))}
              </div>
            </PresentationScopeContext.Provider>
          )}
        </div>
      )}
    </section>
  );
}
