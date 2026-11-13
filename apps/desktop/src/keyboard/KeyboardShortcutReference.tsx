import { useEffect, useRef, useState } from 'react';
import {
  formatShortcut,
  formatShortcutParts,
  isApplePlatform,
  type ShortcutDefinition,
} from '@waypoint/ui-components/keyboard';
import { Kbd } from '../shared/components/Kbd';
import { safeFocus } from '../shared/utils/safeFocus';
import {
  APP_SHORTCUTS,
  SHORTCUT_AREAS,
  type AppShortcut,
  type ShortcutArea,
  type ShortcutKeysLabel,
} from './shortcutRegistry';

function keysLabel(label: ShortcutKeysLabel, platform?: string): string {
  if (typeof label === 'string') return label;
  return isApplePlatform(platform) ? label.apple : label.standard;
}

function KeyCaps({ parts }: { parts: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, index) => (
        <Kbd key={`${part}-${index}`}>{part}</Kbd>
      ))}
    </span>
  );
}

function ShortcutKeys({ shortcut, platform }: { shortcut: AppShortcut; platform?: string }) {
  if (shortcut.keysLabel) {
    const parts = keysLabel(shortcut.keysLabel, platform)
      .split(/\s+/)
      .filter((part) => part.length > 0 && part.toLowerCase() !== 'or');
    return <KeyCaps parts={parts} />;
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {shortcut.chords.map((chord, index) => (
        <span key={chordIdentity(chord)} className="inline-flex items-center gap-1">
          {index > 0 ? <span className="text-[10px] leading-none text-fg-subtle">or</span> : null}
          <KeyCaps parts={formatShortcutParts(chord, platform) ?? []} />
        </span>
      ))}
    </span>
  );
}

function chordIdentity(chord: ShortcutDefinition): string {
  if ('apple' in chord) return `apple:${chord.apple.join('+')}|${chord.standard.join('+')}`;
  return chord.join('+');
}

const FIRST_IN_SECTION: Partial<Record<string, readonly string[]>> = {
  application: [
    'app.dark-mode',
    'app.toggle-sidebar',
    'app.explorer',
    'app.search',
    'app.ai-chat',
    'app.new-chat',
    'app.settings',
    'app.redo',
    'app.undo',
  ],
  files: [
    'files.rename',
    'files.reveal',
    'files.copy-path',
    'files.copy-relative-path',
    'files.open-in-new-panel',
    'files.move-to-trash',
    'files.new-folder',
    'files.save',
  ],
  tabs: ['tabs.reopen', 'tabs.reload', 'tabs.force-reload', 'tabs.close'],
  sequence: [
    'sequence.invert',
    'sequence.find',
    'sequence.find-next',
    'sequence.find-previous',
    'sequence.commit',
    'sequence.clear',
  ],
  pages: [
    'pages.duplicate-block',
    'pages.delete-block',
    'pages.move-up',
    'pages.move-down',
    'pages.clear-formatting',
    'pages.quote',
    'pages.code-block',
  ],
  chat: ['chat.stop', 'chat.newline', 'chat.approval-focus', 'chat.previous', 'chat.next'],
  genome: ['genome.dismiss-read'],
};

function withPriorityFirst(areaId: string, rows: AppShortcut[]): AppShortcut[] {
  const lead = FIRST_IN_SECTION[areaId];
  if (!lead) return rows;
  const rank = new Map(lead.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? 1000) - (rank.get(b.id) ?? 1000));
}

const SPOKEN_KEY: Record<string, string> = {
  '⌘': 'Command',
  '⇧': 'Shift',
  '⌥': 'Option',
  '⌃': 'Control',
  Ctrl: 'Control',
  Alt: 'Alt',
  Shift: 'Shift',
  Esc: 'Escape',
  '←': 'Left',
  '→': 'Right',
  '↑': 'Up',
  '↓': 'Down',
  '⌫': 'Delete',
  '↩': 'Return',
};

function shortcutKeyWords(shortcut: AppShortcut, platform?: string): string {
  const parts = shortcut.keysLabel
    ? keysLabel(shortcut.keysLabel, platform)
        .split(/\s+/)
        .filter((part) => part.length > 0 && part.toLowerCase() !== 'or')
    : shortcut.chords.flatMap((chord) => formatShortcutParts(chord, platform) ?? []);
  const spoken = parts.map((part) => SPOKEN_KEY[part] ?? part);
  return [...parts, ...spoken, formatShortcut(shortcut.chords[0], platform)]
    .filter(Boolean)
    .join(' ');
}

function keyTokens(shortcut: AppShortcut, platform?: string): string[] {
  return shortcutKeyWords(shortcut, platform)
    .toLowerCase()
    .split(/\s+/)
    .flatMap((part) =>
      part.split('+').flatMap((piece) => piece.match(/[a-z0-9]+|[^a-z0-9]/g) ?? [])
    );
}

