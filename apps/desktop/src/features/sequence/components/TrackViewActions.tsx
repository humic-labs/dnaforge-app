import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, TextField } from '../../../components/ui';
import { EllipsisIcon } from '../../../components/icons';
import { IconButton } from '../../../shared/components/IconButton';
import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { COMMAND_IDS, COMMAND_SCOPES, useCommandHandler } from '../../../commands';
import type { Tab } from '../../canvas/public/types';
import type { SaveTrackViewRequest } from '../../../shared/track-view';
import type { TrackViewSession } from '../track-view-session';
import { useLaneContractStore } from '../lane-contract-store';
import { TrackViewSaveDialog } from './TrackViewSaveDialog';

export function TrackViewActions({
  tab,
  session,
  isActive,
}: {
  tab: Tab;
  session: TrackViewSession;
  isActive: boolean;
}) {
  const presentationOverlay = usePresentationOverlay('keyboard');
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => () => session.cancelNaming(), [session]);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const naming = state.kind === 'naming' ? state : state.kind === 'saving' ? state.naming : null;
  const saving = state.kind === 'saving';
  const surface = naming?.mode ?? (menu ? 'menu' : null);
  const name = naming?.name ?? '';
  const error = naming?.error ?? null;
  const setName = (name: string) => session.setName(name);
  const close = useCallback(
    (restoreFocus = true) => {
      if (session.getSnapshot().kind === 'saving') return;
      setMenu(false);
      session.cancelNaming();
      if (restoreFocus) safeFocus(trigger.current);
    },
    [session]
  );
  const beginNaming = (mode: 'save' | 'rename' | 'copy') => {
    setMenu(false);
    session.beginNaming(mode);
  };
  const save = async (name: string, destination?: SaveTrackViewRequest['destination']) => {
    const result = await session.saveHuman(name, destination);
    if (result.ok) {
      setMenu(false);
      safeFocus(trigger.current);
    }
  };
  useCommandHandler(
    COMMAND_IDS.editUndo,
    () => useLaneContractStore.getState().undoLaneChange(tab.id),
    {
      scope: COMMAND_SCOPES.tabSequence,
      active: isActive,
      enabled: () => useLaneContractStore.getState().canUndoLaneChange(tab.id),
    }
  );
  useCommandHandler(
    COMMAND_IDS.editRedo,
    () => useLaneContractStore.getState().redoLaneChange(tab.id),
    {
      scope: COMMAND_SCOPES.tabSequence,
      active: isActive,
      enabled: () => useLaneContractStore.getState().canRedoLaneChange(tab.id),
    }
  );
  useEffect(() => {
    if (surface === 'menu')
      root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    else if (surface) {
      safeFocus(nameInput.current);
      nameInput.current?.select();
    }
  }, [surface]);
  useEffect(() => {
    if (surface !== 'menu' && surface !== 'rename') return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [surface, close]);
  return (
    <div
      ref={root}
      className="relative flex items-center gap-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (
          surface === 'menu' &&
          ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          const items = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
          );
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
      onBlur={(event) => {
        if (
          (surface === 'menu' || surface === 'rename') &&
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          close(false);
      }}
    >
      <button
        type="button"
        className="h-8 rounded border border-border px-3 text-sm hover:bg-bg-muted disabled:cursor-wait disabled:opacity-50"
        disabled={saving}
        onClick={() => {
          if (tab.trackView) void save(tab.trackView.document.name);
          else beginNaming('save');
        }}
      >
        {saving && surface === null ? 'Saving…' : 'Save view'}
      </button>
      <IconButton
        ref={trigger}
        icon={<EllipsisIcon className="h-5 w-5 text-fg" strokeWidth={3} />}
        label="Track view actions"
        size="sm"
        variant="ghost"
        showTooltip={false}
        disabled={saving}
        aria-haspopup="menu"
        aria-expanded={surface === 'menu'}
        onClick={() => {
          if (surface) close();
          else setMenu(true);
        }}
      />
      {surface === 'menu' && (
        <PresentationScopeContext.Provider value={presentationOverlay.scope}>
          <div
            role="menu"
            aria-label="Track view actions"
            className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-border bg-bg p-1 shadow-lg"
            ref={presentationOverlay.bindRef(undefined, '0')}
          >
            {tab.trackView && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full rounded px-3 py-2 text-left text-sm text-fg hover:bg-bg-muted focus:bg-bg-muted"
                  onClick={() => beginNaming('rename')}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full rounded px-3 py-2 text-left text-sm text-fg hover:bg-bg-muted focus:bg-bg-muted"
                  onClick={() => beginNaming('copy')}
                >
                  Save As…
                </button>
              </>
            )}
          </div>
        </PresentationScopeContext.Provider>
      )}
      {(surface === 'save' || surface === 'copy') && (
        <TrackViewSaveDialog
          initialName={name}
          initialPath={tab.trackView?.path}
          saving={saving}
          error={error}
          onCancel={() => close()}
          onSave={(nextName, destination) => void save(nextName, destination)}
        />
      )}
      {surface === 'rename' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(name);
          }}
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-bg p-3 shadow-lg"
          aria-label="Rename Track view"
        >
          <label className="mb-2 block text-xs text-fg-muted" htmlFor={`track-view-name-${tab.id}`}>
            Rename Track view
          </label>
          <TextField
            ref={nameInput}
            id={`track-view-name-${tab.id}`}
            aria-label="Track view name"
            value={name}
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" disabled={saving} onClick={() => close()}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : surface === 'rename' ? 'Rename' : 'Save Track view'}
            </Button>
          </div>
          {error && (
            <span role="alert" className="mt-2 block text-xs text-red-600">
              {toUserMessage(error, 'tracks.loadFailed')}
            </span>
          )}
        </form>
      )}
    </div>
  );
}
