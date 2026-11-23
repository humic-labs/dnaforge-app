import { entityKindLabel } from '@waypoint/scientific-artifacts/shared/entity-types';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useLayoutEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  MenuTrigger,
  MenuSearchInput,
  MenuRow,
  MenuStatus,
  useMenu,
} from '@waypoint/ui-components';
import type { LimsRecordRelationshipValue } from '../../shared/lims';
import { PortalMenu } from '../PortalMenu';
import { Button } from '../ui';
import { EntityReferenceChip } from './EntityReferenceChip';

export interface EntityLinkChoice {
  id: string;
  name: string;
  kind: string;
  schemaDisplayName?: string;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
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
  const queryKey = JSON.stringify([search, offset, attempt]);
  const visibleChoices = loadedQuery === queryKey ? choices : [];
  const menu = useMenu({
    items: visibleChoices.map((choice) => ({
      id: choice.id,
      textValue: choice.name,
      disabled: busy,
      closeOnActivate: false,
    })),
    selectedId: current?.destinationEntityId,
    defaultOpen: editing,
    onClose: () => onEditingChange?.(false),
    onActivate: (id) => {
      const choice = visibleChoices.find((candidate) => candidate.id === id);
      if (choice)
        void commit({
          origin: 'native',
          destinationEntityId: choice.id,
          relationType: 'references',
          label: choice.name,
          resolution: 'exact',
        });
    },
  });
  const open = menu.isOpen;
  const controlled = useRef({ menu, selectedId: current?.destinationEntityId });
  controlled.current = { menu, selectedId: current?.destinationEntityId };
  useLayoutEffect(() => {
    const { menu: currentMenu, selectedId } = controlled.current;
    if (editing === true && !currentMenu.isOpen) currentMenu.openMenu(selectedId);
    else if (editing === false) currentMenu.close('handoff');
  }, [editing]);
  const changeOpen = (next: boolean) => {
    if (next) {
      menu.openMenu(current?.destinationEntityId);
      onEditingChange?.(true);
    } else menu.close('trigger');
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
        setLoadedQuery(queryKey);
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
  }, [open, disabled, onCommit, searchTargets, search, offset, sourceEntityId, attempt, queryKey]);

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
    menu.close('selection');
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
            typeLookup={
              current.destinationEntityId ? { entityId: current.destinationEntityId } : undefined
            }
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
            <MenuTrigger
              ref={anchorRef}
              open={open}
              aria-haspopup="dialog"
              aria-label={`${current ? 'Change' : 'Choose'} ${label}`}
              aria-expanded={open}
              disabled={disabled || busy}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  changeOpen(true);
                }
              }}
              onClick={() => {
                setSearch('');
                setOffset(0);
                changeOpen(!open);
              }}
            >
              {current ? 'Change' : 'Choose entity…'}
            </MenuTrigger>
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
        menu={menu}
        initialFocusRef={inputRef}
        anchorRef={anchorRef}
        onRequestClose={menu.close}
        role="dialog"
        aria-label={`Choose ${label}`}
        preferredSide="bottom"
        horizontalAlign="start"
        layout={{ width: '20rem' }}
        selection={false}
      >
        <label htmlFor={searchId} className="sr-only">
          Search entities for {label}
        </label>
        <MenuSearchInput
          ref={inputRef}
          aria-controls={`${searchId}-choices`}
          aria-activedescendant={
            menu.activeId === null ? undefined : `${searchId}-${encodeURIComponent(menu.activeId)}`
          }
          id={searchId}
          type="search"
          value={search}
          placeholder="Search by name or record ID"
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
        />
        <div
          id={`${searchId}-choices`}
          role="listbox"
          aria-label={`${label} entities`}
          className="mt-2 max-h-64 overflow-y-auto"
        >
          {loading || (loadedQuery !== queryKey && !queryError) ? (
            <MenuStatus role="status">Searching entities…</MenuStatus>
          ) : queryError ? (
            <div className="p-2 text-xs">
              <p role="alert" className="text-error">
                {toUserMessage(queryError, 'operation.failed')}
              </p>
              <Button onClick={() => setAttempt((value) => value + 1)}>Retry search</Button>
            </div>
          ) : visibleChoices.length === 0 ? (
            <MenuStatus>No matching entities.</MenuStatus>
          ) : (
            visibleChoices.map((choice) => (
              <MenuRow
                key={choice.id}
                id={`${searchId}-${encodeURIComponent(choice.id)}`}
                role="option"
                aria-selected={current?.destinationEntityId === choice.id}
                active={menu.activeId === choice.id}
                selected={current?.destinationEntityId === choice.id}
                tabIndex={-1}
                disabled={busy}
                description={`${choice.registryId ? `${choice.registryId} · ` : ''}${choice.schemaDisplayName ?? entityKindLabel(choice.kind)}`}
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => menu.point(choice.id)}
                onClick={() => menu.activate(choice.id)}
              >
                {choice.name}
              </MenuRow>
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
