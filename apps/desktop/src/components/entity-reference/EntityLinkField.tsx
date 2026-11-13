import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { LimsRecordRelationshipValue } from '../../shared/lims';
import { PortalMenu } from '../PortalMenu';
import { Button, TextField } from '../ui';
import { EntityReferenceChip } from './EntityReferenceChip';

export interface EntityLinkChoice {
  id: string;
  name: string;
  kind: string;
  registryId?: string | null;
}

export interface EntityLinkFieldProps {
  label: string;
  value: unknown;
  sourceEntityId?: string;
  disabled?: boolean;
  required?: boolean;
  onCommit?: (value: LimsRecordRelationshipValue | null) => void | Promise<void>;
  searchTargets: (
    search: string,
    offset: number
  ) => Promise<{ choices: EntityLinkChoice[]; totalCount: number }>;
  onOpen: (entityId: string) => Promise<void>;
  onEditingChange?: (editing: boolean) => void;
  editing?: boolean;
  triggerRef?: RefObject<HTMLButtonElement>;
  menuAttributes?: { 'data-metadata-field'?: string };
}

function relationshipValue(value: unknown): LimsRecordRelationshipValue | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('label' in value) ||
    typeof value.label !== 'string' ||
    !('destinationEntityId' in value)
  )
    return null;
  return value as LimsRecordRelationshipValue;
}

export function EntityLinkField(props: EntityLinkFieldProps) {
  const value = relationshipValue(props.value);
  return (
    <EntityLinkFieldControl
      key={
        props.sourceEntityId ?? (props.onCommit ? 'draft' : (value?.destinationEntityId ?? 'empty'))
      }
      {...props}
    />
  );
}

