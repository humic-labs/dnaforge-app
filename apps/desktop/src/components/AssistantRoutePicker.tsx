import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserVisibleText,
} from '@waypoint/user-messages';
import { useCallback, useRef, useState } from 'react';
import {
  getAssistantRouteDetail,
  getAssistantRouteLabel,
  type AssistantRouteOption,
  type AssistantRouteSelection,
} from '../features/ai/assistant-routes';
import type { AssistantHostId } from '../features/ai/assistant-hosts';
import { SlidersIcon } from './icons';
import { ChatComposerDisclosureIcon } from './ChatComposerDisclosureIcon';
import { PortalMenu } from './PortalMenu';

interface AssistantRoutePickerProps {
  activeRoute: AssistantRouteSelection;
  options: AssistantRouteOption[];
  isConfigured: boolean;
  onSelect: (route: AssistantRouteSelection) => void;
  onHostedSignInRequired?: (selection: AssistantRouteSelection) => void;
  onManageSources: () => void;
  onConfigureHost?: (hostId: AssistantHostId) => void;
  buttonTestId: string;
  menuTestId: string;
  optionTestIdPrefix: string;
  manageTestId?: string;
  buttonClassName: string;
  menuClassName: string;
  showInlineDetail?: boolean;
  emptyLabel?: string;
}

interface RoutePickerDisplay {
  primary: string;
  secondary: UserVisibleText;
}

function getFallbackDisplay(route: AssistantRouteSelection): RoutePickerDisplay {
  return {
    primary: getAssistantRouteLabel(route),
    secondary: getAssistantRouteDetail(route),
  };
}

function getOptionDisplay(option: AssistantRouteOption): RoutePickerDisplay {
  if (option.selection.kind === 'provider') {
    if (!option.configured || option.readiness !== 'ready') {
      return {
        primary: option.label,
        secondary: option.detail,
      };
    }

    return {
      primary: option.label,
      secondary: option.sourceLabel,
    };
  }

  if (option.selection.kind === 'cli') {
    if (!option.configured) {
      return {
        primary: option.label,
        secondary: option.detail,
      };
    }

    return {
      primary: option.label,
      secondary: option.detail,
    };
  }

  return {
    primary: option.label,
    secondary: option.detail,
  };
}

export function AssistantRoutePicker({
  activeRoute,
  options,
  isConfigured,
  onSelect,
  onHostedSignInRequired,
  onManageSources,
  onConfigureHost,
  buttonTestId,
  menuTestId,
  optionTestIdPrefix,
  manageTestId,
  buttonClassName,
  menuClassName,
  showInlineDetail = false,
  emptyLabel = 'No assistant source is configured.',
}: AssistantRoutePickerProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activeOption = options.find((option) => option.active);
  const activeRouteConfigured = activeOption?.configured ?? isConfigured;
  const activeDisplay = activeOption
    ? getOptionDisplay(activeOption)
    : getFallbackDisplay(activeRoute);
  const label = activeDisplay.primary;
  const detail: UserVisibleText = activeRouteConfigured
    ? activeDisplay.secondary
    : activeRoute.kind === 'provider'
      ? (activeOption?.detail ?? userMessage('copy.needs-api-key'))
      : (activeOption?.readinessLabel ?? userMessage('assistant.readiness.needs-login'));

  const selectRoute = useCallback(
    (route: AssistantRouteSelection) => {
      setOpen(false);
      onSelect(route);
    },
    [onSelect]
  );

  const manageSources = useCallback(() => {
    setOpen(false);
    onManageSources();
  }, [onManageSources]);

  const configureHost = useCallback(
    (hostId: AssistantHostId) => {
      if (!onConfigureHost) return;
      setOpen(false);
      onConfigureHost(hostId);
    },
    [onConfigureHost]
  );

  const renderOption = (option: AssistantRouteOption) => {
    const canConfigure = option.category !== 'future' && !!onConfigureHost;
    const unavailable = option.readiness === 'unavailable';
    const display = getOptionDisplay(option);
    const detail = display.secondary;
    const selectOrConfigureRoute = () => {
      if (unavailable) return;
      if (option.selection.kind === 'hosted' && !option.configured) {
        if (option.readiness === 'needs-login' && onHostedSignInRequired) {
          setOpen(false);
          onHostedSignInRequired(option.selection);
        }
        return;
      }
      if (!option.configured && option.category === 'cli') {
        if (canConfigure) configureHost(option.hostId);
        else manageSources();
        return;
      }
      selectRoute(option.selection);
    };
    return (
      <div
        key={option.id}
        role="none"
        className={`flex items-center transition-colors ${
          option.active
            ? 'bg-border/45 text-accent dark:bg-border-hover/65'
            : 'text-fg-muted hover:bg-border/45 hover:text-fg dark:hover:bg-border-hover/65'
        }`}
      >
        <button
          type="button"
          role="menuitem"
          aria-current={option.active ? 'true' : undefined}
          aria-disabled={
            option.selection.kind === 'hosted' &&
            !option.configured &&
            option.readiness !== 'needs-login'
              ? 'true'
              : undefined
          }
          onClick={selectOrConfigureRoute}
          disabled={unavailable}
          className="min-w-0 flex-1 px-3 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid={`${optionTestIdPrefix}-${option.id}`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className={`text-xs font-medium ${option.active ? 'text-accent' : 'text-fg'}`}>
              {display.primary}
            </span>
            {option.active && (
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" aria-hidden />
            )}
            {!option.configured && (
              <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                {option.readinessLabel ?? 'Needs setup'}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-fg-subtle">{detail}</div>
        </button>
        {canConfigure && (
          <button
            type="button"
            role="menuitem"
            onClick={() => configureHost(option.hostId)}
            className="mr-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-border/45 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:hover:bg-border-hover/65"
            title={`Configure ${option.label}`}
            aria-label={`Configure ${option.label}`}
            data-testid={`${optionTestIdPrefix}-${option.id}-configure`}
          >
            <SlidersIcon size={13} />
          </button>
        )}
      </div>
    );
  };

  const renderGroup = (
    label: string,
    groupOptions: AssistantRouteOption[],
    showTopBorder: boolean
  ) => {
    if (groupOptions.length === 0) return null;
    return (
      <div role="group" aria-label={label}>
        <div
          className={`px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-fg-subtle ${
            showTopBorder ? 'border-t border-border/70' : ''
          }`}
        >
          {label}
        </div>
        {groupOptions.map(renderOption)}
      </div>
    );
  };

  return (
    <div className="min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`${buttonClassName} max-w-full`}
        title={userMessageWithValues('assistant.routeTitle', {
          route: userMessageValue(label),
          detail: userMessageValue(detail),
        })}
        aria-label={`Run with: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={buttonTestId}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-medium">{label}</span>
          {showInlineDetail && (
            <span className="hidden max-w-[96px] truncate text-fg-subtle lg:inline">
              / {detail}
            </span>
          )}
        </span>
        <ChatComposerDisclosureIcon open={open} />
      </button>
      <PortalMenu
        open={open}
        anchorRef={buttonRef}
        role="menu"
        data-testid={menuTestId}
        className={menuClassName}
        onRequestClose={() => setOpen(false)}
      >
        {options.length === 0 ? (
          <div className="px-3 py-2 text-xs text-fg-muted">{emptyLabel}</div>
        ) : (
          <>{renderGroup('Run with', options, false)}</>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={manageSources}
          className="w-full border-t border-border px-3 py-2 text-left text-xs font-medium text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg"
          data-testid={manageTestId}
        >
          AI settings...
        </button>
      </PortalMenu>
    </div>
  );
}
