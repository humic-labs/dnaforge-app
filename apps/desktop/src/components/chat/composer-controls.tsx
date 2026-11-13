import { useState, useRef, useCallback, useEffect } from 'react';
import { type ChatTurnSummary } from '../../features/ai/hooks/useChat';
import {
  getAssistantRouteDetail,
  getAssistantRouteLabel,
  type AssistantRouteSelection,
} from '../../features/ai/assistant-routes';
import { PortalMenu } from '../PortalMenu';
import { ChatComposerDisclosureIcon } from '../ChatComposerDisclosureIcon';
import { ChatComposerPickerLabel } from '../ChatComposerPickerLabel';
import { EllipsisIcon } from '../icons/glyphs';
import { scheduleFocus } from '../../shared/utils/safeFocus';

export const TURN_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
};

export const TURN_TRANSPORT_LABELS: Record<string, string> = {
  'codex-sdk': 'Codex CLI',
  'claude-agent-sdk': 'Claude Code',
  'grok-acp': 'Grok Build',
};

export const CHAT_COMPOSER_PICKER_CLASS =
  'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs font-semibold text-fg-muted transition-colors hover:bg-border/40 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-border-hover/60';
export const CHAT_MODEL_INPUT_CLASS =
  'h-7 min-w-0 rounded-md border border-transparent bg-bg/50 px-2 text-xs font-semibold text-fg-muted transition-colors hover:bg-border/40 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-bg-muted/40 dark:hover:bg-border-hover/60';
export const CHAT_COMPOSER_SURFACE_CLASS =
  'rounded-2xl border border-border-hover/70 bg-bg-muted/70 shadow-sm transition-all dark:border-border-hover/80 dark:bg-bg-muted';

export interface ChatComposerPickerOption {
  value: string;
  label: string;
  title?: string;
}

export interface ChatComposerPickerProps {
  value: string;
  options: ChatComposerPickerOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  title: string;
  testId: string;
  className?: string;
}

export interface ChatComposerOptionGroup {
  id: string;
  label: string;
  value: string;
  options: ChatComposerPickerOption[];
  onChange: (value: string) => void;
  optionTestId: string;
}

export interface ChatComposerMenuAction {
  id: string;
  label: string;
  description?: string;
  onSelect: () => void;
  testId?: string;
}

