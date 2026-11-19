import { RegistryTemporalInput } from '../RegistryTemporalInput';
import { toOptionalUserMessage, toUserMessage, userMessage } from '@waypoint/user-messages';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button, TextArea, TextField } from '../../../components/ui';
import type { EntitySchemaFieldSnapshot } from '../../entity-schema';
import {
  parseRegistryFieldDraft,
  registryFieldDraftText,
  registryFieldIsEditable,
  registryFieldText,
  registryFieldOptions,
} from './metadata-field-values';
import { InlineEditableValue } from '../InlineEditableValue';
import { useMetadataFieldEditing } from './MetadataEditing';
import { MetadataValue } from './MetadataLayout';
import { MetadataPicker } from './MetadataPicker';

export interface StoredMetadataFieldDraft {
  text: string;
  display: string;
  initialValue: unknown;
  error?: string | null;
}

export function EntityMetadataFieldEditor({
  field,
  value,
  onCommit,
  disabled = false,
  compact = false,
  readOnlyDisplay,
  onEditingChange,
  onDraftChange,
  editRequestId,
  triggerLabel,
  triggerTestId,
  inputId,
  inputTestId,
  renderValue,
  storedDraft,
  onStoredDraftChange,
}: {
  field: EntitySchemaFieldSnapshot;
  value: unknown;
  onCommit?: (value: unknown) => Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  readOnlyDisplay?: ReactNode;
  onEditingChange?: (editing: boolean) => void;
  onDraftChange?: (draft: { valid: true; value: unknown } | { valid: false }) => void;
  editRequestId?: number;
  triggerLabel?: string;
  triggerTestId?: string;
  inputId?: string;
  inputTestId?: string;
  renderValue?: (value: string) => ReactNode;
  storedDraft?: StoredMetadataFieldDraft | null;
  onStoredDraftChange?: (draft: StoredMetadataFieldDraft | null) => void;
}) {
  const [draft, setDraft] = useState(
    () => storedDraft?.text ?? registryFieldDraftText(field, value)
  );
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(storedDraft?.error ?? null);
  const [localPending, setLocalPending] = useState<StoredMetadataFieldDraft | null>(
    storedDraft ?? null
  );
  const pendingDraft = storedDraft === undefined ? localPending : storedDraft;
  const error = pendingDraft?.error ?? localError;
  const committing = useRef(false);
  const interrupting = useRef(false);
  const draftRef = useRef(draft);
  const initialValue = useRef(storedDraft ? storedDraft.initialValue : value);
  const pendingRef = useRef(pendingDraft);
  pendingRef.current = pendingDraft;
  const setPendingDraft = useCallback(
    (next: { text: string; display: string } | null) => {
      const complete = next ? { ...next, initialValue: initialValue.current } : null;
      pendingRef.current = complete;
      setLocalPending(complete);
      onStoredDraftChange?.(complete);
    },
    [onStoredDraftChange]
  );
  const setError = useCallback(
    (next: string | null) => {
      setLocalError(toOptionalUserMessage(next, 'validation.invalid'));
      if (pendingRef.current) {
        const updated = { ...pendingRef.current, error: next };
        pendingRef.current = updated;
        setLocalPending(updated);
        onStoredDraftChange?.(updated);
      }
    },
    [onStoredDraftChange]
  );
  const editable =
    registryFieldIsEditable(field) && !(field.type === 'genetic_code' && typeof value !== 'number');
  const session = useMetadataFieldEditing({
    onBegin: () => {
      const next = pendingDraft?.text ?? registryFieldDraftText(field, value);
      const entryValue = pendingDraft ? pendingDraft.initialValue : value;
      draftRef.current = next;
      setDraft(next);
      setError(null);
      if (storedDraft === undefined) setPendingDraft(null);
      initialValue.current = entryValue;
    },
    onFinish: () => void commit(),
    onCancel: () => {
      onDraftChange?.({ valid: true, value: initialValue.current });
      close();
    },
    onEditingChange,
    editRequestId,
    disabled: disabled || busy,
  });
  const { editing } = session;

  useEffect(() => {
    if (editing) return;
    if (pendingDraft) {
      draftRef.current = pendingDraft.text;
      initialValue.current = pendingDraft.initialValue;
      setDraft(pendingDraft.text);
      return;
    }
    if (storedDraft !== undefined) setLocalError(null);
    const next = registryFieldDraftText(field, value);
    draftRef.current = next;
    setDraft(next);
  }, [editing, field, pendingDraft, storedDraft, value]);

  useEffect(() => {
    if ((onCommit && !disabled) || !editing) {
      interrupting.current = false;
      return;
    }
    if (interrupting.current) return;
    interrupting.current = true;
    if (draftRef.current !== registryFieldDraftText(field, initialValue.current)) {
      setPendingDraft({ text: draftRef.current, display: draftRef.current || '-' });
      setError(
        userMessage(
          'failure.editing-is-unavailable-for-this-record-retry-when-its-project-becomes-'
        )
      );
    }
    session.finish();
  }, [disabled, editing, field, onCommit, onEditingChange, session, setError, setPendingDraft]);

  const close = () => {
    setError(null);
    setPendingDraft(null);
  };
  const commit = async () => {
    if (!onCommit || disabled || committing.current) return;
    if (draftRef.current === registryFieldDraftText(field, initialValue.current)) {
      close();
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseRegistryFieldDraft(field, draftRef.current);
    } catch (cause) {
      setPendingDraft({ text: draftRef.current, display: draftRef.current || '-' });
      setError(toUserMessage(cause, 'metadata.saveFailed'));
      return;
    }
    if (JSON.stringify(parsed) === JSON.stringify(value)) {
      close();
      return;
    }
    committing.current = true;
    setBusy(true);
    setError(null);
    setPendingDraft({ text: draftRef.current, display: registryFieldText(field, parsed) });
    try {
      await onCommit(parsed);
      close();
    } catch (cause) {
      setError(toUserMessage(cause, 'metadata.saveFailed'));
    } finally {
      committing.current = false;
      setBusy(false);
    }
  };

  if (!editing) {
    const text = pendingDraft?.display ?? registryFieldText(field, value);
    return (
      <span
        {...session.boundaryProps}
        className="block min-w-0"
        onClick={onCommit || pendingDraft ? (event) => event.stopPropagation() : undefined}
      >
        {error && field.key === 'name' && !pendingDraft?.text.trim() ? null : !onCommit ||
          !editable ? (
          <MetadataValue compact={compact}>
            {pendingDraft ? text : (readOnlyDisplay ?? text)}
          </MetadataValue>
        ) : (
          <InlineEditableValue
            ref={session.triggerRef}
            aria-label={triggerLabel ?? `Edit ${field.label}`}
            data-testid={triggerTestId}
            disabled={disabled || busy}
            compact={compact}
            title={disabled ? undefined : `Edit ${field.label}`}
            onClick={(event) => {
              event.stopPropagation();
              session.begin();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {renderValue ? renderValue(text) : text}
          </InlineEditableValue>
        )}
        {busy ? (
          <span role="status" className="text-[11px] text-fg-muted">
            Saving…
          </span>
        ) : null}
        {error ? (
          <span
            role="group"
            aria-label={`${field.label} save error`}
            className={`mt-1 flex min-w-0 flex-col whitespace-normal text-[11px] text-error ${compact ? 'gap-1' : 'gap-2 px-3 pb-2.5'}`}
          >
            {compact ? (
              <span title={toUserMessage(error, 'metadata.saveFailed')}>Not saved</span>
            ) : null}
            <span role="alert" className={compact ? 'sr-only' : 'block break-words'}>
              {toUserMessage(error, 'metadata.saveFailed')} Your change has not been saved.
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                type="button"
                aria-label={`Retry ${field.label}`}
                disabled={!onCommit || disabled || busy}
                onClick={() => void commit()}
              >
                Retry
              </Button>
              <Button
                type="button"
                aria-label={`Discard ${field.label}`}
                disabled={busy}
                onClick={() => {
                  onDraftChange?.({ valid: true, value: initialValue.current });
                  close();
                }}
              >
                Discard
              </Button>
            </span>
          </span>
        ) : null}
      </span>
    );
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      session.cancel();
    } else if (
      event.key === 'Enter' &&
      (!(field.type === 'long_text' || field.type === 'string_array') ||
        event.metaKey ||
        event.ctrlKey)
    ) {
      event.preventDefault();
      session.finish(true);
    }
  };
  const changeDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    if (onDraftChange) {
      try {
        const parsed = parseRegistryFieldDraft(field, value);
        onDraftChange({ valid: true, value: parsed });
        if (onStoredDraftChange)
          setPendingDraft({ text: value, display: registryFieldText(field, parsed) });
        setError(null);
      } catch (cause) {
        onDraftChange({ valid: false });
        if (onStoredDraftChange) {
          setPendingDraft({ text: value, display: value || '-' });
          setError(toUserMessage(cause, 'metadata.saveFailed'));
        }
      }
    }
  };
  const shared = {
    id: inputId,
    'data-testid': inputTestId,
    'aria-label': field.label,
    autoFocus: true,
    disabled: busy || disabled,
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      changeDraft(event.target.value),
    onKeyDown: handleKeyDown,
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
  };

  return (
    <span
      {...session.boundaryProps}
      className={`block min-w-0${compact ? '' : ' metadata-field-editor'}`}
      onClick={(event) => event.stopPropagation()}
    >
      {field.type === 'genetic_code' || field.type === 'boolean' || field.type === 'enum' ? (
        <MetadataPicker
          id={inputId}
          testId={inputTestId}
          ariaLabel={field.label}
          value={draft}
          options={registryFieldOptions(field)}
          disabled={busy || disabled}
          required={field.required}
          defaultOpen
          searchLabel={field.type === 'genetic_code' ? 'Search genetic codes' : undefined}
          menuAttributes={{ 'data-metadata-field': session.ownerId }}
          onValueChange={changeDraft}
          onSelect={() => session.finish(true)}
        />
      ) : field.type === 'date' || field.type === 'datetime' ? (
        <RegistryTemporalInput
          type={field.type}
          label={field.label}
          text={draft}
          change={changeDraft}
          id={inputId}
          testId={inputTestId}
          disabled={disabled || busy}
          min={field.minDate}
          max={field.maxDate}
          required={field.required}
          autoFocus
          onFinish={() => session.finish(true)}
          onCancel={() => session.cancel()}
        />
      ) : field.type === 'long_text' || field.type === 'string_array' ? (
        <TextArea {...shared} rows={compact ? 1 : 5} />
      ) : (
        <TextField
          {...shared}
          type={field.type === 'number' ? 'number' : 'text'}
          step={field.type === 'number' ? 'any' : undefined}
          min={field.type === 'number' ? field.minValue : field.minDate}
          max={field.type === 'number' ? field.maxValue : field.maxDate}
          maxLength={field.maxLength}
        />
      )}
      {error && !compact ? (
        <span role="alert" className="mt-1 block text-[11px] text-error">
          {toUserMessage(error, 'metadata.saveFailed')}
        </span>
      ) : null}
    </span>
  );
}
