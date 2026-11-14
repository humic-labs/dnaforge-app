import { isApplePlatform } from '@waypoint/ui-components/keyboard';
import {
  BLOCKING_COMMAND_SCOPES,
  COMMAND_IDS,
  COMMAND_SCOPES,
  COMMAND_SCOPE_PRIORITY,
  FOCUS_COMMAND_SCOPES,
  type CommandBinding,
  type CommandDefinition,
  type CommandDispatchResult,
  type CommandHandlerRegistration,
  type CommandId,
  type CommandScope,
} from './types';

export function assertUniqueCommandDefinitions(
  definitions: readonly Pick<CommandDefinition, 'id'>[]
): void {
  const seen = new Set<CommandId>();
  for (const definition of definitions) {
    if (seen.has(definition.id)) {
      throw new Error(`Duplicate command id: ${definition.id}`);
    }
    seen.add(definition.id);
  }
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function isEditableCommandTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null
  );
}

export function keyboardCommandBelongsToTarget(
  event: KeyboardEvent,
  command: CommandId,
  allowInInput = false
): boolean {
  let terminalPaneNavigation = false;
  if (event.target instanceof Element) {
    const terminalSurface = event.target.closest('[data-terminal-surface]');
    terminalPaneNavigation =
      terminalSurface !== null &&
      (command === COMMAND_IDS.canvasNextTab || command === COMMAND_IDS.canvasPreviousTab);
    if (terminalSurface && !terminalPaneNavigation && !command.startsWith('terminal.')) return true;
    const owner = event.target
      .closest('[data-command-shortcut-owner]')
      ?.getAttribute('data-command-shortcut-owner');
    if (owner === command) return true;
  }
  return !allowInInput && !terminalPaneNavigation && isEditableCommandTarget(event.target);
}

export function matchesCommandBinding(
  event: KeyboardEvent,
  binding: CommandBinding,
  platform?: string
): boolean {
  const keyFromCode = event.code.replace('Key', '').toLowerCase();
  const expectedKey = normalizeKey(binding.key);
  const eventKey = normalizeKey(event.key);
  const keyMatches =
    eventKey === expectedKey ||
    (expectedKey === '`' && event.code === 'Backquote') ||
    (binding.alt === true && keyFromCode === expectedKey);
  if (!keyMatches) return false;

  const apple = isApplePlatform(platform);
  const requiredMeta = binding.meta === true || (binding.cmd === true && apple);
  const requiredCtrl = binding.ctrl === true || (binding.cmd === true && !apple);

  return (
    event.metaKey === requiredMeta &&
    event.ctrlKey === requiredCtrl &&
    event.shiftKey === (binding.shift === true) &&
    event.altKey === (binding.alt === true)
  );
}

function isRegistrationEnabled(registration: CommandHandlerRegistration): boolean {
  return registration.enabled ? registration.enabled() : true;
}

export function getHighestActiveFocusScope(
  activeScopes: ReadonlySet<CommandScope>
): CommandScope | null {
  let winner: CommandScope | null = null;
  for (const scope of activeScopes) {
    if (!FOCUS_COMMAND_SCOPES.has(scope)) continue;
    if (!winner || COMMAND_SCOPE_PRIORITY[scope] > COMMAND_SCOPE_PRIORITY[winner]) {
      winner = scope;
    }
  }
  return winner;
}

function isRegistrationShadowedByFocusedSurface(
  registration: CommandHandlerRegistration,
  activeScopes: ReadonlySet<CommandScope>
): boolean {
  const activeFocusScope = getHighestActiveFocusScope(activeScopes);
  if (!activeFocusScope || activeFocusScope === registration.scope) return false;
  return COMMAND_SCOPE_PRIORITY[activeFocusScope] > COMMAND_SCOPE_PRIORITY[registration.scope];
}

function isRegistrationActive(
  registration: CommandHandlerRegistration,
  activeScopes: ReadonlySet<CommandScope>
): boolean {
  if (registration.scope === COMMAND_SCOPES.appGlobal) return true;
  if (isRegistrationShadowedByFocusedSurface(registration, activeScopes)) return false;
  return activeScopes.has(registration.scope);
}

export function getHighestActiveBlockingScope(
  activeScopes: ReadonlySet<CommandScope>,
  bypassScopes: ReadonlySet<CommandScope> = new Set()
): CommandScope | null {
  let winner: CommandScope | null = null;
  for (const scope of activeScopes) {
    if (bypassScopes.has(scope)) continue;
    if (!BLOCKING_COMMAND_SCOPES.has(scope)) continue;
    if (!winner || COMMAND_SCOPE_PRIORITY[scope] > COMMAND_SCOPE_PRIORITY[winner]) {
      winner = scope;
    }
  }
  return winner;
}

export function resolveCommandHandler(
  command: CommandId,
  registrations: readonly CommandHandlerRegistration[],
  activeScopes: ReadonlySet<CommandScope>
): CommandHandlerRegistration | null {
  const candidates = registrations
    .filter((registration) => registration.command === command)
    .filter(isRegistrationEnabled)
    .filter((registration) => isRegistrationActive(registration, activeScopes))
    .sort((a, b) => COMMAND_SCOPE_PRIORITY[b.scope] - COMMAND_SCOPE_PRIORITY[a.scope]);

  return candidates[0] ?? null;
}

export function isCommandBlockedByScope(
  handler: CommandHandlerRegistration | null,
  activeScopes: ReadonlySet<CommandScope>,
  bypassScopes?: ReadonlySet<CommandScope>
): boolean {
  const blockingScope = getHighestActiveBlockingScope(activeScopes, bypassScopes);
  if (!blockingScope) return false;
  if (!handler) return true;
  return COMMAND_SCOPE_PRIORITY[blockingScope] > COMMAND_SCOPE_PRIORITY[handler.scope];
}

export function createCommandResult(
  command: CommandId,
  handler: CommandHandlerRegistration | null,
  handled: boolean,
  blocked: boolean
): CommandDispatchResult {
  return {
    command,
    handled,
    blocked,
    scope: handler?.scope ?? null,
  };
}
