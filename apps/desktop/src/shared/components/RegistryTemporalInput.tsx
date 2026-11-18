import { useEffect, useRef } from 'react';
import { TextField, UI_FIELD_CLASS } from '../../components/ui';
import {
  encodeClockInput,
  registryClockChoices,
  temporalControlState,
  type TemporalFieldType,
  type RegistryClockInput,
} from '../registry-temporal-input';

export function RegistryTemporalInput({
  type,
  label,
  text,
  change,
  id,
  testId,
  min,
  max,
  required,
  disabled,
  autoFocus,
  onFinish,
  onCancel,
}: {
  type: TemporalFieldType;
  label: string;
  text: string;
  change(text: string): void;
  id?: string;
  testId?: string;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onFinish?(): void;
  onCancel?(): void;
}) {
  const element = useRef<HTMLInputElement>(null);
  const { input, raw } = temporalControlState(type, text);
  let repeated = false,
    error = '';
  if (type === 'datetime' && input.local) {
    try {
      repeated = registryClockChoices(input).repeated;
      if (repeated && !input.fold) error = 'Choose which occurrence of this clock time you mean.';
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : 'Enter a valid clock time and named time zone.';
    }
  }
  useEffect(() => {
    element.current?.setCustomValidity(error);
  }, [error]);
  const update = (patch: Partial<RegistryClockInput>) =>
    change(encodeClockInput({ ...input, fold: '', ...patch }));
  return (
    <span
      className="block min-w-0 space-y-1"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape' && onCancel) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
        if (e.key === 'Enter' && onFinish && !error) {
          e.preventDefault();
          e.stopPropagation();
          onFinish();
        }
      }}
    >
      {raw !== null && (
        <span className="block break-words text-xs text-fg-muted">
          Stored value · {raw}{' '}
          <button
            type="button"
            disabled={disabled}
            className="text-accent"
            onClick={() => change('')}
          >
            Clear
          </button>
        </span>
      )}
      <TextField
        ref={element}
        id={id}
        data-testid={testId}
        type={type === 'date' ? 'date' : 'datetime-local'}
        step={type === 'datetime' ? 'any' : undefined}
        autoFocus={autoFocus}
        aria-label={label}
        min={type === 'date' ? min : undefined}
        max={type === 'date' ? max : undefined}
        required={required && raw === null}
        disabled={disabled}
        value={input.local}
        onChange={(e) =>
          type === 'date' ? change(e.target.value) : update({ local: e.target.value })
        }
      />
      {type === 'datetime' && input.local && (
        <>
          <label className="block text-xs text-fg-muted">
            Time zone
            <TextField
              aria-label={label + ' time zone'}
              disabled={disabled}
              value={input.zone}
              onChange={(e) => update({ zone: e.target.value })}
            />
          </label>
          {repeated && (
            <label className="block text-xs">
              This hour occurs twice
              <select
                className={UI_FIELD_CLASS}
                aria-label={label + ' clock change'}
                disabled={disabled}
                value={input.fold}
                onChange={(e) => update({ fold: e.target.value as RegistryClockInput['fold'] })}
              >
                <option value="">Choose occurrence</option>
                <option value="earlier">First occurrence</option>
                <option value="later">Second occurrence</option>
              </select>
            </label>
          )}
          {error && (
            <span role="status" className="block text-xs text-error">
              {error}
            </span>
          )}
        </>
      )}
    </span>
  );
}
