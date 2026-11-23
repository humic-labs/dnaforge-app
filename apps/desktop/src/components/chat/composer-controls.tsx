import { useState, useRef, useCallback, useEffect } from 'react';
import { type ChatTurnSummary } from '../../features/ai/hooks/useChat';
import {
  getAssistantRouteDetail,
  getAssistantRouteLabel,
  type AssistantRouteSelection,
} from '../../features/ai/assistant-routes';
import { PortalMenu } from '../PortalMenu';
import { ChatComposerPickerLabel } from '../ChatComposerPickerLabel';
import { EllipsisIcon } from '../icons/glyphs';
import { safeFocus } from '../../shared/utils/safeFocus';
import { MenuTrigger, MenuRow, MenuSearchInput, useMenu } from '@waypoint/ui-components';
import { ActionMenu, type ActionMenuEntry } from '../ActionMenu';

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

export const CHAT_COMPOSER_SURFACE_CLASS =
  'chat-composer-surface rounded-2xl border border-border-hover/70 bg-bg-muted/70 shadow-sm transition-all dark:border-border-hover/80 dark:bg-bg-muted';

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
  width?: 'content' | 'compact' | 'standard';
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const entries: ActionMenuEntry[] = [
    ...actions.map(
      (action): ActionMenuEntry => ({
        id: action.id,
        label: action.label,
        description: action.description,
        testId: action.testId ?? `${testId}-${action.id}`,
        onSelect: action.onSelect,
      })
    ),
    ...groups.map(
      (group): ActionMenuEntry => ({
        id: group.id,
        label: group.label,
        description:
          (group.options.find((option) => option.value === group.value) ?? group.options[0])
            ?.label ?? 'Unavailable',
        testId: `${testId}-${group.id}`,
        submenuLabel: `${group.label} options`,
        submenuTestId: `${testId}-submenu`,
        disabled: group.options.length === 0,
        children: group.options.map((option) => ({
          id: option.value,
          label: option.label,
          title: option.title,
          description: option.title,
          role: 'menuitemradio',
          selected: option.value === group.value,
          testId: `${group.optionTestId}-option-${option.value}`,
          closeReason: 'selection',
          onSelect: () => {
            if (option.value !== group.value) group.onChange(option.value);
          },
        })),
      })
    ),
  ];
  if (entries.length === 0) return null;
  return (
    <div className="flex-shrink-0">
      <MenuTrigger
        ref={buttonRef}
        density="compact"
        variant="toolbar"
        iconOnly
        icon={<EllipsisIcon />}
        open={open}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        title={entries.flatMap((entry) => ('label' in entry ? [entry.label] : [])).join(' · ')}
        data-testid={testId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      <ActionMenu
        open={open}
        label={ariaLabel}
        entries={entries}
        anchorRef={buttonRef}
        testId={`${testId}-menu`}
        onClose={() => setOpen(false)}
      />
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
    <div className="w-40 min-w-0">
      <MenuSearchInput
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
      />
    </div>
  );
}

export function ChatComposerPicker({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  testId,
  width = 'content',
}: ChatComposerPickerProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const menu = useMenu({
    items: options.map((option) => ({
      id: option.value,
      textValue: option.label,
      closeOnActivate: false,
    })),
    selectedId: value,
    onFocusItem: (id) => safeFocus(rowRefs.current.get(id)),
    onActivate: (id) => {
      menu.close('selection');
      if (id !== value) onChange(id);
    },
  });
  return (
    <div
      className={`min-w-0 ${width === 'standard' ? 'max-w-[14rem]' : width === 'compact' ? 'max-w-[9rem]' : ''}`}
    >
      <MenuTrigger
        ref={buttonRef}
        density="compact"
        variant="toolbar"
        open={menu.isOpen}
        disabled={options.length === 0}
        onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            menu.openMenu();
          }
        }}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        title={title}
        data-testid={testId}
        data-value={value}
      >
        <ChatComposerPickerLabel label={selectedOption?.label ?? 'Unavailable'} />
      </MenuTrigger>
      <PortalMenu
        menu={menu}
        open={menu.isOpen}
        anchorRef={buttonRef}
        role="listbox"
        aria-label={ariaLabel}
        data-testid={`${testId}-menu`}
        density="compact"
        selection
        onRequestClose={menu.close}
      >
        {options.map((option) => (
          <MenuRow
            key={option.value}
            ref={(node) => {
              if (node) rowRefs.current.set(option.value, node);
              else rowRefs.current.delete(option.value);
            }}
            role="option"
            selected={option.value === value}
            active={menu.activeId === option.value}
            aria-selected={option.value === value}
            title={option.title}
            tabIndex={menu.activeId === option.value ? 0 : -1}
            onPointerEnter={() => menu.point(option.value)}
            onClick={() => menu.activate(option.value)}
            data-testid={`${testId}-option-${option.value}`}
            data-value={option.value}
          >
            {option.label}
          </MenuRow>
        ))}
      </PortalMenu>
    </div>
  );
}