function shortcutMatches(
  shortcut: AppShortcut,
  platform: string | undefined,
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  const tokens = keyTokens(shortcut, platform);
  if (needle.length === 1) return tokens.some((token) => token === needle);
  const prose = [shortcut.label, shortcut.when, shortcut.note]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (prose.includes(needle)) return true;
  const words = needle.split(/\s+/).filter((word) => word.length > 0);
  return words.every((word) =>
    tokens.some((token) => (word.length === 1 ? token === word : token.startsWith(word)))
  );
}

function shortcutListIsOnScreen(root: HTMLElement): boolean {
  if (root.closest('.hidden')) return false;
  for (let node: HTMLElement | null = root; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

type ShortcutFindClaim = (event: KeyboardEvent) => boolean;

type ShortcutFindHost = Window & { __dnaforgeShortcutFind?: Set<ShortcutFindClaim> };

function shortcutFindClaims(): Set<ShortcutFindClaim> {
  const host = window as ShortcutFindHost;
  if (host.__dnaforgeShortcutFind) return host.__dnaforgeShortcutFind;
  const claims = new Set<ShortcutFindClaim>();
  host.__dnaforgeShortcutFind = claims;
  window.addEventListener(
    'keydown',
    (event) => {
      for (const claim of claims) {
        if (!claim(event)) continue;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
    },
    true
  );
  return claims;
}

if (typeof window !== 'undefined') shortcutFindClaims();

export function KeyboardShortcutReference({
  showDevelopment = true,
  platform,
}: {
  showDevelopment?: boolean;
  platform?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [developer, setDeveloper] = useState<{
    area: ShortcutArea;
    shortcuts: readonly AppShortcut[];
  } | null>(null);
  const developerEnabled = import.meta.env.DEV === true && showDevelopment;

  useEffect(() => {
    if (!developerEnabled) {
      setDeveloper(null);
      return;
    }
    let cancelled = false;
    void import('./developerShortcuts').then((mod) => {
      if (cancelled) return;
      setDeveloper({ area: mod.DEVELOPER_SHORTCUT_AREA, shortcuts: mod.DEVELOPER_SHORTCUTS });
    });
    return () => {
      cancelled = true;
    };
  }, [developerEnabled]);

  const shortcuts = developer ? [...APP_SHORTCUTS, ...developer.shortcuts] : APP_SHORTCUTS;
  const areas = developer ? [...SHORTCUT_AREAS, developer.area] : SHORTCUT_AREAS;
  const needle = query.trim().toLowerCase();
  const sections = areas.flatMap((area) => {
    const inArea = shortcuts.filter((shortcut) => shortcut.area === area.id);
    if (inArea.length === 0) return [];
    return [{ area, rows: withPriorityFirst(area.id, inArea) }];
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const claim: ShortcutFindClaim = (event) => {
      if (!shortcutListIsOnScreen(root)) return false;
      const commandFind =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f';
      if (!commandFind) return false;
      setFindOpen(true);
      const field = findRef.current;
      if (field && safeFocus(field)) field.select();
      return true;
    };
    const claims = shortcutFindClaims();
    claims.add(claim);
    return () => {
      claims.delete(claim);
    };
  }, []);

  useEffect(() => {
    if (!findOpen) return;
    const field = findRef.current;
    if (field && safeFocus(field)) field.select();
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen || needle.length === 0) return;
    const match = rootRef.current?.querySelector('[data-shortcut-match="true"]');
    if (match instanceof HTMLElement && typeof match.scrollIntoView === 'function') {
      match.scrollIntoView({ block: 'nearest' });
    }
  }, [findOpen, needle]);

  return (
    <div ref={rootRef}>
      {findOpen ? (
        <input
          ref={findRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
              setFindOpen(false);
            }
          }}
          placeholder="Find"
          aria-label="Find shortcuts"
          data-testid="shortcut-find"
          className="mb-3 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/50"
        />
      ) : null}
      {sections.map(({ area, rows }) => (
        <section key={area.id} data-testid={`shortcut-area-${area.id}`} className="mt-6">
          <h3 className="text-lg font-semibold text-fg">{area.title}</h3>
          <div className="mt-2">
            {rows.map((shortcut) => {
              const matched = shortcutMatches(shortcut, platform, query);
              return (
                <div
                  key={shortcut.id}
                  data-testid={`shortcut-row-${shortcut.id}`}
                  data-shortcut-match={matched ? 'true' : undefined}
                  className={`py-1.5 ${matched ? 'rounded bg-warning/15' : ''}`}
                >
                  <span className="sr-only">{shortcutKeyWords(shortcut, platform)}</span>
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-xs text-fg-muted">{shortcut.label}</span>
                    <span
                      aria-hidden
                      className="h-3 min-w-6 flex-1 text-fg-subtle/80"
                      style={{
                        backgroundImage:
                          'radial-gradient(circle, currentColor 1px, transparent 1.15px)',
                        backgroundSize: '7px 3px',
                        backgroundRepeat: 'repeat-x',
                        backgroundPosition: 'left center',
                      }}
                    />
                    <span className="flex shrink-0 items-center gap-1.5">
                      {shortcut.availability === 'suggested' ? (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
                          Suggested
                        </span>
                      ) : null}
                      <ShortcutKeys shortcut={shortcut} platform={platform} />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
