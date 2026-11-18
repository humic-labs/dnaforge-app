import { ActionMenu } from '../../components/ActionMenu';
import { MenuTrigger } from '@waypoint/ui-components';
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
  const { status, error } = useLimsRegistrationBadge(documentId, sourcePath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const canRegister = !readOnly && Boolean(documentId && sourcePath) && status === 'not_registered';
  const options = getOpenSequenceRegistrationKindOptions({
    sourceType: 'file_dna_sequence',
    topology,
    length,
  });

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
        <div className="relative mt-3">
          <MenuTrigger
            ref={pickerRef}
            density="compact"
            variant="toolbar"
            data-testid="sequence-metadata-register"
            open={pickerOpen}
            aria-haspopup="menu"
            disabled={registering}
            onClick={() => setPickerOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setPickerOpen(true);
              }
            }}
          >
            {registering ? 'Registering…' : 'Register'}
          </MenuTrigger>
          <ActionMenu
            open={pickerOpen}
            anchorRef={pickerRef}
            label="Register sequence as"
            testId="lims-registration-kind-picker"
            onClose={() => setPickerOpen(false)}
            entries={options.map((option) => ({
              id: option.kind,
              label: option.label,
              title: option.title,
              disabled: option.disabled,
              description: option.disabled ? (option.disabledReason ?? 'Unavailable') : undefined,
              testId: `lims-registration-kind-${option.kind}`,
              onSelect: () => {
                void register(option.kind);
              },
            }))}
          />
        </div>
      )}
    </section>
  );
}
