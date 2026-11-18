import { MenuNativeSelect, INTERACTION_CLASS } from '@waypoint/ui-components';
import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../presentation/PresentationSurface';
import { useState, useLayoutEffect, useCallback, useRef } from 'react';
import { VERSION_HISTORY, getReleaseNote, type ReleaseNote } from '../lib/release-notes';
import { CloseIcon } from './icons';
import { APP_BUILD } from '../lib/app-build';
import { installedReleaseVersion } from '../shared/app-build-identity';
import { resolveReleaseNotesRequest } from '../lib/release-notes-presentation';
import type { ReleaseNotesCloseReason } from '../shared/release-notes-telemetry';
import { safeFocus } from '../shared/utils/safeFocus';

interface ReleaseNotesModalProps {
  open: boolean;
  onClose: (reason?: ReleaseNotesCloseReason) => void;
  onDisplayed?: (version: string) => void;

  initialVersion?: string;
}

export function ReleaseNotesModal(props: ReleaseNotesModalProps) {
  return props.open ? <ReleaseNotesDialog {...props} /> : null;
}

function ReleaseNotesDialog({ onClose, onDisplayed, initialVersion }: ReleaseNotesModalProps) {
  const presentationOverlay = usePresentationOverlay('modal');

  const installedVersion = installedReleaseVersion(APP_BUILD);
  const request = resolveReleaseNotesRequest(APP_BUILD, initialVersion).version;
  const [selection, setSelection] = useState({ request, version: request });

  const selected = selection.request === request ? selection.version : request;
  const note = VERSION_HISTORY.includes(selected) ? getReleaseNote(selected) : null;
  const modalRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closed = useRef(false);
  const dismiss = useCallback(
    (reason: ReleaseNotesCloseReason) => {
      if (closed.current) return;
      closed.current = true;
      onClose(reason);
    },
    [onClose]
  );

  useLayoutEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    if (!modal.open) modal.showModal();
    safeFocus(headingRef.current, { preventScroll: true });
    const containFocus = (event: FocusEvent) => {
      if (modal.open && !modal.contains(event.target as Node))
        safeFocus(headingRef.current, { preventScroll: true });
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (modal.open) modal.close();
    };
  }, []);

  useLayoutEffect(() => {
    setSelection((current) =>
      current.request === request ? current : { request, version: request }
    );
  }, [request]);
  useLayoutEffect(() => {
    onDisplayed?.(selected);
  }, [onDisplayed, selected]);

  const onBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === event.currentTarget) dismiss('backdrop');
    },
    [dismiss]
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const modal = modalRef.current;
    if (!modal) return;
    const candidates = [
      ...modal.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), summary, a[href], [tabindex]'
      ),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.closest('[hidden], [inert]') &&
        getComputedStyle(element).display !== 'none' &&
        getComputedStyle(element).visibility !== 'hidden' &&
        [...modal.querySelectorAll('details:not([open])')].every(
          (detail) => !detail.contains(element) || detail.querySelector('summary') === element
        )
    );
    const first = candidates[0];
    const last = candidates[candidates.length - 1];
    const active = document.activeElement;
    if (!first || !last) {
      event.preventDefault();
      safeFocus(headingRef.current);
      return;
    }
    if (
      !candidates.includes(active as HTMLElement) ||
      (event.shiftKey ? active === first : active === last)
    ) {
      event.preventDefault();
      safeFocus(event.shiftKey ? last : first, { preventScroll: true });
    }
  };

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <dialog
        ref={presentationOverlay.bindRef(modalRef, '0')}
        data-testid="release-notes-modal-backdrop"
        data-analytics-block
        className="ph-no-capture fixed inset-0 z-50 m-0 h-full w-full max-h-none max-w-none border-0 open:flex items-center justify-center bg-black/40 backdrop:bg-transparent backdrop-blur-sm p-6"
        onClick={onBackdropClick}
        onKeyDown={onKeyDown}
        onCancel={(event) => {
          event.preventDefault();
          dismiss('escape');
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Release notes"
      >
        <div
          data-testid="release-notes-modal"
          className="bg-bg border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        >
          {}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
            <div className="flex items-baseline gap-3">
              <h2
                ref={headingRef}
                tabIndex={-1}
                data-testid="release-notes-heading"
                className="text-base font-semibold text-fg"
              >
                Release Notes
              </h2>
              <span className="inline-block min-w-0">
                <MenuNativeSelect
                  density="compact"
                  data-testid="release-notes-modal-version-picker"
                  value={selected}
                  onChange={(e) => {
                    if (VERSION_HISTORY.includes(e.target.value))
                      setSelection({ request, version: e.target.value });
                  }}
                >
                  {!note && <option value={selected}>Notes unavailable</option>}
                  {VERSION_HISTORY.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                      {v === installedVersion ? ' (installed)' : ''}
                    </option>
                  ))}
                </MenuNativeSelect>
              </span>
            </div>
            <button
              type="button"
              data-testid="release-notes-modal-close"
              onClick={() => dismiss('close')}
              aria-label="Close"
              className={`${INTERACTION_CLASS} p-1 rounded text-fg-muted transition-colors`}
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {}
          <div className="overflow-y-auto px-5 py-4 flex-1 min-h-0">
            {note ? (
              <ModalReleaseNoteBody note={note} />
            ) : (
              <div className="text-sm text-fg-subtle italic">
                No notes recorded for v{selected}.
              </div>
            )}
          </div>
        </div>
      </dialog>
    </PresentationScopeContext.Provider>
  );
}

function ModalReleaseNoteBody({ note }: { note: ReleaseNote }) {
  return (
    <div className="space-y-4">
      <div className="text-xs text-fg-subtle">Released {note.date}</div>
      <ul className="space-y-2">
        {note.highlights.map((bullet) => (
          <li key={bullet} className="flex gap-2 text-sm text-fg">
            <span className="text-accent mt-0.5 flex-shrink-0">•</span>
            <span className="leading-relaxed">{bullet}</span>
          </li>
        ))}
      </ul>

      {note.added && note.added.length > 0 && (
        <details className="text-xs" open>
          <summary className={`${INTERACTION_CLASS} text-fg-muted font-medium cursor-pointer mb-2`}>
            Added ({note.added.length})
          </summary>
          <ul className="space-y-1.5 pl-3">
            {note.added.map((bullet) => (
              <li key={bullet} className="flex gap-2 text-fg-muted">
                <span className="text-fg-subtle mt-0.5 flex-shrink-0">+</span>
                <span className="leading-relaxed">{bullet}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {note.fixed && note.fixed.length > 0 && (
        <details className="text-xs" open>
          <summary className={`${INTERACTION_CLASS} text-fg-muted font-medium cursor-pointer mb-2`}>
            Fixed ({note.fixed.length})
          </summary>
          <ul className="space-y-1.5 pl-3">
            {note.fixed.map((bullet) => (
              <li key={bullet} className="flex gap-2 text-fg-muted">
                <span className="text-fg-subtle mt-0.5 flex-shrink-0">✓</span>
                <span className="leading-relaxed">{bullet}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {note.underTheHood && note.underTheHood.length > 0 && (
        <details className="text-xs">
          <summary className={`${INTERACTION_CLASS} text-fg-muted font-medium cursor-pointer mb-2`}>
            Under the hood ({note.underTheHood.length})
          </summary>
          <ul className="space-y-1.5 pl-3">
            {note.underTheHood.map((bullet) => (
              <li key={bullet} className="flex gap-2 text-fg-subtle">
                <span className="mt-0.5 flex-shrink-0">·</span>
                <span className="leading-relaxed">{bullet}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
