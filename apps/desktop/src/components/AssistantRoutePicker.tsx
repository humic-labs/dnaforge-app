import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserVisibleText,
} from '@waypoint/user-messages';
import { useRef } from 'react';
import {
  getAssistantRouteDetail,
  getAssistantRouteLabel,
  type AssistantRouteOption,
  type AssistantRouteSelection,
} from '../features/ai/assistant-routes';
import type { AssistantHostId } from '../features/ai/assistant-hosts';
import { SlidersIcon } from './icons';
import {
  MenuTrigger,
  MenuRow,
  MenuRowGroup,
  MenuRowAction,
  MenuSeparator,
  MenuStatus,
  useMenu,
} from '@waypoint/ui-components';
import { safeFocus } from '../shared/utils/safeFocus';
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
  showInlineDetail = false,
  emptyLabel = 'No assistant source is configured.',
}: AssistantRoutePickerProps) {
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

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const configurationId = (id: string) => `configure:${id}`;
  const menu = useMenu({
    items: [
      ...options.flatMap((option) => [
        {
          id: option.id,
          textValue: option.label,
          disabled: option.readiness === 'unavailable',
          closeOnActivate: false,
        },
        ...(option.category !== 'future' && onConfigureHost
          ? [
              {
                id: configurationId(option.id),
                textValue: `Configure ${option.label}`,
                closeOnActivate: false,
              },
            ]
          : []),
      ]),
      { id: 'manage-sources', textValue: 'AI settings', closeOnActivate: false },
    ],
    selectedId: activeOption?.id,
    onFocusItem: (id) => safeFocus(rowRefs.current.get(id)),
    onActivate: (id) => {
      if (id === 'manage-sources') {
        menu.close('handoff');
        onManageSources();
        return;
      }
      const configure = options.find((option) => configurationId(option.id) === id);
      if (configure) {
        menu.close('handoff');
        onConfigureHost?.(configure.hostId);
        return;
      }
      const option = options.find((candidate) => candidate.id === id);
      if (!option || option.readiness === 'unavailable') return;
      if (option.selection.kind === 'hosted' && !option.configured) {
        if (option.readiness === 'needs-login' && onHostedSignInRequired) {
          menu.close('handoff');
          onHostedSignInRequired(option.selection);
        }
        return;
      }
      if (!option.configured && option.category === 'cli') {
        menu.close('handoff');
        if (onConfigureHost) onConfigureHost(option.hostId);
        else onManageSources();
        return;
      }
      menu.close('selection');
      onSelect(option.selection);
    },
  });
  const bindRow = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  };
  return (
    <div className="min-w-0 max-w-[14rem]">
      <MenuTrigger
        ref={buttonRef}
        density="compact"
        variant="toolbar"
        open={menu.isOpen}
        onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            menu.openMenu();
          }
        }}
        title={userMessageWithValues('assistant.routeTitle', {
          route: userMessageValue(label),
          detail: userMessageValue(detail),
        })}
        aria-label={`Run with: ${label}`}
        aria-haspopup="menu"
        data-testid={buttonTestId}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{label}</span>
          {showInlineDetail && (
            <span className="hidden max-w-[96px] truncate text-fg-subtle lg:inline">
              / {detail}
            </span>
          )}
        </span>
      </MenuTrigger>
      <PortalMenu
        menu={menu}
        open={menu.isOpen}
        anchorRef={buttonRef}
        role="menu"
        aria-label="Assistant source"
        data-testid={menuTestId}
        layout={{ width: '20rem' }}
        density="compact"
        selection
        onRequestClose={menu.close}
      >
        {options.length === 0 ? (
          <MenuStatus>{emptyLabel}</MenuStatus>
        ) : (
          <div role="group" aria-label="Run with">
            <MenuStatus>Run with</MenuStatus>
            {options.map((option) => {
              const display = getOptionDisplay(option);
              const configureId = configurationId(option.id);
              return (
                <MenuRowGroup
                  key={option.id}
                  active={menu.activeId === option.id || menu.activeId === configureId}
                >
                  <MenuRow
                    ref={bindRow(option.id)}
                    role="menuitemradio"
                    selected={option.active}
                    aria-checked={option.active}
                    aria-current={option.active ? 'true' : undefined}
                    aria-disabled={
                      option.selection.kind === 'hosted' &&
                      !option.configured &&
                      option.readiness !== 'needs-login'
                        ? true
                        : undefined
                    }
                    disabled={option.readiness === 'unavailable'}
                    active={menu.activeId === option.id}
                    description={display.secondary}
                    tabIndex={menu.activeId === option.id ? 0 : -1}
                    onPointerEnter={() => menu.point(option.id)}
                    onClick={() => menu.activate(option.id)}
                    data-testid={`${optionTestIdPrefix}-${option.id}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span>{display.primary}</span>
                      {!option.configured && (
                        <span className="rounded bg-warning/10 px-1.5 py-0.5 font-medium text-warning">
                          {option.readinessLabel ?? 'Needs setup'}
                        </span>
                      )}
                    </span>
                  </MenuRow>
                  {option.category !== 'future' && onConfigureHost && (
                    <MenuRowAction
                      ref={bindRow(configureId)}
                      role="menuitem"
                      tabIndex={menu.activeId === configureId ? 0 : -1}
                      onPointerEnter={() => menu.point(configureId)}
                      onClick={() => menu.activate(configureId)}
                      title={`Configure ${option.label}`}
                      aria-label={`Configure ${option.label}`}
                      data-testid={`${optionTestIdPrefix}-${option.id}-configure`}
                    >
                      <SlidersIcon size={16} />
                    </MenuRowAction>
                  )}
                </MenuRowGroup>
              );
            })}
          </div>
        )}
        <MenuSeparator />
        <MenuRow
          ref={bindRow('manage-sources')}
          role="menuitem"
          active={menu.activeId === 'manage-sources'}
          tabIndex={menu.activeId === 'manage-sources' ? 0 : -1}
          onPointerEnter={() => menu.point('manage-sources')}
          onClick={() => menu.activate('manage-sources')}
          data-testid={manageTestId}
        >
          AI settings...
        </MenuRow>
      </PortalMenu>
    </div>
  );
}
