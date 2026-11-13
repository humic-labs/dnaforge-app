import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../presentation/PresentationSurface';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { platform } from '../platform';
import { useDarkMode } from '../shared/context/DarkModeContext';
import type { ThirdPartyNotices } from '../shared/ipc/third-party-notices.contract';
import { CloseIcon } from './icons';
import { SETTINGS_SECONDARY_BUTTON_CLASS } from './SettingsSubsection';

const CodeEditor = lazy(() => import('./CodeEditor'));

const UNAVAILABLE: ThirdPartyNotices = { status: 'unavailable' };

function readNotices(): Promise<ThirdPartyNotices> {
  const notices = platform().thirdPartyNotices;
  if (!notices) return Promise.resolve(UNAVAILABLE);
  return notices.read().catch(() => UNAVAILABLE);
}

function openChromiumLicenses(): Promise<boolean> {
  const notices = platform().thirdPartyNotices;
  if (!notices) return Promise.resolve(false);
  return notices.openChromiumLicenses().catch(() => false);
}

export function nextMatch(haystack: string, needle: string, from: number): number {
  if (!needle) return -1;
  const after = haystack.indexOf(needle, from);
  return after >= 0 ? after : haystack.indexOf(needle);
}

function ignoreEdit(): void {}

function DialogStatus({ testId, children }: { testId?: string; children: string }) {
  return (
    <div data-testid={testId} className="px-5 py-4 text-sm text-fg-muted">
      {children}
    </div>
  );
}

export function OpenSourceLicensesDialog({ onClose }: { onClose: () => void }) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const { darkMode } = useDarkMode();
  const [notices, setNotices] = useState<ThirdPartyNotices | null>(null);
  const [query, setQuery] = useState('');
  const [noMatch, setNoMatch] = useState(false);
  const [chromiumFailed, setChromiumFailed] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const text = notices?.status === 'available' ? notices.text : null;
  const searchable = useMemo(() => text?.toLowerCase() ?? '', [text]);

  useEffect(() => {
    let cancelled = false;
    void readNotices().then((result) => {
      if (!cancelled) setNotices(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    presentationEvents.add(window, 'keydown', onKeyDown);
    return () => presentationEvents.remove(window, 'keydown', onKeyDown);
  }, [onClose, presentationEvents]);

  const find = (event: FormEvent) => {
    event.preventDefault();
    const view = viewRef.current;
    if (!view || !query) return;
    const index = nextMatch(searchable, query.toLowerCase(), view.state.selection.main.to);
    setNoMatch(index < 0);
    if (index >= 0) {
      view.dispatch({
        selection: { anchor: index, head: index + query.length },
        scrollIntoView: true,
      });
    }
  };

  const showChromiumLicenses = () => {
    void openChromiumLicenses().then((opened) => setChromiumFailed(!opened));
  };

  return createPortal(
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        data-testid="open-source-licenses-backdrop"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Open-source licenses"
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div
          data-testid="open-source-licenses-dialog"
          className={`bg-bg border border-border rounded-xl shadow-xl w-full max-w-4xl flex flex-col ${
            notices?.status === 'unavailable' ? 'max-h-[80vh]' : 'h-[80vh]'
          }`}
        >
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border flex-shrink-0">
            <h2 className="text-base font-semibold text-fg">Open-source licenses</h2>
            <div className="flex items-center gap-2">
              {text !== null && (
                <>
                  {noMatch && (
                    <span
                      data-testid="open-source-licenses-no-match"
                      className="text-xs text-fg-subtle"
                    >
                      No matches
                    </span>
                  )}
                  <form role="search" onSubmit={find}>
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setNoMatch(false);
                      }}
                      placeholder="Find"
                      aria-label="Find in licenses"
                      data-testid="open-source-licenses-find"
                      className="w-48 bg-bg-subtle border border-border rounded px-2 py-1 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                  </form>
                  <button
                    onClick={showChromiumLicenses}
                    data-testid="open-source-licenses-chromium"
                    className={SETTINGS_SECONDARY_BUTTON_CLASS}
                  >
                    Chromium Licenses ↗
                  </button>
                </>
              )}
              <button
                data-testid="open-source-licenses-close"
                onClick={onClose}
                aria-label="Close"
                className="p-1 rounded hover:bg-bg-muted text-fg-muted hover:text-fg transition-colors"
              >
                <CloseIcon size={16} />
              </button>
            </div>
          </div>
          {chromiumFailed && (
            <div
              data-testid="open-source-licenses-chromium-failed"
              className="px-5 py-2 text-xs text-fg-muted border-b border-border"
            >
              The Chromium license list could not be opened.
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
            {notices === null ? (
              <DialogStatus>Loading…</DialogStatus>
            ) : text === null ? (
              <DialogStatus testId="open-source-licenses-unavailable">
                This development build has no license list. Packaged builds include it.
              </DialogStatus>
            ) : (
              <Suspense fallback={<DialogStatus>Loading…</DialogStatus>}>
                <CodeEditor
                  value={text}
                  onChange={ignoreEdit}
                  language="markdown"
                  darkMode={darkMode}
                  showLineNumbers={false}
                  wordWrap
                  readOnly
                  ariaLabel="Open-source licenses"
                  onReady={(view) => {
                    viewRef.current = view;
                  }}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </PresentationScopeContext.Provider>,
    document.body
  );
}

export function OpenSourceLicensesSetting() {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-settings-target="open-source-licenses"
      tabIndex={-1}
      data-testid="settings-section-open-source-licenses"
      className="flex items-center justify-between gap-3 border-t border-border/30 pt-4"
    >
      <div className="text-xs text-fg-muted">
        Licenses for the open-source components in DNAForge, and where to get their source code.
      </div>
      <button
        onClick={() => setOpen(true)}
        data-testid="settings-open-licenses"
        className={SETTINGS_SECONDARY_BUTTON_CLASS}
      >
        View Licenses →
      </button>
      {open && <OpenSourceLicensesDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