export function ChatComposerNestedOptionsMenu({
  groups,
  actions = [],
  ariaLabel,
  testId,
}: {
  groups: ChatComposerOptionGroup[];
  actions?: ChatComposerMenuAction[];
  ariaLabel: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const parentMenuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const submenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null;

  const close = useCallback(() => {
    setOpen(false);
    setActiveGroupId(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    return scheduleFocus(
      (activeGroup ? submenuRef.current : parentMenuRef.current)?.querySelector<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]'
      )
    );
  }, [activeGroupId, open]);

  const closeSubmenu = useCallback(() => {
    setActiveGroupId(null);
  }, []);

  const openGroup = useCallback((groupId: string, anchor: HTMLButtonElement) => {
    submenuAnchorRef.current = anchor;
    setActiveGroupId(groupId);
  }, []);

  const moveFocus = (container: HTMLElement, current: EventTarget | null, delta: number) => {
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')
    ).filter((item) => !item.hasAttribute('disabled'));
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === current);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  if (groups.length === 0 && actions.length === 0) return null;

  return (
    <div className="flex-shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setActiveGroupId(null);
          setOpen((next) => !next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveGroupId(null);
            setOpen(true);
          }
        }}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={[
          ...actions.map((action) => action.label),
          ...groups.map((group) => {
            const selected =
              group.options.find((option) => option.value === group.value) ?? group.options[0];
            return `${group.label}: ${selected?.label ?? 'Unavailable'}`;
          }),
        ].join(' · ')}
        data-testid={testId}
        className={`${CHAT_COMPOSER_PICKER_CLASS} w-7 justify-center px-0 !text-fg ${
          open ? 'bg-border/40 text-fg dark:bg-border-hover/60' : ''
        }`}
      >
        <EllipsisIcon className="!h-[18px] !w-[18px] shrink-0 stroke-[3]" />
      </button>
      <PortalMenu
        open={open}
        anchorRef={buttonRef}
        role="menu"
        aria-label={ariaLabel}
        data-testid={`${testId}-menu`}
        className="w-64 py-1"
        onRequestClose={close}
        surfaceRef={parentMenuRef}
        insideRefs={[submenuRef]}
        closeOnEscape={!activeGroup}
      >
        <div
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(event.currentTarget, event.target, event.key === 'ArrowDown' ? 1 : -1);
              return;
            }
            if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const items = event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitem"], [role="menuitemradio"]'
              );
              items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
              return;
            }
            if (event.key === 'ArrowRight') {
              const groupId = (event.target as HTMLElement).dataset.groupId;
              if (groupId) {
                event.preventDefault();
                openGroup(groupId, event.target as HTMLButtonElement);
              }
            }
          }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              data-testid={action.testId ?? `${testId}-${action.id}`}
              onClick={() => {
                close();
                action.onSelect();
              }}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-border/45 dark:hover:bg-border-hover/65"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-fg">{action.label}</span>
                {action.description ? (
                  <span className="mt-0.5 block truncate text-[10px] font-medium text-fg-muted">
                    {action.description}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
          {groups.map((group) => {
            const selected =
              group.options.find((option) => option.value === group.value) ?? group.options[0];
            const groupOpen = activeGroupId === group.id;
            return (
              <button
                key={group.id}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={groupOpen}
                data-group-id={group.id}
                data-testid={`${testId}-${group.id}`}
                onClick={(event) => openGroup(group.id, event.currentTarget)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-border/45 dark:hover:bg-border-hover/65 ${
                  groupOpen ? 'bg-border/45 dark:bg-border-hover/65' : ''
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-fg">{group.label}</span>
                  <span className="mt-0.5 block truncate text-[10px] font-medium text-fg-muted">
                    {selected?.label ?? 'Unavailable'}
                  </span>
                </span>
                <span className="text-sm font-bold text-fg-muted" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>
      </PortalMenu>
      <PortalMenu
        key={activeGroup?.id ?? 'closed'}
        open={open && !!activeGroup}
        anchorRef={submenuAnchorRef}
        role="menu"
        placement="submenu"
        aria-label={activeGroup ? `${activeGroup.label} options` : undefined}
        data-testid={`${testId}-submenu`}
        className="w-64 py-1"
        onRequestClose={closeSubmenu}
        surfaceRef={submenuRef}
        insideRefs={[parentMenuRef]}
      >
        <div
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(event.currentTarget, event.target, event.key === 'ArrowDown' ? 1 : -1);
              return;
            }
            if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const items =
                event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
              items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
              return;
            }
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              closeSubmenu();
            }
          }}
        >
          {activeGroup?.options.map((option) => {
            const selected = option.value === activeGroup.value;
            return (
              <button
                key={option.value || 'provider-default'}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={option.title}
                onClick={() => {
                  if (!selected) activeGroup.onChange(option.value);
                  close();
                }}
                data-testid={`${activeGroup.optionTestId}-option-${option.value}`}
                data-value={option.value}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors ${
                  selected
                    ? 'bg-border/45 font-semibold text-accent dark:bg-border-hover/65'
                    : 'text-fg-muted hover:bg-border/45 hover:text-fg dark:hover:bg-border-hover/65'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.title && (
                    <span className="mt-0.5 block text-[10px] font-medium leading-4 text-fg-muted">
                      {option.title}
                    </span>
                  )}
                </span>
                {selected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
              </button>
            );
          })}
        </div>
      </PortalMenu>
    </div>
  );
}

export function formatChatTurnRouteLabel(turn: ChatTurnSummary): string {
  if (turn.routeKind === 'provider') {
    const providerLabel = turn.provider
      ? (TURN_PROVIDER_LABELS[turn.provider] ?? turn.provider)
      : 'Provider';
    return `Direct API - ${providerLabel}${turn.model ? ` / ${turn.model}` : ''}`;
  }
  if (turn.routeKind === 'cli' || turn.transport) {
    const hostLabel = turn.transport
      ? (TURN_TRANSPORT_LABELS[turn.transport] ?? turn.transport)
      : turn.hostId;
    return turn.model ? `${hostLabel} / ${turn.model}` : hostLabel;
  }
  return turn.hostId;
}

export function getChatTurnRouteId(turn: ChatTurnSummary): string {
  if (turn.routeKind === 'provider' && turn.provider && turn.model) {
    return `provider:${turn.provider}:${turn.model}`;
  }
  if (turn.routeKind === 'cli' && turn.transport) {
    return `cli:${turn.transport}:${turn.permissionMode ?? 'native-cli'}`;
  }
  return `${turn.routeKind}:${turn.hostId}`;
}

export function formatAssistantRouteSummary(route: AssistantRouteSelection): string {
  return `${getAssistantRouteLabel(route)} - ${getAssistantRouteDetail(route)}`;
}

export function DirectApiModelTextInput({
  model,
  defaultModel,
  disabled = false,
  title,
  onCommit,
}: {
  model: string;
  defaultModel: string;
  disabled?: boolean;
  title?: string;
  onCommit: (model: string) => void;
}) {
  const [draft, setDraft] = useState(model);

  useEffect(() => {
    setDraft(model);
  }, [model]);

  const commitDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === model) return;
    onCommit(trimmed);
  }, [draft, model, onCommit]);

  return (
    <input
      type="text"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitDraft();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(model);
        }
      }}
      placeholder={defaultModel}
      aria-label="Direct API model"
      title={title ?? `Model: ${model}`}
      data-testid="chat-model-version-input"
      className={`${CHAT_MODEL_INPUT_CLASS} w-40`}
    />
  );
}

export function ChatComposerPicker({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  testId,
  className = '',
}: ChatComposerPickerProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((next) => !next)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        data-testid={testId}
        data-value={value}
        className={`${CHAT_COMPOSER_PICKER_CLASS} max-w-full ${className} ${
          open ? 'bg-border/40 text-fg dark:bg-border-hover/60' : ''
        }`}
      >
        <ChatComposerPickerLabel label={selectedOption.label} />
        <ChatComposerDisclosureIcon open={open} />
      </button>
      <PortalMenu
        open={open}
        anchorRef={buttonRef}
        role="listbox"
        data-testid={`${testId}-menu`}
        className="py-1"
        onRequestClose={() => setOpen(false)}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={active}
              title={option.title}
              onClick={() => {
                setOpen(false);
                if (option.value !== value) onChange(option.value);
              }}
              data-testid={`${testId}-option-${option.value}`}
              data-value={option.value}
              className={`flex w-full min-w-0 items-center gap-2 whitespace-nowrap px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                active
                  ? 'bg-border/45 text-accent dark:bg-border-hover/65'
                  : 'text-fg-muted hover:bg-border/45 hover:text-fg dark:hover:bg-border-hover/65'
              }`}
            >
              <span className="min-w-0 truncate">{option.label}</span>
              {active && (
                <span className="ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
              )}
            </button>
          );
        })}
      </PortalMenu>
    </div>
  );
}