function EntityLinkFieldControl({
  label,
  value,
  sourceEntityId,
  disabled = false,
  required = false,
  onCommit,
  searchTargets,
  onOpen,
  onEditingChange,
  editing,
  triggerRef,
  menuAttributes,
}: EntityLinkFieldProps) {
  const localAnchorRef = useRef<HTMLButtonElement>(null);
  const anchorRef = triggerRef ?? localAnchorRef;
  const requestRef = useRef(0);
  const [localOpen, setOpen] = useState(false);
  const open = editing ?? localOpen;
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState<EntityLinkChoice[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<LimsRecordRelationshipValue | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const committing = useRef(false);
  const searchId = useId();
  const current = pending === undefined ? relationshipValue(value) : pending;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onEditingChange?.(next);
  };

  useEffect(() => {
    if (!open || disabled || !onCommit) return;
    let cancelled = false;
    setLoading(true);
    setQueryError(null);
    setChoices([]);
    void searchTargets(search, offset)
      .then((page) => {
        if (cancelled) return;
        setChoices(page.choices.filter((choice) => choice.id !== sourceEntityId));
        setTotalCount(page.totalCount);
      })
      .catch((cause) => {
        if (!cancelled) setQueryError(toUserMessage(cause, 'failure.entity-search-could-not-load'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, disabled, onCommit, searchTargets, search, offset, sourceEntityId, attempt]);

  useEffect(
    () => () => {
      requestRef.current++;
    },
    []
  );

  async function commit(next: LimsRecordRelationshipValue | null) {
    if (!onCommit || disabled || committing.current) return;
    const request = ++requestRef.current;
    committing.current = true;
    setBusy(true);
    setPending(next);
    setError(null);
    changeOpen(false);
    try {
      await onCommit(next);
      if (request === requestRef.current) setPending(undefined);
    } catch (cause) {
      if (request === requestRef.current)
        setError(toUserMessage(cause, 'failure.the-entity-link-could-not-be-saved'));
    } finally {
      if (request === requestRef.current) {
        committing.current = false;
        setBusy(false);
      }
    }
  }

  async function openTarget(entityId: string) {
    setOpening(true);
    setError(null);
    try {
      await onOpen(entityId);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.the-linked-entity-could-not-be-opened'));
    } finally {
      setOpening(false);
    }
  }

  return (
    <span className="block min-w-0" onClick={(event) => event.stopPropagation()}>
      <span className="flex flex-wrap items-center gap-1.5">
        {current ? (
          <EntityReferenceChip
            entityType="record"
            label={current.label}
            preserveExtension
            unavailable={current.destinationEntityId === null}
            busy={opening}
            onOpen={
              current.destinationEntityId
                ? () => openTarget(current.destinationEntityId!)
                : undefined
            }
          />
        ) : !onCommit ? (
          <span>-</span>
        ) : null}
        {onCommit ? (
          <>
            <Button
              ref={anchorRef}
              aria-label={`${current ? 'Change' : 'Choose'} ${label}`}
              aria-expanded={open}
              disabled={disabled || busy}
              onClick={() => {
                setSearch('');
                setOffset(0);
                changeOpen(!open);
              }}
            >
              {current ? 'Change' : 'Choose entity…'}
            </Button>
            {current && !required ? (
              <Button
                aria-label={`Clear ${label}`}
                disabled={disabled || busy}
                onClick={() => void commit(null)}
              >
                Clear
              </Button>
            ) : null}
          </>
        ) : null}
        {busy ? (
          <span role="status" className="text-xs text-fg-muted">
            Saving…
          </span>
        ) : null}
      </span>
      {error ? (
        <span className="mt-1 block text-xs text-error">
          <span role="alert">{toUserMessage(error, 'operation.failed')}</span>
          {pending !== undefined ? (
            <span className="mt-1 flex gap-2">
              <Button
                aria-label={`Retry ${label}`}
                disabled={disabled || busy || !onCommit}
                onClick={() => void commit(pending)}
              >
                Retry
              </Button>
              <Button
                aria-label={`Discard ${label}`}
                disabled={busy}
                onClick={() => {
                  setPending(undefined);
                  setError(null);
                }}
              >
                Discard
              </Button>
            </span>
          ) : null}
        </span>
      ) : null}
      <PortalMenu
        dataAttributes={menuAttributes}
        open={open && !disabled && Boolean(onCommit)}
        anchorRef={anchorRef}
        onRequestClose={() => changeOpen(false)}
        role="dialog"
        aria-label={`Choose ${label}`}
        preferredSide="bottom"
        horizontalAlign="start"
        className="w-80 p-2"
      >
        <label htmlFor={searchId} className="sr-only">
          Search entities for {label}
        </label>
        <TextField
          id={searchId}
          type="search"
          autoFocus
          value={search}
          placeholder="Search by name or record ID"
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
        />
        <div className="mt-2 max-h-64 overflow-y-auto">
          {loading ? (
            <p role="status" className="p-2 text-xs text-fg-muted">
              Searching entities…
            </p>
          ) : queryError ? (
            <div className="p-2 text-xs">
              <p role="alert" className="text-error">
                {toUserMessage(queryError, 'operation.failed')}
              </p>
              <Button onClick={() => setAttempt((value) => value + 1)}>Retry search</Button>
            </div>
          ) : choices.length === 0 ? (
            <p className="p-2 text-xs text-fg-muted">No matching entities.</p>
          ) : (
            choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className="block w-full rounded px-2 py-2 text-left hover:bg-bg-muted focus-visible:bg-bg-muted"
                onClick={() =>
                  void commit({
                    origin: 'native',
                    destinationEntityId: choice.id,
                    relationType: 'references',
                    label: choice.name,
                    resolution: 'exact',
                  })
                }
              >
                <span className="block text-xs font-medium text-fg">{choice.name}</span>
                <span className="block text-[11px] text-fg-muted">
                  {choice.registryId ? `${choice.registryId} · ` : ''}
                  {choice.kind.replace(/_/g, ' ')}
                </span>
              </button>
            ))
          )}
        </div>
        {offset > 0 || offset + 20 < totalCount ? (
          <div className="mt-2 flex justify-between">
            <Button
              disabled={loading || offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 20))}
            >
              Previous
            </Button>
            <Button
              disabled={loading || offset + 20 >= totalCount}
              onClick={() => setOffset((value) => value + 20)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </PortalMenu>
    </span>
  );
}
